"""Pruebas de Trazza en los dos motores con el MISMO código: MySQL/MariaDB (InfinityFree) y PostgreSQL (Tecnología).
Cada caso corre en /mysql y en /pg (dos copias de la app con distinto config.php, cargadas con el mismo respaldo real)
y relee la base directamente. PASS = los dos motores responden lo esperado.

Uso: python3 pruebas_motores.py <carpeta_salida>   (host de prueba: http://localhost:5183)"""
import json, subprocess, sys, itertools, datetime, urllib.request, urllib.error, http.cookiejar, os, re

HOST = "http://localhost:5183"
CLAVE = "Prueba-local-99"
MOTORES = ["mysql", "pg"]
SALIDA = sys.argv[1] if len(sys.argv) > 1 else "."
HOY = (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).strftime("%Y-%m-%d")
MANANA = (datetime.datetime.utcnow() - datetime.timedelta(hours=5) + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
COD = "100021"
seq = itertools.count(1)
PSQL = "/opt/homebrew/opt/postgresql@16/bin/psql"


def sql(q, m):
    if m == "mysql":
        r = subprocess.run(["mariadb", "--socket=/tmp/tzmy.sock", "-u", "root", "-N", "trazza_mysql", "-e", q], capture_output=True, text=True)
    else:
        r = subprocess.run([PSQL, "-h", "/tmp", "-p", "5433", "-U", "trazza_app", "-d", "trazza", "-At", "-F", "\t", "-c", "SET search_path TO trazza", "-c", q], capture_output=True, text=True)
    return (r.stdout + r.stderr).strip().replace("SET\n", "").replace("SET", "").strip()


def uno(tabla, col, id, m):
    return sql(f"select {col} from {tabla} where id='{id}'", m)


class Cliente:
    def __init__(self, m, usuario, planta="PRUEBA"):
        self.m, self.usuario = m, usuario
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        if usuario:
            s, r = self.post("login", {"usuario": usuario, "clave": CLAVE})
            assert s == 200, (m, usuario, s, r)
            s, r = self.post("planta", {"planta": planta})
            assert s == 200 or r.get("panel"), (s, r)

    def post(self, accion, cuerpo):
        req = urllib.request.Request(f"{HOST}/{self.m}/api/api.php?a={accion}", data=json.dumps(cuerpo).encode(),
                                     headers={"Content-Type": "application/json", "X-Trazza": "1"}, method="POST")
        try:
            with self.op.open(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            body = e.read()
            try: return e.code, json.loads(body)
            except Exception: return e.code, body.decode()[:200]

    def get(self, accion):
        try:
            with self.op.open(f"{HOST}/{self.m}/api/api.php?a={accion}") as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def guardar(self, *cambios):
        return self.post("guardar", {"cambios": list(cambios)})


def nid(p):
    return f"{p}TST{next(seq)}"


def entrada(usuario, **kw):
    f = {"id": nid("R"), "origen": "compra", "fecha": HOY, "hora": "10:00", "bodega": "KT", "ordenCompra": "OC1", "factura": "F1",
         "proveedor": "PROV", "remision": "R1", "codigo": COD, "cantidad": 5, "unidad": "UND", "lote": "LTST", "fechaFabricacion": "2026-01-01",
         "fechaVencimiento": "2027-01-01", "recibidoPor": usuario.upper(), "observaciones": "", "calidad": {"requiere": "No", "estado": "No aplica"}}
    f.update(kw)
    return f


def ch(tabla, fila):
    return {"tabla": tabla, "id": fila["id"], "fila": fila}


aux = {m: Cliente(m, "tmpaux") for m in MOTORES}
sup = {m: Cliente(m, "tmpsup") for m in MOTORES}
cal = {m: Cliente(m, "tmpcal") for m in MOTORES}
prog = {m: Cliente(m, "tmpprog") for m in MOTORES}
anon = {m: Cliente(m, None) for m in MOTORES}
resultados = []


def caso(cid, desc, esperado, fn):
    """fn(motor) -> (status, detalle). PASS si los dos motores devuelven el estado esperado."""
    fila = {"id": cid, "desc": desc, "esperado": esperado}
    for m in MOTORES:
        try:
            fila[m] = fn(m)
        except Exception as e:  # una excepción del caso es un FAIL, no detiene las demás pruebas
            fila[m] = ("ERROR", repr(e)[:300])
    fila["status"] = "PASS" if all(fila[m][0] == esperado for m in MOTORES) else "FAIL"
    resultados.append(fila)
    print(f"{fila['status']}  {cid}  {desc}  ->  " + " | ".join(f"{m}: {fila[m][0]}" for m in MOTORES), flush=True)


# ---------- Permisos y flujos (protocolo puntos 1-2) ----------
def p01(m):
    f = entrada("tmpaux"); s, r = aux[m].guardar(ch("recepciones", f))
    return s, f"{r} · SQL: {sql(f'select cantidad, lote, recibido_por from tq_entradas where id=' + chr(39) + f['id'] + chr(39), m)}"
caso("P01", "Auxiliar registra entrada válida (y se relee de la base)", 200, p01)


def p02(m):
    f = entrada("tmpaux"); aux[m].guardar(ch("recepciones", f))
    s, r = aux[m].guardar(ch("recepciones", dict(f, cantidad=999)))
    return s, f"{r} · cantidad en base: {uno('tq_entradas', 'cantidad', f['id'], m)}"
caso("P02", "Auxiliar modifica una entrada guardada (sin solicitud)", 403, p02)


def p03(m):
    f = entrada("tmpaux"); aux[m].guardar(ch("recepciones", f))
    return aux[m].guardar({"tabla": "recepciones", "id": f["id"], "fila": None})
caso("P03", "Auxiliar elimina una entrada", 403, p03)


def preparar_averia(m):
    op = f"OPT{next(seq)}"
    sal = {"id": nid("S"), "fecha": HOY, "hora": "10:00", "ordenProduccion": op, "destino": "L1", "codigo": COD, "cantidad": 10, "unidad": "UND",
           "lote": "LTST", "entregadoPor": "TMPAUX", "recibidoPor": "", "recibido": {"estado": "Pendiente", "por": "", "fecha": ""}, "observaciones": ""}
    dv = {"id": nid("DV"), "fecha": HOY, "hora": "10:05", "op": op, "codigo": COD, "lote": "LTST", "buenas": 1, "malas": 2, "motivo": "Sobrante y rechazo", "registradoPor": "TMPAUX", "observaciones": ""}
    av = {"id": nid("A"), "fecha": HOY, "hora": "10:05", "tipo": "Rechazo", "estado": "Pendiente de completar", "codigo": COD, "lote": "LTST", "op": op, "cantidad": 2, "devolucion": dv["id"], "registradoPor": "TMPAUX", "observaciones": ""}
    s, r = aux[m].guardar(ch("salidas", sal), ch("devoluciones", dv), ch("averias", av))
    assert s == 200, (m, s, r)
    return sal, dv, av


def p04(m):
    _, _, av = preparar_averia(m)
    s, r = aux[m].guardar(ch("averias", dict(av, estado="Completa", observaciones="Golpe en transporte", completadaPor="TMPAUX", fechaCompletada=HOY, horaCompletada="10:10")))
    return s, f"{r} · base: {sql('select estado, observaciones from tq_averias where id=' + chr(39) + av['id'] + chr(39), m)}"
caso("P04", "Auxiliar completa una avería pendiente (flujo permitido)", 200, p04)


def p05(m):
    _, _, av = preparar_averia(m)
    return aux[m].guardar(ch("averias", dict(av, cantidad=50)))
caso("P05", "Auxiliar cambia la cantidad de una avería", 403, p05)


def con_ticket(m):
    f = entrada("tmpaux", calidad={"requiere": "Sí", "estado": "Pendiente", "ticket": f"CAL-T{next(seq)}", "creado": "2026-11-09T10:00:00Z"})
    s, r = aux[m].guardar(ch("recepciones", f)); assert s == 200, (s, r)
    return f


def p06(m):
    f = con_ticket(m)
    f2 = json.loads(json.dumps(f)); f2["calidad"].update(estado="Aprobado", revisadoPor="TMPCAL", fechaRevision="2026-11-09T11:00:00Z", nota="ok")
    s, r = cal[m].guardar(ch("recepciones", f2))
    return s, f"{r} · base: {sql('select calidad_estado, calidad_revisado_por from tq_entradas where id=' + chr(39) + f['id'] + chr(39), m)}"
caso("P06", "Calidad aprueba un ticket pendiente (flujo permitido)", 200, p06)


def p07(m):
    return cal[m].guardar(ch("recepciones", dict(con_ticket(m), cantidad=1)))
caso("P07", "Calidad cambia la cantidad de una entrada", 403, p07)


def p09(m):
    f = entrada("tmpaux"); aux[m].guardar(ch("recepciones", f))
    s, r = sup[m].guardar(ch("recepciones", dict(f, cantidad=7)))
    return s, f"{r} · cantidad en base: {uno('tq_entradas', 'cantidad', f['id'], m)}"
caso("P09", "Supervisora aplica una edición (cantidad 5→7, insertar o actualizar)", 200, p09)


def p10(m):
    h = {"id": nid("H"), "fecha": "2026-11-09T10:00:00Z", "usuario": "TMPAUX", "rol": "Auxiliar", "accion": "x", "tabla": "x", "registro": "", "detalle": ""}
    aux[m].guardar(ch("bitacora", h))
    s, r = sup[m].guardar({"tabla": "bitacora", "id": h["id"], "fila": None})
    return s, f"{r} · sigue en la base: {sql('select count(*) from tq_historial where id=' + chr(39) + h['id'] + chr(39), m)}"
caso("P10", "Supervisora borra una línea del historial", 403, p10)


def p12(m):
    return prog[m].guardar(ch("recepciones", entrada("tmpprog")))
caso("P12", "Progreso intenta escribir", 403, p12)


def p13(m):
    return anon[m].guardar(ch("recepciones", entrada("x")))
caso("P13", "Sin sesión intenta guardar", 401, p13)

# ---------- Validaciones ----------
V = [
    ("V01", "Cantidad 0", lambda: entrada("tmpaux", cantidad=0)),
    ("V03", "Fabricación futura", lambda: entrada("tmpaux", fechaFabricacion=MANANA, fechaVencimiento="2028-01-01")),
    ("V06", "Fecha imposible 2026-02-30", lambda: entrada("tmpaux", fechaVencimiento="2026-02-30")),
    ("V08", "Insumo inexistente", lambda: entrada("tmpaux", codigo="999999")),
    ("V13", "Texto de más de 190 caracteres", lambda: entrada("tmpaux", proveedor="X" * 300)),
]
for cid, desc, gen in V:
    def fn(m, gen=gen):
        f = gen(); s, r = aux[m].guardar(ch("recepciones", f))
        return s, f"{r} · guardado en base: {sql('select count(*) from tq_entradas where id=' + chr(39) + f['id'] + chr(39), m)}"
    caso(cid, desc, 422, fn)


def v05(m):
    f = entrada("tmpaux", fechaFabricacion="N/A", fechaVencimiento="N/A"); s, r = aux[m].guardar(ch("recepciones", f))
    return s, f"{r} · extra: {uno('tq_entradas', 'extra', f['id'], m)}"
caso("V05", "Fechas N/A (permitido)", 200, v05)


def v14(m):
    sal, dv, _ = preparar_averia(m)  # salió 10, devueltas 3 → consulta SUM con UPPER(lote)
    return aux[m].guardar(ch("devoluciones", dict(dv, id=nid("DV"), buenas=8, malas=0)))
caso("V14", "Devolución mayor a lo que salió (suma en la base)", 422, v14)


def v16(m):
    ok, malo = entrada("tmpaux"), entrada("tmpaux", cantidad=-1)
    s, r = aux[m].guardar(ch("recepciones", ok), ch("recepciones", malo))
    return s, f"{r} · fila válida guardada?: {sql('select count(*) from tq_entradas where id=' + chr(39) + ok['id'] + chr(39), m)}"
caso("V16", "Lote con una fila válida y una inválida: no se guarda nada", 422, v16)

# ---------- Propias de la migración: consecutivos, versión, lectura, bloqueo ----------
def m01(m):
    s1, a = aux[m].post("ids", {}); s2, b = aux[m].post("ids", {})
    ok = s1 == 200 and s2 == 200 and b["sig"] == a["fin"] and a["fin"] - a["sig"] == 30
    return (200 if ok else 500), f"1ª reserva {a} · 2ª reserva {b}"
caso("M01", "Reserva de consecutivos: dos reservas seguidas no se cruzan", 200, m01)


def m02(m):
    s, v1 = aux[m].get("version"); v1 = json.loads(v1)["version"]
    aux[m].guardar(ch("recepciones", entrada("tmpaux")))
    s, v2 = aux[m].get("version"); v2 = json.loads(v2)["version"]
    return (200 if v2 == v1 + 1 else 500), f"versión {v1} → {v2}"
caso("M02", "Cada guardado sube la versión de la planta en 1", 200, m02)


def m03(m):
    s, body = aux[m].get("datos"); d = json.loads(body)
    n = {t: len(d["datos"][t]) for t in ["recepciones", "salidas", "devoluciones", "averias", "insumos"]}
    base = {t: int(sql(f"select count(*) from tq_{x}", m)) for t, x in [("recepciones", "entradas"), ("salidas", "salidas"), ("devoluciones", "devoluciones"), ("averias", "averias"), ("insumos", "insumos")]}
    num = isinstance(d["datos"]["recepciones"][0]["cantidad"], (int, float))
    return (s if n == base and num else 500), f"API {n} = base {base} · cantidades numéricas: {num}"
caso("M03", "La app lee todos los registros (mismo conteo que la base, cantidades como número)", 200, m03)


def m04(m):
    sql("delete from accesos where usuario='tmpaux'", m)
    estados = [Cliente.__new__(Cliente) for _ in range(6)]
    cod = []
    for c in estados:
        c.m = m; c.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        s, r = c.post("login", {"usuario": "tmpaux", "clave": "mala-clave-1"}); cod.append(s)
    c = estados[0]; s_ok, r_ok = c.post("login", {"usuario": "tmpaux", "clave": CLAVE})
    hasta = sql("select bloqueado_hasta from accesos where usuario='tmpaux'", m)
    s_d, _ = prog[m].post("desbloquear_usuario", {"usuario": "tmpaux"})
    s_ok2, _ = c.post("login", {"usuario": "tmpaux", "clave": CLAVE})
    ok = cod[:4] == [401] * 4 and cod[4] == 429 and s_ok == 429 and s_d == 200 and s_ok2 == 200
    return (200 if ok else 500), f"intentos {cod} · con clave buena bloqueado: {s_ok} ({r_ok.get('error', '')[:60]}) · hasta {hasta} · desbloquear {s_d} · luego entra {s_ok2}"
caso("M04", "Bloqueo: 5 intentos fallidos bloquean, Progreso desbloquea", 200, m04)


def m05(m):
    s, r = prog[m].post("admin_plantas", {})
    p = next(x for x in r["plantas"] if x["id"] == "PRUEBA")
    return s, f"{len(r['plantas'])} plantas · PRUEBA con {len(p['usuarios'])} usuarios · tmpaux débil={next(u for u in p['usuarios'] if u['usuario'] == 'tmpaux')['debil']}"
caso("M05", "Panel de Progreso: plantas, usuarios y estado de claves", 200, m05)


def m06(m):
    nombre = f"Planta Prueba Motor {m.upper()} {next(seq)}"
    s, r = prog[m].post("crear_planta", {"nombre": nombre, "modulos": ["entradas", "salidas"], "usuarios": [{"usuario": f"auxnueva{m}{next(seq)}", "nombre": "Aux Nueva", "rol": "Auxiliar", "clave": "Clave-Nueva-2026"}]})
    if s != 200: return s, r
    pid = r["id"]; pre = "pl" + pid.lower()
    tablas = sql(f"select count(*) from information_schema.tables where table_name like '{pre}\\_%'", m)
    s2, r2 = prog[m].post("planta", {"planta": pid}); s3, d = prog[m].get("datos")
    return (s if tablas == "9" and s3 == 200 else 500), f"planta {pid} · tablas creadas {tablas} · entra {s2} · datos {s3}"
caso("M06", "Progreso crea una planta nueva (crea sus 9 tablas) y entra a ella", 200, m06)

# ---------- Respaldo ----------
def r01(m):
    s, body = aux[m].get("respaldo")
    return s, body[:80].decode(errors="ignore")
caso("R01", "Auxiliar intenta descargar el respaldo", 401, r01)


def r02(m):
    s, body = prog[m].get("respaldo")
    if s == 200: open(os.path.join(SALIDA, f"respaldo_{m}.sql"), "wb").write(body)
    return s, f"{len(body)} bytes · {body[:70].decode(errors='ignore')!r}"
caso("R02", "Progreso descarga el respaldo", 200, r02)


def r03(m):
    """Restaura el respaldo descargado en una base nueva y compara conteos tabla por tabla."""
    ruta = os.path.join(SALIDA, f"respaldo_{m}.sql")
    texto = open(ruta, encoding="utf-8").read()
    decl = dict(re.findall(r"^-- Tabla (\S+): (\d+) filas$", texto, re.M))
    if m == "mysql":
        subprocess.run(["mariadb", "--socket=/tmp/tzmy.sock", "-u", "root", "-e", "DROP DATABASE IF EXISTS restaurada; CREATE DATABASE restaurada CHARACTER SET utf8mb4"], check=True)
        r = subprocess.run(f"mariadb --socket=/tmp/tzmy.sock -u root restaurada < '{ruta}'", shell=True, capture_output=True, text=True)
        cnt = lambda t: subprocess.run(["mariadb", "--socket=/tmp/tzmy.sock", "-u", "root", "-N", "restaurada", "-e", f"select count(*) from {t}"], capture_output=True, text=True).stdout.strip()
    else:
        subprocess.run([PSQL, "-h", "/tmp", "-p", "5433", "-U", "postgres", "-qc", "DROP DATABASE IF EXISTS restaurada", "-c", "CREATE DATABASE restaurada OWNER trazza_app"], check=True, capture_output=True)
        r = subprocess.run([PSQL, "-h", "/tmp", "-p", "5433", "-U", "trazza_app", "-d", "restaurada", "-v", "ON_ERROR_STOP=1", "-q", "-f", ruta], capture_output=True, text=True)
        cnt = lambda t: subprocess.run([PSQL, "-h", "/tmp", "-p", "5433", "-U", "trazza_app", "-d", "restaurada", "-At", "-c", f"select count(*) from {t}"], capture_output=True, text=True).stdout.strip()
    if r.returncode != 0: return 500, r.stderr[:300]
    mal = {t: (n, cnt(t)) for t, n in decl.items() if cnt(t) != n}
    return (200 if not mal and decl else 500), f"{len(decl)} tablas restauradas · diferencias: {mal or 'ninguna'}"
caso("R03", "El respaldo descargado se restaura completo en una base nueva", 200, r03)

print(f"\n{sum(r['status'] == 'PASS' for r in resultados)}/{len(resultados)} PASS")
json.dump(resultados, open(os.path.join(SALIDA, "resultados_motores.json"), "w"), ensure_ascii=False, indent=1, default=str)
