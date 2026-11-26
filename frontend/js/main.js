// ==========================================
// CONFIGURACIÓN DEL BACKEND FLASK
// ==========================================
const API_BASE = (() => {
  if (window.API_BASE) return window.API_BASE.replace(/\/$/, "");
  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:5000";
  }
  return `http://${host}:5000`;
})();

const CATALOGO_BASE = [
    {
        nombre: "Bulto Estándar (10 Kg)",
        descripcion: "Ideal para asados caseros.",
        precio: 35000,
        stock: 50,
        oferta: "",
        imagen: "https://images.unsplash.com/photo-1544025162-d76694265947?w=150"
    },
    {
        nombre: "Carbón Premium (Restaurantes)",
        descripcion: "Alta duración y brasa estable.",
        precio: 45000,
        stock: 35,
        oferta: "",
        imagen: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=150"
    },
    {
        nombre: "Carbón Ecológico de Coco",
        descripcion: "Cero humo y eco-amigable.",
        precio: 50000,
        stock: 25,
        oferta: "",
        imagen: "https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=150"
    }
];

let history = [];
let soporteHistory = [];
let productosCache = [];
let comprobantesCache = {};
let busy = false;
let clienteActual = null;
let esAdminActual = false;
let telefonoIngresado = "";
let pasoOnboarding = "INICIAL";

function leerArchivoComoDataURL(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve("");
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function obtenerPrecioBaseGuardado(prod) {
    if (!prod) return null;
    try {
        if (prod.id !== undefined && prod.id !== null) {
            const porId = localStorage.getItem(`carbon_ia_base_precio_id_${prod.id}`);
            if (porId && Number(porId) > 0) return Number(porId);
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            const porNom = localStorage.getItem(`carbon_ia_base_precio_nom_${nombreNorm}`);
            if (porNom && Number(porNom) > 0) return Number(porNom);
        }
    } catch (e) {
        console.warn("No se pudo leer precio base:", e);
    }
    return null;
}

function guardarPrecioBaseLocal(prod, precioBase) {
    if (!prod || !precioBase || Number(precioBase) <= 0) return;
    const valor = String(Math.round(Number(precioBase)));
    try {
        if (prod.id !== undefined && prod.id !== null) {
            localStorage.setItem(`carbon_ia_base_precio_id_${prod.id}`, valor);
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            localStorage.setItem(`carbon_ia_base_precio_nom_${nombreNorm}`, valor);
        }
    } catch (e) {
        console.warn("No se pudo guardar precio base:", e);
    }
}

function limpiarPrecioBaseLocal(prod) {
    if (!prod) return;
    try {
        if (prod.id !== undefined && prod.id !== null) {
            localStorage.removeItem(`carbon_ia_base_precio_id_${prod.id}`);
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            localStorage.removeItem(`carbon_ia_base_precio_nom_${nombreNorm}`);
        }
    } catch (e) {
        console.warn("No se pudo limpiar precio base:", e);
    }
}

function calcularDescuentoPorcentaje(precioBase, porcentaje) {
    const base = Math.max(500, Number(precioBase || 35000));
    const pct = Number(porcentaje || 0);
    if (Number.isNaN(pct) || pct <= 0 || pct >= 100) {
        return base;
    }
    const descontado = base * (1 - pct / 100);
    return Math.max(500, Math.round(descontado / 500) * 500);
}

function extraerPorcentajeDeTexto(textoOferta) {
    const match = String(textoOferta || "").match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (!match) return 0;
    const pct = parseFloat(match[1].replace(",", "."));
    return (!Number.isNaN(pct) && pct > 0 && pct < 100) ? pct : 0;
}

function calcularPrecioConOferta(precioBase, textoOferta, precioManual = 0) {
    const base = Math.max(500, Number(precioBase || 35000));
    const manual = Number(precioManual || 0);
    if (manual > 0) {
        return Math.round(manual / 500) * 500;
    }
    const pct = extraerPorcentajeDeTexto(textoOferta);
    if (pct > 0) {
        return calcularDescuentoPorcentaje(base, pct);
    }
    return base;
}

function obtenerOfertaGuardada(prod) {
    if (!prod) return "";
    try {
        if (prod.id !== undefined && prod.id !== null) {
            const porId = localStorage.getItem(`carbon_ia_oferta_id_${prod.id}`);
            if (porId !== null) return porId;
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            return localStorage.getItem(`carbon_ia_oferta_nom_${nombreNorm}`) || "";
        }
    } catch (e) {
        console.warn("No se pudo leer oferta de localStorage:", e);
    }
    return "";
}

function guardarOfertaLocal(prod, textoOferta) {
    if (!prod) return;
    const valor = String(textoOferta || "").trim();
    try {
        if (prod.id !== undefined && prod.id !== null) {
            localStorage.setItem(`carbon_ia_oferta_id_${prod.id}`, valor);
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            localStorage.setItem(`carbon_ia_oferta_nom_${nombreNorm}`, valor);
        }
    } catch (e) {
        console.warn("No se pudo guardar oferta en localStorage:", e);
    }
}

function resolverOfertaProducto(prod) {
    if (prod && typeof prod.oferta === "string") {
        const ofertaRemota = prod.oferta.trim();
        if (ofertaRemota) {
            guardarOfertaLocal(prod, ofertaRemota);
            return ofertaRemota;
        }
        if (typeof prod.id === "number") {
            guardarOfertaLocal(prod, "");
            return "";
        }
    }
    return obtenerOfertaGuardada(prod) || "";
}

function resolverPrecioBaseProducto(prod) {
    const ofertaActiva = resolverOfertaProducto(prod);
    const precioActual = Math.max(500, Number(prod?.precio || 35000));
    const guardado = obtenerPrecioBaseGuardado(prod);

    if (!ofertaActiva) {
        guardarPrecioBaseLocal(prod, precioActual);
        return precioActual;
    }

    const pct = extraerPorcentajeDeTexto(ofertaActiva);
    if (pct > 0 && pct < 100 && !guardado) {
        const estimado = Math.round((precioActual / (1 - pct / 100)) / 500) * 500;
        const baseEstimado = Math.max(precioActual, estimado);
        guardarPrecioBaseLocal(prod, baseEstimado);
        return baseEstimado;
    }

    return guardado || precioActual;
}

function obtenerImagenGuardada(prod) {
    if (!prod) return "";
    try {
        if (prod.id !== undefined && prod.id !== null) {
            const porId = localStorage.getItem(`carbon_ia_img_id_${prod.id}`);
            if (porId) return porId;
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            return localStorage.getItem(`carbon_ia_img_nom_${nombreNorm}`) || "";
        }
    } catch (e) {
        console.warn("No se pudo leer imagen de localStorage:", e);
    }
    return "";
}

function guardarImagenLocal(prod, dataUrl) {
    if (!dataUrl || !prod) return;
    try {
        if (prod.id !== undefined && prod.id !== null) {
            localStorage.setItem(`carbon_ia_img_id_${prod.id}`, dataUrl);
        }
        const nombreNorm = String(prod.nombre || "").trim().toLowerCase();
        if (nombreNorm) {
            localStorage.setItem(`carbon_ia_img_nom_${nombreNorm}`, dataUrl);
        }
    } catch (e) {
        console.warn("No se pudo guardar imagen en localStorage:", e);
    }
}

function resolverImagenProducto(prod, index = 0) {
    if (prod && typeof prod.imagen === "string" && prod.imagen.trim() !== "") {
        return prod.imagen.trim();
    }
    return (
        obtenerImagenGuardada(prod) ||
        CATALOGO_BASE[index % CATALOGO_BASE.length].imagen
    );
}

function obtenerComprobanteGuardado(pedidoId) {
    if (!pedidoId) return "";
    if (comprobantesCache[pedidoId]) return comprobantesCache[pedidoId];
    try {
        return localStorage.getItem(`carbon_ia_comp_${pedidoId}`) || "";
    } catch (e) {
        return "";
    }
}

function guardarComprobanteLocal(pedidoId, dataUrl) {
    if (!pedidoId || !dataUrl) return;
    comprobantesCache[pedidoId] = dataUrl;
    try {
        localStorage.setItem(`carbon_ia_comp_${pedidoId}`, dataUrl);
    } catch (e) {
        console.warn("No se pudo guardar comprobante en localStorage:", e);
    }
}

function resolverNombreProductoPedido(pedido) {
    if (!pedido) return "Bulto de Carbón Vegetal (10 Kg)";
    if (pedido.producto_nombre) return pedido.producto_nombre;

    if (pedido.producto_id !== undefined && pedido.producto_id !== null && productosCache.length > 0) {
        const porId = productosCache.find(p => String(p.id) === String(pedido.producto_id));
        if (porId && porId.nombre) return porId.nombre;
    }

    const cant = Number(pedido.cantidad_bultos || 0);
    const total = Number(pedido.total || 0);
    if (cant > 0 && total > 0 && productosCache.length > 0) {
        const unit = Math.round(total / cant);
        const porPrecio = productosCache.find(p => Number(p.precio) === unit);
        if (porPrecio && porPrecio.nombre) return porPrecio.nombre;
    }

    return productosCache[0]?.nombre || "Bulto de Carbón Vegetal (10 Kg)";
}

function construirMapaPreciosVigentes() {
    const mapa = {};
    productosCache.forEach(p => {
        const precioNum = Number(p.precio || 35000);
        if (p.id !== undefined && p.id !== null) {
            mapa[String(p.id)] = precioNum;
        }
        if (p.nombre) {
            mapa[String(p.nombre).trim().toLowerCase()] = precioNum;
        }
    });
    return mapa;
}

function pedirProductoDesdeCatalogo(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const input = document.getElementById("chat-input");
    if (!input) return;

    input.value = `Quiero 2 bultos de ${prod.nombre}`;
    input.focus();
}

function marcarFeedbackBoton(btnEl, textoExito = "Guardado ✓") {
    if (!btnEl) return;
    const textoOriginal = btnEl.dataset.originalText || btnEl.innerText;
    btnEl.dataset.originalText = textoOriginal;
    btnEl.innerText = textoExito;
    btnEl.style.opacity = "0.9";
    setTimeout(() => {
        if (btnEl && btnEl.isConnected) {
            btnEl.innerText = textoOriginal;
            btnEl.style.opacity = "1";
        }
    }, 1500);
}

function limpiarChatVisualYMemoria(telefono = "") {
    history = [];
    const chatBox = document.getElementById("chat-box");
    if (chatBox) {
        chatBox.innerHTML = "";
    }
    if (telefono) {
        try {
            localStorage.removeItem(`chat_${telefono}`);
            localStorage.removeItem(`history_${telefono}`);
        } catch (e) {
            console.warn("No se pudo limpiar localStorage:", e);
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const authForm = document.getElementById("auth-form");
    const statusDiv = document.getElementById("auth-status");

    if (authForm) {
        authForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            telefonoIngresado = document.getElementById("auth-telefono").value.trim();
            if (!telefonoIngresado) return;

            statusDiv.innerText = "Verificando teléfono a través de Flask...";

            try {
                const resp = await fetch(`${API_BASE}/api/clientes/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ telefono: telefonoIngresado })
                });

                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || "Error al verificar teléfono.");

                esAdminActual = Boolean(data.es_admin);

                if (data.existe && data.cliente) {
                    clienteActual = data.cliente;
                    pasoOnboarding = "COMPLETO";
                } else {
                    clienteActual = { telefono: telefonoIngresado, nombre: "", direccion_habitual: "" };
                    pasoOnboarding = "ESPERANDO_NOMBRE";
                }
                statusDiv.innerText = "";
                iniciarDashboard(clienteActual);
            } catch (err) {
                statusDiv.innerText = "Error al conectar con Flask. Verifica que el servidor esté activo.";
                console.error("Detalle del error:", err);
            }
        });
    }

    document.querySelectorAll(".btn-cerrar-sesion").forEach(btn => {
        btn.addEventListener("click", cerrarSesion);
    });

    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(item => {
        item.addEventListener("click", async (e) => {
            e.preventDefault();
            const parentMenu = item.closest(".nav-menu");
            if (parentMenu) {
                parentMenu.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            }
            item.classList.add("active");

            const targetId = item.getAttribute("data-target");
            mostrarVista(targetId);

            if (targetId === "vista-admin-pedidos" && esAdminActual) {
                await cargarPedidosAdmin();
            } else if ((targetId === "vista-admin-stock" || targetId === "vista-admin-ofertas") && esAdminActual) {
                await cargarProductos();
            } else if (targetId === "vista-portal" && !esAdminActual) {
                await cargarProductos();
            }
        });
    });

    const btnRefrescarAdmin = document.getElementById("btn-refrescar-admin");
    if (btnRefrescarAdmin) {
        btnRefrescarAdmin.addEventListener("click", async () => {
            await cargarPedidosAdmin();
        });
    }

    const btnCargarBase = document.getElementById("btn-cargar-base");
    if (btnCargarBase) {
        btnCargarBase.addEventListener("click", async () => {
            const nombresExistentes = new Set(productosCache.map(p => (p.nombre || "").toLowerCase()));
            for (const base of CATALOGO_BASE) {
                if (!nombresExistentes.has(base.nombre.toLowerCase())) {
                    await fetch(`${API_BASE}/api/admin/productos`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(base)
                    });
                }
            }
            await cargarProductos();
        });
    }

    const prodFotoInput = document.getElementById("prod-foto-file");
    const prodFotoPreview = document.getElementById("prod-foto-preview");
    if (prodFotoInput && prodFotoPreview) {
        prodFotoInput.addEventListener("change", async () => {
            const archivo = prodFotoInput.files && prodFotoInput.files[0];
            if (archivo) {
                const dataUrl = await leerArchivoComoDataURL(archivo);
                if (dataUrl) prodFotoPreview.src = dataUrl;
            }
        });
    }

    const formNuevoProducto = document.getElementById("form-nuevo-producto");
    if (formNuevoProducto) {
        formNuevoProducto.addEventListener("submit", async (e) => {
            e.preventDefault();
            const nombre = document.getElementById("prod-nombre").value.trim();
            const precio = Number(document.getElementById("prod-precio").value);
            const stock = Number(document.getElementById("prod-stock").value);
            const descripcion = document.getElementById("prod-desc").value.trim() || "Carbón vegetal natural.";
            const fotoFile = document.getElementById("prod-foto-file").files[0];

            if (!nombre || precio <= 0) return;

            const imagen = fotoFile ? await leerArchivoComoDataURL(fotoFile) : "";

            try {
                const resp = await fetch(`${API_BASE}/api/admin/productos`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ nombre, precio, precio_bulto: precio, stock, descripcion, imagen })
                });
                const data = await resp.json();
                if (!resp.ok) {
                    const detalle = data.detalle_supabase ? `\nDetalle: ${data.detalle_supabase}` : "";
                    alert(`${data.error || "No se pudo guardar el nuevo tipo de carbón."}${detalle}`);
                    return;
                }

                const creado = data.producto || { nombre, precio, precio_bulto: precio, stock, descripcion, imagen };
                guardarPrecioBaseLocal(creado, precio);
                guardarPrecioBaseLocal({ nombre }, precio);
                if (imagen) {
                    guardarImagenLocal(creado, imagen);
                    guardarImagenLocal({ nombre }, imagen);
                }

                formNuevoProducto.reset();
                document.getElementById("prod-stock").value = "30";
                if (prodFotoPreview) {
                    prodFotoPreview.src = CATALOGO_BASE[0].imagen;
                }
                await cargarProductos();
            } catch (err) {
                console.error("Error creando producto:", err);
            }
        });
    }

    const formNuevaOferta = document.getElementById("form-nueva-oferta");
    if (formNuevaOferta) {
        formNuevaOferta.addEventListener("submit", async (e) => {
            e.preventDefault();
            const selectEl = document.getElementById("oferta-producto-select");
            const index = Number(selectEl.value);
            const prod = productosCache[index];
            if (!prod) return;

            const etiquetaBase = document.getElementById("oferta-texto").value.trim();
            const porcentajeInput = document.getElementById("oferta-porcentaje");
            const porcentaje = porcentajeInput ? Number(porcentajeInput.value) : 0;
            const btnAplicar = document.getElementById("btn-aplicar-oferta");

            if (!etiquetaBase) return;

            const precioBase = resolverPrecioBaseProducto(prod);
            guardarPrecioBaseLocal(prod, precioBase);

            const precioFinal = porcentaje > 0
                ? calcularDescuentoPorcentaje(precioBase, porcentaje)
                : calcularPrecioConOferta(precioBase, etiquetaBase, 0);

            const etiquetaFinal = porcentaje > 0 && !etiquetaBase.includes("%")
                ? `${etiquetaBase} (${porcentaje}% OFF)`
                : etiquetaBase;

            prod.precio = precioFinal;
            prod.oferta = etiquetaFinal;
            guardarOfertaLocal(prod, etiquetaFinal);

            await persistirProducto(prod, index, {
                precio: precioFinal,
                oferta: etiquetaFinal
            });

            document.getElementById("oferta-texto").value = "";
            if (porcentajeInput) porcentajeInput.value = "";
            await cargarProductos();
            marcarFeedbackBoton(btnAplicar, "Aplicada ✓");
        });
    }

    const chatFileInput = document.getElementById("chat-file");
    const fileIndicator = document.getElementById("file-indicator");
    const fileNameText = document.getElementById("file-name-text");

    if (chatFileInput) {
        chatFileInput.addEventListener("change", () => {
            if (chatFileInput.files && chatFileInput.files[0]) {
                const archivo = chatFileInput.files[0];
                fileNameText.innerText = `Archivo listo para enviar: ${archivo.name}`;
                fileIndicator.style.display = "flex";
            } else {
                fileIndicator.style.display = "none";
            }
        });
    }

    const chatForm = document.getElementById("chat-form");
    if (chatForm) {
        chatForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (busy) return;

            const input = document.getElementById("chat-input");
            const mensajeTexto = input.value.trim();
            const archivoAdjunto = chatFileInput.files[0];

            if (!mensajeTexto && !archivoAdjunto) return;

            if (archivoAdjunto) {
                const nombreArchivo = archivoAdjunto.name;
                const esImagen = archivoAdjunto.type.startsWith("image/");
                const dataUrl = esImagen ? await leerArchivoComoDataURL(archivoAdjunto) : "";

                agregarMensajeUsuario(`📎 Comprobante adjuntado: ${nombreArchivo}`);
                chatFileInput.value = "";
                fileIndicator.style.display = "none";

                await validarPagoViaFlask(nombreArchivo, dataUrl);
                return;
            }

            agregarMensajeUsuario(mensajeTexto);
            input.value = "";

            if (pasoOnboarding === "ESPERANDO_NOMBRE") {
                clienteActual.nombre = mensajeTexto;
                pasoOnboarding = "ESPERANDO_DIRECCION";
                agregarMensajeAgente(`Mucho gusto, ${clienteActual.nombre}. ¿Cuál es tu dirección de entrega aquí en Bucaramanga? 📍`);
                return;
            }

            if (pasoOnboarding === "ESPERANDO_DIRECCION") {
                clienteActual.direccion_habitual = mensajeTexto;
                pasoOnboarding = "COMPLETO";

                try {
                    const resp = await fetch(`${API_BASE}/api/clientes`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            telefono: clienteActual.telefono,
                            nombre: clienteActual.nombre,
                            direccion_habitual: clienteActual.direccion_habitual
                        })
                    });
                    const data = await resp.json();
                    if (resp.ok && data.cliente) clienteActual = data.cliente;
                } catch (err) {
                    console.error("Error al registrar cliente:", err);
                }

                actualizarTarjetaPerfil(clienteActual);
                document.getElementById("welcome-user-title").innerText = `¡Hola, ${clienteActual.nombre}! 👋`;
                const saludoInicial = `¡Listo, ${clienteActual.nombre}! Tus datos quedaron guardados. ¿Qué tipo de carbón del catálogo te gustaría pedir y cuántos bultos necesitas? 🔥`;
                history.push({ role: "assistant", content: saludoInicial });
                agregarMensajeAgente(saludoInicial);
                guardarHistorialLocal();
                await cargarPedidosSupabase();
                return;
            }

            history.push({ role: "user", content: mensajeTexto });
            guardarHistorialLocal();
            await enviarMensajeChatFlask(mensajeTexto);
        });
    }

    const soporteForm = document.getElementById("soporte-form");
    if (soporteForm) {
        soporteForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const input = document.getElementById("soporte-input");
            const texto = input.value.trim();
            if (!texto) return;

            const box = document.getElementById("soporte-chat-box");
            box.innerHTML += `<div class="msg user">${texto}</div>`;
            input.value = "";
            box.scrollTop = box.scrollHeight;

            soporteHistory.push({ role: "user", content: texto });
            const typingId = mostrarIndicadorEscribiendo("soporte-chat-box");

            try {
                const resp = await fetch(`${API_BASE}/api/soporte`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ historial: soporteHistory })
                });
                const data = await resp.json();
                removerIndicadorEscribiendo(typingId);

                if (!resp.ok) throw new Error(data.error || "Error en soporte.");

                const respuestaSoporte = data.respuesta || "¡Entendido!";
                box.innerHTML += `<div class="msg bot">${respuestaSoporte}</div>`;
                box.scrollTop = box.scrollHeight;
                soporteHistory.push({ role: "assistant", content: respuestaSoporte });
            } catch (err) {
                removerIndicadorEscribiendo(typingId);
                box.innerHTML += `<div class="msg bot">Lo siento, hubo un error de conexión en soporte.</div>`;
            }
        });
    }
});

function cerrarSesion() {
    const telPrevio = clienteActual?.telefono || "";
    limpiarChatVisualYMemoria(pasoOnboarding !== "COMPLETO" ? telPrevio : "");
    soporteHistory = [];
    busy = false;
    clienteActual = null;
    esAdminActual = false;
    telefonoIngresado = "";
    pasoOnboarding = "INICIAL";

    const authInput = document.getElementById("auth-telefono");
    if (authInput) authInput.value = "";
    const statusDiv = document.getElementById("auth-status");
    if (statusDiv) statusDiv.innerText = "";

    document.getElementById("app-dashboard").style.display = "none";
    document.getElementById("auth-screen").style.display = "flex";
}

function mostrarVista(targetId) {
    document.querySelectorAll(".vista-contenido").forEach(vista => {
        vista.style.display = "none";
    });
    const vistaActiva = document.getElementById(targetId);
    if (vistaActiva) vistaActiva.style.display = "block";
}

function configurarModoPorRol() {
    const menuCliente = document.getElementById("menu-cliente");
    const menuAdmin = document.getElementById("menu-admin");

    if (esAdminActual) {
        if (menuCliente) menuCliente.style.display = "none";
        if (menuAdmin) {
            menuAdmin.style.display = "flex";
            menuAdmin.querySelectorAll(".nav-item").forEach((n, idx) => {
                n.classList.toggle("active", idx === 0);
            });
        }
        mostrarVista("vista-admin-pedidos");
    } else {
        if (menuAdmin) menuAdmin.style.display = "none";
        if (menuCliente) {
            menuCliente.style.display = "flex";
            menuCliente.querySelectorAll(".nav-item").forEach((n, idx) => {
                n.classList.toggle("active", idx === 0);
            });
        }
        mostrarVista("vista-portal");
    }
}

async function iniciarDashboard(cliente) {
    document.getElementById("auth-screen").style.display = "none";
    document.getElementById("app-dashboard").style.display = "flex";
    configurarModoPorRol();

    if (esAdminActual) {
        const nombreAdmin = cliente.nombre || "Administrador";
        document.getElementById("admin-welcome-title").innerText = `Panel de Administración — ${nombreAdmin}`;
        await cargarPedidosAdmin();
        await cargarProductos();
        return;
    }

    limpiarChatVisualYMemoria(pasoOnboarding !== "COMPLETO" ? cliente.telefono : "");
    actualizarTarjetaPerfil(cliente);
    await cargarProductos();

    if (pasoOnboarding === "COMPLETO") {
        cargarHistorialLocal();
        document.getElementById("welcome-user-title").innerText = `¡Hola, ${cliente.nombre}! 👋`;
        const chatBox = document.getElementById("chat-box");
        if (history.length === 0 && (!chatBox || chatBox.children.length === 0)) {
            agregarMensajeAgente(
                `¡Hola ${cliente.nombre}! Qué gusto saludarte. ` +
                `¿Qué tipo de carbón del catálogo deseas hoy y cuántos bultos te enviamos? 🔥`
            );
        }
        await cargarPedidosSupabase();
    } else {
        document.getElementById("welcome-user-title").innerText = `¡Hola, bienvenido! 👋`;
        agregarMensajeAgente(`¡Hola! Qué gusto saludarte. Para comenzar, ¿me regalas tu nombre completo? 😊`);
    }
}

async function persistirProducto(prod, index, cambios) {
    const precioVal = cambios.precio !== undefined ? cambios.precio : Number(prod.precio || 35000);
    const imagenVal = cambios.imagen !== undefined ? cambios.imagen : resolverImagenProducto(prod, index);
    const nombreVal = cambios.nombre !== undefined ? cambios.nombre : prod.nombre;
    const ofertaVal = cambios.oferta !== undefined ? cambios.oferta : resolverOfertaProducto(prod);

    const payload = {
        nombre: nombreVal,
        descripcion: cambios.descripcion !== undefined ? cambios.descripcion : (prod.descripcion || "Carbón vegetal natural."),
        precio: precioVal,
        precio_bulto: precioVal,
        stock: cambios.stock !== undefined ? cambios.stock : Number(prod.stock || 0),
        oferta: ofertaVal,
        imagen: imagenVal
    };

    if (!ofertaVal) {
        guardarPrecioBaseLocal(prod, precioVal);
        guardarPrecioBaseLocal({ nombre: nombreVal }, precioVal);
    }

    if (imagenVal) {
        guardarImagenLocal(prod, imagenVal);
        guardarImagenLocal({ nombre: nombreVal }, imagenVal);
    }
    guardarOfertaLocal(prod, ofertaVal);
    guardarOfertaLocal({ nombre: nombreVal }, ofertaVal);

    if (typeof prod.id === "number") {
        const resp = await fetch(`${API_BASE}/api/admin/productos/${prod.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            if (data.producto) {
                if (imagenVal) guardarImagenLocal(data.producto, imagenVal);
                guardarOfertaLocal(data.producto, ofertaVal);
                if (!ofertaVal) guardarPrecioBaseLocal(data.producto, precioVal);
            }
        }
    } else {
        const resp = await fetch(`${API_BASE}/api/admin/productos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            if (data.producto) {
                if (imagenVal) guardarImagenLocal(data.producto, imagenVal);
                guardarOfertaLocal(data.producto, ofertaVal);
                if (!ofertaVal) guardarPrecioBaseLocal(data.producto, precioVal);
            }
        }
    }
}

async function cargarProductos() {
    try {
        const resp = await fetch(`${API_BASE}/api/productos`);
        const data = await resp.json();
        const remotos = resp.ok && Array.isArray(data.productos) ? data.productos : [];
        const baseLista = remotos.length > 0
            ? remotos
            : CATALOGO_BASE.map((item, idx) => ({ ...item, id: `base-${idx}` }));

        productosCache = baseLista.map(prod => {
            const ofertaResuelta = resolverOfertaProducto(prod);
            const prodConOferta = { ...prod, oferta: ofertaResuelta };
            resolverPrecioBaseProducto(prodConOferta);
            return prodConOferta;
        });
    } catch (err) {
        productosCache = CATALOGO_BASE.map((item, idx) => ({
            ...item,
            id: `base-${idx}`,
            oferta: resolverOfertaProducto(item)
        }));
    }

    renderCatalogoCliente();
    renderTablaAdminStock();
    renderTablaAdminOfertas();
}

function renderCatalogoCliente() {
    const contenedor = document.getElementById("catalogo-dinamico");
    if (!contenedor) return;

    contenedor.innerHTML = "";
    productosCache.forEach((prod, idx) => {
        const imgSrc = resolverImagenProducto(prod, idx);
        const ofertaTexto = resolverOfertaProducto(prod);
        const precioBase = resolverPrecioBaseProducto(prod);
        const precioActual = Number(prod.precio);
        const tieneDescuento = ofertaTexto && precioActual < precioBase;

        const badgeOferta = ofertaTexto
            ? `<span style="display:inline-block; background:#ea580c; color:#fff; font-size:0.7rem; font-weight:bold; padding:2px 8px; border-radius:999px; margin-left:6px;">${ofertaTexto}</span>`
            : "";
        const stockTexto = `Stock: ${prod.stock ?? 0} und.`;
        const precioHtml = tieneDescuento
            ? `<span style="color:#94a3b8; text-decoration:line-through; font-size:0.75rem; margin-right:6px;">$${precioBase.toLocaleString("es-CO")}</span><span style="color: var(--green); font-weight: bold; font-size: 0.9rem;">$${precioActual.toLocaleString("es-CO")} COP</span>`
            : `<span style="color: var(--green); font-weight: bold; font-size: 0.9rem;">$${precioActual.toLocaleString("es-CO")} COP</span>`;

        const card = document.createElement("div");
        card.style.cssText = "display: flex; gap: 12px; background: #0f172a; padding: 12px; border-radius: 8px; border: 1px solid #334155; align-items: center;";
        card.innerHTML = `
            <img src="${imgSrc}" alt="${prod.nombre}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;">
            <div style="flex: 1;">
                <h4 style="color: #fff; font-size: 0.95rem;">${prod.nombre}${badgeOferta}</h4>
                <p style="color: var(--text-muted); font-size: 0.75rem;">${prod.descripcion || "Carbón vegetal natural."}</p>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; gap: 8px; flex-wrap: wrap;">
                    <div>${precioHtml}</div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="color: #94a3b8; font-size: 0.75rem;">${stockTexto}</span>
                        <button type="button" onclick="pedirProductoDesdeCatalogo(${idx})" style="padding: 4px 8px; background: #ea580c; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 0.72rem; font-weight: bold;">Pedir en Chat</button>
                    </div>
                </div>
            </div>
        `;
        contenedor.appendChild(card);
    });
}

function renderTablaAdminStock() {
    const tbody = document.getElementById("tabla-admin-stock");
    if (!tbody) return;

    tbody.innerHTML = "";
    productosCache.forEach((prod, index) => {
        const imgSrc = resolverImagenProducto(prod, index);
        const ofertaTexto = resolverOfertaProducto(prod);
        const precioBase = resolverPrecioBaseProducto(prod);
        const precioInputVal = ofertaTexto ? precioBase : Number(prod.precio);

        const fila = document.createElement("tr");
        fila.innerHTML = `
            <td>
                <div style="display:flex; align-items:center; gap:8px;">
                    <img id="row-img-${index}" src="${imgSrc}" alt="${prod.nombre}" style="width:38px; height:38px; object-fit:cover; border-radius:6px;">
                    <input type="text" id="stock-nombre-${index}" value="${prod.nombre}" style="width: 155px; padding: 6px 8px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; font-weight: 600;">
                </div>
            </td>
            <td>
                <input type="text" id="stock-desc-${index}" value="${prod.descripcion || ""}" placeholder="Descripción" style="width: 150px; padding: 6px 8px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #cbd5e1; font-size: 0.8rem;">
            </td>
            <td>
                <input type="number" id="stock-precio-${index}" value="${precioInputVal}" min="1000" step="500" style="width: 100px; padding: 6px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff;">
            </td>
            <td>
                <strong id="stock-actual-${index}">${prod.stock ?? 0}</strong>
            </td>
            <td>
                <div style="display:flex; gap:4px; align-items:center;">
                    <input type="number" id="sumar-stock-${index}" value="10" min="1" style="width: 60px; padding: 6px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff;">
                    <button type="button" onclick="llenarStockFila(${index})" style="padding: 6px 8px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">+ Stock</button>
                </div>
            </td>
            <td>
                <input type="file" id="stock-foto-${index}" accept="image/*" onchange="previsualizarFotoFila(event, ${index})" style="width: 135px; font-size: 0.72rem; color: #cbd5e1;">
            </td>
            <td>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button type="button" id="btn-guardar-stock-${index}" onclick="guardarCambiosStock(${index})" style="padding: 6px 11px; background: #16a34a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Guardar</button>
                    <button type="button" onclick="eliminarProductoFila(${index})" style="padding: 6px 9px; background: #dc2626; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Eliminar</button>
                </div>
            </td>
        `;
        tbody.appendChild(fila);
    });
}

async function previsualizarFotoFila(event, index) {
    const archivo = event.target && event.target.files && event.target.files[0];
    if (!archivo) return;
    const dataUrl = await leerArchivoComoDataURL(archivo);
    const imgEl = document.getElementById(`row-img-${index}`);
    if (dataUrl && imgEl) {
        imgEl.src = dataUrl;
    }
}

async function eliminarProductoFila(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const nombreActual = document.getElementById(`stock-nombre-${index}`)?.value.trim() || prod.nombre;
    const confirmar = confirm(`¿Seguro que deseas eliminar "${nombreActual}"?`);
    if (!confirmar) return;

    if (typeof prod.id === "number") {
        try {
            const resp = await fetch(`${API_BASE}/api/admin/productos/${prod.id}`, {
                method: "DELETE"
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                alert(data.error || "No se pudo eliminar el producto en Supabase.");
                return;
            }
        } catch (err) {
            console.error("Error eliminando producto:", err);
            alert("Error de conexión al eliminar el producto.");
            return;
        }
    } else {
        productosCache.splice(index, 1);
        renderCatalogoCliente();
        renderTablaAdminStock();
        renderTablaAdminOfertas();
        return;
    }

    limpiarPrecioBaseLocal(prod);
    await cargarProductos();
}

function renderTablaAdminOfertas() {
    const selectEl = document.getElementById("oferta-producto-select");
    const tbody = document.getElementById("tabla-admin-ofertas");

    if (selectEl) {
        selectEl.innerHTML = "";
        productosCache.forEach((prod, index) => {
            const opt = document.createElement("option");
            opt.value = index;
            opt.textContent = prod.nombre;
            selectEl.appendChild(opt);
        });
    }

    if (!tbody) return;
    tbody.innerHTML = "";

    productosCache.forEach((prod, index) => {
        const ofertaTexto = resolverOfertaProducto(prod);
        const fila = document.createElement("tr");
        fila.innerHTML = `
            <td><strong>${prod.nombre}</strong></td>
            <td>$${Number(prod.precio).toLocaleString("es-CO")} COP</td>
            <td>
                ${ofertaTexto
                    ? `<span style="background:#ea580c; color:#fff; padding:3px 9px; border-radius:999px; font-size:0.75rem; font-weight:bold;">${ofertaTexto}</span>`
                    : `<span style="color:#94a3b8; font-size:0.8rem;">Sin oferta</span>`}
            </td>
            <td>
                <input type="text" id="oferta-edit-${index}" value="${ofertaTexto}" placeholder="Ej: 15% OFF" style="width: 150px; padding: 6px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff;">
            </td>
            <td style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" id="btn-guardar-oferta-${index}" onclick="guardarOfertaFila(${index})" style="padding: 6px 10px; background: #16a34a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Guardar</button>
                <button type="button" onclick="quitarOfertaFila(${index})" style="padding: 6px 10px; background: #dc2626; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Quitar</button>
            </td>
        `;
        tbody.appendChild(fila);
    });
}

async function llenarStockFila(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const sumar = Math.max(1, Number(document.getElementById(`sumar-stock-${index}`).value || 10));
    const nuevoStock = Number(prod.stock || 0) + sumar;
    prod.stock = nuevoStock;
    document.getElementById(`stock-actual-${index}`).innerText = nuevoStock;

    await persistirProducto(prod, index, { stock: nuevoStock });
    await cargarProductos();
}

async function guardarCambiosStock(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const nombreInput = document.getElementById(`stock-nombre-${index}`);
    const descInput = document.getElementById(`stock-desc-${index}`);
    const btnGuardar = document.getElementById(`btn-guardar-stock-${index}`);

    const nuevoNombre = (nombreInput ? nombreInput.value.trim() : "") || prod.nombre;
    const nuevaDesc = descInput ? descInput.value.trim() : (prod.descripcion || "Carbón vegetal natural.");
    const precioIngresado = Math.max(1000, Number(document.getElementById(`stock-precio-${index}`).value || prod.precio));
    const fotoInput = document.getElementById(`stock-foto-${index}`);
    const nuevaFotoFile = fotoInput && fotoInput.files ? fotoInput.files[0] : null;
    const imagenFinal = nuevaFotoFile
        ? await leerArchivoComoDataURL(nuevaFotoFile)
        : resolverImagenProducto(prod, index);

    const ofertaActiva = resolverOfertaProducto(prod);
    const pctOferta = extraerPorcentajeDeTexto(ofertaActiva);

    let precioAGuardar = precioIngresado;
    if (!ofertaActiva) {
        guardarPrecioBaseLocal(prod, precioIngresado);
        guardarPrecioBaseLocal({ nombre: nuevoNombre }, precioIngresado);
    } else if (pctOferta > 0 && pctOferta < 100) {
        guardarPrecioBaseLocal(prod, precioIngresado);
        guardarPrecioBaseLocal({ nombre: nuevoNombre }, precioIngresado);
        precioAGuardar = calcularDescuentoPorcentaje(precioIngresado, pctOferta);
    }

    await persistirProducto(prod, index, {
        nombre: nuevoNombre,
        descripcion: nuevaDesc,
        precio: precioAGuardar,
        stock: Number(prod.stock || 0),
        imagen: imagenFinal
    });
    await cargarProductos();
    marcarFeedbackBoton(document.getElementById(`btn-guardar-stock-${index}`) || btnGuardar, "Guardado ✓");
}

async function guardarOfertaFila(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const btnGuardarOferta = document.getElementById(`btn-guardar-oferta-${index}`);
    const nuevaOferta = document.getElementById(`oferta-edit-${index}`).value.trim();

    if (!nuevaOferta) {
        await quitarOfertaFila(index);
        return;
    }

    const precioBase = resolverPrecioBaseProducto(prod);
    guardarPrecioBaseLocal(prod, precioBase);

    const precioCalculado = calcularPrecioConOferta(precioBase, nuevaOferta, 0);
    prod.precio = precioCalculado;
    prod.oferta = nuevaOferta;
    guardarOfertaLocal(prod, nuevaOferta);

    await persistirProducto(prod, index, {
        precio: precioCalculado,
        oferta: nuevaOferta
    });
    await cargarProductos();
    marcarFeedbackBoton(document.getElementById(`btn-guardar-oferta-${index}`) || btnGuardarOferta, "Guardado ✓");
}

async function quitarOfertaFila(index) {
    const prod = productosCache[index];
    if (!prod) return;

    const precioBase = resolverPrecioBaseProducto(prod);
    prod.precio = precioBase;
    prod.oferta = "";
    guardarOfertaLocal(prod, "");
    guardarPrecioBaseLocal(prod, precioBase);

    await persistirProducto(prod, index, {
        precio: precioBase,
        oferta: ""
    });
    await cargarProductos();
}

function actualizarTarjetaPerfil(cliente) {
    document.getElementById("perfil-nombre").innerText = cliente.nombre || "Registrando...";
    document.getElementById("perfil-telefono").innerText = cliente.telefono || "-";
    document.getElementById("perfil-direccion").innerText = cliente.direccion_habitual || "Bucaramanga";
}

function agregarMensajeUsuario(texto) {
    const chatBox = document.getElementById("chat-box");
    if (chatBox) {
        const div = document.createElement("div");
        div.className = "msg user";
        div.innerText = texto;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
    if (pasoOnboarding === "COMPLETO") {
        guardarHistorialLocal();
    }
}

function agregarMensajeAgente(texto) {
    const chatBox = document.getElementById("chat-box");
    if (chatBox) {
        const div = document.createElement("div");
        div.className = "msg bot";
        div.innerText = texto;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
    if (pasoOnboarding === "COMPLETO") {
        guardarHistorialLocal();
    }
}

function mostrarIndicadorEscribiendo(containerId) {
    const chatBox = document.getElementById(containerId);
    const id = "typing-" + Date.now();
    if (chatBox) {
        const div = document.createElement("div");
        div.id = id;
        div.className = "msg bot";
        div.innerHTML = `<span style="display:inline-flex; gap:4px; align-items:center;">Escribiendo<span style="animation: blink 1s infinite">.</span><span style="animation: blink 1s infinite 0.2s">.</span><span style="animation: blink 1s infinite 0.4s">.</span></span>`;
        chatBox.appendChild(div);
        chatBox.scrollTop = chatBox.scrollHeight;
    }
    return id;
}

function removerIndicadorEscribiendo(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function guardarHistorialLocal() {
    if (pasoOnboarding === "COMPLETO" && clienteActual && clienteActual.telefono) {
        const chatBox = document.getElementById("chat-box");
        if (chatBox) {
            localStorage.setItem(`chat_${clienteActual.telefono}`, chatBox.innerHTML);
        }
        localStorage.setItem(`history_${clienteActual.telefono}`, JSON.stringify(history));
    }
}

function cargarHistorialLocal() {
    if (pasoOnboarding !== "COMPLETO" || !clienteActual || !clienteActual.telefono) {
        return;
    }
    const chatBox = document.getElementById("chat-box");
    const savedHtml = localStorage.getItem(`chat_${clienteActual.telefono}`);
    const savedHistory = localStorage.getItem(`history_${clienteActual.telefono}`);
    if (savedHtml && chatBox) {
        chatBox.innerHTML = savedHtml;
        chatBox.scrollTop = chatBox.scrollHeight;
    }
    if (savedHistory) {
        try {
            history = JSON.parse(savedHistory);
        } catch (e) {
            history = [];
        }
    }
}

async function enviarMensajeChatFlask(mensaje) {
    busy = true;
    const typingId = mostrarIndicadorEscribiendo("chat-box");

    try {
        const resp = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mensaje,
                historial: history,
                cliente: clienteActual,
                precios_vigentes: construirMapaPreciosVigentes()
            })
        });

        const data = await resp.json().catch(() => ({}));
        removerIndicadorEscribiendo(typingId);

        if (!resp.ok) throw new Error(data.error || "Error al conectar con Flask.");

        const respuestaIA = data.respuesta || "¡Entendido!";
        history.push({ role: "assistant", content: respuestaIA });
        agregarMensajeAgente(respuestaIA);
        guardarHistorialLocal();

        if (data.pedido_creado || data.pedido_cancelado) {
            await cargarPedidosSupabase();
        }
    } catch (error) {
        removerIndicadorEscribiendo(typingId);
        agregarMensajeAgente("Lo siento, hubo un problema de conexión con el servidor Flask.");
    } finally {
        busy = false;
    }
}

async function validarPagoViaFlask(nombreArchivo, comprobanteData = "") {
    busy = true;
    const typingId = mostrarIndicadorEscribiendo("chat-box");

    try {
        const resp = await fetch(`${API_BASE}/api/validar-pago`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cliente_id: clienteActual?.id,
                nombre_archivo: nombreArchivo,
                comprobante_data: comprobanteData
            })
        });

        const data = await resp.json().catch(() => ({}));
        removerIndicadorEscribiendo(typingId);

        if (!resp.ok) throw new Error(data.error || "Error al validar pago.");

        if (data.pedido_id && comprobanteData) {
            guardarComprobanteLocal(data.pedido_id, comprobanteData);
        }

        const respPago = data.respuesta || "";
        if (respPago) {
            history.push({ role: "assistant", content: respPago });
            agregarMensajeAgente(respPago);
            guardarHistorialLocal();
        }
        await cargarPedidosSupabase();
    } catch (error) {
        removerIndicadorEscribiendo(typingId);
        agregarMensajeAgente("Lo siento, ocurrió un error al procesar el archivo adjunto.");
    } finally {
        busy = false;
    }
}

function formatearEstadoPagoEtiqueta(estadoPago) {
    const est = String(estadoPago || "SIN_COMPROBANTE").toUpperCase();
    if (est === "EN_REVISION") {
        return `<div style="font-size:0.72rem; color:#38bdf8; margin-top:3px;">Pago: EN_REVISION</div>`;
    }
    if (est === "APROBADO") {
        return `<div style="font-size:0.72rem; color:#22c55e; margin-top:3px;">Pago: APROBADO</div>`;
    }
    if (est === "RECHAZADO") {
        return `<div style="font-size:0.72rem; color:#ef4444; margin-top:3px;">Pago: RECHAZADO</div>`;
    }
    return `<div style="font-size:0.72rem; color:#94a3b8; margin-top:3px;">Pago: PENDIENTE</div>`;
}

function resolverEstadoRecibo(estadoPedido, estadoPago) {
    const estPed = String(estadoPedido || "").toUpperCase();
    const estPag = String(estadoPago || "").toUpperCase();

    if (estPed === "CONFIRMADO" || estPed === "ENTREGADO" || estPag === "APROBADO") {
        return {
            texto: "ESTADO: PAGO CONFIRMADO ✅",
            color: "#22c55e"
        };
    }
    if (estPed === "RECHAZADO" || estPag === "RECHAZADO") {
        return {
            texto: "ESTADO: PAGO RECHAZADO ❌",
            color: "#ef4444"
        };
    }
    return {
        texto: "ESTADO: PAGO EN REVISIÓN ⏳",
        color: "#0284c7"
    };
}

async function cargarPedidosSupabase() {
    if (!clienteActual || !clienteActual.id) return;

    try {
        const resp = await fetch(`${API_BASE}/api/pedidos?cliente_id=${encodeURIComponent(clienteActual.id)}`);
        const data = await resp.json();
        if (!resp.ok) return;

        const todosPedidos = data.pedidos || [];

        const tbodyActual = document.getElementById("tabla-pedido-actual");
        if (tbodyActual) {
            tbodyActual.innerHTML = "";
            if (todosPedidos.length > 0) {
                const p = todosPedidos[0];
                const nombreProdP = resolverNombreProductoPedido(p);
                let botonRecibo = p.estado_pago === "EN_REVISION"
                    ? `<span style="color: #38bdf8; font-size: 0.78rem; font-weight: 600;">En revisión</span>`
                    : `<span style="color: var(--text-muted); font-size: 0.8rem;">Pendiente de pago</span>`;
                if (p.estado === "CONFIRMADO" || p.estado === "ENTREGADO") {
                    const prodSafe = encodeURIComponent(nombreProdP);
                    const estPedSafe = encodeURIComponent(p.estado || "PENDIENTE");
                    const estPagSafe = encodeURIComponent(p.estado_pago || "SIN_COMPROBANTE");
                    botonRecibo = `<button onclick="generarReciboPDF(${p.id}, ${p.cantidad_bultos}, ${p.total}, decodeURIComponent('${prodSafe}'), decodeURIComponent('${estPedSafe}'), decodeURIComponent('${estPagSafe}'))" style="padding: 6px 12px; background: #ea580c; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-weight: bold;"><i class="ph-bold ph-file-pdf"></i> Ver Recibo</button>`;
                }

                tbodyActual.innerHTML = `
                    <tr>
                        <td><strong>#${p.id}</strong></td>
                        <td>${p.cantidad_bultos} x ${nombreProdP}</td>
                        <td>$${Number(p.total).toLocaleString("es-CO")}</td>
                        <td>
                            <strong style="color: ${obtenerColorEstado(p.estado)};">${p.estado}</strong>
                            ${formatearEstadoPagoEtiqueta(p.estado_pago)}
                        </td>
                        <td>${botonRecibo}</td>
                    </tr>
                `;
            } else {
                tbodyActual.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">Sin pedidos activos.</td></tr>`;
            }
        }

        const tbodyCompleta = document.getElementById("tabla-pedidos-completa");
        if (tbodyCompleta) {
            tbodyCompleta.innerHTML = "";
            todosPedidos.forEach(pedido => {
                const nombreProdH = resolverNombreProductoPedido(pedido);
                const prodSafeH = encodeURIComponent(nombreProdH);
                const estPedSafe = encodeURIComponent(pedido.estado || "PENDIENTE");
                const estPagSafe = encodeURIComponent(pedido.estado_pago || "SIN_COMPROBANTE");
                let btnH = (pedido.estado === "CONFIRMADO" || pedido.estado === "ENTREGADO")
                    ? `<button onclick="generarReciboPDF(${pedido.id}, ${pedido.cantidad_bultos}, ${pedido.total}, decodeURIComponent('${prodSafeH}'), decodeURIComponent('${estPedSafe}'), decodeURIComponent('${estPagSafe}'))" style="padding: 4px 8px; background: #334155; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem;">Recibo</button>`
                    : "-";

                const fila = document.createElement("tr");
                fila.innerHTML = `
                    <td>#${pedido.id}</td>
                    <td>${pedido.cantidad_bultos} x ${nombreProdH}</td>
                    <td>$${Number(pedido.total).toLocaleString("es-CO")}</td>
                    <td>
                        <strong style="color: ${obtenerColorEstado(pedido.estado)};">${pedido.estado}</strong>
                        ${formatearEstadoPagoEtiqueta(pedido.estado_pago)}
                    </td>
                    <td>${pedido.direccion_entrega || "Bucaramanga"}</td>
                    <td>${btnH}</td>
                `;
                tbodyCompleta.appendChild(fila);
            });
        }
    } catch (err) {
        console.error("Error cargando pedidos desde Flask:", err);
    }
}

async function cargarPedidosAdmin() {
    const tbodyAdmin = document.getElementById("tabla-admin-pedidos");
    if (!tbodyAdmin) return;

    try {
        const resp = await fetch(`${API_BASE}/api/admin/pedidos`);
        const data = await resp.json();
        if (!resp.ok) return;

        const pedidos = data.pedidos || [];
        tbodyAdmin.innerHTML = "";

        if (pedidos.length === 0) {
            tbodyAdmin.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted);">No hay pedidos registrados.</td></tr>`;
            return;
        }

        pedidos.forEach(ped => {
            if (ped.comprobante_imagen) {
                guardarComprobanteLocal(ped.id, ped.comprobante_imagen);
            }
            const imgSrc = ped.comprobante_imagen || obtenerComprobanteGuardado(ped.id);
            const celdaComprobante = imgSrc
                ? `<div style="display:flex; align-items:center; gap:8px;">
                        <img src="${imgSrc}" alt="Comprobante #${ped.id}" style="width:42px; height:42px; object-fit:cover; border-radius:6px; border:1px solid #475569;">
                        <button type="button" onclick="verComprobanteModal(${ped.id})" style="padding:4px 8px; background:#0284c7; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:0.75rem; font-weight:bold;">Ver Foto</button>
                   </div>`
                : (ped.comprobante || "-");

            const nombreProdAdmin = resolverNombreProductoPedido(ped);
            const bultosNum = Number(ped.cantidad_bultos || 0);

            const fila = document.createElement("tr");
            fila.innerHTML = `
                <td><strong>#${ped.id}</strong></td>
                <td>${ped.cliente_nombre} (${ped.cliente_telefono})</td>
                <td>
                    <div><strong>${bultosNum} bultos</strong></div>
                    <div style="font-size:0.75rem; color:#94a3b8;">${nombreProdAdmin}</div>
                </td>
                <td>$${Number(ped.total).toLocaleString("es-CO")}</td>
                <td>${celdaComprobante}</td>
                <td>
                    <strong style="color: ${obtenerColorEstado(ped.estado)};">${ped.estado}</strong>
                    ${formatearEstadoPagoEtiqueta(ped.estado_pago)}
                </td>
                <td style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <button onclick="cambiarEstadoAdmin(${ped.id}, 'CONFIRMADO')" style="padding: 5px 9px; background: #16a34a; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Aprobar</button>
                    <button onclick="cambiarEstadoAdmin(${ped.id}, 'RECHAZADO')" style="padding: 5px 9px; background: #dc2626; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 0.75rem; font-weight: bold;">Rechazar</button>
                </td>
            `;
            tbodyAdmin.appendChild(fila);
        });
    } catch (err) {
        console.error("Error cargando pedidos de admin:", err);
    }
}

function verComprobanteModal(pedidoId) {
    const imgSrc = obtenerComprobanteGuardado(pedidoId);
    const modal = document.getElementById("modal-comprobante");
    const imgEl = document.getElementById("img-comprobante-modal");
    if (imgSrc && modal && imgEl) {
        imgEl.src = imgSrc;
        modal.style.display = "flex";
    }
}

function cerrarModalComprobante() {
    const modal = document.getElementById("modal-comprobante");
    if (modal) modal.style.display = "none";
}

async function cambiarEstadoAdmin(pedidoId, nuevoEstado) {
    try {
        const resp = await fetch(`${API_BASE}/api/admin/pedidos/${pedidoId}/estado`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ estado: nuevoEstado })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            alert(data.error || "No se pudo actualizar el estado del pedido.");
            return;
        }

        await cargarPedidosAdmin();
        await cargarPedidosSupabase();
        await cargarProductos();
    } catch (err) {
        console.error("Error actualizando estado en admin:", err);
    }
}

function generarReciboPDF(
    idPedido,
    cantidad,
    total,
    nombreProducto = "Bulto de Carbón Vegetal (10 Kg)",
    estadoPedido = "PENDIENTE",
    estadoPago = "SIN_COMPROBANTE"
) {
    const estadoInfo = resolverEstadoRecibo(estadoPedido, estadoPago);
    const ventanaRecibo = window.open("", "_blank", "width=700,height=800");
    ventanaRecibo.document.write(`
        <html>
        <head>
            <title>Recibo de Compra #${idPedido} - Carbón IA</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 40px; color: #1e293b; background: #f8fafc; }
                .receipt-container { background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 500px; margin: auto; }
                h2 { color: #ea580c; margin-bottom: 5px; }
                .info { margin-bottom: 20px; font-size: 0.9rem; color: #475569; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { padding: 10px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; }
                th { background: #f1f5f9; }
                .total-row { font-weight: bold; font-size: 1.1rem; color: #0f172a; }
                .footer { text-align: center; margin-top: 30px; font-size: 0.80rem; color: #94a3b8; }
                .btn-print { display: block; width: 100%; padding: 12px; background: #ea580c; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-top: 25px; text-align: center; }
                @media print { .btn-print { display: none; } }
            </style>
        </head>
        <body>
            <div class="receipt-container">
                <h2>🔥 Carbón IA Bucaramanga</h2>
                <div class="info">
                    <p><strong>Comprobante de Transacción Digital</strong></p>
                    <p>Fecha: ${new Date().toLocaleDateString()} | Pedido #${idPedido}</p>
                    <p>Cliente: ${clienteActual.nombre} (${clienteActual.telefono})</p>
                    <p>Dirección de Entrega: ${clienteActual.direccion_habitual || "Bucaramanga"}</p>
                </div>
                <table>
                    <tr>
                        <th>Descripción</th>
                        <th>Cant.</th>
                        <th>Total</th>
                    </tr>
                    <tr>
                        <td>${nombreProducto}</td>
                        <td>${cantidad}</td>
                        <td>$${Number(total).toLocaleString("es-CO")} COP</td>
                    </tr>
                    <tr class="total-row">
                        <td colspan="2">Total:</td>
                        <td>$${Number(total).toLocaleString("es-CO")} COP</td>
                    </tr>
                </table>
                <p style="margin-top: 20px; color: ${estadoInfo.color}; font-weight: bold; text-align: center;">${estadoInfo.texto}</p>
                <button class="btn-print" onclick="window.print()">Imprimir / Guardar como PDF</button>
                <div class="footer">¡Gracias por tu compra en Carbón IA! Calidad garantizada para tus asados.</div>
            </div>
        </body>
        </html>
    `);
    ventanaRecibo.document.close();
}

function obtenerColorEstado(estado) {
    switch (estado) {
        case "CONFIRMADO": return "#22c55e";
        case "ENTREGADO": return "#3b82f6";
        case "PENDIENTE": return "#f59e0b";
        case "RECHAZADO": return "#ef4444";
        default: return "#6b7280";
    }
}