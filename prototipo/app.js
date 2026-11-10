/* =====================================================================
   TRAZZA · Prototipo funcional (réplica de INVENTARIO KITS.xlsx)
   Roles: Progreso (todo) · Supervisor · Auxiliar de almacén · Calidad
   - Entradas, salidas, devoluciones y averías: formularios (fecha automática).
   - Registros guardados: solo lectura; los cambios pasan por "Solicitud de
     edición" que aprueba la supervisora (o Progreso).
   - Toda acción queda en el Historial de modificaciones (bitácora).
   - Multiplanta: cada planta tiene sus propias tablas; la sesión solo abre las
     de la planta elegida.
   - Los datos viven en MySQL (tablas por planta) y se leen por api/api.php.
   ===================================================================== */

const SESION = JSON.parse(sessionStorage.getItem("trazza_sesion") || "null");
const PLANTA = SESION?.planta || "";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- Roles y permisos ---------- */
const ROL = SESION?.rol || "";
const ES = { progreso: ROL === "Progreso", supervisor: ROL === "Supervisor", auxiliar: ROL === "Auxiliar", calidad: ROL === "Calidad" };
/* Progreso VE todo pero no ejecuta acciones; cada acción es exclusiva de su rol */
const PUEDE = {
  registrar: ES.auxiliar,            // entradas, salidas, devoluciones, averías
  solicitarEdicion: ES.auxiliar,     // pide cambios a registros guardados
  aprobarSolicitudes: ES.supervisor, // solo la supervisora aprueba ediciones
  firmarSalidas: ES.supervisor,      // "Recibido por" + firma dibujada
  aprobarCalidad: ES.calidad,        // tickets de calidad
  editarCatalogos: ES.supervisor,    // tablas de insumos y proveedores
};
const BODEGAS = PLANTA === "PRUEBA" ? ["KT", "TQ"] : ["Bodega"];
const NOMBRE_BODEGA = { KT: "Bodega KT", TQ: "Bodega TKT" };
const nomBodega = b => NOMBRE_BODEGA[b] || b;
const TIPOS_AVERIA = ["Conteo", "Rechazo"];

/* ---------- Estado ---------- */
let BD = null;

/* ---------- Datos en SQL (api/api.php) ---------- */
let BASE = {}, VERSION = 0, IDS = { sig: 0, fin: 0 }, guardando = 0, colaGuardado = Promise.resolve();
async function api(accion, cuerpo) {
  const r = await fetch("api/api.php?a=" + accion, cuerpo ? { method: "POST", headers: { "Content-Type": "application/json", "X-Trazza": "1" }, body: JSON.stringify(cuerpo) } : {});
  if (r.status === 401) { sessionStorage.removeItem("trazza_sesion"); location.replace("index.html"); throw new Error("sesion"); }
  const datos = await r.json().catch(() => null);
  if (!datos || !r.ok) throw new Error(datos?.error || "Sin respuesta del servidor");
  return datos;
}
/* Filas de la app tal como van a SQL: insumos y maestro son una sola tabla */
function filasBD() {
  const d = D(), m = Object.fromEntries(d.maestro.map(x => [x.codigo, x]));
  return { recepciones: d.recepciones, salidas: d.salidas, devoluciones: d.devoluciones, averias: d.averias, proveedores: d.proveedores,
    insumos: d.insumos.map(i => ({ ...m[i.codigo], ...i })), solicitudes: [...BD.solicitudes].reverse(), bitacora: [...BD.bitacora].reverse() }; // en la app van del más nuevo al más viejo
}
const instantanea = () => Object.fromEntries(Object.entries(filasBD()).map(([t, filas]) => [t, Object.fromEntries(filas.map(f => [f.id, JSON.stringify(f)]))]));
/* Módulos activos de la planta (los elige Progreso en el panel). Los fijos siempre están. */
const MODULOS_FIJOS = ["inicio", "inventario", "cat-insumos", "cat-proveedores", "solicitudes", "bitacora"];
let MODULOS_PLANTA = SESION?.modulos || null;
const moduloActivo = k => !MODULOS_PLANTA || MODULOS_FIJOS.includes(k) || MODULOS_PLANTA.includes(k);
function aplicarDatos(r) {
  if (r.planta) { const antes = JSON.stringify(MODULOS_PLANTA); MODULOS_PLANTA = r.planta.modulos || []; if (antes !== JSON.stringify(MODULOS_PLANTA) && $("#nav").innerHTML) pintarMenu(); }
  const maestro = r.datos.insumos.map(({ codigo, descripcion, tipo, unidad, kitsPT }) => ({ codigo, descripcion, tipo, unidad, kitsPT }));
  BD = { datos: { ...r.datos, maestro }, solicitudes: r.solicitudes, bitacora: r.bitacora };
  BASE = instantanea(); VERSION = r.version;
}
/* Envía a SQL solo las filas que cambiaron; si falla, avisa y vuelve a lo que hay guardado */
function guardar() {
  const actual = instantanea(), cambios = [];
  Object.entries(actual).forEach(([tabla, filas]) => {
    Object.entries(filas).forEach(([id, json]) => { if (BASE[tabla]?.[id] !== json) cambios.push({ tabla, id, fila: JSON.parse(json) }); });
    Object.keys(BASE[tabla] || {}).forEach(id => { if (!(id in filas)) cambios.push({ tabla, id, fila: null }); });
  });
  BASE = actual;
  if (!cambios.length) return;
  guardando++;
  colaGuardado = colaGuardado.then(() => api("guardar", { cambios })).then(r => {
    const otro = r.version !== VERSION + 1;
    VERSION = otro ? -1 : r.version;
  }).catch(e => {
    if (e.message === "sesion") return;
    alert(`No se guardó el último cambio: ${e.message}. Se recargarán los datos del servidor.`);
    location.reload();
  }).finally(() => { guardando--; });
}
/* Trae lo que registraron otras personas, sin interrumpir a quien está escribiendo */
async function refrescar() {
  const ocupado = () => guardando || !$("#modal").hidden || document.activeElement?.matches?.("input, textarea, select");
  if (ocupado() || document.hidden) return;
  try {
    if ((await api("version")).version === VERSION) return;
    const r = await api("datos");
    if (ocupado()) return;
    aplicarDatos(r); actualizarBadges(); render();
  } catch (e) {}
}
const reservarIds = () => api("ids", {}).then(r => (IDS = r)).catch(() => {});
const D = () => BD.datos;
const nuevoId = p => {
  if (IDS.fin - IDS.sig === 10) reservarIds();
  return p + (IDS.sig < IDS.fin ? IDS.sig++ : Date.now().toString(36).toUpperCase());
};

/* ---------- Historial de modificaciones (trazabilidad) ---------- */
function registrarBitacora(accion, tabla, registro, detalle) {
  BD.bitacora.unshift({ id: nuevoId("H"), fecha: new Date().toISOString(), usuario: SESION?.usuario || "", rol: ROL, accion, tabla, registro: registro || "", detalle: detalle || "" });
}

/* ---------- Utilidades ---------- */
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtN = v => (v === "" || v == null ? "" : Number(v).toLocaleString("es-CO", { maximumFractionDigits: 2 }));
const fmtF = f => (f ? f.split("-").reverse().join("/") : "");
const fmtFH = iso => (iso ? new Date(iso).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "");
/* Fecha y hora del sistema (no las escribe ni elige el usuario) */
const ahora = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return { fecha: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hora: `${p(d.getHours())}:${p(d.getMinutes())}` }; };
const relojTxt = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
setInterval(() => document.querySelectorAll("[data-reloj]").forEach(el => (el.textContent = relojTxt())), 1000);
const fFecha = r => `${fmtF(r.fecha)}${r.hora ? ` <small class="muted">${r.hora}</small>` : ""}`;
const hoy = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
function U(s) { return String(s ?? "").trim().toUpperCase(); }
const desc = cod => (D().maestro.find(m => m.codigo === String(cod)) || D().insumos.find(i => i.codigo === String(cod)) || {}).descripcion || "";
const insumoTxt = cod => (cod ? `${cod} - ${desc(cod)}` : "");
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
const disponible = r => !["Pendiente", "Rechazado"].includes(r.calidad?.estado);
const ESTADO_CAL_CHIP = { Pendiente: "e-alerta", Aprobado: "e-ok", Rechazado: "e-peligro", "No aplica": "e-gris" };

/* =====================================================================
   CÁLCULOS (equivalentes a las fórmulas del Excel)
   ===================================================================== */

/* Hoja INVENTARIO: stock = inicial + entradas + devoluciones buenas − salidas.
   No cuentan: saldos iniciales (solo FIFO) ni entradas bloqueadas por Calidad. */
function calcInventario() {
  const { recepciones, salidas, devoluciones } = D();
  return D().insumos.map(i => {
    const rec = recepciones.filter(r => r.codigo === i.codigo && r.origen !== "saldo-inicial" && disponible(r));
    const enCalidad = recepciones.filter(r => r.codigo === i.codigo && r.calidad?.estado === "Pendiente").reduce((a, r) => a + Number(r.cantidad || 0), 0);
    const sal = salidas.filter(s => s.codigo === i.codigo);
    const dev = devoluciones.filter(x => x.codigo === i.codigo);
    const devueltas = dev.reduce((a, x) => a + Number(x.buenas || 0), 0);
    const entradas = rec.reduce((a, r) => a + Number(r.cantidad || 0), 0);
    const salReg = sal.reduce((a, s) => a + Number(s.cantidad || 0), 0);
    const salidasTot = Number(i.salidasHistoricas || 0) + salReg;
    const stock = Number(i.stockInicial || 0) + entradas + devueltas - salidasTot;
    const maxF = arr => arr.map(x => x.fecha).filter(Boolean).sort().pop() || "";
    const ultE = entradas + devueltas === 0 ? i.baseFechaEntrada || "" : maxF([...rec, ...dev]);
    let ultS = salReg === 0 ? "" : maxF(sal);
    if (i.baseFechaSalida) ultS = salReg === 0 ? i.baseFechaSalida : [i.baseFechaSalida, ultS].sort().pop();
    return { ...i, entradas, devueltas, enCalidad, salidas: salidasTot, stock, ultE, ultS, kits: kitsDe(i.codigo) };
  });
}
const estadoStock = s => (s < 0 ? "rojo" : s <= 100 ? "amarillo" : "");

/* Kits en los que se usa cada insumo (para agrupar el inventario) */
const nombreKit = k => { const [cod, ...nom] = k.kit.split(" - "); return { cod, nombre: nom.join(" - "), corto: /VIP/.test(k.kit) ? "VIP" : /VH/.test(k.kit) ? "VH" : "RN" }; };
function kitsDe(cod) {
  const pt = D().maestro.find(m => m.codigo === cod && m.tipo === "PT");
  if (pt) return [...new Set(pt.kitsPT || [])];
  return D().kits.filter(k => k.insumos.some(x => x.codigo === cod)).map(k => nombreKit(k).corto);
}
const esPT = cod => D().maestro.some(m => m.codigo === String(cod) && m.tipo === "PT");

/* Hojas CONTROL LOTES / LOTES POR REVISAR (fórmula LET con FIFO) */
function calcLotes() {
  const { recepciones, salidas, devoluciones } = D();
  const entradas = [
    ...recepciones.filter(disponible).map(r => ({ cod: r.codigo, lot: r.lote, fecha: r.fecha, cant: Number(r.cantidad || 0), venc: r.fechaVencimiento || "" })),
    ...devoluciones.filter(x => Number(x.buenas) > 0 && x.lote && U(x.lote) !== "N/A").map(x => ({ cod: x.codigo, lot: x.lote, fecha: "", cant: Number(x.buenas) })),
  ];
  const pares = [], vistos = new Set();
  const add = (cod, lot) => { const k = cod + "|" + U(lot); if (!vistos.has(k)) { vistos.add(k); pares.push({ cod, lot: String(lot).trim() }); } };
  entradas.filter(e => e.cod && String(e.lot ?? "").trim() !== "").forEach(e => add(e.cod, e.lot));
  salidas.filter(s => s.codigo && String(s.lote ?? "").trim() !== "" && U(s.lote) !== "N/A").forEach(s => add(s.codigo, s.lote));
  pares.sort((a, b) => Number(a.cod) - Number(b.cod));

  const filas = pares.map(p => {
    const es = entradas.filter(e => e.cod === p.cod && U(e.lot) === U(p.lot));
    const fechas = es.map(e => e.fecha).filter(Boolean).sort();
    const ent = es.reduce((a, e) => a + e.cant, 0);
    const vs = es.map(e => e.venc).filter(Boolean), vence = vs.filter(x => x !== "N/A").sort()[0] || (vs.length ? "N/A" : "");
    const sal = salidas.filter(s => s.codigo === p.cod && U(s.lote) === U(p.lot)).reduce((a, s) => a + Number(s.cantidad || 0), 0);
    return { codigo: p.cod, insumo: desc(p.cod), lote: p.lot, fecha: fechas[0] || "", vence, entradas: ent, salidas: sal, saldo: ent - sal };
  });
  filas.forEach(f => {
    const minF = filas.filter(o => o.codigo === f.codigo && o.saldo > 0).map(o => o.fecha || "0").sort()[0];
    f.prioridad = f.saldo < 0 ? "REVISAR" : f.saldo === 0 ? "AGOTADO" : !f.fecha ? "REVISAR FECHA" : f.fecha === minF ? "USAR PRIMERO" : "EN ESPERA";
    f.control = f.saldo < 0 ? "Falta entrada o saldo inicial" : f.saldo === 0 ? "Cerrado" : !f.fecha ? "Falta fecha del lote" : "Disponible";
  });
  return filas;
}
/* Orden de uso: por insumo, primero lo disponible por fecha (FIFO), luego agotados y por revisar */
const RANGO_PRIOR = { "USAR PRIMERO": 0, "EN ESPERA": 1, "REVISAR FECHA": 2, REVISAR: 3, AGOTADO: 4 };
function lotesEnOrdenDeUso(lotes) {
  const orden = [...lotes].sort((a, b) => a.insumo.localeCompare(b.insumo) || RANGO_PRIOR[a.prioridad] - RANGO_PRIOR[b.prioridad] || (a.fecha || "9").localeCompare(b.fecha || "9"));
  const n = {};
  orden.forEach(l => { l.orden = l.saldo > 0 ? (n[l.codigo] = (n[l.codigo] || 0) + 1) : ""; });
  return orden;
}

/* Reparte una cantidad entre los lotes disponibles en orden FIFO (puede usar 2 o más lotes) */
function repartirFIFO(cod, cantidad, saldos) {
  const lotes = saldos.filter(l => l.codigo === cod && l.saldo > 0).sort((a, b) => (a.fecha || "9").localeCompare(b.fecha || "9"));
  const partes = [];
  let resta = cantidad;
  for (const l of lotes) {
    if (resta <= 0) break;
    const toma = Math.min(resta, l.saldo);
    partes.push({ lote: l.lote, cantidad: toma, saldo: l.saldo });
    resta -= toma;
  }
  if (resta > 0) partes.push({ lote: "N/A", cantidad: resta, saldo: 0, falta: true });
  return partes;
}

/* Hoja AVERIAS: resumen SUMIFS por código */
function calcAverias() {
  return D().maestro.map(m => {
    const total = D().averias.filter(a => a.codigo === m.codigo).reduce((s, a) => s + Number(a.cantidad || 0), 0);
    return { codigo: m.codigo, descripcion: m.descripcion, total, estado: total > 0 ? "Con averías" : "Sin averías" };
  });
}

/* =====================================================================
   LISTAS DESPLEGABLES (salen del catálogo que edita la supervisora)
   ===================================================================== */
const OPC_INSUMOS = (incluir = "") => D().maestro.filter(m => m.activo !== false || m.codigo === String(incluir))
  .sort((a, b) => (a.tipo === "PT") - (b.tipo === "PT")).map(m => [m.codigo, `${m.tipo === "PT" ? "[PT] " : ""}${m.codigo} - ${m.descripcion}`]);
const OPC_PROVEEDORES = (incluir = "") => D().proveedores.filter(p => p.activo !== false || U(p.nombre) === U(incluir)).map(p => [p.nombre, p.nombre]);
const opciones = (lista, valor, vacio) => (vacio ? `<option value="">${vacio}</option>` : "") + lista.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(valor) ? "selected" : ""}>${esc(t)}</option>`).join("");
const campoFecha = id => `<div class="campo"><label>Fecha y hora</label><div class="campo-fijo" id="${id}" data-reloj title="La fecha y la hora las pone el sistema">${relojTxt()}</div><span class="ayuda">🔒 Automática del sistema · no se puede modificar</span></div>`;

/* =====================================================================
   SOLICITUDES DE EDICIÓN (las aprueba la supervisora o Progreso)
   ===================================================================== */
const TABLAS = {
  recepciones: { nombre: "Entrada", campos: [["bodega", "Bodega", ["sel", BODEGAS]], ["ordenCompra", "Orden de compra"], ["factura", "Factura"], ["proveedor", "Proveedor", "proveedor"], ["remision", "Remisión"], ["codigo", "Insumo", "insumo"], ["cantidad", "Cantidad recibida", "number"], ["unidad", "Unidad"], ["lote", "Lote"], ["fechaFabricacion", "Fecha de fabricación", "date"], ["fechaVencimiento", "Fecha de vencimiento", "date"], ["observaciones", "Observaciones"]] },
  salidas: { nombre: "Salida", campos: [["ordenProduccion", "Orden de producción"], ["destino", "Destino"], ["codigo", "Insumo", "insumo"], ["cantidad", "Cantidad salida", "number"], ["unidad", "Unidad"], ["lote", "Lote"], ["observaciones", "Observaciones"]] },
  devoluciones: { nombre: "Devolución", campos: [["op", "Orden de producción"], ["codigo", "Insumo", "insumo"], ["lote", "Lote"], ["buenas", "Unidades buenas (sobrante)", "number"], ["malas", "Unidades malas (rechazo)", "number"], ["observaciones", "Observaciones"]] },
  averias: { nombre: "Avería", campos: [["tipo", "Tipo", ["sel", TIPOS_AVERIA]], ["codigo", "Insumo", "insumo"], ["lote", "Lote"], ["cantidad", "Cantidad avería", "number"], ["observaciones", "Observaciones / causa"]] },
  insumos: { nombre: "Insumo (inventario)", campos: [["descripcion", "Descripción"], ["stockInicial", "Stock inicial", "number"], ["salidasHistoricas", "Salidas históricas (antes del registro)", "number"], ["unidad", "Unidad"], ["observaciones", "Observaciones"]] },
};
const pendiente = (tabla, id) => BD.solicitudes.some(s => s.estado === "Pendiente" && s.tabla === tabla && s.registroId === id);
const btnEditar = (tabla, id) => !PUEDE.solicitarEdicion ? "" : pendiente(tabla, id)
  ? `<span class="chip-e e-alerta" title="Tiene una solicitud pendiente">⏳ Pendiente</span>`
  : `<button class="btn-lapiz" data-solicitar="${tabla}" data-id="${esc(id)}" title="Solicitar edición">✎</button>`;
const checkNA = (id, marcado) => `<label style="display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;font-weight:700;color:var(--ink-2);cursor:pointer"><input type="checkbox" id="${id}-na" data-na="${id}" ${marcado ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--im-azul)"> No aplica (N/A)</label>`;
document.addEventListener("change", e => { const c = e.target.closest?.("[data-na]"); if (!c) return; const inp = document.getElementById(c.dataset.na); if (!inp) return; inp.disabled = c.checked; if (c.checked) inp.value = ""; inp.closest(".campo")?.classList.remove("invalido"); });
const fechaONA = id => ($(`#${id}-na`)?.checked ? "N/A" : $(`#${id}`).value.trim());
const valorTxt = (campo, v) => (campo === "codigo" ? insumoTxt(v) : campo === "bodega" && v ? nomBodega(v) : /^fecha(Fabricacion|Vencimiento)?$/.test(campo) && v ? fmtF(v) : v === "" || v == null ? "—" : v);

function inputCampo([k, label, tipo], valor, prefijo = "f") {
  const id = `${prefijo}-${k}`;
  if (tipo === "insumo") return `<div class="campo"><label for="${id}">${label}</label><select id="${id}" name="${k}">${opciones(OPC_INSUMOS(valor), valor)}</select></div>`;
  if (tipo === "proveedor") return `<div class="campo"><label for="${id}">${label}</label><select id="${id}" name="${k}">${opciones(OPC_PROVEEDORES(valor), valor, "—")}</select></div>`;
  if (tipo === "date" && /^fecha(Fabricacion|Vencimiento)$/.test(k)) { const na = valor === "N/A"; return `<div class="campo"><label for="${id}">${label}</label><input id="${id}" name="${k}" type="date" value="${na ? "" : esc(valor)}" ${na ? "disabled" : ""}>${checkNA(id, na)}</div>`; }
  if (Array.isArray(tipo)) return `<div class="campo"><label for="${id}">${label}</label><select id="${id}" name="${k}">${opciones(tipo[1].map(o => [o, k === "bodega" ? nomBodega(o) : o]), valor, "—")}</select></div>`;
  return `<div class="campo"><label for="${id}">${label}</label><input id="${id}" name="${k}" type="${tipo || "text"}" ${tipo === "number" ? 'step="any" min="0"' : ""} value="${esc(valor)}"></div>`;
}

function abrirSolicitud(tabla, id, tipoInicial = "Modificar") {
  const cfg = TABLAS[tabla];
  const reg = D()[tabla].find(r => r.id === id);
  if (!reg) return;
  abrirModal(`Solicitud de edición · ${cfg.nombre}`, `
    <form id="form-sol" novalidate>
      <div class="tabs" id="tipo-sol">
        <button type="button" class="tab ${tipoInicial === "Modificar" ? "activo" : ""}" data-tipo="Modificar">Modificar datos</button>
        ${tabla !== "insumos" ? `<button type="button" class="tab ${tipoInicial === "Eliminar" ? "activo" : ""}" data-tipo="Eliminar">Eliminar registro</button>` : ""}
      </div>
      <p class="aviso">La solicitud queda pendiente hasta que la supervisora la apruebe. La fecha del registro no se puede cambiar.</p>
      <div class="form-grid" id="campos-sol" style="margin-top:12px">${cfg.campos.map(c => inputCampo(c, reg[c[0]], "m")).join("")}</div>
      <div class="campo ancho" style="margin-top:14px"><label for="m-motivo">Motivo de la solicitud <span class="req">*</span></label>
        <textarea id="m-motivo" rows="2" placeholder="Explica por qué se necesita el cambio"></textarea></div>
      <p class="aviso rojo" id="sol-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button class="btn btn-primario">Enviar solicitud</button></div>
    </form>`, { formulario: true });
  let tipo = tipoInicial;
  const setTipo = t => { tipo = t; $$("#tipo-sol .tab").forEach(b => b.classList.toggle("activo", b.dataset.tipo === t)); $$("#campos-sol input, #campos-sol select").forEach(i => (i.disabled = t === "Eliminar")); $$("#campos-sol [data-na]").forEach(c => { if (c.checked) $("#" + c.dataset.na).disabled = true; }); };
  $$("#tipo-sol .tab").forEach(b => b.addEventListener("click", () => setTipo(b.dataset.tipo)));
  setTipo(tipo);
  $("#form-sol").addEventListener("submit", e => {
    e.preventDefault();
    const err = $("#sol-error"), motivo = $("#m-motivo").value.trim();
    const valores = Object.fromEntries(cfg.campos.map(([k, , t]) => { const v = $(`#m-${k}-na`) ? fechaONA(`m-${k}`) : $(`#m-${k}`).value.trim(); return [k, t === "number" && v !== "" ? Number(v) : v]; }));
    const cambios = {};
    if (tipo === "Modificar") cfg.campos.forEach(([k]) => { if (String(reg[k] ?? "") !== String(valores[k] ?? "")) cambios[k] = [reg[k] ?? "", valores[k]]; });
    if (tipo !== "Eliminar" && cfg.campos.some(([k, , t]) => t === "number" && (valores[k] === "" || valores[k] < 0))) { err.textContent = "Las cantidades deben ser números mayores o iguales a 0."; err.hidden = false; return; }
    if (tipo === "Modificar" && !Object.keys(cambios).length) { err.textContent = "No has cambiado ningún dato."; err.hidden = false; return; }
    if (!motivo) { err.textContent = "Escribe el motivo de la solicitud."; err.hidden = false; return; }
    const sid = nuevoId("SOL-");
    const resumen = `${insumoTxt(reg.codigo) || reg.descripcion || ""} · ${fmtN(reg.cantidad ?? "")} · lote ${reg.lote || "—"}`;
    BD.solicitudes.unshift({ id: sid, fecha: new Date().toISOString(), usuario: SESION.usuario, tabla, registroId: reg.id, tipo, cambios, resumen, motivo, estado: "Pendiente" });
    registrarBitacora("Solicitud de edición creada", cfg.nombre, reg.id, `${sid} · ${tipo} · ${motivo}`);
    guardar(); cerrarModal(); actualizarBadges(); render();
    toast("Solicitud enviada. Queda pendiente de aprobación de la supervisora.");
  });
}

function resolverSolicitud(id, aprobar) {
  if (!PUEDE.aprobarSolicitudes) return;
  const s = BD.solicitudes.find(x => x.id === id);
  if (!s || s.estado !== "Pendiente") return;
  if (aprobar) {
    const lista = D()[s.tabla];
    const idx = lista.findIndex(r => r.id === s.registroId);
    if (idx < 0) s.estado = "No aplicable";
    else {
      if (s.tipo === "Modificar") Object.entries(s.cambios).forEach(([k, [, v]]) => (lista[idx][k] = v));
      if (s.tipo === "Eliminar") lista.splice(idx, 1);
      s.estado = "Aprobada";
    }
  } else s.estado = "Rechazada";
  s.resueltoPor = SESION.usuario; s.fechaResolucion = new Date().toISOString();
  registrarBitacora(`Solicitud ${s.estado.toLowerCase()}`, TABLAS[s.tabla].nombre, s.registroId,
    `${s.id} · ${s.tipo}${s.tipo === "Modificar" ? " · " + Object.entries(s.cambios).map(([k, [a, b]]) => `${k}: ${a} → ${b}`).join("; ") : ""}`);
  guardar(); actualizarBadges(); render();
  toast(`Solicitud ${s.estado.toLowerCase()}.`);
}

/* =====================================================================
   VISTAS Y MENÚ POR ROL
   ===================================================================== */
const AUX_SUP_PRO = ["Auxiliar", "Supervisor", "Progreso"];
const SUP_PRO = ["Supervisor", "Progreso"];
const VISTAS = {
  inicio: { titulo: "Inicio", render: () => vInicio(), roles: ["Auxiliar", "Supervisor", "Progreso", "Calidad"], ico: "▣", menu: "Inicio" },
  entradas: { titulo: "Entradas de insumos", render: () => vModulo("entradas"), roles: AUX_SUP_PRO, ico: "↓", menu: "Entradas", sec: "Registros" },
  salidas: { titulo: "Salidas de insumos", render: () => vModulo("salidas"), roles: AUX_SUP_PRO, ico: "↑", menu: "Salidas", sec: "Registros", badge: "firmas" },
  devoluciones: { titulo: "Devoluciones a inventario", render: () => vModulo("devoluciones"), roles: AUX_SUP_PRO, ico: "↺", menu: "Devoluciones", sec: "Registros" },
  averias: { titulo: "Averías", render: () => vModulo("averias"), roles: AUX_SUP_PRO, ico: "⚠", menu: "Averías", sec: "Registros", badge: "averias" },
  inventario: { titulo: "Inventario", render: () => vInventario(), roles: AUX_SUP_PRO, ico: "▤", menu: "Inventario", sec: "Consultar" },
  lotes: { titulo: "Control de lotes FIFO · orden de uso", render: () => vLotes(), roles: AUX_SUP_PRO, ico: "◷", menu: "Control lotes FIFO", sec: "Consultar" },
  kits: { titulo: "Códigos y composición de kits", render: () => vKits(), roles: AUX_SUP_PRO, ico: "◫", menu: "Códigos kits", sec: "Consultar" },
  historial: { titulo: "Historial de movimientos", render: () => vHistorial(), roles: SUP_PRO, ico: "≡", menu: "Historial movimientos", sec: "Consultar" },
  calidad: { titulo: "Calidad · tickets de revisión", render: () => vCalidad(), roles: ["Calidad", "Supervisor", "Progreso"], ico: "✔", menu: ES.calidad ? "Tickets de calidad" : "Calidad", sec: "Control", badge: "calidad" },
  solicitudes: { titulo: ES.auxiliar ? "Mis solicitudes de edición" : ES.supervisor ? "Solicitudes por aprobar" : "Solicitudes de edición", render: () => vSolicitudes(), roles: AUX_SUP_PRO, ico: "✎", menu: ES.auxiliar ? "Mis solicitudes" : ES.supervisor ? "Solicitudes por aprobar" : "Solicitudes de edición", sec: "Control", badge: "solicitudes" },
  "cat-insumos": { titulo: "Insumos", render: () => vCatalogo("insumos"), roles: SUP_PRO, ico: "☷", menu: "Insumos", sec: "Listas" },
  "cat-proveedores": { titulo: "Proveedores", render: () => vCatalogo("proveedores"), roles: SUP_PRO, ico: "⌂", menu: "Proveedores", sec: "Listas" },
  bitacora: { titulo: "Historial de modificaciones", render: () => vBitacora(), roles: SUP_PRO, ico: "⧉", menu: "Historial de modificaciones", sec: "Control" },
};
const permitida = clave => VISTAS[clave] && VISTAS[clave].roles.includes(ROL) && moduloActivo(clave);
let filtros = {};

function pintarMenu() {
  let html = "", sec = "";
  Object.entries(VISTAS).filter(([k]) => permitida(k)).forEach(([k, v]) => {
    if (v.sec && v.sec !== sec) { sec = v.sec; html += `<p class="nav-titulo">${sec}</p>`; }
    html += `<a href="#${k}" data-ico="${v.ico}">${v.menu}${v.badge ? ` <span class="badge" data-badge="${v.badge}"></span>` : ""}</a>`;
  });
  $("#nav").innerHTML = html;
}

function tabla(cols, filas, vacio = "Sin registros") {
  return `<div class="tabla-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.cl || ""}">${c.t}</th>`).join("")}</tr></thead>
  <tbody>${filas.length ? filas.join("") : `<tr><td colspan="${cols.length}" class="vacio">${vacio}</td></tr>`}</tbody></table></div>`;
}
const chipPrioridad = p => `<span class="chip-e ${{ "USAR PRIMERO": "e-ok", "EN ESPERA": "e-alerta", AGOTADO: "e-gris", REVISAR: "e-peligro", "REVISAR FECHA": "e-peligro" }[p] || "e-info"}">${p}</span>`;
const btnCsv = (tipo, txt = "⤓ CSV") => `<button class="btn btn-borde" data-csv="${tipo}">${txt}</button>`;

/* ---------- Inicio: ver dashboard.js ---------- */

/* =====================================================================
   ENTRADAS (fecha automática, factura, bodega TK/TQ, ticket de calidad)
   ===================================================================== */
function formEntrada() {
  return `<p class="sub">Ingreso de compras y sobrantes devueltos. La fecha es automática. Una vez guardado, el registro solo se cambia con una solicitud de edición.</p>
    <form id="form-entrada" novalidate>
      <div class="form-grid">
        ${campoFecha("e-fecha")}
        <div class="campo"><label for="e-bodega">Bodega <span class="req">*</span></label><select id="e-bodega">${opciones(BODEGAS.map(b => [b, nomBodega(b)]), BODEGAS.length === 1 ? BODEGAS[0] : "", BODEGAS.length === 1 ? "" : "Selecciona…")}</select></div>
        <div class="campo"><label for="e-oc">Orden de compra <span class="req">*</span></label><input id="e-oc" placeholder="Ej: 102094803 o N/A"></div>
        <div class="campo"><label for="e-factura">Facturas <span class="req">*</span></label><input id="e-factura" placeholder="Ej: FE201210 o N/A"></div>
        <div class="campo"><label for="e-prov">Proveedor <span class="req">*</span></label><select id="e-prov">${opciones(OPC_PROVEEDORES(), "", "Selecciona un proveedor…")}</select>
          <span class="ayuda">¿No está? La supervisora lo agrega en Insumos y proveedores.</span></div>
        <div class="campo"><label for="e-rem">Remisión <span class="req">*</span></label><input id="e-rem" placeholder="Ej: REM-00402409"></div>
        <div class="campo ancho"><label for="e-insumo">Insumo <span class="req">*</span></label>
          <select id="e-insumo">${opciones(OPC_INSUMOS(), "", "Selecciona un insumo…")}</select><span class="ayuda" id="e-info"></span></div>
        <div class="campo"><label for="e-cant">Cantidad recibida <span class="req">*</span></label><input type="number" id="e-cant" min="1" step="1" placeholder="0"><span class="ayuda">Número entero mayor a 0</span></div>
        <div class="campo"><label for="e-und">Unidad</label><input id="e-und" readonly placeholder="Según el insumo"></div>
        <div class="campo"><label for="e-lote">Lote <span class="req">*</span></label><input id="e-lote" placeholder="Ej: TKT0346024 o N/A"></div>
        <div class="campo"><label for="e-fab">Fecha de fabricación <span class="req">*</span></label><input type="date" id="e-fab" max="${ahora().fecha}">${checkNA("e-fab")}</div>
        <div class="campo"><label for="e-venc">Fecha de vencimiento <span class="req">*</span></label><input type="date" id="e-venc"><span class="ayuda">Debe ser posterior a la de fabricación</span>${checkNA("e-venc")}</div>
        ${moduloActivo("calidad") ? `<div class="campo"><label for="e-calidad">¿Requiere revisión de calidad? <span class="req">*</span></label><select id="e-calidad">${opciones([["No", "No"], ["Sí", "Sí · crear ticket para Calidad"]], "No")}</select>
          <span class="ayuda" id="e-cal-ayuda">El material queda disponible de una vez.</span></div>` : `<input type="hidden" id="e-calidad" value="No">`}
        <div class="campo"><label for="e-por">Recibido por</label><input id="e-por" value="${esc(SESION.usuario)}" readonly></div>
        <div class="campo ancho"><label for="e-obs">Observaciones</label><input id="e-obs" placeholder="Ej: Se le da entrada por sobrante de OP 1948556"></div>
      </div>
      <p class="aviso rojo" id="e-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button type="reset" class="btn btn-borde">Limpiar</button><button class="btn btn-primario">Guardar entrada</button></div>
    </form>`;
}
function tablaRecepciones(filas) {
  return tabla([{ t: "Fecha" }, { t: "Bodega" }, { t: "OC" }, { t: "Facturas" }, { t: "Proveedor" }, { t: "Remisión" }, { t: "Insumo" }, { t: "Cantidad", cl: "num" }, { t: "Und" }, { t: "Lote" }, { t: "Fabricación" }, { t: "Vencimiento" }, { t: "Calidad" }, { t: "Recibido por" }, { t: "Obs." }, { t: "" }],
    filas.map(r => `<tr><td>${fFecha(r)}</td><td>${esc(r.bodega ? nomBodega(r.bodega) : "—")}</td><td>${esc(r.ordenCompra)}</td><td>${esc(r.factura || "—")}</td><td>${esc(r.proveedor)}</td><td>${esc(r.remision)}</td><td class="txt">${esc(insumoTxt(r.codigo))}</td><td class="num fuerte">${fmtN(r.cantidad)}</td><td>${esc(r.unidad)}</td><td>${esc(r.lote)}</td><td>${r.fechaFabricacion ? fmtF(r.fechaFabricacion) : "—"}</td><td>${r.fechaVencimiento ? fmtF(r.fechaVencimiento) : "—"}</td>
      <td>${r.origen === "saldo-inicial" ? `<span class="chip-e e-info">Saldo inicial</span>` : `<span class="chip-e ${ESTADO_CAL_CHIP[r.calidad?.estado] || "e-gris"}" title="${esc(r.calidad?.ticket || "")}">${esc(r.calidad?.estado || "No aplica")}${r.calidad?.ticket ? " · " + esc(r.calidad.ticket) : ""}</span>`}</td>
      <td>${esc(r.recibidoPor)}</td><td>${esc(r.observaciones)}</td><td>${btnEditar("recepciones", r.id)}</td></tr>`));
}
function initEntradas() {
  $("#e-insumo").addEventListener("change", e => {
    const i = calcInventario().find(x => x.codigo === e.target.value), m = D().maestro.find(x => x.codigo === e.target.value);
    $("#e-und").value = m?.unidad || i?.unidad || "";
    $("#e-info").innerHTML = i ? `Stock actual: <b>${fmtN(i.stock)} ${esc(i.unidad)}</b>` : "";
  });
  $("#e-calidad").addEventListener("change", e => {
    $("#e-cal-ayuda").textContent = e.target.value === "Sí" ? "Se crea un ticket para Calidad. El material queda BLOQUEADO hasta que Calidad lo apruebe." : "El material queda disponible de una vez.";
  });
  $("#form-entrada").addEventListener("reset", () => { $("#e-info").textContent = ""; setTimeout(() => { $("#e-por").value = SESION.usuario; $("#e-und").value = ""; $("#e-fab").disabled = $("#e-venc").disabled = false; }); });
  $("#form-entrada").addEventListener("submit", e => {
    e.preventDefault();
    const err = $("#e-error"); err.hidden = true;
    $$(".campo", e.target).forEach(c => c.classList.remove("invalido"));
    const req = ["e-bodega", "e-oc", "e-factura", "e-prov", "e-rem", "e-insumo", "e-cant", "e-lote", "e-fab", "e-venc"].filter(id => !$("#" + id).value.trim() && !$(`#${id}-na`)?.checked);
    const cant = Number($("#e-cant").value);
    if (!req.includes("e-cant") && (!Number.isInteger(cant) || cant <= 0)) req.push("e-cant");
    if (req.length) { req.forEach(id => $("#" + id).closest(".campo").classList.add("invalido")); err.textContent = "Revisa los campos marcados en rojo (obligatorios; la cantidad debe ser un entero mayor a 0)."; err.hidden = false; return; }
    const v = id => $("#" + id).value.trim();
    const fab = fechaONA("e-fab"), venc = fechaONA("e-venc");
    const errFecha = fab !== "N/A" && fab > ahora().fecha ? ["e-fab", "La fecha de fabricación no puede ser futura."] : fab !== "N/A" && venc !== "N/A" && venc <= fab ? ["e-venc", "La fecha de vencimiento debe ser posterior a la de fabricación."] : null;
    if (errFecha) { $("#" + errFecha[0]).closest(".campo").classList.add("invalido"); err.textContent = errFecha[1]; err.hidden = false; return; }
    const requiere = v("e-calidad") === "Sí";
    const id = nuevoId("R");
    const ticket = requiere ? nuevoId("CAL-") : "";
    D().recepciones.push({ id, origen: "compra", ...ahora(), bodega: v("e-bodega"), ordenCompra: v("e-oc"), factura: v("e-factura"), proveedor: v("e-prov"), remision: v("e-rem"), codigo: v("e-insumo"), cantidad: cant,
      unidad: v("e-und"), lote: U(v("e-lote")), fechaFabricacion: fab, fechaVencimiento: venc, recibidoPor: SESION.usuario, observaciones: v("e-obs"),
      calidad: requiere ? { requiere: "Sí", estado: "Pendiente", ticket, creado: new Date().toISOString() } : { requiere: "No", estado: "No aplica" } });
    registrarBitacora("Entrada registrada", "Entrada", id, `${insumoTxt(v("e-insumo"))} · +${cant} · lote ${U(v("e-lote"))} · vence ${fmtF(venc)} · ${nomBodega(v("e-bodega"))} · factura ${v("e-factura")}${requiere ? ` · ticket ${ticket} para Calidad` : ""}`);
    guardar(); toast(requiere ? `Entrada guardada. Ticket ${ticket} enviado a Calidad (material bloqueado).` : `Entrada guardada: +${fmtN(cant)} ${desc(v("e-insumo"))}`);
    cerrarModal(); actualizarBadges(); render();
  });
}

/* =====================================================================
   SALIDAS (fecha automática, lote FIFO automático, recibido por supervisora)
   ===================================================================== */
function formSalida() {
  return `<p class="sub">Registra una orden de producción con uno o varios insumos. El lote se asigna solo por FIFO; si un lote no alcanza, toma lo que falta del siguiente.</p>
    <form id="form-salida" novalidate>
      <div class="form-grid">
        ${campoFecha("s-fecha")}
        <div class="campo"><label for="s-op">Orden de producción <span class="req">*</span></label><input id="s-op" placeholder="Ej: 1956314"></div>
        <div class="campo"><label for="s-dest">Destino <span class="req">*</span></label><input id="s-dest" list="dl-dest" value="PRODUCCION"></div>
        <div class="campo"><label for="s-entrega">Entregado por</label><input id="s-entrega" value="${esc(SESION.usuario)}" readonly></div>
      </div>
      <div class="seccion-form"><h3>Insumos que salen</h3><button type="button" class="btn btn-borde btn-mini" id="btn-linea">+ Agregar insumo</button></div>
      <div class="ayuda-kit">
        <div class="campo"><label for="k-kit">Atajo: cargar insumos de un kit</label><select id="k-kit"><option value="">Selecciona kit…</option>${D().kits.map((k, i) => `<option value="${i}">${esc(k.kit)}</option>`).join("")}</select></div>
        <div class="campo"><label for="k-cant">Kits a producir</label><input type="number" id="k-cant" min="1" step="1" placeholder="0"></div>
        <button type="button" class="btn btn-amarillo-s" id="btn-kit">Calcular</button>
      </div>
      <div id="lineas"></div>
      <p class="aviso rojo" id="s-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button type="button" class="btn btn-borde" id="btn-limpiar-s">Limpiar</button><button class="btn btn-primario">Guardar salida</button></div>
    </form>
    <datalist id="dl-dest">${[...new Set([...D().salidas.map(s => s.destino), "PRODUCCION"].filter(Boolean))].map(v => `<option value="${esc(v)}">`).join("")}</datalist>`;
}
const chipRecibido = s => s.recibido?.estado === "Pendiente" ? `<span class="chip-e e-alerta">⏳ Por firmar</span>`
  : `${esc(s.recibidoPor || s.recibido?.por || "")}${s.recibido?.firma ? ` <button class="btn-lapiz" data-ver-firma="${esc(s.id)}" title="Ver firma">✍</button>` : ""}`;
function tablaSalidas(filas) {
  return tabla([{ t: "Fecha" }, { t: "OP" }, { t: "Destino" }, { t: "Insumo" }, { t: "Cantidad", cl: "num" }, { t: "Und" }, { t: "Lote" }, { t: "Entregó" }, { t: "Recibió" }, { t: "Obs." }, { t: "" }],
    filas.map(s => `<tr><td>${fFecha(s)}</td><td>${esc(s.ordenProduccion)}</td><td>${esc(s.destino)}</td><td class="txt">${esc(insumoTxt(s.codigo))}</td><td class="num fuerte">${fmtN(s.cantidad)}</td><td>${esc(s.unidad)}</td><td>${esc(s.lote)}</td><td>${esc(s.entregadoPor)}</td><td>${chipRecibido(s)}</td><td>${esc(s.observaciones)}</td><td>${btnEditar("salidas", s.id)}</td></tr>`));
}
function initSalidas() {
  const inv = calcInventario(), lotes = calcLotes();
  const cont = $("#lineas");
  /* Reparte todas las líneas en orden, descontando de los saldos lo que ya tomó la línea anterior */
  const repartirTodo = () => {
    const saldos = lotes.map(l => ({ ...l }));
    $$(".linea", cont).forEach(div => {
      const cod = $(".l-insumo", div).value, c = Number($(".l-cant", div).value || 0), info = $(".info", div);
      if (!cod) { info.innerHTML = ""; div._partes = []; return; }
      const i = inv.find(x => x.codigo === cod);
      const partes = c > 0 ? repartirFIFO(cod, c, saldos) : [];
      partes.forEach(p => { const l = saldos.find(x => x.codigo === cod && U(x.lote) === U(p.lote)); if (l) l.saldo -= p.cantidad; });
      div._partes = partes;
      const lotesTxt = partes.map(p => p.falta
        ? `<span class="chip-e e-peligro">Sin lote disponible: ${fmtN(p.cantidad)}</span>`
        : `<span class="chip-e e-ok">Lote ${esc(p.lote)}: ${fmtN(p.cantidad)} de ${fmtN(p.saldo)}</span>`).join(" ");
      info.innerHTML = `Stock actual: <b>${fmtN(i?.stock ?? 0)} ${esc(i?.unidad || "")}</b>${c > (i?.stock ?? 0) ? ` <span class="chip-e e-peligro">Supera el stock</span>` : ""}${partes.length ? `<br>Se toma de: ${lotesTxt}` : ""}`;
    });
  };
  const agregarLinea = (cod = "", cant = "") => {
    const div = document.createElement("div");
    div.className = "linea linea-auto";
    div.innerHTML = `
      <div class="campo"><label>Insumo <span class="req">*</span></label><select class="l-insumo">${opciones(OPC_INSUMOS(), cod, "Selecciona…")}</select></div>
      <div class="campo"><label>Cantidad <span class="req">*</span></label><input type="number" class="l-cant" min="0" step="any" value="${cant}"></div>
      <div class="campo"><label>Observaciones</label><input class="l-obs"></div>
      <button type="button" class="btn-quitar" title="Quitar">×</button>
      <div class="info"></div>`;
    cont.appendChild(div);
    $(".l-insumo", div).addEventListener("change", repartirTodo);
    $(".l-cant", div).addEventListener("input", repartirTodo);
    $(".btn-quitar", div).addEventListener("click", () => { div.remove(); if (!cont.children.length) agregarLinea(); repartirTodo(); });
    repartirTodo();
  };
  agregarLinea();
  $("#btn-linea").addEventListener("click", () => agregarLinea());
  $("#btn-limpiar-s").addEventListener("click", () => abrirRegistro("salidas"));
  $("#btn-kit").addEventListener("click", () => {
    const k = D().kits[$("#k-kit").value], n = Number($("#k-cant").value);
    if (!k || !(n > 0)) { toast("Selecciona un kit y la cantidad de kits."); return; }
    cont.innerHTML = "";
    const conocidos = new Set(D().maestro.filter(m => m.activo !== false).map(m => m.codigo));
    k.insumos.filter(x => conocidos.has(x.codigo)).forEach(x => agregarLinea(x.codigo, Math.ceil(n * x.factor)));
    toast(`Cargados ${cont.children.length} insumos para ${fmtN(n)} kits.`);
  });
  $("#form-salida").addEventListener("submit", e => {
    e.preventDefault();
    repartirTodo();
    const err = $("#s-error"); err.hidden = true;
    $$(".campo", e.target).forEach(c => c.classList.remove("invalido"));
    const req = ["s-op", "s-dest"].filter(id => !$("#" + id).value.trim());
    req.forEach(id => $("#" + id).closest(".campo").classList.add("invalido"));
    const lineas = $$(".linea", cont).map(div => ({ div, cod: $(".l-insumo", div).value, cant: Number($(".l-cant", div).value), obs: $(".l-obs", div).value.trim(), partes: div._partes || [] }));
    let malas = 0;
    lineas.forEach(l => { if (!l.cod) { $(".l-insumo", l.div).closest(".campo").classList.add("invalido"); malas++; } if (!(l.cant > 0)) { $(".l-cant", l.div).closest(".campo").classList.add("invalido"); malas++; } });
    if (req.length || malas) { err.textContent = "Revisa los campos marcados en rojo. Cada insumo necesita una cantidad mayor a 0."; err.hidden = false; return; }
    const sinLote = lineas.filter(l => l.partes.some(p => p.falta));
    if (sinLote.length && !confirm(`${sinLote.length} insumo(s) no tienen lotes suficientes: lo que falta saldrá como "N/A" y el inventario puede quedar negativo. ¿Guardar de todas formas?`)) return;
    const v = id => $("#" + id).value.trim();
    let registros = 0;
    lineas.forEach(l => l.partes.forEach(p => {
      const id = nuevoId("S");
      D().salidas.push({ id, ...ahora(), ordenProduccion: v("s-op"), destino: U(v("s-dest")), codigo: l.cod, cantidad: p.cantidad, unidad: (inv.find(i => i.codigo === l.cod) || {}).unidad || "",
        lote: p.lote, entregadoPor: SESION.usuario, recibidoPor: "", recibido: { estado: "Pendiente", por: "", fecha: "" }, observaciones: l.obs });
      registros++;
      registrarBitacora("Salida registrada", "Salida", id, `OP ${v("s-op")} · ${insumoTxt(l.cod)} · −${p.cantidad} · lote ${p.lote}`);
    }));
    guardar(); toast(`Salida guardada: OP ${v("s-op")} · ${registros} registro(s) por lote. Pendiente de recibir.`); cerrarModal(); actualizarBadges(); render();
  });
}
/* La supervisora confirma el "Recibido por" de cada OP */
function porRecibir() {
  const g = {};
  D().salidas.filter(s => s.recibido?.estado === "Pendiente").forEach(s => (g[s.ordenProduccion] ||= []).push(s));
  return Object.entries(g).map(([op, items]) => ({ op, items }));
}
function abrirPorRecibir() {
  const grupos = porRecibir();
  abrirModal(`Salidas por firmar (${grupos.length} OP)`, grupos.length ? `
    <p class="sub">${PUEDE.firmarSalidas ? "Escribe quién recibió el material en producción y firma en el recuadro. La fecha y la hora las pone el sistema." : "Estas salidas esperan la firma de la supervisora."}</p>
    ${grupos.map(g => `<section class="card firma-op" style="margin-bottom:14px" data-op="${esc(g.op)}"><div class="grupo-titulo"><h2>OP ${esc(g.op)}</h2><span class="sub">${g.items.length} registro(s)</span></div>
      ${tabla([{ t: "Fecha" }, { t: "Insumo" }, { t: "Lote" }, { t: "Cantidad", cl: "num" }, { t: "Entregó" }], g.items.map(s => `<tr><td>${fFecha(s)}</td><td class="txt">${esc(insumoTxt(s.codigo))}</td><td>${esc(s.lote)}</td><td class="num fuerte">${fmtN(s.cantidad)}</td><td>${esc(s.entregadoPor)}</td></tr>`))}
      ${PUEDE.firmarSalidas ? `<div class="firma-form">
        <div class="campo"><label>Recibido por <span class="req">*</span></label><input class="f-recibe" placeholder="Nombre de quien recibe en producción"></div>
        <div class="campo"><label>Firma de la supervisora <span class="req">*</span></label><canvas class="firma-pad" width="520" height="160"></canvas>
          <span class="ayuda">Firma con el dedo o el mouse · <button type="button" class="link-btn" data-borrar-firma>Borrar firma</button></span></div>
        ${campoFecha("f-fecha-" + g.op)}
        <p class="aviso rojo f-error" hidden></p>
        <div class="acciones-form"><button class="btn btn-ok" data-firmar="${esc(g.op)}">✍ Firmar y confirmar recibido</button></div></div>` : `<span class="chip-e e-alerta">Esperando firma de la supervisora</span>`}
    </section>`).join("")}`
    : `<p class="vacio">No hay salidas pendientes de firma 👍</p>`, { ancho: true, lectura: "por-recibir", formulario: PUEDE.firmarSalidas });
  $$(".firma-pad").forEach(prepararFirma);
}
/* Recuadro de firma: dibuja con mouse, dedo o lápiz */
function prepararFirma(cv) {
  const ctx = cv.getContext("2d");
  ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1F2937";
  let dibujando = false;
  const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
  cv.addEventListener("pointerdown", e => { dibujando = true; cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); cv.dataset.firmado = "1"; });
  cv.addEventListener("pointermove", e => { if (!dibujando) return; ctx.lineTo(...pos(e)); ctx.stroke(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => cv.addEventListener(ev, () => (dibujando = false)));
}
function confirmarRecibido(op) {
  if (!PUEDE.firmarSalidas) return;
  const caja = $(`.firma-op[data-op="${CSS.escape(op)}"]`), nombre = $(".f-recibe", caja).value.trim(), cv = $(".firma-pad", caja), err = $(".f-error", caja);
  if (!nombre || !cv.dataset.firmado) { err.textContent = !nombre ? "Escribe quién recibió el material." : "Falta la firma."; err.hidden = false; return; }
  const items = D().salidas.filter(s => s.ordenProduccion === op && s.recibido?.estado === "Pendiente");
  const t = ahora(), firma = cv.toDataURL("image/png");
  items.forEach(s => { s.recibido = { estado: "Recibido", por: U(nombre), firma, firmadoPor: SESION.usuario, fecha: t.fecha, hora: t.hora }; s.recibidoPor = U(nombre); });
  registrarBitacora("Salida firmada", "Salida", "OP " + op, `Recibido por ${U(nombre)} · firmó ${SESION.usuario}`);
  guardar(); actualizarBadges(); render(); abrirPorRecibir(); toast(`OP ${op} firmada: recibido por ${U(nombre)}.`);
}
function verFirma(id) {
  const s = D().salidas.find(x => x.id === id);
  if (!s?.recibido?.firma) return;
  const volver = $("#modal").hidden ? null : $("#modal").dataset.lectura || null;
  abrirModal(`Firma · OP ${s.ordenProduccion}`, `<div class="firma-ver"><img src="${s.recibido.firma}" alt="Firma"></div>
    <p><b>Recibido por:</b> ${esc(s.recibido.por)}<br><b>Firmó:</b> ${esc(s.recibido.firmadoPor)} · ${fmtF(s.recibido.fecha)} ${esc(s.recibido.hora || "")}</p>
    <div class="acciones-form"><button class="btn btn-borde" data-cerrar>Cerrar</button></div>`);
  volverA = volver;
}

/* =====================================================================
   DEVOLUCIONES (vuelve material: buenas al inventario, malas a averías)
   ===================================================================== */
function formDevolucion() {
  const ops = [...new Set(D().salidas.map(s => s.ordenProduccion).filter(Boolean))].sort((a, b) => String(b).localeCompare(String(a)));
  return `<p class="sub">Material que producción devuelve. Las unidades <b>buenas</b> (sobrante) vuelven al inventario y a su lote; las <b>malas</b> (rechazo) se crean como avería pendiente de completar.</p>
    <form id="form-dev" novalidate>
      <div class="form-grid">
        ${campoFecha("d-fecha")}
        <div class="campo"><label for="d-op">Orden de producción <span class="req">*</span></label><select id="d-op">${opciones(ops.map(o => [o, "OP " + o]), "", "Selecciona la OP…")}</select></div>
        <div class="campo ancho"><label for="d-sal">Insumo y lote que salió con esa OP <span class="req">*</span></label><select id="d-sal" disabled><option value="">Primero elige la OP…</option></select><span class="ayuda" id="d-info"></span></div>
        <div class="campo"><label for="d-buenas">Unidades buenas (sobrante)</label><input type="number" id="d-buenas" min="0" step="1" value="0"><span class="ayuda">Vuelven al inventario</span></div>
        <div class="campo"><label for="d-malas">Unidades malas (rechazo)</label><input type="number" id="d-malas" min="0" step="1" value="0"><span class="ayuda">Pasan a averías</span></div>
        <div class="campo"><label for="d-por">Registrado por</label><input id="d-por" value="${esc(SESION.usuario)}" readonly></div>
        <div class="campo ancho"><label for="d-obs">Observaciones</label><input id="d-obs" placeholder="Ej: Sobrante de la OP, material en buen estado"></div>
      </div>
      <p class="aviso rojo" id="d-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button class="btn btn-primario">Guardar devolución</button></div>
    </form>`;
}
/* Lo que salió de un insumo+lote con una OP, menos lo ya devuelto */
function salidoDisponible(op, cod, lote) {
  const salio = D().salidas.filter(s => s.ordenProduccion === op && s.codigo === cod && U(s.lote) === U(lote)).reduce((a, s) => a + Number(s.cantidad || 0), 0);
  const devuelto = D().devoluciones.filter(x => x.op === op && x.codigo === cod && U(x.lote) === U(lote)).reduce((a, x) => a + Number(x.buenas || 0) + Number(x.malas || 0), 0);
  return { salio, devuelto, max: salio - devuelto };
}
function initDevolucion() {
  const selOp = $("#d-op"), selSal = $("#d-sal");
  selOp.addEventListener("change", () => {
    const pares = {};
    D().salidas.filter(s => s.ordenProduccion === selOp.value).forEach(s => (pares[s.codigo + "|" + s.lote] = { cod: s.codigo, lote: s.lote }));
    selSal.innerHTML = opciones(Object.values(pares).map(p => { const d = salidoDisponible(selOp.value, p.cod, p.lote); return [p.cod + "|" + p.lote, `${insumoTxt(p.cod)} · lote ${p.lote} · salieron ${fmtN(d.salio)}`]; }), "", "Selecciona…");
    selSal.disabled = !selOp.value; $("#d-info").textContent = "";
  });
  selSal.addEventListener("change", () => {
    const [cod, lote] = selSal.value.split("|");
    const d = cod ? salidoDisponible(selOp.value, cod, lote) : null;
    $("#d-info").innerHTML = d ? `Salieron <b>${fmtN(d.salio)}</b> · ya devueltas ${fmtN(d.devuelto)} · máximo a devolver <b>${fmtN(d.max)}</b>` : "";
  });
  $("#form-dev").addEventListener("submit", e => {
    e.preventDefault();
    const err = $("#d-error"); err.hidden = true;
    $$(".campo", e.target).forEach(c => c.classList.remove("invalido"));
    const buenas = Number($("#d-buenas").value || 0), malas = Number($("#d-malas").value || 0);
    const malos = [];
    if (!selOp.value) malos.push("d-op");
    if (!selSal.value) malos.push("d-sal");
    if (!Number.isInteger(buenas) || buenas < 0) malos.push("d-buenas");
    if (!Number.isInteger(malas) || malas < 0) malos.push("d-malas");
    if (malos.length) { malos.forEach(id => $("#" + id).closest(".campo").classList.add("invalido")); err.textContent = "Revisa los campos marcados en rojo."; err.hidden = false; return; }
    if (buenas + malas <= 0) { err.textContent = "Escribe cuántas unidades devolvieron (buenas, malas o ambas)."; err.hidden = false; return; }
    const [cod, lote] = selSal.value.split("|");
    const d = salidoDisponible(selOp.value, cod, lote);
    if (buenas + malas > d.max) { err.textContent = `No puedes devolver más de lo que salió: máximo ${fmtN(d.max)} unidades para este lote y OP.`; err.hidden = false; return; }
    const id = nuevoId("DV"), obs = $("#d-obs").value.trim();
    const motivo = malas > 0 && buenas > 0 ? "Sobrante y rechazo" : malas > 0 ? "Rechazo" : "Sobrante";
    D().devoluciones.push({ id, ...ahora(), op: selOp.value, codigo: cod, lote, buenas, malas, motivo, registradoPor: SESION.usuario, observaciones: obs });
    registrarBitacora("Devolución registrada", "Devolución", id, `OP ${selOp.value} · ${insumoTxt(cod)} · lote ${lote} · buenas ${buenas} · malas ${malas}`);
    if (malas > 0) {
      const aid = nuevoId("A");
      D().averias.push({ id: aid, ...ahora(), tipo: "Rechazo", estado: "Pendiente de completar", codigo: cod, lote, op: selOp.value, cantidad: malas, devolucion: id, registradoPor: SESION.usuario, observaciones: "" });
      registrarBitacora("Avería creada automáticamente (rechazo)", "Avería", aid, `Desde devolución ${id} · ${malas} und`);
    }
    guardar(); cerrarModal(); actualizarBadges(); render();
    toast(malas > 0 ? `Devolución guardada. ${malas} und quedaron como avería pendiente de completar.` : `Devolución guardada: +${buenas} al inventario.`);
  });
}
function tablaDevoluciones(filas) {
  return tabla([{ t: "Fecha" }, { t: "OP" }, { t: "Insumo" }, { t: "Lote" }, { t: "Buenas", cl: "num" }, { t: "Malas", cl: "num" }, { t: "Motivo" }, { t: "Registró" }, { t: "Obs." }, { t: "" }],
    filas.map(x => `<tr><td>${fFecha(x)}</td><td>${esc(x.op)}</td><td class="txt">${esc(insumoTxt(x.codigo))}</td><td>${esc(x.lote)}</td><td class="num fuerte">${fmtN(x.buenas)}</td><td class="num fuerte">${fmtN(x.malas)}</td>
      <td><span class="chip-e ${x.malas > 0 ? "e-peligro" : "e-ok"}">${esc(x.motivo)}</span></td><td>${esc(x.registradoPor)}</td><td>${esc(x.observaciones)}</td><td>${btnEditar("devoluciones", x.id)}</td></tr>`));
}

/* =====================================================================
   AVERÍAS (rechazos automáticos + conteos; fecha automática)
   ===================================================================== */
function formAveria(aid = null) {
  const pend = averiasPendientes();
  return `<p class="sub">Elige el tipo: <b>Rechazo</b> para terminar de llenar una avería que llegó desde Devoluciones, o <b>Conteo</b> para registrar una avería nueva encontrada en un conteo.</p>
    <form id="form-av" novalidate>
      <div class="form-grid">
        ${campoFecha("a-fecha")}
        <div class="campo"><label for="a-tipo">Tipo <span class="req">*</span></label><select id="a-tipo">${opciones([["Rechazo", `Rechazo · viene de devoluciones (${pend.length})`], ["Conteo", "Conteo · avería nueva"]], aid ? "Rechazo" : pend.length ? "Rechazo" : "Conteo")}</select></div>
        <div class="campo ancho" data-solo="Rechazo"><label for="a-pend">Rechazo por completar <span class="req">*</span></label>
          <select id="a-pend">${opciones(pend.map(a => [a.id, `${insumoTxt(a.codigo)} · OP ${a.op} · lote ${a.lote} · ${fmtN(a.cantidad)} und`]), aid || "", pend.length ? "Selecciona…" : "No hay rechazos pendientes")}</select></div>
        <div class="campo ancho"><label for="a-insumo">Insumo <span class="req">*</span></label><select id="a-insumo">${opciones(OPC_INSUMOS(), "", "Selecciona un insumo…")}</select></div>
        <div class="campo"><label for="a-lote">Lote</label><input id="a-lote" placeholder="Opcional"></div>
        <div class="campo"><label for="a-op">OP</label><input id="a-op" placeholder="Opcional"></div>
        <div class="campo"><label for="a-cant">Cantidad <span class="req">*</span></label><input type="number" id="a-cant" min="1" step="1"></div>
        <div class="campo"><label for="a-por">Registrado por</label><input id="a-por" value="${esc(SESION.usuario)}" readonly></div>
        <div class="campo ancho"><label for="a-obs">Observaciones / causa <span class="req">*</span></label><input id="a-obs" placeholder="Ej: Caja rota, humedad, material defectuoso…"></div>
      </div>
      <p class="aviso rojo" id="a-error" hidden></p>
      <div class="acciones-form"><button type="button" class="btn btn-borde" data-cerrar>Cancelar</button><button class="btn btn-primario" id="a-guardar">Guardar avería</button></div>
    </form>`;
}
function initAveria() {
  const form = $("#form-av"), tipo = $("#a-tipo"), pend = $("#a-pend");
  const bloquear = si => ["a-insumo", "a-lote", "a-op", "a-cant"].forEach(id => { const el = $("#" + id); el.disabled = si; });
  const cargarRechazo = () => {
    const a = D().averias.find(x => x.id === pend.value);
    $("#a-insumo").value = a?.codigo || ""; $("#a-lote").value = a?.lote || ""; $("#a-op").value = a?.op || ""; $("#a-cant").value = a?.cantidad || "";
  };
  const pintar = () => {
    const rech = tipo.value === "Rechazo";
    $$("[data-solo='Rechazo']", form).forEach(el => (el.hidden = !rech));
    bloquear(rech);
    if (rech) cargarRechazo(); else { ["a-insumo", "a-lote", "a-op", "a-cant"].forEach(id => ($("#" + id).value = "")); }
    $("#a-guardar").textContent = rech ? "Completar avería" : "Guardar avería";
  };
  tipo.addEventListener("change", pintar);
  pend.addEventListener("change", cargarRechazo);
  pintar();
  form.addEventListener("submit", e => {
    e.preventDefault();
    const err = $("#a-error"); err.hidden = true;
    $$(".campo", form).forEach(c => c.classList.remove("invalido"));
    const obs = $("#a-obs").value.trim(), t = ahora();
    if (tipo.value === "Rechazo") {
      const malos = [!pend.value && "a-pend", !obs && "a-obs"].filter(Boolean);
      if (malos.length) { malos.forEach(id => $("#" + id).closest(".campo").classList.add("invalido")); err.textContent = !pend.value ? "Selecciona el rechazo que vas a completar." : "Escribe la causa u observación."; err.hidden = false; return; }
      const a = D().averias.find(x => x.id === pend.value);
      Object.assign(a, { observaciones: obs, estado: "Completa", completadaPor: SESION.usuario, fechaCompletada: t.fecha, horaCompletada: t.hora });
      registrarBitacora("Avería completada", "Avería", a.id, obs);
    } else {
      const cod = $("#a-insumo").value, cant = Number($("#a-cant").value);
      const malos = [!cod && "a-insumo", (!Number.isInteger(cant) || cant <= 0) && "a-cant", !obs && "a-obs"].filter(Boolean);
      if (malos.length) { malos.forEach(id => $("#" + id).closest(".campo").classList.add("invalido")); err.textContent = "Revisa los campos marcados en rojo."; err.hidden = false; return; }
      const id = nuevoId("A");
      D().averias.push({ id, ...t, tipo: "Conteo", estado: "Completa", codigo: cod, lote: U($("#a-lote").value), op: $("#a-op").value.trim(), cantidad: cant, registradoPor: SESION.usuario, observaciones: obs });
      registrarBitacora("Avería registrada", "Avería", id, `Conteo · ${insumoTxt(cod)} · ${cant} und · ${obs}`);
    }
    guardar(); cerrarModal(); actualizarBadges(); render(); toast(tipo.value === "Rechazo" ? "Avería por rechazo completada." : "Avería por conteo guardada.");
  });
}
const averiasPendientes = () => D().averias.filter(a => a.estado === "Pendiente de completar");
function tablaAverias(filas) {
  return tabla([{ t: "Fecha" }, { t: "Tipo" }, { t: "Estado" }, { t: "OP" }, { t: "Lote" }, { t: "Insumo" }, { t: "Cantidad", cl: "num" }, { t: "Observaciones" }, { t: "" }],
    filas.map(a => `<tr class="${a.estado === "Pendiente de completar" ? "fila-espera" : ""}"><td>${fFecha(a)}</td><td>${esc(a.tipo)}</td><td><span class="chip-e ${a.estado === "Completa" ? "e-ok" : "e-alerta"}">${esc(a.estado)}</span></td><td>${esc(a.op || "—")}</td><td>${esc(a.lote || "—")}</td><td class="txt">${esc(insumoTxt(a.codigo))}</td><td class="num fuerte">${fmtN(a.cantidad)}</td><td class="txt">${esc(a.observaciones)}</td>
      <td>${a.estado === "Pendiente de completar" && PUEDE.registrar ? `<button class="btn btn-amarillo-s btn-mini" data-completar="${a.id}">Completar</button>` : btnEditar("averias", a.id)}</td></tr>`));
}

/* =====================================================================
   PANTALLA DE MÓDULO (registro) + LECTURA EN VENTANA FLOTANTE
   ===================================================================== */
const MODULOS = {
  entradas: { titulo: "Entradas registradas", tabla: "recepciones", csv: "entradas", desc: `Ingreso de compras y sobrantes. Fecha automática, factura, bodega${BODEGAS.length > 1 ? " (" + BODEGAS.map(nomBodega).join(" / ") + ")" : ""} y revisión de calidad cuando aplique.`, nuevo: "+ Nueva entrada", ver: "Ver entradas", ico: "↓",
    leer: () => tablaRecepciones([...D().recepciones].reverse()) },
  salidas: { titulo: "Salidas registradas", tabla: "salidas", csv: "salidas", desc: "Salidas por orden de producción. El lote se asigna solo por FIFO y la supervisora confirma el recibido.", nuevo: "+ Nueva salida", ver: "Ver salidas", ico: "↑", amarillo: true,
    leer: () => tablaSalidas([...D().salidas].reverse()) },
  devoluciones: { titulo: "Devoluciones registradas", tabla: "devoluciones", csv: "devoluciones", desc: "Material que devuelve producción: buenas vuelven al inventario, malas pasan a averías.", nuevo: "+ Nueva devolución", ver: "Ver devoluciones", ico: "↺",
    leer: () => tablaDevoluciones([...D().devoluciones].reverse()) },
  averias: { titulo: "Averías registradas", tabla: "averias", csv: "averias", desc: "Averías por rechazo (llegan solas desde devoluciones) y por conteo realizado.", nuevo: "+ Nueva avería", ver: "Ver averías", ico: "⚠",
    leer: () => { const res = calcAverias(), con = res.filter(r => r.total > 0); const pend = averiasPendientes(); return `
      ${pend.length ? `<h3 class="titulo-lectura">Por completar <small>${pend.length} llegaron desde devoluciones con rechazo</small></h3>${tablaAverias(pend)}` : ""}
      <h3 class="titulo-lectura">Registro de averías</h3>${tablaAverias([...D().averias].reverse())}
      <h3 class="titulo-lectura">Suma de averías por código <small>${con.length} de ${res.length} insumos con averías</small></h3>
      ${tabla([{ t: "Código" }, { t: "Descripción" }, { t: "Total", cl: "num" }, { t: "Estado" }], res.map(r => `<tr><td>${r.codigo}</td><td class="txt">${esc(r.descripcion)}</td><td class="num fuerte">${fmtN(r.total)}</td><td><span class="chip-e ${r.total > 0 ? "e-peligro" : "e-ok"}">${r.estado}</span></td></tr>`))}`; } },
};
function vModulo(clave) {
  const m = MODULOS[clave], regs = D()[m.tabla];
  const ult = [...regs].map(r => r.fecha).filter(Boolean).sort().pop();
  const pendSol = BD.solicitudes.filter(s => s.estado === "Pendiente" && s.tabla === m.tabla).length;
  const extra = clave === "salidas" ? { n: porRecibir().length, txt: PUEDE.firmarSalidas ? "✍ Firmar salidas" : "⏳ Por firmar", attr: "data-por-recibir", lbl: "OP por firmar" }
    : clave === "averias" ? { n: averiasPendientes().length, txt: "⚠ Por completar", attr: 'data-leer="averias"', lbl: "Por completar" }
    : clave === "entradas" ? { n: D().recepciones.filter(r => r.calidad?.estado === "Pendiente").length, txt: "", attr: "", lbl: "En revisión de calidad" } : null;
  setAcciones(btnCsv(m.csv, "⤓ Exportar CSV"));
  return `<section class="card modulo">
    <div class="modulo-ico">${m.ico}</div>
    <p class="modulo-desc">${m.desc}</p>
    <div class="modulo-botones">
      ${PUEDE.registrar ? `<button class="btn btn-grande ${m.amarillo ? "btn-amarillo-s" : "btn-primario"}" data-registrar="${clave}">${m.nuevo}</button>` : ""}
      <button class="btn btn-grande btn-borde" data-leer="${clave}">☰ ${m.ver}</button>
      ${extra && extra.txt && extra.n ? `<button class="btn btn-grande ${clave === "salidas" && PUEDE.firmarSalidas ? "btn-amarillo-s" : "btn-borde"}" ${extra.attr}>${extra.txt} (${extra.n})</button>` : ""}
    </div>
    <div class="modulo-datos">
      <div><small>Registros</small><b>${fmtN(regs.length)}</b></div>
      <div><small>Último registro</small><b>${ult ? fmtF(ult) : "—"}</b></div>
      <div><small>${extra ? extra.lbl : "Solicitudes pendientes"}</small><b>${extra ? extra.n : pendSol}</b></div>
    </div>
  </section>`;
}
function abrirLectura(clave) {
  if (clave === "por-recibir") return abrirPorRecibir();
  const m = MODULOS[clave];
  abrirModal(`${m.titulo} (${D()[m.tabla].length})`, `
    <p class="sub">Solo lectura${PUEDE.solicitarEdicion ? " · usa ✎ para solicitar un cambio a un registro" : ""}.</p>
    <div class="filtros"><input id="f-lectura" placeholder="Buscar en los registros…">${btnCsv(m.csv, "⤓ Exportar CSV")}</div>
    <div id="lectura">${m.leer()}</div>`, { ancho: true, lectura: clave });
  $("#f-lectura").addEventListener("input", e => {
    const q = U(e.target.value);
    $$("#lectura tbody tr").forEach(tr => (tr.hidden = !!q && !U(tr.textContent).includes(q)));
  });
}
const REGISTROS = {
  entradas: { titulo: "Nueva entrada de insumos", form: formEntrada, init: initEntradas },
  salidas: { titulo: "Nueva salida de insumos", form: formSalida, init: initSalidas, ancho: true },
  devoluciones: { titulo: "Nueva devolución", form: formDevolucion, init: initDevolucion },
  averias: { titulo: "Nueva avería", form: () => formAveria(), init: initAveria },
};
function abrirRegistro(tipo) {
  if (!PUEDE.registrar) return;
  const r = REGISTROS[tipo];
  abrirModal(r.titulo, r.form(), { ancho: r.ancho, formulario: true });
  r.init();
  $("#modal-cuerpo select:not([disabled]), #modal-cuerpo input:not([readonly])")?.focus();
}
function abrirCompletarAveria(aid) {
  if (!PUEDE.registrar) return;
  abrirModal("Completar avería por rechazo", formAveria(aid), { formulario: true });
  initAveria();
}

/* =====================================================================
   INVENTARIO (agrupado por uso en kits: comunes a los 3, compartidos, únicos)
   ===================================================================== */
function grupoInventario(i) {
  const k = i.kits;
  if (i.tipo === "PT") return { orden: 20, titulo: BODEGAS.includes("KT") ? "Producto terminado · Bodega KT" : "Producto terminado" };
  if (k.length === 3) return { orden: 0, titulo: "Comunes a los 3 kits (RN, VH y VIP)" };
  if (k.length === 2) return { orden: 1, titulo: `Compartidos: kits ${k.join(" y ")}` };
  if (k.length === 1) return { orden: 2 + ["RN", "VH", "VIP"].indexOf(k[0]), titulo: { RN: "Solo KIT WINNY SENSITIVE RN · 112226", VH: "Solo KIT WINNY VH · 115362", VIP: "Solo KIT WINNY VH VIP · 118477" }[k[0]] };
  return { orden: 9, titulo: "Otros insumos (no están en la composición de un kit)" };
}
function vInventario() {
  const inv = calcInventario(), q = U(filtros.inv || "");
  setAcciones(btnCsv("inventario", "⤓ Exportar CSV"));
  const grupos = {};
  inv.filter(i => !q || U(i.codigo + " " + i.descripcion).includes(q)).forEach(i => { const g = grupoInventario(i); (grupos[g.titulo] ||= { ...g, filas: [] }).filas.push(i); });
  const html = Object.values(grupos).sort((a, b) => a.orden - b.orden).map(g => `
    <section class="card"><div class="grupo-titulo"><h2>${esc(g.titulo)}</h2><span class="sub">${g.filas.length} insumos</span></div>
    ${tabla([{ t: "Código" }, { t: "Descripción" }, { t: "Kits" }, { t: "Stock inicial", cl: "num" }, { t: "Entradas", cl: "num" }, { t: "Devoluc.", cl: "num" }, { t: "Salidas", cl: "num" }, { t: "Stock actual", cl: "num" }, { t: "En calidad", cl: "num" }, { t: "Unidad" }, { t: "Últ. entrada" }, { t: "Últ. salida" }, { t: "" }],
      g.filas.map(i => `<tr><td>${i.codigo}</td><td class="txt">${esc(i.descripcion)}</td><td>${i.kits.length ? i.kits.map(k => `<span class="chip-e e-info">${k}</span>`).join(" ") : "—"}</td><td class="num">${fmtN(i.stockInicial)}</td><td class="num">${fmtN(i.entradas)}</td><td class="num">${fmtN(i.devueltas)}</td><td class="num">${fmtN(i.salidas)}</td>
        <td class="num fuerte ${estadoStock(i.stock) ? "stock-" + estadoStock(i.stock) : ""}">${fmtN(i.stock)}</td><td class="num">${i.enCalidad ? `<span class="chip-e e-alerta">${fmtN(i.enCalidad)}</span>` : "—"}</td><td>${esc(i.unidad)}</td><td>${fmtF(i.ultE)}</td><td>${fmtF(i.ultS)}</td><td>${btnEditar("insumos", i.id)}</td></tr>`))}
    </section>`).join("");
  return `<div class="filtros"><input id="f-inv" placeholder="Buscar por código o descripción…" value="${esc(filtros.inv || "")}"></div>
  <p class="aviso">Stock actual = stock inicial + entradas + devoluciones buenas − salidas. "En calidad" son unidades bloqueadas esperando aprobación. <span class="chip-e e-alerta">0 a 100</span> stock bajo · <span class="chip-e e-peligro">menor a 0</span> negativo.</p>
  ${html || `<div class="card vacio">Sin resultados</div>`}`;
}

/* ---------- Control de lotes FIFO (en orden de uso) ---------- */
function vLotes() {
  const lotes = calcLotes(), tab = filtros.lotesTab || "control", q = U(filtros.lotes || "");
  setAcciones(btnCsv("lotes", "⤓ Exportar CSV"));
  const base = tab === "control" ? lotes.filter(l => l.saldo >= 0) : lotes.filter(l => l.saldo < 0);
  const filas = lotesEnOrdenDeUso(base).filter(l => !q || U(l.codigo + " " + l.insumo + " " + l.lote).includes(q));
  const cls = p => ({ "USAR PRIMERO": "fila-usar", "EN ESPERA": "fila-espera", REVISAR: "fila-revisar" }[p] || "");
  let previo = "";
  return `<div class="tabs">
    <button class="tab ${tab === "control" ? "activo" : ""}" data-lotes-tab="control">Control lotes (${lotes.filter(l => l.saldo >= 0).length})</button>
    <button class="tab ${tab === "revisar" ? "activo" : ""}" data-lotes-tab="revisar">Lotes por revisar (${lotes.filter(l => l.saldo < 0).length})</button></div>
  ${tab === "revisar" ? `<p class="aviso rojo">Lotes con salidas registradas pero sin entrada o saldo inicial suficiente.</p>` : `<p class="aviso">Ordenado por insumo y <b>en orden de uso</b>: el N° 1 es el lote que debe salir primero (FIFO). Los agotados van al final de cada insumo. Las entradas bloqueadas por Calidad no aparecen hasta ser aprobadas.</p>`}
  <div class="filtros"><input id="f-lotes" placeholder="Buscar código, insumo o lote…" value="${esc(filtros.lotes || "")}"></div>
  <section class="card">${tabla([{ t: "Insumo" }, { t: "Orden de uso", cl: "num" }, { t: "Lote" }, { t: "Fecha entrada" }, { t: "Vence" }, { t: "Saldo", cl: "num" }, { t: "Prioridad FIFO" }, { t: "Entradas", cl: "num" }, { t: "Salidas", cl: "num" }, { t: "Control" }],
    filas.map(l => { const nuevo = l.codigo !== previo; previo = l.codigo; return `<tr class="${cls(l.prioridad)} ${nuevo ? "fila-grupo" : ""}"><td class="txt">${nuevo ? `<b>${esc(l.insumo)}</b><br><small class="muted">${l.codigo}</small>` : ""}</td><td class="num fuerte">${l.orden ? l.orden + "°" : "—"}</td><td>${esc(l.lote)}</td><td>${fmtF(l.fecha)}</td><td>${l.vence ? fmtF(l.vence) : "—"}</td><td class="num fuerte">${fmtN(l.saldo)}</td><td>${chipPrioridad(l.prioridad)}</td><td class="num">${fmtN(l.entradas)}</td><td class="num">${fmtN(l.salidas)}</td><td>${esc(l.control)}</td></tr>`; }),
    tab === "revisar" ? "No hay lotes por revisar 👍" : "Sin lotes")}</section>`;
}

/* ---------- Códigos kits ---------- */
function vKits() {
  setAcciones(btnCsv("kits", "⤓ Exportar CSV"));
  const enInv = new Set(D().insumos.map(i => i.codigo));
  const comunes = D().maestro.filter(m => m.tipo !== "PT" && kitsDe(m.codigo).length === 3);
  return `<p class="aviso">Composición de cada kit (Excel de productos actualizado) y cuánto insumo consume una unidad producida. Los materiales marcados como <span class="chip-e e-ok">común</span> se usan en los 3 kits. Debajo de cada kit está su producto terminado (Bodega KT).</p>
  ${comunes.length ? `<section class="card"><h2>Materiales comunes a los 3 kits</h2><p class="sub">Se descuentan del mismo inventario sin importar qué kit se produzca.</p>
    ${tabla([{ t: "Código" }, { t: "Insumo" }, { t: "Consumo por kit" }], comunes.map(m => `<tr><td>${m.codigo}</td><td class="txt">${esc(m.descripcion)}</td><td>${D().kits.map(k => `<span class="chip-e e-info">${nombreKit(k).corto}: ${esc((k.insumos.find(x => x.codigo === m.codigo) || {}).regla || "")}</span>`).join(" ")}</td></tr>`))}</section>` : ""}
  <div class="kits">${D().kits.map(k => { const n = nombreKit(k); return `
    <section class="card"><div class="kit-cab"><h2>${esc(n.nombre)}</h2><b>Cod. oferta ${esc(n.cod)}</b></div>
    ${tabla([{ t: "Código" }, { t: "Insumo" }, { t: "Consumo por kit" }],
      k.insumos.map(x => `<tr><td>${x.codigo}</td><td class="txt">${esc(x.descripcion)} ${kitsDe(x.codigo).length === 3 ? `<span class="chip-e e-ok">común</span>` : ""} ${enInv.has(x.codigo) ? "" : `<span class="chip-e e-gris">sin inventario</span>`}</td><td>${esc(x.regla)}</td></tr>`))}
    ${(() => { const pts = D().maestro.filter(m => m.tipo === "PT" && (m.kitsPT || []).includes(n.corto)); return pts.length ? `<h3 class="titulo-lectura" style="margin-top:16px">Producto terminado del kit <small>Bodega KT</small></h3>${tabla([{ t: "Código" }, { t: "Producto terminado" }], pts.map(p => `<tr><td>${p.codigo}</td><td class="txt">${esc(p.descripcion)}</td></tr>`))}` : ""; })()}</section>`; }).join("")}</div>`;
}

/* ---------- Historial de movimientos (solo supervisor / progreso) ---------- */
function vHistorial() {
  setAcciones(btnCsv("historial", "⤓ Exportar CSV"));
  const tipo = filtros.hTipo || "todos", q = U(filtros.h || "");
  const ok = r => !q || U(Object.values(r).map(v => typeof v === "object" ? JSON.stringify(v) : v).join(" ") + " " + desc(r.codigo)).includes(q);
  const rec = [...D().recepciones].reverse().filter(ok), sal = [...D().salidas].reverse().filter(ok), dev = [...D().devoluciones].reverse().filter(ok);
  return `<div class="filtros">
    <select id="f-htipo">${opciones([["todos", "Todos los movimientos"], ["entradas", "Solo entradas"], ["salidas", "Solo salidas"], ["devoluciones", "Solo devoluciones"]], tipo)}</select>
    <input id="f-h" placeholder="Buscar OC, OP, factura, lote, insumo, proveedor…" value="${esc(filtros.h || "")}"></div>
  ${["todos", "entradas"].includes(tipo) ? `<section class="card"><h2>Entradas (${rec.length})</h2><p class="sub">Compras, sobrantes y saldos iniciales.</p>${tablaRecepciones(rec)}</section>` : ""}
  ${["todos", "salidas"].includes(tipo) ? `<section class="card"><h2>Salidas (${sal.length})</h2><p class="sub">Un registro por lote usado.</p>${tablaSalidas(sal)}</section>` : ""}
  ${["todos", "devoluciones"].includes(tipo) ? `<section class="card"><h2>Devoluciones (${dev.length})</h2>${tablaDevoluciones(dev)}</section>` : ""}`;
}

/* ---------- Calidad: tickets de revisión ---------- */
function vCalidad() {
  setAcciones(btnCsv("calidad", "⤓ Exportar CSV"));
  const est = filtros.calEst || "Pendiente";
  const tickets = D().recepciones.filter(r => r.calidad?.requiere === "Sí");
  const lista = tickets.filter(r => est === "Todos" || r.calidad.estado === est).reverse();
  return `<p class="aviso">Las entradas que requieren revisión quedan <b>bloqueadas</b> (no suman al inventario ni al FIFO) hasta que Calidad las apruebe. Si se rechazan, el material no entra.</p>
  <div class="tabs">${["Pendiente", "Aprobado", "Rechazado", "Todos"].map(e => `<button class="tab ${est === e ? "activo" : ""}" data-cal-est="${e}">${e === "Todos" ? e : e + "s"} (${e === "Todos" ? tickets.length : tickets.filter(r => r.calidad.estado === e).length})</button>`).join("")}</div>
  <section class="card">${tabla([{ t: "Ticket" }, { t: "Fecha" }, { t: "Bodega" }, { t: "Proveedor" }, { t: "Factura" }, { t: "Insumo" }, { t: "Lote" }, { t: "Cantidad", cl: "num" }, { t: "Recibió" }, { t: "Estado" }, { t: "Revisión" }, { t: "" }],
    lista.map(r => `<tr><td class="fuerte">${esc(r.calidad.ticket)}</td><td>${fFecha(r)}</td><td>${esc(nomBodega(r.bodega))}</td><td>${esc(r.proveedor)}</td><td>${esc(r.factura)}</td><td class="txt">${esc(insumoTxt(r.codigo))}</td><td>${esc(r.lote)}</td><td class="num fuerte">${fmtN(r.cantidad)}</td><td>${esc(r.recibidoPor)}</td>
      <td><span class="chip-e ${ESTADO_CAL_CHIP[r.calidad.estado]}">${esc(r.calidad.estado)}</span></td><td class="txt">${r.calidad.revisadoPor ? `${esc(r.calidad.revisadoPor)} · ${fmtFH(r.calidad.fechaRevision)}<br><small>${esc(r.calidad.nota || "")}</small>` : "—"}</td>
      <td>${r.calidad.estado === "Pendiente" && PUEDE.aprobarCalidad ? `<div style="display:flex;gap:6px"><button class="btn btn-ok btn-mini" data-cal-aprobar="${r.id}">Aprobar</button><button class="btn btn-rojo btn-mini" data-cal-rechazar="${r.id}">Rechazar</button></div>` : ""}</td></tr>`),
    "No hay tickets en este estado")}</section>`;
}
function resolverCalidad(id, aprobar) {
  if (!PUEDE.aprobarCalidad) return;
  const r = D().recepciones.find(x => x.id === id);
  if (!r || r.calidad?.estado !== "Pendiente") return;
  const nota = prompt(aprobar ? "Nota de aprobación (opcional):" : "¿Por qué se rechaza? (obligatorio)") ?? null;
  if (nota === null) return;
  if (!aprobar && !nota.trim()) { toast("Para rechazar escribe el motivo."); return; }
  Object.assign(r.calidad, { estado: aprobar ? "Aprobado" : "Rechazado", revisadoPor: SESION.usuario, fechaRevision: new Date().toISOString(), nota: nota.trim() });
  registrarBitacora(`Ticket de calidad ${aprobar ? "aprobado" : "rechazado"}`, "Calidad", r.calidad.ticket, `${insumoTxt(r.codigo)} · lote ${r.lote} · ${fmtN(r.cantidad)} und${nota.trim() ? " · " + nota.trim() : ""}`);
  guardar(); actualizarBadges(); render(); toast(`Ticket ${r.calidad.ticket} ${aprobar ? "aprobado: el material ya está disponible" : "rechazado"}.`);
}

/* ---------- Solicitudes (aprueba solo supervisora / progreso) ---------- */
function vSolicitudes() {
  setAcciones(btnCsv("solicitudes", "⤓ Exportar CSV"));
  const est = filtros.solEst || "Pendiente";
  const visibles = ES.auxiliar ? BD.solicitudes.filter(s => s.usuario === SESION.usuario) : BD.solicitudes;
  const lista = visibles.filter(s => est === "Todas" || s.estado === est);
  const chipEst = e => `<span class="chip-e ${{ Pendiente: "e-alerta", Aprobada: "e-ok", Rechazada: "e-peligro" }[e] || "e-gris"}">${e}</span>`;
  const detalle = s => {
    if (s.tipo === "Eliminar") { const r = D()[s.tabla].find(x => x.id === s.registroId); return `<span class="cambio">Eliminar registro${r ? `: ${esc(insumoTxt(r.codigo) || r.descripcion || "")} · ${fmtN(r.cantidad ?? "")}` : ""}</span>`; }
    const nombres = Object.fromEntries(TABLAS[s.tabla].campos.map(([k, l]) => [k, l]));
    return Object.entries(s.cambios).map(([k, [a, b]]) => `<div class="cambio"><b>${nombres[k] || k}:</b> <del>${esc(valorTxt(k, a))}</del> → <ins>${esc(valorTxt(k, b))}</ins></div>`).join("");
  };
  return `<p class="aviso">${PUEDE.aprobarSolicitudes ? "El auxiliar pide los cambios y tú los apruebas o rechazas. Al aprobar, el cambio se aplica, los cálculos se actualizan y queda en el Historial de modificaciones." : ES.auxiliar ? "Aquí ves el estado de las solicitudes que enviaste. Las aprueba o rechaza la supervisora." : "Solo lectura. Las solicitudes las aprueba o rechaza la supervisora."}</p>
  <div class="tabs">${["Pendiente", "Aprobada", "Rechazada", "Todas"].map(e => `<button class="tab ${est === e ? "activo" : ""}" data-sol-est="${e}">${e === "Todas" ? e : e + "s"} (${e === "Todas" ? visibles.length : visibles.filter(s => s.estado === e).length})</button>`).join("")}</div>
  <section class="card">${tabla([{ t: "N°" }, { t: "Fecha" }, { t: "Solicita" }, { t: "Tipo" }, { t: "Tabla" }, { t: "Detalle del cambio" }, { t: "Motivo" }, { t: "Estado" }, { t: "" }],
    lista.map(s => `<tr><td>${s.id}</td><td>${fmtFH(s.fecha)}</td><td>${esc(s.usuario)}</td><td>${s.tipo}</td><td>${TABLAS[s.tabla]?.nombre || s.tabla}</td><td class="txt">${detalle(s)}</td><td class="txt">${esc(s.motivo)}</td><td>${chipEst(s.estado)}${s.resueltoPor ? `<br><small>${esc(s.resueltoPor)}</small>` : ""}</td>
      <td>${s.estado === "Pendiente" && PUEDE.aprobarSolicitudes ? `<div style="display:flex;gap:6px"><button class="btn btn-ok btn-mini" data-aprobar="${s.id}">Aprobar</button><button class="btn btn-rojo btn-mini" data-rechazar="${s.id}">Rechazar</button></div>` : ""}</td></tr>`),
    "No hay solicitudes en este estado")}</section>`;
}

/* ---------- Insumos y Proveedores (tablas que edita la supervisora) ---------- */
function vCatalogo(tab) {
  const ed = PUEDE.editarCatalogos;
  setAcciones(btnCsv(tab === "insumos" ? "catInsumos" : "catProveedores", "⤓ Exportar CSV"));
  const celda = (tipo, id, valor, corto) => ed ? `<input class="input-tabla ${corto ? "corto" : ""}" data-cat-edit="${tipo}" data-id="${esc(id)}" value="${esc(valor)}">` : esc(valor || "—");
  const borrar = (tipo, id) => `<td><button class="btn btn-borde btn-mini btn-eliminar" data-cat-borrar="${tipo}" data-id="${esc(id)}">Eliminar</button></td>`;
  const aviso = `<p class="aviso">${ed ? "Edita directamente en la tabla (se guarda al salir de la celda). Lo que agregues aparece de inmediato en las listas desplegables del auxiliar. Si eliminas algo con movimientos, los movimientos se conservan pero ya no aparecerá en inventario ni en las listas." : "Solo lectura. Estas listas las administra la supervisora."}</p>`;
  if (tab === "insumos") {
    const ins = D().maestro;
    return `${aviso}
    ${ed ? `<section class="card"><h2>Agregar insumo</h2>
      <form id="form-cat-ins" class="form-grid" novalidate>
        <div class="campo"><label for="ci-cod">Código <span class="req">*</span></label><input id="ci-cod" placeholder="Ej: 10058000"></div>
        <div class="campo ancho"><label for="ci-desc">Descripción <span class="req">*</span></label><input id="ci-desc" placeholder="Ej: ETIQUETA AUTOADHE 32X15"></div>
        <div class="campo"><label for="ci-und">Unidad <span class="req">*</span></label><input id="ci-und" list="dl-und" placeholder="MILU, UND, ROLLO…"></div>
        <div class="campo"><label for="ci-tipo">Tipo <span class="req">*</span></label><select id="ci-tipo">${opciones([["Insumo", "Insumo"], ["PT", "Producto terminado"]], "Insumo")}</select></div>
        <div class="campo" style="align-self:end"><button class="btn btn-primario">+ Agregar insumo</button></div>
      </form><datalist id="dl-und">${["MILU", "UND", "ROLLO", "MLU"].map(u => `<option value="${u}">`).join("")}</datalist></section>` : ""}
    <section class="card"><h2>Insumos (${ins.length})</h2>${tabla([{ t: "Código" }, { t: "Tipo" }, { t: "Descripción" }, { t: "Unidad" }, { t: "Kits" }, ...(ed ? [{ t: "" }] : [])],
      [...ins].sort((a, b) => (a.tipo === "PT") - (b.tipo === "PT")).map(m => `<tr><td>${m.codigo}</td><td><span class="chip-e ${m.tipo === "PT" ? "e-alerta" : "e-info"}">${m.tipo === "PT" ? "Producto terminado" : "Insumo"}</span></td><td class="txt">${celda("ins-desc", m.codigo, m.descripcion)}</td><td>${celda("ins-und", m.codigo, m.unidad, 1)}</td>
        <td>${kitsDe(m.codigo).map(k => `<span class="chip-e e-info">${k}</span>`).join(" ") || "—"}</td>
        ${ed ? borrar("ins", m.codigo) : ""}</tr>`))}</section>`;
  }
  const prov = D().proveedores;
  return `${aviso}
  ${ed ? `<section class="card"><h2>Agregar proveedor</h2>
    <form id="form-cat-prov" class="form-grid" novalidate>
      <div class="campo ancho"><label for="cp-nom">Nombre <span class="req">*</span></label><input id="cp-nom" placeholder="Ej: CARTONERA NACIONAL"></div>
      <div class="campo"><label for="cp-nit">NIT</label><input id="cp-nit" placeholder="Opcional"></div>
      <div class="campo"><label for="cp-con">Contacto</label><input id="cp-con" placeholder="Opcional"></div>
      <div class="campo" style="align-self:end"><button class="btn btn-primario">+ Agregar proveedor</button></div>
    </form></section>` : ""}
  <section class="card"><h2>Proveedores (${prov.length})</h2>${tabla([{ t: "Proveedor" }, { t: "NIT" }, { t: "Contacto" }, { t: "Entregas", cl: "num" }, ...(ed ? [{ t: "" }] : [])],
    prov.map(p => `<tr><td class="txt">${celda("prov-nom", p.id, p.nombre)}</td><td>${celda("prov-nit", p.id, p.nit, 1)}</td><td>${celda("prov-con", p.id, p.contacto)}</td>
      <td class="num">${D().recepciones.filter(r => U(r.proveedor) === U(p.nombre)).length}</td>
      ${ed ? borrar("prov", p.id) : ""}</tr>`))}</section>`;
}
function initCatalogos() {
  $("#form-cat-ins")?.addEventListener("submit", e => {
    e.preventDefault();
    const cod = $("#ci-cod").value.trim(), dsc = U($("#ci-desc").value), und = U($("#ci-und").value);
    if (!cod || !dsc || !und) { toast("Código, descripción y unidad son obligatorios."); return; }
    if (D().maestro.some(m => m.codigo === cod)) { toast("Ya existe un insumo con ese código."); return; }
    const tipo = $("#ci-tipo").value;
    D().maestro.push({ codigo: cod, descripcion: dsc, unidad: und, tipo, kitsPT: [], activo: true });
    if (!D().insumos.some(i => i.codigo === cod)) D().insumos.push({ id: cod, codigo: cod, descripcion: dsc, unidad: und, tipo, kitsPT: [], grupo: "", stockInicial: 0, salidasHistoricas: 0, baseFechaEntrada: "", baseFechaSalida: "", observaciones: "" });
    registrarBitacora("Insumo agregado al catálogo", "Insumos", cod, `${dsc} · ${und}`);
    guardar(); render(); toast("Insumo agregado. Ya aparece en las listas desplegables.");
  });
  $("#form-cat-prov")?.addEventListener("submit", e => {
    e.preventDefault();
    const nom = U($("#cp-nom").value);
    if (!nom) { toast("Escribe el nombre del proveedor."); return; }
    if (D().proveedores.some(p => U(p.nombre) === nom)) { toast("Ese proveedor ya existe."); return; }
    const id = nuevoId("P");
    D().proveedores.push({ id, nombre: nom, nit: $("#cp-nit").value.trim(), contacto: $("#cp-con").value.trim(), activo: true });
    registrarBitacora("Proveedor agregado al catálogo", "Proveedores", id, nom);
    guardar(); render(); toast("Proveedor agregado. Ya aparece en la lista de entradas.");
  });
}
function editarCatalogo(el) {
  if (!PUEDE.editarCatalogos) return;
  const v = el.value.trim(), id = el.dataset.id, campo = el.dataset.catEdit;
  const [tipo, k] = campo.split("-");
  const reg = tipo === "ins" ? D().maestro.find(m => m.codigo === id) : D().proveedores.find(p => p.id === id);
  const prop = { desc: "descripcion", und: "unidad", nom: "nombre", nit: "nit", con: "contacto" }[k];
  const nuevo = ["descripcion", "unidad", "nombre"].includes(prop) ? U(v) : v;
  if (!reg || String(reg[prop] ?? "") === nuevo || (!nuevo && ["descripcion", "unidad", "nombre"].includes(prop))) { el.value = reg?.[prop] ?? ""; return; }
  const antes = reg[prop];
  reg[prop] = nuevo;
  if (tipo === "ins") { const i = D().insumos.find(x => x.codigo === id); if (i && prop === "descripcion") i.descripcion = nuevo; if (i && prop === "unidad") i.unidad = nuevo; }
  registrarBitacora(`${tipo === "ins" ? "Insumo" : "Proveedor"} modificado en catálogo`, tipo === "ins" ? "Insumos" : "Proveedores", id, `${prop}: ${antes} → ${nuevo}`);
  guardar(); toast("Cambio guardado en el catálogo.");
}
/* Lo que ya tiene movimientos, saldo o kit se puede eliminar, pero se advierte antes */
function usoInsumo(cod) {
  const movs = ["recepciones", "salidas", "devoluciones", "averias"].reduce((n, k) => n + D()[k].filter(r => r.codigo === cod).length, 0);
  const ins = D().insumos.find(i => i.codigo === cod) || {};
  const kits = kitsDe(cod);
  if (movs) return `Tiene ${movs} movimiento(s) registrados`;
  if (Number(ins.stockInicial) || Number(ins.salidasHistoricas)) return "Tiene saldo inicial en inventario";
  if (kits.length) return `Hace parte del kit ${kits.join(", ")}`;
  return "";
}
function usoProveedor(nombre) {
  const n = D().recepciones.filter(r => U(r.proveedor) === U(nombre)).length;
  return n ? `Tiene ${n} entrada(s) registradas` : "";
}
function eliminarCatalogo(tipo, id) {
  if (!PUEDE.editarCatalogos) return;
  const ins = tipo === "ins";
  const reg = ins ? D().maestro.find(m => m.codigo === id) : D().proveedores.find(p => p.id === id);
  if (!reg) return;
  const uso = ins ? usoInsumo(id) : usoProveedor(reg.nombre);
  const aviso = uso ? `\n\nATENCIÓN: ${uso}. Esos registros se conservan, pero ${ins ? "este insumo dejará de aparecer en inventario y en las listas" : "este proveedor dejará de aparecer en las listas"}.` : "";
  if (!confirm(`¿Eliminar ${ins ? "el insumo" : "el proveedor"} ${reg.descripcion || reg.nombre}? Esta acción no se puede deshacer.${aviso}`)) return;
  if (ins) { D().maestro.splice(D().maestro.indexOf(reg), 1); const i = D().insumos.findIndex(x => x.codigo === id); if (i >= 0) D().insumos.splice(i, 1); }
  else D().proveedores.splice(D().proveedores.indexOf(reg), 1);
  registrarBitacora(`${ins ? "Insumo" : "Proveedor"} eliminado del catálogo`, ins ? "Insumos" : "Proveedores", id, reg.descripcion || reg.nombre);
  guardar(); render(); toast(`${ins ? "Insumo" : "Proveedor"} eliminado.`);
}

/* ---------- Historial de modificaciones: trazabilidad de las solicitudes de edición ---------- */
function filasModificaciones() {
  const out = [];
  BD.solicitudes.forEach(s => {
    const nombres = Object.fromEntries((TABLAS[s.tabla]?.campos || []).map(([k, l]) => [k, l]));
    const base = { fecha: s.fecha, id: s.id, modulo: TABLAS[s.tabla]?.nombre || s.tabla, registro: s.registroId, motivo: s.motivo, solicito: s.usuario, estado: s.estado, resolvio: s.resueltoPor || "", fechaRes: s.fechaResolucion || "" };
    if (s.tipo === "Eliminar") out.push({ ...base, campo: "Registro completo", antes: s.resumen || "(registro)", despues: "ELIMINADO" });
    else Object.entries(s.cambios || {}).forEach(([k, [a, b]]) => out.push({ ...base, campo: nombres[k] || k, antes: valorTxt(k, a), despues: valorTxt(k, b) }));
  });
  return out;
}
function vBitacora() {
  setAcciones(btnCsv("bitacora", "⤓ Exportar CSV"));
  const q = U(filtros.bit || "");
  const filas = filasModificaciones().filter(f => !q || U(Object.values(f).join(" ")).includes(q));
  const chip = e => `<span class="chip-e ${{ Pendiente: "e-alerta", Aprobada: "e-ok", Rechazada: "e-peligro" }[e] || "e-gris"}">${e}</span>`;
  return `<p class="aviso">Trazabilidad de cada <b>solicitud de edición</b>: qué campo se pidió cambiar, el valor anterior y el nuevo, quién lo pidió, el motivo y quién lo aprobó o rechazó.</p>
  <div class="filtros"><input id="f-bit" placeholder="Buscar usuario, módulo, campo, valor…" value="${esc(filtros.bit || "")}"></div>
  <section class="card">${tabla([{ t: "Fecha solicitud" }, { t: "N°" }, { t: "Módulo" }, { t: "Registro" }, { t: "Campo" }, { t: "Valor anterior" }, { t: "Valor nuevo" }, { t: "Motivo" }, { t: "Solicitó" }, { t: "Estado" }, { t: "Resolvió" }],
    filas.map(f => `<tr><td>${fmtFH(f.fecha)}</td><td>${esc(f.id)}</td><td>${esc(f.modulo)}</td><td>${esc(f.registro)}</td><td class="fuerte">${esc(f.campo)}</td><td class="txt"><span class="cambio"><del>${esc(f.antes)}</del></span></td><td class="txt"><span class="cambio"><ins>${esc(f.despues)}</ins></span></td><td class="txt">${esc(f.motivo)}</td><td>${esc(f.solicito)}</td><td>${chip(f.estado)}</td><td>${f.resolvio ? `${esc(f.resolvio)}<br><small class="muted">${fmtFH(f.fechaRes)}</small>` : "—"}</td></tr>`),
    "Todavía no hay solicitudes de edición")}</section>`;
}

/* =====================================================================
   CSV (una exportación por cada tabla)
   ===================================================================== */
function exportar(tipo) {
  const R = D();
  const cal = r => r.origen === "saldo-inicial" ? "SALDO INICIAL" : `${r.calidad?.estado || ""}${r.calidad?.ticket ? " " + r.calidad.ticket : ""}`;
  const tablas = {
    entradas: [["FECHA", "HORA", "BODEGA", "ORDEN DE COMPRA", "FACTURA", "PROVEEDOR", "REMISION", "CODIGO", "INSUMO", "CANTIDAD", "UNIDAD", "LOTE", "FECHA FABRICACION", "FECHA VENCIMIENTO", "CALIDAD", "RECIBIDO POR", "OBSERVACIONES"],
      ...R.recepciones.map(r => [r.fecha, r.hora || "", nomBodega(r.bodega), r.ordenCompra, r.factura, r.proveedor, r.remision, r.codigo, desc(r.codigo), r.cantidad, r.unidad, r.lote, r.fechaFabricacion || "", r.fechaVencimiento || "", cal(r), r.recibidoPor, r.observaciones])],
    salidas: [["FECHA", "HORA", "ORDEN DE PRODUCCION", "DESTINO", "CODIGO", "INSUMO", "CANTIDAD", "UNIDAD", "LOTE", "ENTREGADO POR", "ESTADO", "RECIBIDO POR", "FIRMO", "FIRMA", "OBSERVACIONES"],
      ...R.salidas.map(s => [s.fecha, s.hora || "", s.ordenProduccion, s.destino, s.codigo, desc(s.codigo), s.cantidad, s.unidad, s.lote, s.entregadoPor, s.recibido?.estado, s.recibidoPor, s.recibido?.firmadoPor || "", s.recibido?.firma ? "SI" : "NO", s.observaciones])],
    devoluciones: [["FECHA", "HORA", "OP", "CODIGO", "INSUMO", "LOTE", "BUENAS", "MALAS", "MOTIVO", "REGISTRADO POR", "OBSERVACIONES"],
      ...R.devoluciones.map(x => [x.fecha, x.hora || "", x.op, x.codigo, desc(x.codigo), x.lote, x.buenas, x.malas, x.motivo, x.registradoPor, x.observaciones])],
    averias: [["FECHA", "HORA", "TIPO", "ESTADO", "OP", "LOTE", "CODIGO", "INSUMO", "CANTIDAD", "OBSERVACIONES"],
      ...R.averias.map(a => [a.fecha, a.hora || "", a.tipo, a.estado, a.op, a.lote, a.codigo, desc(a.codigo), a.cantidad, a.observaciones])],
    inventario: [["TIPO", "CODIGO", "DESCRIPCION", "KITS", "STOCK INICIAL", "ENTRADAS", "DEVOLUCIONES", "SALIDAS", "STOCK ACTUAL", "EN CALIDAD", "UNIDAD", "FECHA ULT. ENTRADA", "FECHA ULT. SALIDA"],
      ...calcInventario().map(i => [i.tipo === "PT" ? "PRODUCTO TERMINADO" : "INSUMO", i.codigo, i.descripcion, i.kits.join(" "), i.stockInicial, i.entradas, i.devueltas, i.salidas, i.stock, i.enCalidad, i.unidad, i.ultE, i.ultS])],
    lotes: [["CODIGO", "INSUMO", "ORDEN DE USO", "LOTE", "FECHA PRIMERA ENTRADA", "VENCE", "ENTRADAS", "SALIDAS", "SALDO", "PRIORIDAD FIFO", "CONTROL"],
      ...lotesEnOrdenDeUso(calcLotes()).map(l => [l.codigo, l.insumo, l.orden, l.lote, l.fecha, l.vence, l.entradas, l.salidas, l.saldo, l.prioridad, l.control])],
    kits: [["KIT", "TIPO", "CODIGO", "DESCRIPCION", "CONSUMO POR KIT", "REGLA", "COMUN A LOS 3"], ...R.kits.flatMap(k => [
      ...k.insumos.map(x => [k.kit, "INSUMO", x.codigo, x.descripcion, x.factor, x.regla, kitsDe(x.codigo).length === 3 ? "SI" : "NO"]),
      ...R.maestro.filter(m => m.tipo === "PT" && (m.kitsPT || []).includes(nombreKit(k).corto)).map(m => [k.kit, "PRODUCTO TERMINADO", m.codigo, m.descripcion, "", "", ""])])],
    historial: [["TIPO", "FECHA", "OC / OP", "FACTURA", "PROVEEDOR / DESTINO", "CODIGO", "INSUMO", "CANTIDAD", "LOTE", "RESPONSABLE", "RECIBIDO POR"],
      ...R.recepciones.map(r => ["ENTRADA", r.fecha, r.ordenCompra, r.factura, r.proveedor, r.codigo, desc(r.codigo), r.cantidad, r.lote, r.recibidoPor, r.recibidoPor]),
      ...R.salidas.map(s => ["SALIDA", s.fecha, s.ordenProduccion, "", s.destino, s.codigo, desc(s.codigo), s.cantidad, s.lote, s.entregadoPor, s.recibidoPor]),
      ...R.devoluciones.map(x => ["DEVOLUCION", x.fecha, x.op, "", "", x.codigo, desc(x.codigo), Number(x.buenas) + Number(x.malas), x.lote, x.registradoPor, ""])],
    calidad: [["TICKET", "FECHA", "BODEGA", "PROVEEDOR", "FACTURA", "CODIGO", "INSUMO", "LOTE", "CANTIDAD", "ESTADO", "REVISADO POR", "FECHA REVISION", "NOTA"],
      ...R.recepciones.filter(r => r.calidad?.requiere === "Sí").map(r => [r.calidad.ticket, r.fecha, nomBodega(r.bodega), r.proveedor, r.factura, r.codigo, desc(r.codigo), r.lote, r.cantidad, r.calidad.estado, r.calidad.revisadoPor || "", r.calidad.fechaRevision || "", r.calidad.nota || ""])],
    solicitudes: [["N", "FECHA", "SOLICITA", "TIPO", "TABLA", "REGISTRO", "CAMBIOS", "MOTIVO", "ESTADO", "RESUELTO POR"],
      ...BD.solicitudes.map(s => [s.id, s.fecha, s.usuario, s.tipo, s.tabla, s.registroId, Object.entries(s.cambios || {}).map(([k, [a, b]]) => `${k}: ${a} -> ${b}`).join(" | "), s.motivo, s.estado, s.resueltoPor || ""])],
    catInsumos: [["CODIGO", "TIPO", "DESCRIPCION", "UNIDAD", "KITS"], ...R.maestro.map(m => [m.codigo, m.tipo === "PT" ? "PRODUCTO TERMINADO" : "INSUMO", m.descripcion, m.unidad, kitsDe(m.codigo).join(" ")])],
    catProveedores: [["PROVEEDOR", "NIT", "CONTACTO"], ...R.proveedores.map(p => [p.nombre, p.nit, p.contacto])],
    bitacora: [["FECHA SOLICITUD", "N", "MODULO", "REGISTRO", "CAMPO", "VALOR ANTERIOR", "VALOR NUEVO", "MOTIVO", "SOLICITO", "ESTADO", "RESOLVIO", "FECHA RESOLUCION"],
      ...filasModificaciones().map(f => [f.fecha, f.id, f.modulo, f.registro, f.campo, f.antes, f.despues, f.motivo, f.solicito, f.estado, f.resolvio, f.fechaRes])],
  };
  const filas = tablas[tipo];
  if (!filas) return;
  const csv = "﻿" + filas.map(f => f.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: `trazza-${tipo}-${hoy()}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

/* =====================================================================
   NAVEGACIÓN / EVENTOS GLOBALES
   ===================================================================== */
function setAcciones(html) { $("#barra-acciones").innerHTML = html; }
function abrirModal(titulo, html, op = {}) { $("#modal-titulo").textContent = titulo; $("#modal-cuerpo").innerHTML = html; $(".modal").classList.toggle("ancho", !!op.ancho); $("#modal").dataset.formulario = op.formulario ? "1" : ""; $("#modal").dataset.lectura = op.lectura || ""; $("#modal").hidden = false; $(".modal").scrollTop = 0; }
/* Si la ventana se abrió desde una lectura (ej. ✎ en la tabla), al cerrarla se vuelve a esa lectura */
let volverA = null;
function cerrarModal() { $("#modal").hidden = true; $("#modal-cuerpo").innerHTML = ""; const v = volverA; volverA = null; if (v) abrirLectura(v); }
function actualizarBadges() {
  const n = {
    solicitudes: (ES.auxiliar ? BD.solicitudes.filter(s => s.usuario === SESION.usuario) : ES.supervisor ? BD.solicitudes : []).filter(s => s.estado === "Pendiente").length,
    calidad: ES.calidad ? D().recepciones.filter(r => r.calidad?.estado === "Pendiente").length : 0,
    averias: ES.auxiliar ? averiasPendientes().length : 0,
    firmas: ES.supervisor ? porRecibir().length : 0,
  };
  $$("[data-badge]").forEach(b => (b.textContent = n[b.dataset.badge] || ""));
}

function render() {
  let clave = location.hash.slice(1) || "inicio";
  if (!permitida(clave)) clave = "inicio";
  const v = VISTAS[clave];
  $("#titulo-vista").textContent = v.titulo;
  document.title = `${v.titulo} · ${window.APP_CONFIG?.nombre || "Trazza"}`;
  $$("#nav a").forEach(a => a.classList.toggle("activo", a.getAttribute("href") === "#" + clave));
  $("#vista").innerHTML = v.render();
  if (clave.startsWith("cat-") && PUEDE.editarCatalogos) initCatalogos();
  $("#menu").classList.remove("abierto");
  actualizarBadges();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-cerrar]");
  if (!t) return;
  const d = t.dataset;
  if ("cerrar" in d) cerrarModal();
  else if (d.registrar) abrirRegistro(d.registrar);
  else if (d.leer) abrirLectura(d.leer);
  else if ("porRecibir" in d) abrirPorRecibir();
  else if (d.firmar) confirmarRecibido(d.firmar);
  else if (d.verFirma) verFirma(d.verFirma);
  else if ("borrarFirma" in d) { const cv = t.closest(".campo").querySelector(".firma-pad"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); delete cv.dataset.firmado; }
  else if (d.completar) { volverA = $("#modal").hidden ? null : $("#modal").dataset.lectura || null; abrirCompletarAveria(d.completar); }
  else if (d.solicitar) { volverA = $("#modal").hidden ? null : $("#modal").dataset.lectura || null; abrirSolicitud(d.solicitar, d.id); }
  else if (d.aprobar) resolverSolicitud(d.aprobar, true);
  else if (d.rechazar) resolverSolicitud(d.rechazar, false);
  else if (d.calAprobar) resolverCalidad(d.calAprobar, true);
  else if (d.calRechazar) resolverCalidad(d.calRechazar, false);
  else if (d.calEst) { filtros.calEst = d.calEst; render(); }
  else if (d.catBorrar) eliminarCatalogo(d.catBorrar, d.id);
  else if (d.csv) exportar(d.csv);
  else if (d.lotesTab) { filtros.lotesTab = d.lotesTab; render(); }
  else if (d.solEst) { filtros.solEst = d.solEst; render(); }
});
document.addEventListener("input", e => {
  const map = { "f-inv": "inv", "f-lotes": "lotes", "f-h": "h", "f-bit": "bit" };
  if (map[e.target.id]) { filtros[map[e.target.id]] = e.target.value; const pos = e.target.selectionStart; render(); const el = $("#" + e.target.id); el.focus(); el.setSelectionRange(pos, pos); }
});
document.addEventListener("change", e => {
  if (e.target.id === "f-htipo") { filtros.hTipo = e.target.value; render(); }
  if (e.target.dataset.catEdit) editarCatalogo(e.target);
});
$("#modal").addEventListener("click", e => { if (e.target.id === "modal" && !$("#modal").dataset.formulario) cerrarModal(); }); // en formularios no se cierra al hacer clic afuera, para no perder lo escrito
document.addEventListener("keydown", e => { if (e.key === "Escape") cerrarModal(); });
$("#btn-menu").addEventListener("click", () => $("#menu").classList.toggle("abierto"));
/* Tema claro / oscuro */
const ICO_SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
const ICO_LUNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';
function pintarBotonTema() {
  const oscuro = document.documentElement.dataset.theme === "dark";
  $("#tema-ico").innerHTML = oscuro ? ICO_SOL : ICO_LUNA;
  $("#tema-txt").textContent = oscuro ? "Tema claro" : "Tema oscuro";
  $("#btn-tema").title = oscuro ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
}
$("#btn-tema").addEventListener("click", () => {
  const nuevo = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem("trazza_tema", nuevo); } catch (e) {}
  pintarBotonTema();
});
pintarBotonTema();
if (ES.progreso) {
  const b = document.createElement("button");
  b.className = "btn-salir"; b.id = "btn-panel"; b.textContent = "← Plantas"; b.title = "Volver al panel de plantas";
  b.addEventListener("click", () => { location.href = "panel.html?v=" + Date.now(); });
  $("#btn-salir").before(b);
}
$("#btn-salir").addEventListener("click", async () => { await api("salir", {}).catch(() => {}); sessionStorage.removeItem("trazza_sesion"); location.href = "index.html?v=" + Date.now(); });
window.addEventListener("hashchange", () => { if (BD) render(); });

/* Inicio */
$("#u-nombre").textContent = SESION?.nombre || "";
$("#u-rol").textContent = ({ Auxiliar: "Auxiliar de almacén" }[ROL] || ROL) + " · " + (SESION?.plantaNombre || PLANTA);
$("#nombre-app").textContent = window.APP_CONFIG?.nombre || "Trazza";
(async () => {
  try {
    aplicarDatos(await api("datos"));
  } catch (e) {
    if (e.message !== "sesion") $("#vista").innerHTML = `<p class="aviso rojo">No se pudieron cargar los datos: ${esc(e.message)}. Recarga la página.</p>`;
    return;
  }
  await reservarIds();
  pintarMenu();
  render();
  setInterval(refrescar, 30000);
})();
