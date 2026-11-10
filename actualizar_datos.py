"""Actualiza prototipo/datos.js desde el Excel de la planta (solo datos, misma estructura).
Uso: python3 actualizar_datos.py "ruta/al/excel.xlsx"   (la hoja CORREOS nunca se lee)"""
import collections, datetime, json, os, re, subprocess, sys, warnings
import openpyxl
warnings.filterwarnings("ignore")
BASE = os.path.dirname(os.path.abspath(__file__))
DATOS = os.path.join(BASE, "datos-fuente", "datos.js")
U = lambda s: str(s if s is not None else "").strip().upper()
T = lambda s: str(s if s is not None else "").strip()
def fecha(v):
    return v.date().isoformat() if isinstance(v, datetime.datetime) else ""
def serial(n):
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(n))).isoformat()
def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
cod = lambda v: str(int(v))

wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
wf = openpyxl.load_workbook(sys.argv[1])
d = json.loads(subprocess.check_output(["node", "-e", "global.window={};require(process.argv[1]);console.log(JSON.stringify(window.DATOS_INICIALES))", DATOS]))

filas = lambda hoja: wb[hoja].iter_rows(min_row=3, values_only=True)
rec = [dict(fecha=fecha(r[0]), ordenCompra=T(r[1]), proveedor=T(r[2]), remision=T(r[3]), codigo=cod(r[5]), cantidad=r[6], unidad=T(r[7]), lote=T(r[8]), recibidoPor=T(r[9]), observaciones=T(r[10]))
       for r in filas("RECEPCION INSUMOS") if num(r[5]) and num(r[6])]
sal = [dict(fecha=fecha(r[0]), ordenProduccion=T(r[1]), destino=T(r[2]), codigo=cod(r[4]), cantidad=r[5], unidad=T(r[6]), lote=T(r[7]), entregadoPor=T(r[8]), recibidoPor=T(r[9]), observaciones=T(r[10]))
       for r in filas("SALIDAS INSUMOS") if num(r[4]) and num(r[5])]
dev = [dict(fecha=fecha(r[0]), op=T(r[1]), codigo=cod(r[4]), lote=T(r[7]), buenas=r[5], malas=0, motivo="", registradoPor=T(r[8]), observaciones=T(r[9]))
       for r in filas("DEVOLUCIONES") if num(r[4]) and num(r[5])]
ave = [dict(fecha=fecha(r[0]), op=T(r[1]), codigo=cod(r[3]), cantidad=r[4], observaciones=T(r[5]))
       for r in filas("AVERIAS") if num(r[3]) and num(r[4])]

# Inventario: mismo stock del Excel (stock inicial + entradas + devoluciones - salidas)
inv = {}
for fila in wb["INVENTARIO"].iter_rows():
    if num(fila[0].value):
        inv.setdefault(cod(fila[0].value), fila)
suma = lambda lista, c, k: sum(x[k] for x in lista if x["codigo"] == c)
for i in d["insumos"]:
    f = inv.get(i["codigo"])
    if not f:
        continue
    fh = str(wf["INVENTARIO"][f[7].coordinate].value or "")
    fs = str(wf["INVENTARIO"][f[8].coordinate].value or "")
    be, bs = re.search(r"\b(4\d{4})\b", fh), re.search(r"\b(4\d{4})\b", fs)
    i.update(stockInicial=f[2].value, salidasHistoricas=f[4].value - suma(sal, i["codigo"], "cantidad"), unidad=T(f[6].value),
             baseFechaEntrada=serial(be.group(1)) if be and f[3].value else "", baseFechaSalida=serial(bs.group(1)) if bs else "")

# Lotes: los saldos ajustados a mano en el Excel entran como "saldo inicial" del lote (mecanismo que ya existe)
objetivo, fechas = {}, {}
for r in wb["CONTROL LOTES"].iter_rows(min_row=3, values_only=True):
    if num(r[0]):
        k = (cod(r[0]), U(r[2])); objetivo[k] = r[6] or 0; fechas[k] = (fecha(r[3]), T(r[2]))
for r in wb["LOTES AGOTADOS"].iter_rows(min_row=4, values_only=True):
    if num(r[0]):
        k = (cod(r[0]), U(r[2])); objetivo.setdefault(k, 0); fechas.setdefault(k, (fecha(r[3]), T(r[2])))
movido = collections.Counter(); lote_txt = {}; primera = {}
for x in rec:
    if x["lote"]:
        k = (x["codigo"], U(x["lote"])); movido[k] += x["cantidad"]; lote_txt[k] = x["lote"]
        primera[k] = min(primera.get(k, "9"), x["fecha"])
for x in dev:
    if x["lote"] and U(x["lote"]) != "N/A":
        k = (x["codigo"], U(x["lote"])); movido[k] += x["buenas"]; lote_txt[k] = x["lote"]
for x in sal:
    if x["lote"]:
        k = (x["codigo"], U(x["lote"])); movido[k] -= x["cantidad"]; lote_txt.setdefault(k, x["lote"])
ajustes = []
for k in sorted(set(objetivo) | set(movido)):
    falta = round(objetivo.get(k, 0) - movido[k], 6)
    f, txt = fechas.get(k, ("", lote_txt.get(k, k[1])))
    antes = f and f < primera.get(k, "9")
    if falta or antes:
        ajustes.append(dict(fecha=f or primera.get(k, ""), codigo=k[0], lote=txt, cantidad=falta, registradoPor="EXCEL", observaciones="Ajuste de saldo segun CONTROL LOTES"))

d.update(recepciones=rec, salidas=sal, devoluciones=dev, averias=ave, lotesAntiguos=ajustes)
cab = "/* Datos iniciales extraídos de " + os.path.basename(sys.argv[1]) + " + productos_digitalizados_actualizado.xlsx (kits y producto terminado) */\n"
open(DATOS, "w", encoding="utf-8").write(cab + "window.DATOS_INICIALES = " + json.dumps(d, ensure_ascii=False, indent=1) + ";\n")
print("entradas", len(rec), "salidas", len(sal), "devoluciones", len(dev), "averias", len(ave), "ajustes de lote", len(ajustes), "negativos", sum(a["cantidad"] < 0 for a in ajustes), "sin fecha", sum(not x["fecha"] for x in rec + sal + dev + ave))
