/* =====================================================================
   TRAZZA · Dashboard de Inicio
   Indicadores que NO están en los otros módulos: capacidad de producción
   por kit, cobertura en días, trazabilidad, tasa de averías, salud FIFO,
   flujo semanal, consumo y proveedores.
   Usa funciones globales de app.js (D, calcInventario, calcLotes, fmtN...).
   ===================================================================== */

/* Colores de gráficos: variables CSS --c-ent / --c-sal (validadas para tema claro y oscuro en app.css) */
const COBERTURA_RIESGO = 15; // días
const COBERTURA_ALERTA = 30; // días
const DIA = 86400000;

const fechaD = f => new Date(f + "T00:00:00");
const diasEntre = (a, b) => Math.round((fechaD(b) - fechaD(a)) / DIA);
const compacto = n => Math.abs(n) >= 1e6 ? fmtN(Math.round(n / 1e5) / 10) + " M" : Math.abs(n) >= 1e4 ? fmtN(Math.round(n / 100) / 10) + " K" : fmtN(Math.round(n));
const pct = (a, b) => (b ? (a / b) * 100 : 0);

/* ---------- Cálculo de indicadores ---------- */
function calcDashboard(periodo) {
  const HOY = hoy();
  const desde = periodo === "todo" ? "" : new Date(Date.now() - Number(periodo) * DIA).toISOString().slice(0, 10);
  const enPer = r => !desde || (r.fecha || "") >= desde;
  const sal = D().salidas.filter(enPer), rec = D().recepciones.filter(r => enPer(r) && r.origen !== "saldo-inicial"), ave = D().averias.filter(enPer);
  const inv = calcInventario().filter(i => i.tipo !== "PT"), lotes = calcLotes(); // el tablero analiza insumos; el PT tiene su propio inventario
  const invMap = Object.fromEntries(inv.map(i => [i.codigo, i]));

  /* Consumo diario promedio: salidas registradas / días calendario del período */
  const fechasSal = D().salidas.map(s => s.fecha).filter(Boolean).sort();
  const inicio = desde || fechasSal[0] || HOY;
  const dias = Math.max(1, diasEntre(inicio, HOY));
  const consumo = {};
  sal.forEach(s => (consumo[s.codigo] = (consumo[s.codigo] || 0) + Number(s.cantidad || 0)));
  const cobertura = inv.map(i => {
    const diario = (consumo[i.codigo] || 0) / dias;
    const diasCob = diario > 0 ? Math.max(0, i.stock) / diario : null;
    return { ...i, consumo: consumo[i.codigo] || 0, diario, diasCob };
  });
  const conConsumo = cobertura.filter(c => c.diasCob !== null).sort((a, b) => a.diasCob - b.diasCob);
  const enRiesgo = conConsumo.filter(c => c.diasCob < COBERTURA_RIESGO);

  /* Capacidad de producción por kit: el insumo más escaso manda */
  const kits = D().kits.map(k => {
    const [cod, ...nom] = k.kit.split(" - ");
    const comps = k.insumos.filter(x => invMap[x.codigo]).map(x => {
      const i = invMap[x.codigo];
      return { codigo: x.codigo, descripcion: i.descripcion, unidad: i.unidad, stock: i.stock, regla: x.regla, posibles: Math.max(0, Math.floor(i.stock / x.factor)) };
    }).sort((a, b) => a.posibles - b.posibles);
    const sinInv = k.insumos.filter(x => !invMap[x.codigo]);
    return { codigo: cod, nombre: nom.join(" - "), posibles: comps.length ? comps[0].posibles : 0, limitante: comps[0], comps, sinInv };
  });

  /* Trazabilidad: salidas con lote identificado */
  const salConLote = sal.filter(s => s.lote && U(s.lote) !== "N/A").length;

  /* Averías vs unidades despachadas */
  const undSal = sal.reduce((a, s) => a + Number(s.cantidad || 0), 0);
  const undAve = ave.reduce((a, s) => a + Number(s.cantidad || 0), 0);

  /* Salud FIFO */
  const activos = lotes.filter(l => l.saldo > 0 && l.fecha);
  const antiguo = [...activos].sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  const envejecidos = activos.filter(l => diasEntre(l.fecha, HOY) > 90).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const revisar = lotes.filter(l => l.saldo < 0);
  const usar = activos.filter(l => l.prioridad === "USAR PRIMERO");

  /* Flujo semanal (número de movimientos) */
  const lunes = f => { const d = fechaD(f); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const semanas = {};
  rec.forEach(r => r.fecha && ((semanas[lunes(r.fecha)] ||= { e: 0, s: 0, eu: 0, su: 0 }).e++, (semanas[lunes(r.fecha)].eu += Number(r.cantidad || 0))));
  sal.forEach(s => s.fecha && ((semanas[lunes(s.fecha)] ||= { e: 0, s: 0, eu: 0, su: 0 }).s++, (semanas[lunes(s.fecha)].su += Number(s.cantidad || 0))));
  const flujo = Object.entries(semanas).sort(([a], [b]) => a.localeCompare(b)).map(([sem, v]) => ({ sem, ...v }));

  /* Top consumo y proveedores */
  const top = Object.entries(consumo).map(([c, u]) => ({ codigo: c, unidades: u, descripcion: desc(c), unidad: invMap[c]?.unidad || "" })).sort((a, b) => b.unidades - a.unidades).slice(0, 6);
  const prov = {};
  rec.forEach(r => { const p = (r.proveedor || "").trim(); if (p && U(p) !== "N/A") prov[p] = (prov[p] || 0) + 1; });
  const sobrantes = rec.filter(r => U(r.proveedor) === "N/A" || /SOBRANTE/i.test(r.observaciones || "")).length;
  const proveedores = Object.entries(prov).map(([p, n]) => ({ p, n })).sort((a, b) => b.n - a.n);

  return { dias, inicio, kits, cobertura, conConsumo, enRiesgo, sal, rec, salConLote, undSal, undAve, ops: new Set(sal.map(s => s.ordenProduccion)).size,
    activos, antiguo, envejecidos, revisar, usar, flujo, top, proveedores, sobrantes, HOY };
}

/* =====================================================================
   PIEZAS VISUALES (los colores salen de variables CSS: cambian con el tema)
   ===================================================================== */
const ESTADO_COB = d => (d === null ? "gris" : d < COBERTURA_RIESGO ? "rojo" : d < COBERTURA_ALERTA ? "amarillo" : "verde");
const ESTADO_TXT = { rojo: "Crítico", amarillo: "Atención", verde: "Suficiente", gris: "Sin consumo" };
const ESTADO_ICO = { rojo: "▲", amarillo: "●", verde: "✓", gris: "–" };
const lunesDe = f => { const d = fechaD(f); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const corto = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/* Mini columnas (una serie; la última resaltada) */
function sparkBars(vals, tips, w = 92, h = 36) {
  if (!vals.length) return "";
  const max = Math.max(...vals, 1), n = vals.length, gap = 2, bw = Math.max(3, Math.min(10, (w - gap * (n - 1)) / n));
  const total = bw * n + gap * (n - 1), x0 = w - total;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${vals.map((v, i) => {
    const bh = Math.max(v > 0 ? 3 : 1, (v / max) * (h - 2));
    return `<rect class="${i === n - 1 ? "ult" : ""}" x="${x0 + i * (bw + gap)}" y="${h - bh}" width="${bw}" height="${bh}" rx="1.5" data-tip="${esc(tips[i])}"/>`;
  }).join("")}</svg>`;
}
/* Medidor circular */
function gauge(p, size = 58) {
  const r = size / 2 - 6, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, p));
  return `<svg class="gauge" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle class="pista" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="7"/>
    <circle class="valor" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="7" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central">${Math.round(v)}%</text></svg>`;
}
/* Barra apilada de estados */
function barraEstados(partes) {
  const total = partes.reduce((a, p) => a + p.n, 0) || 1;
  return `<div class="estado-barra">${partes.filter(p => p.n).map(p => `<span class="${p.c}" style="width:${(p.n / total) * 100}%" data-tip="${esc(p.t)}: ${p.n}"></span>`).join("")}</div>`;
}
function kpi({ label, valor, unidad = "", pie = "", estado = "", viz = "" }) {
  return `<div class="kpi2 s2 ${estado}">
    <span class="kpi2-label">${label}</span>
    <div class="kpi2-fila"><span class="kpi2-valor">${valor}${unidad ? `<small>${unidad}</small>` : ""}</span><span class="kpi2-viz">${viz}</span></div>
    <div class="kpi2-pie">${pie}</div></div>`;
}
function panel(clase, titulo, sub, cuerpo, pie = "", extra = "") {
  return `<section class="panel ${clase}"><div class="panel-cab"><div><h2>${titulo}</h2>${sub ? `<p>${sub}</p>` : ""}</div>${extra}</div>${cuerpo}${pie ? `<div class="panel-pie">${pie}</div>` : ""}</section>`;
}

/* Columnas agrupadas entradas vs salidas por semana */
function graficoFlujo(flujo) {
  if (!flujo.length) return `<p class="vacio">Sin movimientos en el período</p>`;
  const W = 640, H = 250, m = { t: 22, r: 6, b: 30, l: 30 };
  const max = Math.max(...flujo.flatMap(f => [f.e, f.s]), 1);
  const paso = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10, top = Math.ceil(max / paso) * paso;
  const y = v => m.t + (H - m.t - m.b) * (1 - v / top), base = H - m.b;
  const banda = (W - m.l - m.r) / flujo.length, bw = Math.min(24, (banda - 20) / 2);
  const col = (x, v, cls, tip) => { if (v <= 0) return ""; const yy = y(v), r = Math.min(4, base - yy);
    return `<path class="col ${cls}" d="M${x},${base} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${base} Z" data-tip="${esc(tip)}"/><text class="val" x="${x + bw / 2}" y="${yy - 6}" text-anchor="middle">${v}</text>`; };
  let g = "";
  for (let v = 0; v <= top; v += paso) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${m.l - 8}" y="${y(v) + 4}" class="eje" text-anchor="end">${v}</text>`;
  flujo.forEach((f, i) => {
    const x0 = m.l + banda * i, cx = x0 + banda / 2;
    const tip = `Semana del ${fmtF(f.sem)}\nEntradas: ${f.e} registros · ${fmtN(f.eu)} und\nSalidas: ${f.s} registros · ${fmtN(f.su)} und`;
    g += `<rect class="hit" x="${x0 + 4}" y="${m.t}" width="${banda - 8}" height="${base - m.t}" rx="8" data-tip="${esc(tip)}"/>`;
    g += col(cx - bw - 1, f.e, "c-ent", tip) + col(cx + 1, f.s, "c-sal", tip);
    g += `<text x="${cx}" y="${base + 19}" class="eje" text-anchor="middle">${fmtF(f.sem).slice(0, 5)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="grafico" role="img" aria-label="Registros de entrada y salida por semana">${g}<line x1="${m.l}" x2="${W - m.r}" y1="${base}" y2="${base}" class="base"/></svg>`;
}

/* Dona de lotes por prioridad FIFO */
function dona(partes, centro, sub) {
  const total = partes.reduce((a, p) => a + p.n, 0) || 1, R = 80, r = 54, C = 85;
  let ang = -Math.PI / 2, segs = "";
  partes.filter(p => p.n).forEach(p => {
    const a = (p.n / total) * Math.PI * 2, a2 = ang + a, big = a > Math.PI ? 1 : 0;
    const pt = (rad, ra) => `${C + rad * Math.cos(ra)},${C + rad * Math.sin(ra)}`;
    segs += a >= Math.PI * 2 - 1e-6
      ? `<circle class="seg ${p.c}" cx="${C}" cy="${C}" r="${(R + r) / 2}" fill="none" stroke-width="${R - r}" data-tip="${esc(p.t)}: ${p.n}"/>`
      : `<path class="seg ${p.c}" d="M${pt(R, ang)} A${R},${R} 0 ${big} 1 ${pt(R, a2)} L${pt(r, a2)} A${r},${r} 0 ${big} 0 ${pt(r, ang)} Z" data-tip="${esc(p.t)}: ${p.n} lotes (${fmtN(Math.round((p.n / total) * 100))}%)"/>`;
    ang = a2;
  });
  return `<svg class="dona" viewBox="0 0 170 170" role="img" aria-label="Lotes por prioridad FIFO">${segs}
    <text class="centro" x="85" y="82" text-anchor="middle">${centro}</text><text class="centro-sub" x="85" y="104" text-anchor="middle">${sub}</text></svg>`;
}

/* Barras horizontales de una serie */
function barrasH(items, valor, etiqueta, tip, sufijo = () => "", color = "var(--c-ent)") {
  if (!items.length) return `<p class="vacio">Sin datos en el período</p>`;
  const max = Math.max(...items.map(valor), 1);
  return `<div class="hb">${items.map(it => `
    <div class="hb-fila" data-tip="${esc(tip(it))}">
      <span class="hb-etq">${esc(etiqueta(it))}</span><span class="hb-val">${compacto(valor(it))}${sufijo(it)}</span>
      <span class="hb-pista"><span class="hb-barra" style="width:${Math.max(2, (valor(it) / max) * 100)}%;background:${color}"></span></span>
    </div>`).join("")}</div>`;
}

/* =====================================================================
   VISTA INICIO
   ===================================================================== */
/* Cada rol ve su propio tablero */
function vInicio() {
  if (ES.calidad) return vInicioCalidad();
  return vInicioSupervisor();
}

function vInicioSupervisor() {
  const per = filtros.periodo || "todo";
  const k = calcDashboard(per);
  const lotes = calcLotes();
  const sol = BD.solicitudes, pend = sol.filter(s => s.estado === "Pendiente").length;
  const nFirmas = porRecibir().length, nSol = BD.solicitudes.filter(x => x.estado === "Pendiente").length;
  setAcciones(ES.supervisor ? `<button class="btn btn-amarillo-s" data-por-recibir>✍ Firmar salidas${nFirmas ? ` (${nFirmas})` : ""}</button><a class="btn btn-primario" href="#solicitudes">✎ Solicitudes${nSol ? ` (${nSol})` : ""}</a>` : "");

  /* Derivados para visualizar (misma información de siempre) */
  const trz = pct(k.salConLote, k.sal.length), tAve = pct(k.undAve, k.undSal);
  const cobProm = k.conConsumo.length ? k.conConsumo.reduce((a, c) => a + Math.min(c.diasCob, 365), 0) / k.conConsumo.length : null;
  const diasAnt = k.antiguo ? diasEntre(k.antiguo.fecha, k.HOY) : 0;
  const est = { rojo: 0, amarillo: 0, verde: 0, gris: 0 };
  k.cobertura.forEach(c => est[ESTADO_COB(c.diasCob)]++);
  const semanas = k.flujo.map(f => f.sem);
  const aveSem = semanas.map(s => D().averias.filter(a => a.fecha && lunesDe(a.fecha) === s).reduce((t, a) => t + Number(a.cantidad || 0), 0));
  const prior = ["USAR PRIMERO", "EN ESPERA", "AGOTADO", "REVISAR"].map((p, i) => ({ t: p.charAt(0) + p.slice(1).toLowerCase(), n: lotes.filter(l => l.prioridad === p || (p === "REVISAR" && l.prioridad === "REVISAR FECHA")).length, c: ["s-usar", "s-espera", "s-agotado", "s-revisar"][i] }));
  const totE = k.flujo.reduce((a, f) => a + f.e, 0), totS = k.flujo.reduce((a, f) => a + f.s, 0);
  const maxKit = Math.max(...k.kits.map(x => x.posibles), 1);

  /* Alertas */
  const alertas = [];
  k.kits.filter(x => x.posibles === 0).forEach(x => alertas.push(["critica", "!", `${x.nombre}: no se puede producir`, `Sin stock de ${x.limitante ? x.limitante.descripcion : "un insumo"}`]));
  k.enRiesgo.forEach(c => alertas.push(["critica", "▲", `${corto(c.descripcion, 40)}`, `Cobertura de ${fmtN(Math.round(c.diasCob))} días (${fmtN(c.stock)} ${c.unidad})`]));
  if (k.revisar.length) alertas.push(["media", "●", `${k.revisar.length} lote(s) por revisar`, "Salidas mayores a sus entradas registradas"]);
  if (k.envejecidos.length) alertas.push(["media", "◷", `${k.envejecidos.length} lotes con más de 90 días`, `El más antiguo lleva ${diasAnt} días en bodega`]);
  if (pend && !ES.auxiliar) alertas.push(["info", "✎", `${pend} solicitud(es) por aprobar`, "Revisa el módulo de solicitudes"]);
  const nRecibir = porRecibir().length, nCal = D().recepciones.filter(r => r.calidad?.estado === "Pendiente").length, nAve = averiasPendientes().length;
  if (nRecibir) alertas.push(["media", "↑", `${nRecibir} OP pendiente(s) de firma`, "Salidas → Firmar salidas"]);
  if (nCal) alertas.push(["media", "✔", `${nCal} entrada(s) esperando a Calidad`, "Material bloqueado hasta la aprobación"]);
  if (nAve) alertas.push(["media", "⚠", `${nAve} avería(s) por completar`, "Llegaron desde devoluciones con rechazo"]);
  if (!alertas.length) alertas.push(["bien", "✓", "Sin alertas", "Todo el inventario está en orden"]);

  const periodos = [["todo", "Todo el historial"], ["90", "90 días"], ["30", "30 días"]];

  return `<div class="dash">
  <div class="dash-cab">
    <div class="dash-cab-txt"><span class="vivo"><i></i>EN LÍNEA</span>
      <span>${per === "todo" ? `Historial completo · consumo promedio de ${k.dias} días (desde el ${fmtF(k.inicio)})` : `Últimos ${per} días`} · Corte al ${fmtF(k.HOY)}</span></div>
    <div class="segmento" role="group" aria-label="Período">${periodos.map(([v, t]) => `<button class="${per === v ? "activo" : ""}" data-periodo="${v}">${t}</button>`).join("")}</div>
  </div>
  ${ES.auxiliar ? accesosAuxiliar() : ""}

  ${kpi({ label: "Insumos en riesgo", valor: k.enRiesgo.length, unidad: `de ${k.cobertura.length}`, estado: k.enRiesgo.length ? "rojo" : "verde",
     viz: "", pie: `${barraEstados([{ c: "r", n: est.rojo, t: "Crítico" }, { c: "a", n: est.amarillo, t: "Atención" }, { c: "v", n: est.verde, t: "Suficiente" }, { c: "g", n: est.gris, t: "Sin consumo" }])}
       <div class="mini-leyenda" style="margin-top:7px"><span><i style="background:var(--bad)"></i>${est.rojo}</span><span><i style="background:var(--warn)"></i>${est.amarillo}</span><span><i style="background:var(--ok)"></i>${est.verde}</span><span><i style="background:var(--gray)"></i>${est.gris}</span></div>` })}
  ${kpi({ label: "Cobertura promedio", valor: cobProm === null ? "—" : fmtN(Math.round(cobProm)), unidad: cobProm === null ? "" : "días",
     viz: sparkBars(k.conConsumo.map(c => Math.min(c.diasCob, 120)), k.conConsumo.map(c => `${c.descripcion}: ${fmtN(Math.round(c.diasCob))} días`)),
     pie: "Días de stock al ritmo de consumo actual" })}
  ${kpi({ label: "Trazabilidad de lotes", valor: `${fmtN(Math.round(trz))}`, unidad: "%", estado: trz >= 90 ? "verde" : trz >= 70 ? "amarillo" : "rojo",
     viz: gauge(trz), pie: `<b>${k.salConLote}</b> de <b>${k.sal.length}</b> salidas con lote` })}
  ${kpi({ label: "Tasa de averías", valor: fmtN(Math.round(tAve * 100) / 100), unidad: "%", estado: tAve < 0.5 ? "verde" : tAve < 2 ? "amarillo" : "rojo",
     viz: sparkBars(aveSem, semanas.map((s, i) => `Semana del ${fmtF(s)}: ${fmtN(aveSem[i])} und averiadas`)),
     pie: `<b>${fmtN(k.undAve)}</b> und de <b>${compacto(k.undSal)}</b> despachadas` })}
  ${kpi({ label: "Órdenes de producción", valor: k.ops,
     viz: sparkBars(k.flujo.map(f => f.s), k.flujo.map(f => `Semana del ${fmtF(f.sem)}: ${f.s} salidas`)),
     pie: `<b>${k.sal.length}</b> salidas · <b>${k.rec.length}</b> entradas` })}
  ${ES.auxiliar ? kpi({ label: "Mis registros de hoy", valor: misRegistrosHoy(), pie: "Entradas, salidas y devoluciones" }) : kpi({ label: ES.supervisor ? "Solicitudes por aprobar" : "Solicitudes pendientes", valor: pend, estado: pend ? "amarillo" : "verde",
     viz: gauge(sol.length ? pct(sol.filter(s => s.estado !== "Pendiente").length, sol.length) : 100),
     pie: pend ? "Requieren revisión" : `Todo al día · ${sol.filter(s => s.estado === "Aprobada").length} aprobadas` })}

  ${panel("s8", "Capacidad de producción con el stock actual", "El insumo más escaso define cuántos kits puedes armar hoy",
    `<div class="cap-lista">${k.kits.map(x => `
      <div class="cap-fila">
        <div class="cap-nombre">${esc(x.nombre)}<small>Cod. oferta ${esc(x.codigo)}</small></div>
        <div class="cap-pista ${x.posibles === 0 ? "cero" : ""}" data-tip="${esc(x.nombre)}: ${fmtN(x.posibles)} kits posibles${x.limitante ? `\nLimita: ${x.limitante.descripcion} (stock ${fmtN(x.limitante.stock)} ${x.limitante.unidad} · ${x.limitante.regla})` : ""}">
          ${x.posibles > 0 ? `<span style="width:${Math.max(3, (x.posibles / maxKit) * 100)}%"></span>` : ""}
          <em>${x.limitante ? `Limita: ${esc(x.limitante.descripcion)}` : ""}</em></div>
        <div class="cap-num">${compacto(x.posibles)}<small>kits</small></div>
        <div class="cap-comps">${x.comps.slice(0, 4).map(c => { const ref = x.comps.at(-1).posibles || 1; return `
          <div class="cap-comp" data-tip="${esc(c.descripcion)}: alcanza para ${fmtN(c.posibles)} kits"><span>${esc(corto(c.descripcion, 26))}</span><em>${compacto(c.posibles)}</em>
          <span class="meter ${c.posibles === 0 ? "rojo" : ""}"><span style="width:${Math.max(2, (c.posibles / ref) * 100)}%"></span></span></div>`; }).join("")}</div>
      </div>`).join("")}</div>`,
    k.kits.some(x => x.sinInv.length) ? `<span class="cap-nota">No se controla en inventario: ${k.kits.flatMap(x => x.sinInv.map(s => esc(s.descripcion))).join(", ")}</span>` : "")}

  ${panel("s4", "Alertas operativas", "Lo que requiere atención hoy",
    `<div class="alertas">${alertas.slice(0, 8).map(([c, i, t, s]) => `<div class="alerta ${c}"><span class="ico">${i}</span><div><b>${esc(t)}</b><span>${esc(s)}</span></div></div>`).join("")}</div>`)}

  ${panel("s7 par", "Flujo de movimientos por semana", "Registros de entrada y salida · pasa el cursor para ver unidades", graficoFlujo(k.flujo),
    `<span>Entradas: <b>${totE}</b> registros</span><span>Salidas: <b>${totS}</b> registros</span><span>Semana pico: <b>${k.flujo.length ? fmtF([...k.flujo].sort((a, b) => b.e + b.s - a.e - a.s)[0].sem) : "—"}</b></span>`,
    `<div class="leyenda"><span><i style="background:var(--c-ent)"></i>Entradas</span><span><i style="background:var(--c-sal)"></i>Salidas</span></div>`)}

  ${panel("s5 par", "Salud de lotes (FIFO)", "Distribución de lotes por prioridad de consumo",
    `<div class="dona-wrap">${dona(prior, lotes.length, "LOTES")}
      <div class="dona-ley">${prior.map(p => `<div><i class="${p.c}" style="background:var(${{ "s-usar": "--ok", "s-espera": "--warn", "s-agotado": "--gray", "s-revisar": "--bad" }[p.c]})"></i><span>${p.t}<small>${fmtN(Math.round(pct(p.n, lotes.length)))}% del total</small></span><b>${p.n}</b></div>`).join("")}</div></div>`,
    k.antiguo ? `<span>Más antiguo con saldo: <b>${esc(k.antiguo.lote)}</b> · ${esc(corto(k.antiguo.insumo, 24))} · <b>${diasAnt} días</b></span>` : "")}

  ${panel("s8", "Cobertura de inventario", "¿Para cuántos días alcanza el stock al ritmo de consumo actual?",
    `<div class="scroll-y"><table class="tabla-dash"><thead><tr><th>Insumo</th><th class="num">Stock actual</th><th class="num">Consumo diario</th><th>Cobertura</th><th>Estado</th></tr></thead><tbody>
    ${[...k.conConsumo, ...k.cobertura.filter(c => c.diasCob === null)].map(c => { const n = ESTADO_COB(c.diasCob), d = c.diasCob === null ? null : Math.round(c.diasCob); return `
      <tr><td class="ins"><b>${esc(c.descripcion)}</b><small>${c.codigo}</small></td><td class="num">${fmtN(c.stock)} <span class="muted">${esc(c.unidad)}</span></td><td class="num">${c.diario ? fmtN(Math.round(c.diario * 10) / 10) : "—"}</td>
      <td>${d === null ? `<span class="muted">—</span>` : `<div class="cob"><span class="meter ${n}"><span style="width:${Math.min(100, (d / 120) * 100)}%"></span></span><b>${d > 365 ? "+365" : fmtN(d)} días</b></div>`}</td>
      <td><span class="pill ${n}">${ESTADO_ICO[n]} ${ESTADO_TXT[n]}</span></td></tr>`; }).join("")}</tbody></table></div>`,
    `<span>Crítico: menos de ${COBERTURA_RIESGO} días · Atención: ${COBERTURA_RIESGO} a ${COBERTURA_ALERTA} días · La barra llega al 100% en 120 días</span>`)}

  ${panel("s4", "Insumos más consumidos", "Unidades despachadas en el período (cada insumo en su unidad)",
    barrasH(k.top, t => t.unidades, t => t.descripcion, t => `${t.descripcion}: ${fmtN(t.unidades)} ${t.unidad}`, t => ` <small>${esc(t.unidad)}</small>`),
    k.top.length ? `<span>Mayor consumo: <b>${esc(corto(k.top[0].descripcion, 30))}</b></span>` : "")}

  ${panel("s5 par", "Recepciones por proveedor", `Entregas recibidas en el período${k.sobrantes ? ` · además ${k.sobrantes} entradas por sobrantes devueltos` : ""}`,
    barrasH(k.proveedores, p => p.n, p => p.p, p => `${p.p}: ${p.n} entregas`, p => ` <small>${p.n === 1 ? "entrega" : "entregas"}</small>`, "var(--c-sal)"),
    `<span>Total: <b>${k.proveedores.reduce((a, p) => a + p.n, 0)}</b> entregas de <b>${k.proveedores.length}</b> proveedores</span>`)}

  ${panel("s7 par", "Lotes con más de 90 días", "Deben salir primero para cumplir la rotación FIFO",
    k.envejecidos.length ? `<div class="lotes-viejos">${(() => { const mx = Math.max(...k.envejecidos.map(l => diasEntre(l.fecha, k.HOY))); return k.envejecidos.map(l => { const d = diasEntre(l.fecha, k.HOY); return `
      <div class="lv" data-tip="${esc(l.insumo)}\nLote ${esc(l.lote)} · entrada ${fmtF(l.fecha)} · saldo ${fmtN(l.saldo)}"><div><b>${esc(l.insumo)}</b><small>Lote ${esc(l.lote)} · ${fmtF(l.fecha)} · saldo ${fmtN(l.saldo)}</small></div>
      <span class="meter amarillo"><span style="width:${(d / mx) * 100}%"></span></span><em>${d} d</em></div>`; }).join(""); })()}</div>` : `<p class="vacio">No hay lotes envejecidos 👍</p>`,
    `<span>Lotes activos: <b>${k.activos.length}</b></span><span>Por revisar: <b class="${k.revisar.length ? "txt-peligro" : ""}">${k.revisar.length}</b></span>`)}
  </div>
  <p style="text-align:right;margin:0"><button class="btn btn-borde btn-mini" id="btn-reset">↺ Restablecer datos de prueba</button></p>`;
}

/* ---------- Tooltip global y filtro de período ---------- */
(() => {
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; document.body.appendChild(tip);
  document.addEventListener("mouseover", e => { const el = e.target.closest("[data-tip]"); if (!el) return; tip.textContent = el.dataset.tip; tip.hidden = false; });
  document.addEventListener("mousemove", e => { if (tip.hidden) return; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = x + "px"; tip.style.top = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 8) + "px"; });
  document.addEventListener("mouseout", e => { if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) tip.hidden = true; });
  document.addEventListener("click", e => { const b = e.target.closest("[data-periodo]"); if (b) { filtros.periodo = b.dataset.periodo; render(); } });
})();


/* =====================================================================
   TABLERO DEL AUXILIAR DE ALMACÉN (operativo: qué hacer hoy)
   ===================================================================== */
/* El auxiliar ve el tablero del supervisor, con sus accesos de registro y sin lo que solo aprueba la supervisora */
function accesosAuxiliar() {
  const acceso = (reg, ico, txt, cls) => `<button class="acceso ${cls}" data-registrar="${reg}"><span>${ico}</span>${txt}</button>`;
  return `<div class="accesos s12">${[["entradas", "↓", "Nueva entrada", "azul"], ["salidas", "↑", "Nueva salida", "amarillo"], ["devoluciones", "↺", "Nueva devolución", "azul"], ["averias", "⚠", "Nueva avería", "amarillo"]].filter(([k]) => moduloActivo(k)).map(x => acceso(...x)).join("")}</div>`;
}
function misRegistrosHoy() {
  const H = hoy(), yo = SESION.usuario;
  return [...D().recepciones.filter(r => r.fecha === H && r.recibidoPor === yo), ...D().salidas.filter(s => s.fecha === H && s.entregadoPor === yo), ...D().devoluciones.filter(x => x.fecha === H && x.registradoPor === yo)].length;
}

/* =====================================================================
   TABLERO DE CALIDAD
   ===================================================================== */
function vInicioCalidad() {
  const t = D().recepciones.filter(r => r.calidad?.requiere === "Sí");
  const pend = t.filter(r => r.calidad.estado === "Pendiente"), apr = t.filter(r => r.calidad.estado === "Aprobado"), rec = t.filter(r => r.calidad.estado === "Rechazado");
  setAcciones(`<a class="btn btn-primario" href="#calidad">✔ Ir a tickets</a>`);
  return `<div class="dash">
  <div class="dash-cab"><div class="dash-cab-txt"><span class="vivo"><i></i>EN LÍNEA</span><span>Hola, <b>${esc(SESION.nombre)}</b> · revisión de calidad de entradas</span></div></div>
  ${kpi({ label: "Tickets pendientes", valor: pend.length, estado: pend.length ? "amarillo" : "verde", pie: "Material bloqueado esperando revisión" })}
  ${kpi({ label: "Unidades bloqueadas", valor: compacto(pend.reduce((a, r) => a + Number(r.cantidad || 0), 0)), pie: "No suman al inventario" })}
  ${kpi({ label: "Aprobados", valor: apr.length, estado: "verde", pie: "Liberados al inventario" })}
  ${kpi({ label: "Rechazados", valor: rec.length, estado: rec.length ? "rojo" : "verde", pie: "No entraron al inventario" })}
  ${kpi({ label: "Tasa de aprobación", valor: fmtN(Math.round(pct(apr.length, apr.length + rec.length) || 0)), unidad: "%", viz: gauge(apr.length + rec.length ? pct(apr.length, apr.length + rec.length) : 100), pie: "De los tickets ya revisados" })}
  ${kpi({ label: "Total tickets", valor: t.length, pie: "Desde que se activó la revisión" })}
  ${panel("s12", "Tickets pendientes de revisión", "Aprueba o rechaza desde el módulo Calidad",
    pend.length ? `<div class="scroll-y"><table class="tabla-dash"><thead><tr><th>Ticket</th><th>Fecha</th><th>Insumo</th><th>Proveedor</th><th>Lote</th><th class="num">Cantidad</th></tr></thead><tbody>
      ${pend.map(r => `<tr><td class="fuerte">${esc(r.calidad.ticket)}</td><td>${fmtF(r.fecha)}</td><td class="ins"><b>${esc(desc(r.codigo))}</b><small>${r.codigo}</small></td><td>${esc(r.proveedor)}</td><td>${esc(r.lote)}</td><td class="num fuerte">${fmtN(r.cantidad)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="vacio">No hay tickets pendientes 👍</p>`)}
  </div>`;
}
