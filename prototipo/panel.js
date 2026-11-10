/* =====================================================================
   TRAZZA · Panel de plantas (solo rol Progreso)
   - Ver plantas: entrar a cada una (solo lectura), cambiar módulos,
     administrar usuarios y activar / desactivar la planta.
   - Crear planta: nombre, módulos y usuarios. El servidor crea sus tablas.
   ===================================================================== */
const PANEL = JSON.parse(sessionStorage.getItem("trazza_panel") || "null");
if (!PANEL) location.replace("index.html");
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const FIJOS = ["Inicio", "Inventario", "Insumos", "Proveedores", "Solicitudes de edición", "Historial de modificaciones"];
const ROL_TXT = { Supervisor: "Supervisor", Auxiliar: "Auxiliar de almacén", Calidad: "Calidad" };
let DATA = null, tab = "plantas";

async function api(accion, cuerpo) {
  const r = await fetch("api/api.php?a=" + accion, cuerpo ? { method: "POST", headers: { "Content-Type": "application/json", "X-Trazza": "1" }, body: JSON.stringify(cuerpo) } : {});
  if (r.status === 401) { sessionStorage.removeItem("trazza_panel"); location.replace("index.html"); throw new Error("sesion"); }
  const datos = await r.json().catch(() => null);
  if (!datos || !r.ok) throw new Error(datos?.error || "Sin respuesta del servidor");
  return datos;
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }
function abrirModal(titulo, html) { $("#modal-titulo").textContent = titulo; $("#modal-cuerpo").innerHTML = html; $("#modal").hidden = false; $(".modal").scrollTop = 0; }
function cerrarModal() { $("#modal").hidden = true; $("#modal-cuerpo").innerHTML = ""; usuariosDe = null; }
/* Contraseña fácil de dictar: letras sin confusión + números */
function generarClave() {
  const L = "abcdefghjkmnpqrstuvwxyz", n = new Uint32Array(7);
  crypto.getRandomValues(n);
  return "Tz" + [0, 1, 2, 3].map(i => n[i] % 10).join("") + "-" + [4, 5, 6].map(i => L[n[i] % L.length]).join("");
}
const sugerirUsuario = (nombre, rol) => {
  const p = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/).filter(Boolean);
  return p.length >= 2 ? (p[0][0] + p[p.length > 3 ? 2 : 1]).slice(0, 40) : p[0] || rol.toLowerCase();
};

async function cargar() {
  try { DATA = await api("admin_plantas"); render(); }
  catch (e) { if (e.message !== "sesion") $("#vista").innerHTML = `<p class="aviso rojo">No se pudo cargar: ${esc(e.message)}. Recarga la página.</p>`; }
}
function render() {
  $$("#tabs .tab").forEach(b => b.classList.toggle("activo", b.dataset.tab === tab));
  $("#vista").innerHTML = tab === "plantas" ? vPlantas() : vCrear();
  if (tab === "crear") initCrear();
}

/* ---------- Ver plantas ---------- */
function vPlantas() {
  const cards = DATA.plantas.map(p => {
    const act = p.usuarios.filter(u => u.activo);
    const porRol = DATA.roles.map(r => [r, act.filter(u => u.rol === r).length]).filter(([, n]) => n).map(([r, n]) => `${n} ${{ Supervisor: ["supervisor", "supervisores"], Auxiliar: ["auxiliar", "auxiliares"], Calidad: ["de calidad", "de calidad"] }[r][n === 1 ? 0 : 1]}`).join(" · ");
    return `<section class="card planta-card ${p.activa ? "" : "inactiva"}">
      <div class="planta-cab"><div><h2>${esc(p.nombre)}</h2><small>Código ${esc(p.id)}</small></div>
        <span class="chip-e ${p.activa ? "e-ok" : "e-gris"}">${p.activa ? "Activa" : "Desactivada"}</span></div>
      <div class="planta-mods">${p.modulos.map(m => `<span class="mod-chip">${esc(DATA.modulos[m])}</span>`).join("") || `<span class="mod-chip fijo">Solo módulos fijos</span>`}</div>
      <div class="planta-usuarios">👥 ${act.length} usuario${act.length === 1 ? "" : "s"} activo${act.length === 1 ? "" : "s"}${porRol ? ` · ${porRol}` : ""}</div>
      <div class="planta-acciones">
        ${p.activa ? `<button class="btn btn-primario" data-entrar="${esc(p.id)}">👁 Ver planta</button>` : ""}
        <button class="btn btn-borde" data-modulos="${esc(p.id)}">⚙ Módulos</button>
        <button class="btn btn-borde" data-usuarios="${esc(p.id)}">👥 Usuarios</button>
        <button class="btn btn-borde" data-activar="${esc(p.id)}">${p.activa ? "⏸ Desactivar" : "▶ Activar"}</button>
      </div></section>`;
  });
  return `<p class="sub" style="margin:0 0 16px;color:var(--ink-2)">Entra a ver cualquier planta (solo lectura), cambia sus módulos o sus usuarios. Las plantas no se borran: se desactivan y sus datos quedan guardados.</p>
    <div class="plantas-grid">${cards.join("")}</div>`;
}
async function entrar(id) {
  try {
    const s = await api("planta", { planta: id });
    sessionStorage.setItem("trazza_sesion", JSON.stringify(s));
    location.href = "app.html?v=" + Date.now();
  } catch (e) { toast(e.message); }
}
const planta = id => DATA.plantas.find(p => p.id === id);
function checksModulos(marcados) {
  return `<div class="mod-lista">${FIJOS.map(f => `<label class="mod-op fijo"><input type="checkbox" checked disabled> ${f}</label>`).join("")}</div>
    <p class="ayuda" style="margin:8px 0 14px;font-size:12.5px;color:var(--ink-2)">Los de arriba son fijos en toda planta. Elige los demás:</p>
    <div class="mod-lista" id="mods">${Object.entries(DATA.modulos).map(([k, t]) => `<label class="mod-op"><input type="checkbox" value="${k}" ${marcados.includes(k) ? "checked" : ""}> ${esc(t)}</label>`).join("")}</div>`;
}
const modulosMarcados = () => $$("#mods input:checked").map(i => i.value);
function abrirModulos(id) {
  const p = planta(id);
  abrirModal(`Módulos · ${p.nombre}`, `<form id="form-mod" class="card" style="border:0;box-shadow:none">
    <div class="campo"><label for="m-nombre">Nombre de la planta</label><input id="m-nombre" value="${esc(p.nombre)}" maxlength="60"></div>
    <h3 class="paso-titulo">Módulos</h3>${checksModulos(p.modulos)}
    <p class="aviso" style="margin-top:14px">Quitar un módulo solo lo oculta del menú: los datos ya registrados no se borran y vuelven a aparecer si lo activas de nuevo. Los usuarios conectados ven el cambio en menos de un minuto.</p>
    <p class="aviso rojo" id="m-error" hidden></p>
    <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button class="btn btn-primario">Guardar cambios</button></div></form>`);
  $("#form-mod").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      await api("editar_planta", { id, nombre: $("#m-nombre").value, modulos: modulosMarcados() });
      cerrarModal(); toast("Planta actualizada."); cargar();
    } catch (ex) { $("#m-error").textContent = ex.message; $("#m-error").hidden = false; }
  });
}
async function alternarActiva(id) {
  const p = planta(id);
  const txt = p.activa
    ? `¿Desactivar "${p.nombre}"?\n\nSus usuarios ya no podrán entrar. Las tablas y los datos quedan guardados y puedes activarla de nuevo cuando quieras.`
    : `¿Activar de nuevo "${p.nombre}"? Sus usuarios activos podrán volver a entrar.`;
  if (!confirm(txt)) return;
  try { await api("editar_planta", { id, activa: !p.activa }); toast(p.activa ? "Planta desactivada." : "Planta activada."); cargar(); }
  catch (e) { toast(e.message); }
}

/* ---------- Usuarios de una planta ---------- */
function abrirUsuarios(id) {
  const p = planta(id);
  const filas = p.usuarios.map(u => `<tr class="${u.activo ? "" : "fila-espera"}">
      <td class="fuerte">${esc(u.usuario)}</td>
      <td><input class="input-tabla" data-u-nombre="${esc(u.usuario)}" value="${esc(u.nombre)}"></td>
      <td><select class="input-tabla" data-u-rol="${esc(u.usuario)}">${DATA.roles.map(r => `<option value="${r}" ${r === u.rol ? "selected" : ""}>${ROL_TXT[r]}</option>`).join("")}</select></td>
      <td><span class="chip-e ${u.activo ? "e-ok" : "e-gris"}">${u.activo ? "Activo" : "Inactivo"}</span></td>
      <td style="white-space:nowrap"><button class="btn btn-mini btn-primario" data-u-guardar="${esc(u.usuario)}">Guardar</button>
        <button class="btn btn-mini btn-borde" data-u-clave="${esc(u.usuario)}">🔑 Contraseña</button>
        <button class="btn btn-mini btn-borde" data-u-activo="${esc(u.usuario)}">${u.activo ? "Desactivar" : "Activar"}</button></td></tr>`);
  abrirModal(`Usuarios · ${p.nombre}`, `<div style="padding:18px 22px">
    <div class="tabla-wrap"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
      <tbody>${filas.join("") || `<tr><td colspan="5" class="vacio">Sin usuarios</td></tr>`}</tbody></table></div>
    <h3 class="paso-titulo">Agregar usuario</h3>
    <form id="form-u" novalidate>${filaUsuario("n", { rol: "Auxiliar" }, false)}
      <p class="aviso rojo" id="u-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cerrar</button><button class="btn btn-primario">＋ Agregar usuario</button></div></form>
    <p class="aviso" style="margin-top:12px">Las contraseñas se guardan cifradas: no se pueden ver después. Si alguien la olvida, asígnale una nueva con 🔑.</p></div>`);
  initFila($("#form-u .usr-fila"));
  const err = msg => { $("#u-error").textContent = msg; $("#u-error").hidden = false; };
  $("#form-u").addEventListener("submit", async e => {
    e.preventDefault();
    const x = leerFila($("#form-u .usr-fila"));
    try {
      await api("guardar_usuario", { nuevo: true, planta: id, ...x });
      await cargar(); abrirUsuarios(id);
      mostrarCreados(`Usuario agregado a ${p.nombre}`, [x]);
    } catch (ex) { err(ex.message); }
  });
  usuariosDe = id;
}
/* Botones de la tabla de usuarios (un solo manejador para el modal) */
let usuariosDe = null;
$("#modal-cuerpo").addEventListener("click", async e => {
    const b = e.target.closest("button[data-u-guardar], button[data-u-activo], button[data-u-clave]"); if (!b || !usuariosDe) return;
    const id = usuariosDe, p = planta(id);
    const u = k => p.usuarios.find(x => x.usuario === k);
    const guardarU = async (k, extra = {}) => {
      const base = { usuario: k, nombre: $(`[data-u-nombre="${k}"]`).value, rol: $(`[data-u-rol="${k}"]`).value };
      await api("guardar_usuario", { ...base, ...extra });
      await cargar(); abrirUsuarios(id);
    };
    try {
      if (b.dataset.uGuardar) { await guardarU(b.dataset.uGuardar); toast("Usuario actualizado."); }
      if (b.dataset.uActivo) {
        const x = u(b.dataset.uActivo);
        if (x.activo && !confirm(`¿Desactivar a ${x.usuario}? Ya no podrá entrar (su historial queda guardado).`)) return;
        await guardarU(x.usuario, { activo: !x.activo }); toast(x.activo ? "Usuario desactivado." : "Usuario activado.");
      }
      if (b.dataset.uClave) {
        const k = b.dataset.uClave, nueva = prompt(`Nueva contraseña para ${k} (mínimo 6 caracteres). Puedes dejar la sugerida o escribir otra:`, generarClave());
        if (nueva == null) return;
        await guardarU(k, { clave: nueva.trim() });
        mostrarCreados(`Contraseña nueva`, [{ usuario: k, nombre: u(k).nombre, rol: u(k).rol, clave: nueva.trim() }]);
      }
    } catch (ex) { toast(ex.message); }
});
/* Fila de usuario (nombre, usuario, rol, contraseña) usada en crear planta y agregar usuario */
function filaUsuario(pre, u = {}, quitar = true) {
  return `<div class="usr-fila">
    <div class="campo"><label>Nombre completo <span class="req">*</span></label><input data-f="nombre" value="${esc(u.nombre || "")}" placeholder="Ej: KAREN OROZCO MORALES"></div>
    <div class="campo"><label>Usuario (para entrar) <span class="req">*</span></label><input data-f="usuario" value="${esc(u.usuario || "")}" placeholder="Ej: korozco" autocapitalize="none" spellcheck="false"></div>
    <div class="campo"><label>Rol <span class="req">*</span></label><select data-f="rol">${DATA.roles.map(r => `<option value="${r}" ${r === u.rol ? "selected" : ""}>${ROL_TXT[r]}</option>`).join("")}</select></div>
    <div class="campo"><label>Contraseña <span class="req">*</span></label><div class="clave-caja"><input data-f="clave" value="${esc(u.clave || generarClave())}" spellcheck="false"><button type="button" class="btn btn-borde" data-generar title="Generar otra">↻</button></div></div>
    ${quitar ? `<button type="button" class="btn-quitar" data-quitar title="Quitar">×</button>` : "<span></span>"}</div>`;
}
function initFila(f) {
  const usr = $('[data-f="usuario"]', f);
  usr.addEventListener("input", () => (usr.dataset.tocado = "1"));
  $('[data-f="nombre"]', f).addEventListener("input", e => { if (!usr.dataset.tocado) usr.value = sugerirUsuario(e.target.value, $('[data-f="rol"]', f).value); });
  $("[data-generar]", f).addEventListener("click", () => ($('[data-f="clave"]', f).value = generarClave()));
  $("[data-quitar]", f)?.addEventListener("click", () => f.remove());
}
const leerFila = f => Object.fromEntries($$("[data-f]", f).map(i => [i.dataset.f, i.dataset.f === "usuario" ? i.value.trim().toLowerCase() : i.value.trim()]));
/* Muestra usuario y contraseña una sola vez para entregarlos */
function mostrarCreados(titulo, lista, extra = "") {
  const texto = lista.map(x => `${x.nombre} · ${ROL_TXT[x.rol] || x.rol} · usuario: ${x.usuario} · contraseña: ${x.clave}`).join("\n");
  abrirModal(titulo, `<div style="padding:18px 22px">${extra}
    <p class="aviso amarillo">Copia estos datos ahora y entrégalos a cada persona: <b>las contraseñas no se vuelven a mostrar</b>.</p>
    <div class="tabla-wrap creados" style="margin-top:12px"><table><thead><tr><th>Nombre</th><th>Rol</th><th>Usuario</th><th>Contraseña</th></tr></thead>
      <tbody>${lista.map(x => `<tr><td>${esc(x.nombre.toUpperCase())}</td><td>${esc(ROL_TXT[x.rol] || x.rol)}</td><td><code>${esc(x.usuario)}</code></td><td><code>${esc(x.clave)}</code></td></tr>`).join("")}</tbody></table></div>
    <div class="acciones-form"><button class="btn btn-borde" id="btn-copiar">⧉ Copiar</button><button class="btn btn-primario" data-cerrar>Listo</button></div></div>`);
  $("#btn-copiar").addEventListener("click", () => navigator.clipboard.writeText(texto).then(() => toast("Copiado."), () => toast("No se pudo copiar; selecciona el texto de la tabla.")));
}

/* ---------- Crear planta ---------- */
function vCrear() {
  return `<form id="form-crear" class="card" novalidate>
    <h2>Crear planta nueva</h2>
    <p class="sub">La planta se crea desde cero con sus propias tablas vacías. Funciona igual que las demás: sus usuarios entran por el inicio de sesión de siempre y solo ven los módulos que elijas.</p>
    <h3 class="paso-titulo">1 · Nombre</h3>
    <div class="form-grid"><div class="campo"><label for="c-nombre">Nombre de la planta <span class="req">*</span></label><input id="c-nombre" maxlength="60" placeholder="Ej: Planta Norte"></div></div>
    <h3 class="paso-titulo">2 · Módulos</h3>${checksModulos(Object.keys(DATA.modulos))}
    <h3 class="paso-titulo">3 · Usuarios</h3>
    <div id="c-usuarios">${["Supervisor", "Auxiliar", "Calidad"].map(r => filaUsuario("c", { rol: r })).join("")}</div>
    <button type="button" class="btn btn-borde" id="c-mas" style="margin-top:10px">＋ Otro usuario</button>
    <p class="aviso" style="margin-top:16px">Insumos, proveedores y stock empiezan vacíos: la supervisora los agrega desde la app (Insumos y Proveedores).</p>
    <p class="aviso rojo" id="c-error" hidden></p>
    <div class="acciones-form"><button type="button" class="btn btn-borde" id="c-limpiar">Limpiar</button><button class="btn btn-primario" id="c-crear">Crear planta</button></div>
  </form>`;
}
function initCrear() {
  $$("#c-usuarios .usr-fila").forEach(initFila);
  $("#c-mas").addEventListener("click", () => { $("#c-usuarios").insertAdjacentHTML("beforeend", filaUsuario("c", { rol: "Auxiliar" })); initFila($("#c-usuarios .usr-fila:last-child")); });
  $("#c-limpiar").addEventListener("click", () => render());
  $("#form-crear").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#c-error"); err.hidden = true;
    const nombre = $("#c-nombre").value.trim(), modulos = modulosMarcados(), usuarios = $$("#c-usuarios .usr-fila").map(leerFila);
    const fallo = !nombre ? "Escribe el nombre de la planta." : !usuarios.length ? "Agrega al menos un usuario." : usuarios.some(u => !u.nombre || !u.usuario || !u.clave) ? "Completa nombre, usuario y contraseña de cada usuario (o quita la fila con ×)." : "";
    if (fallo) { err.textContent = fallo; err.hidden = false; return; }
    const lista = modulos.map(m => DATA.modulos[m]).join(", ") || "solo los fijos";
    if (!confirm(`¿Crear "${nombre}"?\n\nMódulos: ${lista}\nUsuarios: ${usuarios.map(u => `${u.usuario} (${u.rol})`).join(", ")}`)) return;
    const btn = $("#c-crear"); btn.disabled = true; btn.textContent = "Creando…";
    try {
      const r = await api("crear_planta", { nombre, modulos, usuarios });
      tab = "plantas"; await cargar();
      mostrarCreados(`Planta creada: ${nombre}`, usuarios, `<p class="aviso" style="margin-bottom:10px">✔ Se crearon las tablas de <b>${esc(nombre)}</b> (código ${esc(r.id)}). Ya puedes entrar a verla y sus usuarios ya pueden iniciar sesión.</p>`);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = "Crear planta"; }
  });
}

/* ---------- Eventos ---------- */
$("#u-nombre").textContent = PANEL?.nombre || "";
$("#tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); } });
$("#vista").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.entrar) entrar(b.dataset.entrar);
  if (b.dataset.modulos) abrirModulos(b.dataset.modulos);
  if (b.dataset.usuarios) abrirUsuarios(b.dataset.usuarios);
  if (b.dataset.activar) alternarActiva(b.dataset.activar);
});
$("#modal").addEventListener("click", e => { if (e.target.closest("[data-cerrar]")) cerrarModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) cerrarModal(); });
$("#btn-salir").addEventListener("click", async () => { await api("salir", {}).catch(() => {}); sessionStorage.removeItem("trazza_panel"); sessionStorage.removeItem("trazza_sesion"); location.href = "index.html?v=" + Date.now(); });
if (PANEL) cargar();
