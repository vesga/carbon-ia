import os
import re
from datetime import datetime, timezone
from flask import Flask, jsonify, request
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://azbjrrbhvbmnbyvhxxdr.supabase.co").strip().rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "sb_publishable_hx99kGNl5tBmaLrszIn_Rg_BhwEhV9H").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()



ADMIN_PHONES = {
    t.strip()
    for t in os.getenv("ADMIN_PHONES", "3000000000").split(",")
    if t.strip()
}

MODEL = "google/gemini-2.5-flash-lite"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

DETALLE_PEDIDOS_MULTI = {}
BORRADORES = {}  # cliente_id -> {"items": [...], "bultos": int, "total": int, "prod": dict}

SYSTEM_PROMPT = """Eres asesor comercial de una distribuidora de carbón vegetal natural en Bucaramanga.
Hablas de forma cercana, directa y breve como en un chat real.

REGLAS OBLIGATORIAS DE FORMATO Y TONO:
1. MENSAJES CORTOS (MÁXIMO 2 O 3 LÍNEAS): Sé conciso y directo.
2. PROHIBIDO ASTERISCOS Y LISTAS: Nunca escribas *, #, -, •, negritas ni listas con viñetas. Escribe en texto corrido.
3. CATÁLOGO COMO ÚNICA VERDAD: Usa SOLO los nombres, precios vigentes, descripciones y stock de "CATÁLOGO ACTUAL Y PRECIOS VIGENTES". Nunca menciones precios que no estén ahí. Si un producto no tiene oferta activa, dilo claramente.
4. CANTIDADES INVÁLIDAS O SIN STOCK: Si el cliente pide 0, números negativos o más bultos que el stock disponible (o un producto con stock 0), indícalo amablemente.
5. NUNCA INVENTES PEDIDOS NI APROBACIONES: Jamás digas "ya te separé", "ya revisé tu pedido", "está en proceso", "ya fue aprobado" o "listo para entrega" si no está confirmado en el sistema.
6. IDENTIDAD: Nunca digas que eres IA, modelo, bot o asistente virtual, y no uses nombres propios.
7. Si preguntan por todos los productos o qué venden, resume el catálogo completo en una sola frase con precios.
8. Todos los bultos son de 10 kg salvo que el catálogo diga otra cosa.
9. Nunca registres ni confirmes pedidos tú mismo: eso lo hace el sistema. Si el cliente quiere pedir, pídele producto y cantidad.
10. Si el cliente duda o pregunta algo, responde la duda primero y no empujes la venta en cada mensaje.
11. Si preguntan algo fuera del negocio, redirige amable al carbón."""

SOPORTE_PROMPT = """Eres asesor de soporte al cliente de la distribuidora de carbón en Bucaramanga.
Responde en máximo 2 líneas en texto corrido, sin asteriscos, sin guiones de lista ni viñetas, sobre entregas en Bucaramanga, productos del catálogo y pagos (Nequi 315 420 8890, Bancolombia Ahorros 482-910345-12 o efectivo contra entrega). Nunca digas que eres IA o bot ni uses nombres propios."""


def supabase_headers():
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def es_telefono_admin(telefono: str, cliente: dict | None = None) -> bool:
    tel_limpio = re.sub(r"\D", "", str(telefono or ""))
    admin_limpios = {re.sub(r"\D", "", t) for t in ADMIN_PHONES}
    if tel_limpio and tel_limpio in admin_limpios:
        return True
    if cliente and str(cliente.get("tipo_cliente", "")).upper() == "ADMIN":
        return True
    return False


def limpiar_respuesta_chat(texto: str, max_lineas: int = 3, quitar_saludo_repetido: bool = False) -> str:
    """Elimina asteriscos, markdown, listas y saludos repetitivos."""
    if not texto:
        return "¿Qué tipo de carbón del catálogo deseas pedir y cuántos bultos necesitas?"

    limpio = str(texto)
    limpio = re.sub(r"[*#_`~]+", "", limpio)

    lineas_procesadas = []
    for raw_line in limpio.splitlines():
        line = re.sub(r"^\s*([-•–—]+|\d+[.)])\s+", "", raw_line).strip()
        if quitar_saludo_repetido:
            line = re.sub(r"^(¡?hola[!,.]?\s*)+", "", line, flags=re.IGNORECASE).strip()
            line = re.sub(r"^(¡?qué gusto saludarte[!,.]?\s*)+", "", line, flags=re.IGNORECASE).strip()
        if line:
            lineas_procesadas.append(line)

    if not lineas_procesadas:
        return "¿Qué tipo de carbón del catálogo deseas pedir y cuántos bultos necesitas?"

    return "\n".join(lineas_procesadas[:max_lineas]).strip()


def normalizar_texto_busqueda(texto: str) -> str:
    """Normaliza errores comunes de escritura para reconocer productos y estados."""
    t = str(texto or "").lower()
    t = re.sub(r"premiun+", "premium", t)
    t = re.sub(r"estandar", "estándar", t)
    t = re.sub(r"ecolog[ií]c[oa]", "ecológico", t)
    t = re.sub(r"briquet[ae]s?", "briquetas", t)
    t = re.sub(r"haceptad[oa]", "aceptado", t)
    t = re.sub(r"\bbiene\b", "viene", t)
    return t


def es_pregunta_informativa(texto_norm: str) -> bool:
    """Detecta preguntas o consultas informativas que no deben crear pedidos."""
    patrones = (
        "que cantidad", "cuanta cantidad", "cuanto pesa", "cuanto mide", "como viene",
        "de que es", "que significa", "cuanto vale", "cuanto cuesta", "que precio",
        "cual es el precio", "hay stock", "tienen stock", "en un bulto", "por bulto",
        "que incluye", "como es el",
        "quiero saber", "quisiera saber", "me gustaria saber", "informacion", "información",
        "cuentame", "cuéntame", "explicame", "explícame", "que productos", "qué productos",
        "que tipos", "qué tipos", "cuales", "cuáles", "diferencia", "recomiend",
        "de que trata", "que venden", "qué venden",
    )
    if any(p in texto_norm for p in patrones):
        return True
    if texto_norm.strip().endswith("?") and not any(
        w in texto_norm for w in ("quiero", "dame", "pedir", "llevar", "confirmo", "pagar")
    ):
        return True
    return False


def es_negacion(texto_norm: str) -> bool:
    limpio = re.sub(r"[^a-záéíóúñ\s]", "", texto_norm).strip()
    return limpio in ("no", "mejor no", "nel", "dejalo", "déjalo", "cancela", "cancelar", "ya no")


def llamar_openrouter(messages, temperature=0.2, max_tokens=160):
    if not OPENROUTER_API_KEY:
        raise RuntimeError("Falta configurar OPENROUTER_API_KEY en el servidor Flask.")

    resp = requests.post(
        OPENROUTER_URL,
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": MODEL,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "messages": messages,
        },
        timeout=30,
    )
    data = resp.json() if resp.content else {}
    if not resp.ok:
        raise RuntimeError(data.get("error", {}).get("message", "Error al conectar con OpenRouter."))

    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    return content.strip() if isinstance(content, str) else "¡Entendido!"


def obtener_productos_normalizados():
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/productos",
        params={"order": "id.asc"},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        return []

    productos = r.json() if isinstance(r.json(), list) else []
    normalizados = []
    for p in productos:
        precio_raw = p.get("precio_bulto") if p.get("precio_bulto") is not None else p.get("precio")
        normalizados.append({
            "id": p.get("id"),
            "nombre": p.get("nombre") or "Carbón Vegetal",
            "descripcion": p.get("descripcion") or "Carbón natural para asados.",
            "precio": int(float(precio_raw or 35000)),
            "stock": int(p.get("stock") if p.get("stock") is not None else 50),
            "oferta": str(p.get("oferta") or "").strip(),
            "imagen": str(p.get("imagen") or p.get("imagen_url") or "").strip(),
        })
    return normalizados


def seleccionar_producto_desde_mensaje(mensaje: str, productos: list[dict], precios_cliente: dict | None = None):
    texto = normalizar_texto_busqueda(mensaje)
    precios_cliente = precios_cliente or {}

    mejor_prod = None
    mejor_score = 0

    for p in productos:
        nombre_p = normalizar_texto_busqueda(p.get("nombre") or "")
        palabras = [
            w for w in re.findall(r"[a-záéíóúñ]{3,}", nombre_p)
            if w not in ("bulto", "carbón", "carbon", "de", "con", "para", "natural")
        ]
        score = 0
        if nombre_p and nombre_p in texto:
            score += 12
        for w in palabras:
            if w in texto:
                score += 3
        if score > mejor_score:
            mejor_score = score
            mejor_prod = p

    if not mejor_prod and productos:
        if "premium" in texto:
            mejor_prod = next(
                (p for p in productos if "premium" in normalizar_texto_busqueda(p.get("nombre", ""))),
                productos[0],
            )
        elif "ecológico" in texto or "coco" in texto:
            mejor_prod = next(
                (p for p in productos if any(k in normalizar_texto_busqueda(p.get("nombre", "")) for k in ("ecológico", "coco"))),
                productos[0],
            )
        elif "briquetas" in texto:
            mejor_prod = next(
                (p for p in productos if "briquetas" in normalizar_texto_busqueda(p.get("nombre", ""))),
                productos[0],
            )
        elif "estándar" in texto:
            mejor_prod = next(
                (p for p in productos if "estándar" in normalizar_texto_busqueda(p.get("nombre", ""))),
                productos[0],
            )
        else:
            mejor_prod = productos[0]

    if not mejor_prod:
        return "Bulto de Carbón (10 Kg)", 35000, None

    pid_key = str(mejor_prod.get("id"))
    nombre_key = str(mejor_prod.get("nombre") or "").strip().lower()
    precio_unit = int(float(
        precios_cliente.get(pid_key)
        if pid_key in precios_cliente
        else precios_cliente.get(nombre_key, mejor_prod.get("precio", 35000))
    ))
    return mejor_prod.get("nombre") or "Carbón Vegetal", max(500, precio_unit), mejor_prod


def buscar_producto_para_pedido(pedido: dict | None, productos_db: list[dict]):
    if not pedido or not productos_db:
        return None
    if pedido.get("producto_id") is not None:
        prod = next((p for p in productos_db if p.get("id") == pedido.get("producto_id")), None)
        if prod:
            return prod

    cantidad = int(pedido.get("cantidad_bultos") or 0)
    total_ped = float(pedido.get("total") or 0)
    if cantidad > 0 and total_ped > 0:
        unit_ped = int(round(total_ped / cantidad))
        prod_match = next((p for p in productos_db if int(p.get("precio") or 0) == unit_ped), None)
        if prod_match:
            return prod_match

    return productos_db[0]


def extraer_cantidad_valida(texto: str):
    t = str(texto or "").lower()
    if re.search(r"-\s*\d+", t):
        return -1
    t = re.sub(r"\bq(\d)\b", r"2\1", t)
    # Ignorar números que son peso o plata, no bultos
    t = re.sub(r"\d+\s*(kg|kilos?|cop|pesos)\b", " ", t)
    t = re.sub(r"\$\s*[\d.,]+", " ", t)
    nums = re.findall(r"\b\d+\b", t)
    return int(nums[0]) if nums else 0


def detecta_producto_explicito(mensaje: str, productos: list[dict]) -> bool:
    texto = normalizar_texto_busqueda(mensaje)
    if any(k in texto for k in ("estándar", "premium", "coco", "ecológico", "briquetas", "algarrobo")):
        return True
    for p in productos:
        nombre_p = normalizar_texto_busqueda(p.get("nombre") or "")
        palabras = [
            w for w in re.findall(r"[a-záéíóúñ]{4,}", nombre_p)
            if w not in ("bulto", "carbón", "carbon", "natural", "para")
        ]
        if any(w in texto for w in palabras):
            return True
    return False


def extraer_items_multiples(mensaje: str, productos: list[dict]) -> list[tuple[int, str]]:
    """Separa frases como '10 de premiun y 10 de coco' en pares (cantidad, segmento)."""
    partes = re.split(r"\s*(?:,|;|\by\b|\be\b)\s*", mensaje, flags=re.IGNORECASE)
    items = []
    for parte in partes:
        parte_limpia = parte.strip()
        if not parte_limpia:
            continue
        cant = extraer_cantidad_valida(parte_limpia)
        if cant != 0 and detecta_producto_explicito(parte_limpia, productos):
            items.append((cant, parte_limpia))
    return items


def buscar_ultimo_producto_en_historial(historial: list[dict], productos: list[dict]):
    for m in reversed(historial[:-1]):
        contenido = str(m.get("content", ""))
        if detecta_producto_explicito(contenido, productos):
            return contenido
    return ""


def buscar_ultima_cantidad_en_historial(historial: list[dict]):
    for m in reversed(historial[:-1]):
        if m.get("role") == "user":
            cant = extraer_cantidad_valida(str(m.get("content", "")))
            if cant > 0:
                return cant
    return 0


def armar_borrador(mensaje, productos, precios_cliente, historial=None):
    items = extraer_items_multiples(mensaje, productos)
    if not items:
        cant = extraer_cantidad_valida(mensaje)
        if cant != 0 and detecta_producto_explicito(mensaje, productos):
            items = [(cant, mensaje)]
        elif cant != 0 and historial:
            prod_previo = buscar_ultimo_producto_en_historial(historial, productos)
            if prod_previo:
                items = [(cant, f"{cant} de {prod_previo}")]

    validos, avisos, prod_principal = [], [], None
    for cant, seg in items:
        nombre, precio_u, prod = seleccionar_producto_desde_mensaje(seg, productos, precios_cliente)
        stock = int((prod or {}).get("stock") or 0)
        if cant <= 0:
            avisos.append(f"La cantidad para {nombre} no es válida.")
        elif stock <= 0:
            avisos.append(f"De {nombre} no tenemos stock por ahora.")
        elif cant > stock:
            avisos.append(f"De {nombre} solo tenemos {stock} bultos.")
        else:
            prod_principal = prod_principal or prod
            validos.append({
                "nombre": nombre,
                "cantidad": cant,
                "precio_unitario": precio_u,
                "subtotal": cant * precio_u,
            })
    return validos, avisos, prod_principal


def es_confirmacion_o_cierre(texto_norm: str) -> bool:
    limpio = re.sub(r"[^a-záéíóúñ\s]", "", texto_norm).strip()
    if limpio in ("si", "sí", "dale", "listo", "confirmo", "confirmar", "de acuerdo", "ok", "okay", "pagar", "quiero pagar", "proceder"):
        return True
    return any(k in limpio for k in ("quiero pagar", "confirmo", "haz el pedido", "hazlo", "enviar pedido", "registrar pedido"))


def consultar_estado_ultimo_pedido(cliente_id):
    if not cliente_id:
        return None
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={
            "cliente_id": f"eq.{cliente_id}",
            "order": "id.desc",
            "limit": "1",
        },
        headers=supabase_headers(),
        timeout=15,
    )
    filas = r.json() if r.ok and isinstance(r.json(), list) else []
    if not filas:
        return None

    ped = filas[0]
    r_pagos = requests.get(
        f"{SUPABASE_URL}/rest/v1/pagos",
        params={"pedido_id": f"eq.{ped.get('id')}", "order": "id.desc", "limit": "1"},
        headers=supabase_headers(),
        timeout=15,
    )
    pagos = r_pagos.json() if r_pagos.ok and isinstance(r_pagos.json(), list) else []
    ped["estado_pago"] = pagos[0].get("estado_pago") if pagos else "SIN_COMPROBANTE"
    return ped


def cancelar_ultimo_pedido_pendiente(cliente_id):
    if not cliente_id:
        return None

    r_pend = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={
            "cliente_id": f"eq.{cliente_id}",
            "estado": "eq.PENDIENTE",
            "order": "id.desc",
            "limit": "1",
        },
        headers=supabase_headers(),
        timeout=15,
    )
    pendientes = r_pend.json() if r_pend.ok and isinstance(r_pend.json(), list) else []
    if not pendientes:
        return False

    pedido = pendientes[0]
    pedido_id = pedido.get("id")
    r_upd = requests.patch(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={"id": f"eq.{pedido_id}"},
        json={"estado": "RECHAZADO"},
        headers=supabase_headers(),
        timeout=15,
    )
    if r_upd.ok:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/pagos",
            params={"pedido_id": f"eq.{pedido_id}"},
            json={"estado_pago": "RECHAZADO"},
            headers=supabase_headers(),
            timeout=15,
        )
        return pedido_id
    return None


def insertar_pedido_en_supabase(cliente_id, cantidad, precio_unitario, prod_obj, direccion, detalle_items=None):
    total_calc = cantidad * precio_unitario
    cuerpo_pedido = {
        "cliente_id": cliente_id,
        "cantidad_bultos": cantidad,
        "total": total_calc,
        "estado": "PENDIENTE",
        "direccion_entrega": direccion or "Bucaramanga",
    }
    if prod_obj and isinstance(prod_obj.get("id"), int):
        cuerpo_pedido["producto_id"] = prod_obj["id"]

    r_ins = requests.post(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        json=cuerpo_pedido,
        headers=supabase_headers(),
        timeout=15,
    )
    if not r_ins.ok and "producto_id" in cuerpo_pedido:
        cuerpo_pedido.pop("producto_id", None)
        r_ins = requests.post(
            f"{SUPABASE_URL}/rest/v1/pedidos",
            json=cuerpo_pedido,
            headers=supabase_headers(),
            timeout=15,
        )

    if r_ins.ok and r_ins.json():
        creado = r_ins.json()[0]
        if detalle_items:
            resumen_nombres = " + ".join(
                f"{item['cantidad']} x {item['nombre']}" for item in detalle_items
            )
            creado["producto_nombre"] = resumen_nombres
            creado["items"] = detalle_items
            if creado.get("id") is not None:
                DETALLE_PEDIDOS_MULTI[creado["id"]] = resumen_nombres
        else:
            creado["producto_nombre"] = (prod_obj or {}).get("nombre") or "Carbón Vegetal"
        creado["precio_unitario"] = precio_unitario
        return creado
    return None


@app.get("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "supabase_configurado": bool(SUPABASE_URL and SUPABASE_ANON_KEY),
        "openrouter_configurado": bool(OPENROUTER_API_KEY),
    })


@app.post("/api/clientes/login")
def login_cliente():
    payload = request.get_json(silent=True) or {}
    telefono = str(payload.get("telefono", "")).strip()
    if not telefono:
        return jsonify({"error": "El teléfono es obligatorio."}), 400

    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/clientes",
        params={"telefono": f"eq.{telefono}", "select": "*"},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        return jsonify({
            "error": "Error consultando clientes en Supabase.",
            "status_supabase": r.status_code,
            "detalle_supabase": r.text,
        }), 502

    filas = r.json()
    if filas:
        cliente = filas[0]
        return jsonify({
            "existe": True,
            "es_admin": es_telefono_admin(telefono, cliente),
            "cliente": cliente,
        })

    return jsonify({
        "existe": False,
        "es_admin": es_telefono_admin(telefono, None),
        "cliente": {"telefono": telefono, "nombre": "", "direccion_habitual": ""},
    })


@app.post("/api/clientes")
def crear_cliente():
    payload = request.get_json(silent=True) or {}
    telefono = str(payload.get("telefono", "")).strip()
    nombre = str(payload.get("nombre", "")).strip()
    direccion = str(payload.get("direccion_habitual", "Bucaramanga")).strip()

    if not telefono or not nombre:
        return jsonify({"error": "Teléfono y nombre son obligatorios."}), 400

    tipo = "ADMIN" if es_telefono_admin(telefono, None) else "NUEVO"
    nuevo = {
        "telefono": telefono,
        "nombre": nombre,
        "tipo_cliente": tipo,
        "direccion_habitual": direccion,
    }
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/clientes",
        json=nuevo,
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        return jsonify({
            "error": "No se pudo registrar el cliente en Supabase.",
            "status_supabase": r.status_code,
            "detalle_supabase": r.text,
        }), 502

    creados = r.json()
    cliente_creado = creados[0] if creados else nuevo
    return jsonify({
        "es_admin": es_telefono_admin(telefono, cliente_creado),
        "cliente": cliente_creado,
    }), 201


@app.get("/api/productos")
def listar_productos():
    return jsonify({"productos": obtener_productos_normalizados()})


@app.post("/api/admin/productos")
def admin_crear_producto():
    payload = request.get_json(silent=True) or {}
    nombre = str(payload.get("nombre", "")).strip()
    descripcion = str(payload.get("descripcion", "Carbón natural de alta calidad.")).strip()
    precio_raw = payload.get("precio_bulto") if payload.get("precio_bulto") is not None else payload.get("precio")
    precio = int(float(precio_raw or 0))
    stock = int(payload.get("stock") or 0)
    oferta = str(payload.get("oferta", "")).strip()
    imagen = str(payload.get("imagen", "")).strip()

    if not nombre or precio <= 0:
        return jsonify({"error": "Nombre y precio válido son obligatorios."}), 400

    cuerpo = {
        "nombre": nombre,
        "descripcion": descripcion,
        "precio_bulto": precio,
        "stock": max(0, stock),
        "oferta": oferta or None,
        "imagen": imagen or None,
    }

    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/productos",
        json=cuerpo,
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        for col in ("imagen", "oferta"):
            if col in cuerpo:
                cuerpo.pop(col, None)
                r = requests.post(
                    f"{SUPABASE_URL}/rest/v1/productos",
                    json=cuerpo,
                    headers=supabase_headers(),
                    timeout=15,
                )
                if r.ok:
                    break

    if not r.ok:
        return jsonify({
            "error": "No se pudo crear el producto en Supabase.",
            "status_supabase": r.status_code,
            "detalle_supabase": r.text,
        }), 502

    creado = r.json()[0] if r.json() else dict(cuerpo)
    creado["precio"] = int(float(creado.get("precio_bulto") or precio))
    if "oferta" not in creado:
        creado["oferta"] = oferta
    if "imagen" not in creado:
        creado["imagen"] = imagen
    return jsonify({"producto": creado}), 201


@app.patch("/api/admin/productos/<int:producto_id>")
def admin_actualizar_producto(producto_id):
    payload = request.get_json(silent=True) or {}
    cambios = {}

    precio_raw = payload.get("precio_bulto") if payload.get("precio_bulto") is not None else payload.get("precio")
    if precio_raw is not None:
        cambios["precio_bulto"] = max(1, int(float(precio_raw)))
    if "stock" in payload and payload["stock"] is not None:
        cambios["stock"] = max(0, int(payload["stock"]))
    if "oferta" in payload:
        val_oferta = str(payload.get("oferta") or "").strip()
        cambios["oferta"] = val_oferta if val_oferta else None
    if "nombre" in payload and str(payload["nombre"]).strip():
        cambios["nombre"] = str(payload["nombre"]).strip()
    if "descripcion" in payload:
        cambios["descripcion"] = str(payload.get("descripcion") or "").strip()
    if "imagen" in payload:
        val_img = str(payload.get("imagen") or "").strip()
        cambios["imagen"] = val_img if val_img else None

    if not cambios:
        return jsonify({"error": "No hay cambios válidos para actualizar."}), 400

    cuerpo = dict(cambios)
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/productos",
        params={"id": f"eq.{producto_id}"},
        json=cuerpo,
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        for col in ("imagen", "oferta"):
            if col in cuerpo:
                cuerpo.pop(col, None)
                if cuerpo:
                    r = requests.patch(
                        f"{SUPABASE_URL}/rest/v1/productos",
                        params={"id": f"eq.{producto_id}"},
                        json=cuerpo,
                        headers=supabase_headers(),
                        timeout=15,
                    )
                    if r.ok:
                        break

    if not r.ok:
        return jsonify({
            "error": "No se pudo actualizar el producto.",
            "status_supabase": r.status_code,
            "detalle_supabase": r.text,
        }), 502

    actualizado = r.json()[0] if r.json() else {"id": producto_id, **cambios}
    if "precio_bulto" in actualizado:
        actualizado["precio"] = int(float(actualizado["precio_bulto"]))
    for k, v in cambios.items():
        if k not in actualizado:
            actualizado[k] = v or ""
    return jsonify({"producto": actualizado})


@app.delete("/api/admin/productos/<int:producto_id>")
def admin_eliminar_producto(producto_id):
    r = requests.delete(
        f"{SUPABASE_URL}/rest/v1/productos",
        params={"id": f"eq.{producto_id}"},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        return jsonify({
            "error": "No se pudo eliminar el producto en Supabase.",
            "status_supabase": r.status_code,
            "detalle_supabase": r.text,
        }), 502

    return jsonify({"eliminado": True, "id": producto_id})


@app.get("/api/pedidos")
def listar_pedidos():
    cliente_id = request.args.get("cliente_id")
    if not cliente_id:
        return jsonify({"error": "Falta cliente_id."}), 400

    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={"cliente_id": f"eq.{cliente_id}", "order": "id.desc"},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r.ok:
        return jsonify({"error": "Error consultando pedidos en Supabase."}), 502

    pedidos = r.json() if isinstance(r.json(), list) else []
    r_pagos = requests.get(
        f"{SUPABASE_URL}/rest/v1/pagos",
        params={"order": "id.desc"},
        headers=supabase_headers(),
        timeout=15,
    )
    pagos_por_pedido = {}
    if r_pagos.ok:
        for pg in (r_pagos.json() if isinstance(r_pagos.json(), list) else []):
            pid = pg.get("pedido_id")
            if pid not in pagos_por_pedido:
                pagos_por_pedido[pid] = pg

    enriquecidos = []
    for ped in pedidos:
        pid = ped.get("id")
        pago = pagos_por_pedido.get(pid, {})
        item = {
            **ped,
            "estado_pago": pago.get("estado_pago") or ("APROBADO" if ped.get("estado") in ("CONFIRMADO", "ENTREGADO") else "SIN_COMPROBANTE"),
            "metodo_pago": pago.get("metodo_pago") or "",
        }
        if pid in DETALLE_PEDIDOS_MULTI:
            item["producto_nombre"] = DETALLE_PEDIDOS_MULTI[pid]
        enriquecidos.append(item)

    return jsonify({"pedidos": enriquecidos})


@app.post("/api/chat")
def chat_ventas():
    payload = request.get_json(silent=True) or {}
    mensaje = str(payload.get("mensaje", "")).strip()
    historial = payload.get("historial", [])
    cliente = payload.get("cliente") or {}
    precios_cliente = payload.get("precios_vigentes") or {}

    if not mensaje:
        return jsonify({"error": "Mensaje vacío."}), 400

    productos_contexto = obtener_productos_normalizados()
    cliente_id = cliente.get("id")
    texto = normalizar_texto_busqueda(mensaje)
    tiene_historial_previo = len(historial) > 1
    es_consulta_info = es_pregunta_informativa(texto)

    # 1. Confirmación o negación de un borrador existente
    borrador = BORRADORES.get(cliente_id) if cliente_id else None
    if borrador and es_negacion(texto):
        BORRADORES.pop(cliente_id, None)
        return jsonify({
            "respuesta": limpiar_respuesta_chat(
                "Listo, no registro nada. ¿Qué carbón te gustaría pedir?",
                max_lineas=2,
                quitar_saludo_repetido=True,
            ),
            "pedido_creado": None,
        })

    if borrador and es_confirmacion_o_cierre(texto):
        BORRADORES.pop(cliente_id, None)
        detalle_items = borrador["items"] if len(borrador["items"]) >= 2 else None
        precio_prom = int(round(borrador["total"] / borrador["bultos"]))
        ped = insertar_pedido_en_supabase(
            cliente_id,
            borrador["bultos"],
            precio_prom,
            borrador["prod"],
            cliente.get("direccion_habitual") or "Bucaramanga",
            detalle_items=detalle_items,
        )
        if ped:
            ped["total"] = borrador["total"]
            if len(borrador["items"]) == 1:
                ped["producto_nombre"] = borrador["items"][0]["nombre"]
            total_fmt = f"{borrador['total']:,}".replace(",", ".")
            return jsonify({
                "respuesta": limpiar_respuesta_chat(
                    f"Listo, registré tu Pedido #{ped.get('id')} por ${total_fmt} COP. "
                    "Puedes pagar por Nequi (315 420 8890) o Bancolombia Ahorros (482-910345-12) y adjuntar el comprobante.",
                    max_lineas=3,
                    quitar_saludo_repetido=True,
                ),
                "pedido_creado": ped,
            })

    # 2. Cancelación directa de pedido pendiente ya registrado en BD
    if any(k in texto for k in ("cancelar", "anular")) and ("pedido" in texto or cliente_id):
        cancelado = cancelar_ultimo_pedido_pendiente(cliente_id)
        if cancelado:
            return jsonify({
                "respuesta": limpiar_respuesta_chat(
                    f"Listo, cancelé tu pedido pendiente #{cancelado}. ¿Te gustaría hacer un pedido nuevo con otro producto?",
                    max_lineas=2,
                    quitar_saludo_repetido=True,
                ),
                "pedido_creado": None,
                "pedido_cancelado": cancelado,
            })
        return jsonify({
            "respuesta": limpiar_respuesta_chat(
                "No tienes pedidos pendientes por cancelar en este momento. ¿Qué carbón te gustaría pedir hoy?",
                max_lineas=2,
                quitar_saludo_repetido=True,
            ),
            "pedido_creado": None,
        })

    # 3. Consulta real de aprobación o estado del último pedido
    es_consulta_estado = (
        any(k in texto for k in ("aprobado", "aprobaron", "aceptado", "aceptaron", "rechazado", "rechazaron", "revisaron", "confirmaron"))
        or ("estado" in texto and "pedido" in texto)
        or ("en que estado" in texto)
    )
    if cliente_id and es_consulta_estado:
        ultimo_ped = consultar_estado_ultimo_pedido(cliente_id)
        if not ultimo_ped:
            return jsonify({
                "respuesta": limpiar_respuesta_chat(
                    "No encontré pedidos registrados todavía. ¿Qué carbón del catálogo deseas pedir?",
                    max_lineas=2,
                    quitar_saludo_repetido=True,
                ),
                "pedido_creado": None,
            })
        pid = ultimo_ped.get("id")
        est = str(ultimo_ped.get("estado") or "PENDIENTE").upper()
        est_pago = str(ultimo_ped.get("estado_pago") or "SIN_COMPROBANTE").upper()
        if est in ("CONFIRMADO", "ENTREGADO"):
            msg_est = f"Tu Pedido #{pid} fue ACEPTADO y está en estado {est}."
        elif est == "RECHAZADO":
            msg_est = f"Tu Pedido #{pid} fue RECHAZADO. Si deseas, podemos registrar un pedido nuevo."
        elif est_pago == "EN_REVISION":
            msg_est = f"Tu Pedido #{pid} está en estado PENDIENTE y su pago está EN_REVISION por el administrador."
        else:
            msg_est = f"Tu Pedido #{pid} está en estado PENDIENTE (pago: {est_pago})."
        return jsonify({
            "respuesta": limpiar_respuesta_chat(msg_est, max_lineas=2, quitar_saludo_repetido=True),
            "pedido_creado": None,
        })

    # 4. Armar borrador (nunca en preguntas informativas)
    if cliente_id and not es_consulta_info:
        validos, avisos, prod_p = armar_borrador(
            mensaje, productos_contexto, precios_cliente, historial=historial
        )
        if validos:
            bultos = sum(i["cantidad"] for i in validos)
            total = sum(i["subtotal"] for i in validos)
            BORRADORES[cliente_id] = {
                "items": validos,
                "bultos": bultos,
                "total": total,
                "prod": prod_p,
            }
            detalle = " y ".join(f"{i['cantidad']} de {i['nombre']}" for i in validos)
            total_fmt = f"{total:,}".replace(",", ".")
            msg = f"Serían {detalle} por ${total_fmt} COP. ¿Confirmo el pedido?"
            if avisos:
                msg += " " + " ".join(avisos)
            return jsonify({
                "respuesta": limpiar_respuesta_chat(msg, max_lineas=3, quitar_saludo_repetido=True),
                "pedido_creado": None,
            })
        if avisos:
            return jsonify({
                "respuesta": limpiar_respuesta_chat(" ".join(avisos), max_lineas=2, quitar_saludo_repetido=True),
                "pedido_creado": None,
            })

    # 5. Construir catálogo vigente exacto para el LLM
    lineas_catalogo = []
    ofertas_activas = []
    for p in productos_contexto:
        precio_vigente = int(precios_cliente.get(
            str(p["id"]),
            precios_cliente.get(str(p["nombre"]).lower(), p["precio"])
        ))
        precio_fmt = f"${precio_vigente:,}".replace(",", ".")
        stock_num = int(p.get("stock", 0))
        estado_stock = f"Stock: {stock_num}" if stock_num > 0 else "Agotado (Stock: 0)"
        if p.get("oferta"):
            ofertas_activas.append(f"{p['nombre']} ({p['oferta']}, precio final {precio_fmt} COP)")
        desc_txt = f" ({p['descripcion']})" if p.get("descripcion") else ""
        lineas_catalogo.append(f"{p['nombre']}{desc_txt} a {precio_fmt} COP, {estado_stock}.")

    resumen_ofertas = (
        "OFERTAS ACTIVAS HOY: " + "; ".join(ofertas_activas) + "."
        if ofertas_activas
        else "OFERTAS ACTIVAS HOY: Ninguna."
    )
    resumen_catalogo = "\n".join(lineas_catalogo)
    prompt_sistema = (
        f"{SYSTEM_PROMPT}\n\n{resumen_ofertas}\nCATÁLOGO ACTUAL Y PRECIOS VIGENTES:\n{resumen_catalogo}"
        if resumen_catalogo
        else f"{SYSTEM_PROMPT}\n\n{resumen_ofertas}"
    )
    if cliente_id and BORRADORES.get(cliente_id):
        prompt_sistema += "\nHAY UN PEDIDO EN BORRADOR esperando confirmación del cliente (sí/no)."

    mensajes_ia = [{"role": "system", "content": prompt_sistema}] + [
        {"role": m.get("role", "user"), "content": str(m.get("content", ""))}
        for m in historial[-10:]
    ]

    try:
        respuesta_ia = llamar_openrouter(mensajes_ia, temperature=0.2, max_tokens=160)
        respuesta_ia = limpiar_respuesta_chat(
            respuesta_ia,
            max_lineas=3,
            quitar_saludo_repetido=tiene_historial_previo,
        )
        return jsonify({
            "respuesta": respuesta_ia,
            "pedido_creado": None,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/api/validar-pago")
def validar_pago():
    payload = request.get_json(silent=True) or {}
    cliente_id = payload.get("cliente_id")
    nombre_archivo = str(payload.get("nombre_archivo", "")).strip()
    metodo_pago = str(payload.get("metodo_pago", "Nequi / Transferencia")).strip()
    comprobante_data = str(payload.get("comprobante_data", "")).strip()

    if not cliente_id or not nombre_archivo:
        return jsonify({"error": "Faltan datos del comprobante o del cliente."}), 400

    r_pend = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={
            "cliente_id": f"eq.{cliente_id}",
            "estado": "eq.PENDIENTE",
            "order": "id.desc",
            "limit": "1",
        },
        headers=supabase_headers(),
        timeout=15,
    )
    pendientes = r_pend.json() if r_pend.ok else []

    if not pendientes:
        return jsonify({
            "tiene_pendiente": False,
            "aprobado": False,
            "respuesta": limpiar_respuesta_chat(
                "No tienes un pedido pendiente ahora mismo. Dime qué carbón y cuántos bultos deseas pedir.",
                max_lineas=2,
                quitar_saludo_repetido=True,
            ),
        })

    pedido_id = pendientes[0]["id"]
    estado_pago = "EN_REVISION"
    url_a_guardar = comprobante_data if comprobante_data.startswith("data:image/") else nombre_archivo

    requests.post(
        f"{SUPABASE_URL}/rest/v1/pagos",
        json={
            "pedido_id": pedido_id,
            "metodo_pago": metodo_pago,
            "estado_pago": estado_pago,
            "comprobante_url": url_a_guardar,
            "fecha_pago": datetime.now(timezone.utc).isoformat(),
        },
        headers=supabase_headers(),
        timeout=15,
    )

    respuesta_final = limpiar_respuesta_chat(
        f"Recibimos tu comprobante ({nombre_archivo}) para el Pedido #{pedido_id}. Quedó enviado al administrador para su revisión.",
        max_lineas=2,
        quitar_saludo_repetido=True,
    )

    return jsonify({
        "tiene_pendiente": True,
        "aprobado": False,
        "enviado_admin": True,
        "estado_pago": estado_pago,
        "pedido_id": pedido_id,
        "respuesta": respuesta_final,
    })


@app.get("/api/admin/pedidos")
def admin_listar_pedidos():
    r_pedidos = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={"order": "id.desc"},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r_pedidos.ok:
        return jsonify({"error": "Error consultando pedidos para admin."}), 502

    r_clientes = requests.get(
        f"{SUPABASE_URL}/rest/v1/clientes",
        params={"select": "*"},
        headers=supabase_headers(),
        timeout=15,
    )
    r_pagos = requests.get(
        f"{SUPABASE_URL}/rest/v1/pagos",
        params={"order": "id.desc"},
        headers=supabase_headers(),
        timeout=15,
    )

    clientes_map = {c.get("id"): c for c in (r_clientes.json() if r_clientes.ok else [])}
    pagos_por_pedido = {}
    for p in (r_pagos.json() if r_pagos.ok else []):
        pid = p.get("pedido_id")
        if pid not in pagos_por_pedido:
            pagos_por_pedido[pid] = p

    resultado = []
    for ped in r_pedidos.json():
        pid = ped.get("id")
        cli = clientes_map.get(ped.get("cliente_id"), {})
        pago = pagos_por_pedido.get(pid, {})
        comp = pago.get("comprobante_url") or ""
        es_imagen = comp.startswith("data:image/")
        item = {
            **ped,
            "cliente_nombre": cli.get("nombre") or "Cliente",
            "cliente_telefono": cli.get("telefono") or "-",
            "comprobante": "Comprobante de pago" if es_imagen else (comp or "-"),
            "comprobante_imagen": comp if es_imagen else "",
            "metodo_pago": pago.get("metodo_pago") or "-",
            "estado_pago": pago.get("estado_pago") or "SIN_COMPROBANTE",
        }
        if pid in DETALLE_PEDIDOS_MULTI:
            item["producto_nombre"] = DETALLE_PEDIDOS_MULTI[pid]
        resultado.append(item)

    return jsonify({"pedidos": resultado})


@app.post("/api/admin/pedidos/<int:pedido_id>/estado")
def admin_actualizar_estado_pedido(pedido_id):
    payload = request.get_json(silent=True) or {}
    nuevo_estado = str(payload.get("estado", "")).strip().upper()

    if nuevo_estado not in ("PENDIENTE", "CONFIRMADO", "ENTREGADO", "RECHAZADO"):
        return jsonify({"error": "Estado no válido."}), 400

    r_get = requests.get(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={"id": f"eq.{pedido_id}", "select": "*"},
        headers=supabase_headers(),
        timeout=15,
    )
    pedidos_actuales = r_get.json() if r_get.ok and r_get.json() else []
    pedido_previo = pedidos_actuales[0] if pedidos_actuales else None
    estado_anterior = str((pedido_previo or {}).get("estado") or "").upper()
    cantidad_bultos = int((pedido_previo or {}).get("cantidad_bultos") or 0)

    estados_con_descuento = ("CONFIRMADO", "ENTREGADO")
    ya_descontado = estado_anterior in estados_con_descuento
    debe_descontar = nuevo_estado in estados_con_descuento

    stock_descontado = False
    stock_repuesto = False

    if cantidad_bultos > 0 and ya_descontado != debe_descontar:
        productos_db = obtener_productos_normalizados()
        prod_objetivo = buscar_producto_para_pedido(pedido_previo, productos_db)

        if prod_objetivo and isinstance(prod_objetivo.get("id"), int):
            stock_actual = int(prod_objetivo.get("stock") or 0)

            if debe_descontar and not ya_descontado:
                if stock_actual < cantidad_bultos:
                    return jsonify({
                        "error": f"Stock insuficiente en '{prod_objetivo.get('nombre')}' (disponible: {stock_actual}, solicitado: {cantidad_bultos})."
                    }), 409

                nuevo_stock = max(0, stock_actual - cantidad_bultos)
                r_stk = requests.patch(
                    f"{SUPABASE_URL}/rest/v1/productos",
                    params={"id": f"eq.{prod_objetivo['id']}"},
                    json={"stock": nuevo_stock},
                    headers=supabase_headers(),
                    timeout=15,
                )
                if r_stk.ok:
                    stock_descontado = True

            elif ya_descontado and not debe_descontar:
                nuevo_stock = stock_actual + cantidad_bultos
                r_stk = requests.patch(
                    f"{SUPABASE_URL}/rest/v1/productos",
                    params={"id": f"eq.{prod_objetivo['id']}"},
                    json={"stock": nuevo_stock},
                    headers=supabase_headers(),
                    timeout=15,
                )
                if r_stk.ok:
                    stock_repuesto = True

    r_upd = requests.patch(
        f"{SUPABASE_URL}/rest/v1/pedidos",
        params={"id": f"eq.{pedido_id}"},
        json={"estado": nuevo_estado},
        headers=supabase_headers(),
        timeout=15,
    )
    if not r_upd.ok:
        return jsonify({"error": "No se pudo actualizar el pedido en Supabase."}), 502

    nuevo_estado_pago = "APROBADO" if nuevo_estado in ("CONFIRMADO", "ENTREGADO") else (
        "RECHAZADO" if nuevo_estado == "RECHAZADO" else "EN_REVISION"
    )
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/pagos",
        params={"pedido_id": f"eq.{pedido_id}"},
        json={"estado_pago": nuevo_estado_pago},
        headers=supabase_headers(),
        timeout=15,
    )

    actualizado = r_upd.json()[0] if r_upd.json() else {"id": pedido_id, "estado": nuevo_estado}
    return jsonify({
        "pedido": actualizado,
        "estado_pago": nuevo_estado_pago,
        "stock_descontado": stock_descontado,
        "stock_repuesto": stock_repuesto,
    })


@app.post("/api/soporte")
def chat_soporte():
    payload = request.get_json(silent=True) or {}
    historial = payload.get("historial", [])
    if not historial:
        return jsonify({"error": "Historial vacío."}), 400

    mensajes_ia = [{"role": "system", "content": SOPORTE_PROMPT}] + [
        {"role": m.get("role", "user"), "content": str(m.get("content", ""))}
        for m in historial[-10:]
    ]

    try:
        respuesta_ia = llamar_openrouter(mensajes_ia, temperature=0.3, max_tokens=140)
        respuesta_ia = limpiar_respuesta_chat(respuesta_ia, max_lineas=2, quitar_saludo_repetido=True)
        return jsonify({"respuesta": respuesta_ia})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)