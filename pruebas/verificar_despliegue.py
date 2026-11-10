"""Verificación del paso 6 de DESPLIEGUE.md contra una instalación de Trazza.

Uso: python3 -I pruebas/verificar_despliegue.py <url_base> <usuario_progreso> <usuario_auxiliar>
Pide las contraseñas por teclado (no quedan en el historial de la terminal).
Registra UNA entrada de prueba con lote "VERIF-DESPLIEGUE" que la supervisora puede eliminar después.
"""
import sys, json, getpass, datetime, urllib.request, urllib.error, http.cookiejar

BASE = sys.argv[1].rstrip("/")
U_PROG, U_AUX = sys.argv[2], sys.argv[3]
C_PROG = getpass.getpass(f"Contraseña de {U_PROG}: ")
C_AUX = getpass.getpass(f"Contraseña de {U_AUX}: ")


def cliente():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def pedir(op, accion, cuerpo=None):
    url = f"{BASE}/api/api.php?a={accion}"
    req = urllib.request.Request(url, data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
                                 headers={"Content-Type": "application/json", "X-Trazza": "1"}, method="POST" if cuerpo is not None else "GET")
    try:
        with op.open(req, timeout=20) as r:
            b = r.read(); return r.status, b
    except urllib.error.HTTPError as e:
        return e.code, e.read()


res = []
def caso(nombre, ok, detalle):
    res.append(("PASS" if ok else "FAIL", nombre, detalle))

anon = cliente()
s, b = pedir(anon, "", None) if False else (None, None)
with anon.open(f"{BASE}/index.html", timeout=20) as r:
    caso("Pantalla de ingreso", r.status == 200 and b"Trazza" in r.read(), f"HTTP {r.status}")
s, b = pedir(anon, "respaldo")
caso("Respaldo sin sesión bloqueado", s == 401, f"HTTP {s}")

prog = cliente()
s, b = pedir(prog, "login", {"usuario": U_PROG, "clave": C_PROG})
caso("Ingreso de Progreso", s == 200 and json.loads(b).get("panel"), f"HTTP {s}")
s, b = pedir(prog, "admin_plantas", {})
plantas = [p["nombre"] for p in json.loads(b).get("plantas", [])] if s == 200 else []
caso("Panel de plantas", s == 200 and len(plantas) >= 1, ", ".join(plantas))
s, b = pedir(prog, "respaldo")
tablas = b.count(b"\n-- Tabla ")
caso("Descarga del respaldo", s == 200 and b.rstrip().endswith(b"-- Fin del respaldo") and tablas >= 20, f"{tablas} tablas, {len(b)//1024} KB")

aux = cliente()
s, b = pedir(aux, "login", {"usuario": U_AUX, "clave": C_AUX})
plantas_aux = json.loads(b).get("plantas", []) if s == 200 else []
caso("Ingreso de auxiliar", s == 200 and plantas_aux, f"HTTP {s}")
if plantas_aux:
    planta = plantas_aux[0]["id"]
    pedir(aux, "planta", {"planta": planta})
    s, b = pedir(aux, "datos")
    d = json.loads(b) if s == 200 else {}
    insumo = (d.get("datos", {}).get("insumos") or [{}])[0].get("codigo")
    bodega = "KT" if planta == "PRUEBA" else "Bodega"
    s2, b2 = pedir(aux, "ids", {})
    sig = json.loads(b2).get("sig") if s2 == 200 else None
    hoy = (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).strftime("%Y-%m-%d")
    fila = {"id": f"R{sig}", "origen": "compra", "fecha": hoy, "hora": "00:00", "bodega": bodega, "ordenCompra": "VERIF", "factura": "VERIF",
            "proveedor": "VERIFICACION", "remision": "VERIF", "codigo": insumo, "cantidad": 1, "unidad": "UND", "lote": "VERIF-DESPLIEGUE",
            "fechaFabricacion": "N/A", "fechaVencimiento": "N/A", "recibidoPor": U_AUX.upper(), "observaciones": "Verificación de despliegue",
            "calidad": {"requiere": "No", "estado": "No aplica"}}
    s3, b3 = pedir(aux, "guardar", {"cambios": [{"tabla": "recepciones", "id": fila["id"], "fila": fila}]})
    s4, b4 = pedir(aux, "datos")
    guardada = any(r.get("lote") == "VERIF-DESPLIEGUE" for r in json.loads(b4).get("datos", {}).get("recepciones", [])) if s4 == 200 else False
    caso("Registrar entrada y releerla", s3 == 200 and guardada, f"guardar HTTP {s3}, releída: {guardada}")

bloq = cliente()
codigos = [pedir(bloq, "login", {"usuario": "verificacion-bloqueo", "clave": "x"})[0] for _ in range(5)]
caso("Bloqueo tras 5 intentos", codigos[-1] == 429, str(codigos))

for estado, nombre, det in res:
    print(f"{estado:4}  {nombre}  ({det})")
print("RESULTADO:", "PASS" if all(r[0] == "PASS" for r in res) else "FAIL")
