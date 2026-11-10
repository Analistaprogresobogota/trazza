// Genera prototipo/api/semilla.php (datos iniciales de SQL) desde datos-fuente/datos.js y datos-fuente/usuarios.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const BASE = dirname(fileURLToPath(import.meta.url));
globalThis.window = {};
createRequire(import.meta.url)(join(BASE, 'datos-fuente', 'datos.js'));
function U(s) { return String(s ?? "").trim().toUpperCase(); }
function nuevoEstado() {
  const d = structuredClone(window.DATOS_INICIALES);
  let n = 0;
  const und = cod => (d.insumos.find(i => i.codigo === cod) || {}).unidad || "";
  d.recepciones.forEach(r => Object.assign(r, { id: "R" + ++n, origen: "compra", factura: "", bodega: "", calidad: { requiere: "No", estado: "No aplica" } }));
  /* Los antiguos "lotes antiguos" pasan a entradas tipo SALDO INICIAL: alimentan el FIFO pero no suman al stock (igual que en el Excel) */
  d.lotesAntiguos.forEach(a => d.recepciones.push({ id: "R" + ++n, origen: "saldo-inicial", fecha: a.fecha, ordenCompra: "N/A", factura: "", bodega: "", proveedor: "SALDO INICIAL", remision: "N/A",
    codigo: a.codigo, cantidad: a.cantidad, unidad: und(a.codigo), lote: a.lote, recibidoPor: a.registradoPor, observaciones: a.observaciones || "Saldo inicial (antes Lotes antiguos)", calidad: { requiere: "No", estado: "No aplica" } }));
  delete d.lotesAntiguos;
  d.salidas.forEach(s => Object.assign(s, { id: "S" + ++n, recibido: { estado: "Recibido", por: s.recibidoPor, fecha: s.fecha } }));
  d.averias.forEach(a => Object.assign(a, { id: "A" + ++n, tipo: "Conteo", estado: "Completa", lote: "", op: a.op || "", registradoPor: "" }));
  d.devoluciones = (d.devoluciones || []).map(x => ({ id: "D" + ++n, ...x }));
  d.insumos.forEach(i => (i.id = i.codigo));
  d.maestro.forEach(m => Object.assign(m, { tipo: "Insumo", unidad: und(m.codigo), activo: true }));
  d.insumos.forEach(i => (i.tipo = "Insumo"));
  /* Producto terminado (hoja Bodega KT): inventario propio, mismas entradas y salidas */
  (d.productosTerminados || []).forEach(p => {
    d.maestro.push({ codigo: p.codigo, descripcion: p.descripcion, tipo: "PT", unidad: "UND", activo: true, kitsPT: p.kits });
    d.insumos.push({ id: p.codigo, codigo: p.codigo, descripcion: p.descripcion, tipo: "PT", kitsPT: p.kits, grupo: "PT", stockInicial: 0, salidasHistoricas: 0, unidad: "UND", baseFechaEntrada: "", baseFechaSalida: "", observaciones: "" });
  });
  d.proveedores = [...new Set(d.recepciones.map(r => (r.proveedor || "").trim()).filter(p => p && !["N/A", "SALDO INICIAL"].includes(U(p))))]
    .sort().map((p, i) => ({ id: "P" + (i + 1), nombre: p, nit: "", contacto: "", activo: true }));
  return { datos: d, solicitudes: [], bitacora: [], seq: n + 1 };
}
/* Planta nueva: sin insumos, proveedores, stock ni movimientos (conserva los kits) */
function estadoVacio() {
  const e = nuevoEstado();
  ["recepciones", "salidas", "averias", "devoluciones", "proveedores", "insumos", "maestro"].forEach(k => (e.datos[k] = []));
  return e;
}
function estadoInicial(planta) { return planta === "PRUEBA" ? nuevoEstado() : estadoVacio(); }

function tablas(e) {
  const d = e.datos, m = Object.fromEntries(d.maestro.map(x => [x.codigo, x]));
  return { recepciones: d.recepciones, salidas: d.salidas, devoluciones: d.devoluciones, averias: d.averias, proveedores: d.proveedores,
    insumos: d.insumos.map(i => ({ ...m[i.codigo], ...i })), kits: d.kits.map(k => ({ id: k.kit, ...k })) };
}
const usuarios = JSON.parse(readFileSync(join(BASE, 'datos-fuente', 'usuarios.json'), 'utf8'));
const plantas = Object.fromEntries(['PRUEBA', 'PROGRESO'].map(p => { const e = estadoInicial(p); return [p, { tablas: tablas(e), seq: e.seq }]; }));
writeFileSync(join(BASE, 'prototipo', 'api', 'semilla.php'), "<?php return json_decode(<<<'JSON'\n" + JSON.stringify({ usuarios, plantas }) + "\nJSON\n, true);\n");
console.log('semilla ok', Object.entries(plantas).map(([p, e]) => p + ': ' + Object.entries(e.tablas).map(([t, f]) => t + ' ' + f.length).join(', ')).join(' | '));
