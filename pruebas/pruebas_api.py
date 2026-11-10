"""Pruebas de API de Trazza (puntos 1-2 del protocolo). Corre cada caso contra la versión
anterior (/base) y la nueva (/proto) sobre la misma base local de prueba, y relee SQL."""
import json, subprocess, sys, itertools, datetime, urllib.request, http.cookiejar

HOST = "http://localhost:5181"
CLAVE = "Prueba-local-99"
HOY = (datetime.datetime.utcnow() - datetime.timedelta(hours=5)).strftime("%Y-%m-%d")
MANANA = (datetime.datetime.utcnow() - datetime.timedelta(hours=5) + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
COD = "100021"
seq = itertools.count(1)


def sql(q):
    r = subprocess.run(["mariadb", "--socket=/tmp/tzdb.sock", "-u", "root", "-N", "trazza_prueba", "-e", q], capture_output=True, text=True)
    return r.stdout.strip()


class Cliente:
    def __init__(self, base, usuario):
        self.base, self.usuario = base, usuario
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        if usuario:
            s, r = self.post("login", {"usuario": usuario, "clave": CLAVE})
            assert s == 200, (usuario, s, r)
            if not r.get("panel"):
                s, r = self.post("planta", {"planta": "PRUEBA"})
                assert s == 200, (s, r)
            else:
                self.post("planta", {"planta": "PRUEBA"})

    def post(self, accion, cuerpo):
        req = urllib.request.Request(f"{HOST}/{self.base}/api/api.php?a={accion}", data=json.dumps(cuerpo).encode(),
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
            with self.op.open(f"{HOST}/{self.base}/api/api.php?a={accion}") as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def guardar(self, *cambios):
        return self.post("guardar", {"cambios": list(cambios)})

    def leer(self, tabla, id):
        s, r = self.post("datos", {}) if False else (None, None)
        _, d = self.op_datos()
        lista = d["datos"].get(tabla) if tabla in d["datos"] else d.get(tabla)
        return next((x for x in lista if x["id"] == id), None)

    def op_datos(self):
        with self.op.open(f"{HOST}/{self.base}/api/api.php?a=datos") as r:
            return r.status, json.loads(r.read())


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


resultados = []


def caso(cid, desc, esperado_nuevo, fn):
    """fn(base) -> (status, detalle). Corre en base (anterior) y proto (nueva)."""
    fila = {"id": cid, "desc": desc}
    for base in ["base", "proto"]:
        s, det = fn(base)
        fila[base] = (s, det)
    s_new = fila["proto"][0]
    fila["status"] = "PASS" if s_new == esperado_nuevo else "FAIL"
    fila["esperado"] = esperado_nuevo
    resultados.append(fila)


# ---------- Preparación: registros de apoyo creados con la versión nueva (flujo legítimo) ----------
aux = {b: Cliente(b, "tmpaux") for b in ["base", "proto"]}
sup = {b: Cliente(b, "tmpsup") for b in ["base", "proto"]}
cal = {b: Cliente(b, "tmpcal") for b in ["base", "proto"]}
prog = {b: Cliente(b, "tmpprog") for b in ["base", "proto"]}
anon = {b: Cliente(b, None) for b in ["base", "proto"]}


def nuevo(base, tabla, fila, quien="aux"):
    c = {"aux": aux, "sup": sup, "cal": cal}[quien][base]
    s, r = c.guardar(ch(tabla, fila))
    return s, r


# P01 entrada válida + relectura
def p01(b):
    f = entrada("tmpaux"); s, r = nuevo(b, "recepciones", f)
    back = sql(f"select cantidad, lote, recibido_por from tq_entradas where id='{f['id']}'")
    return s, f"{r} · SQL: {back}"
caso("P01", "Auxiliar registra entrada válida (y se relee de SQL)", 200, p01)


def p02(b):
    f = entrada("tmpaux"); nuevo("proto", "recepciones", f)
    f2 = dict(f, cantidad=999); s, r = nuevo(b, "recepciones", f2)
    return s, f"{r} · SQL cantidad: {sql(f'select cantidad from tq_entradas where id=' + chr(39) + f['id'] + chr(39))}"
caso("P02", "Auxiliar modifica directamente una entrada guardada (sin solicitud)", 403, p02)


def p03(b):
    f = entrada("tmpaux"); nuevo("proto", "recepciones", f)
    s, r = aux[b].guardar({"tabla": "recepciones", "id": f["id"], "fila": None})
    return s, r
caso("P03", "Auxiliar elimina una entrada", 403, p03)

# Rechazo pendiente para completar: salida + devolución con malas + avería pendiente
def preparar_averia():
    op = f"OPT{next(seq)}"
    sal = {"id": nid("S"), "fecha": HOY, "hora": "10:00", "ordenProduccion": op, "destino": "L1", "codigo": COD, "cantidad": 10, "unidad": "UND",
           "lote": "LTST", "entregadoPor": "TMPAUX", "recibidoPor": "", "recibido": {"estado": "Pendiente", "por": "", "fecha": ""}, "observaciones": ""}
    dv = {"id": nid("DV"), "fecha": HOY, "hora": "10:05", "op": op, "codigo": COD, "lote": "LTST", "buenas": 1, "malas": 2, "motivo": "Sobrante y rechazo", "registradoPor": "TMPAUX", "observaciones": ""}
    av = {"id": nid("A"), "fecha": HOY, "hora": "10:05", "tipo": "Rechazo", "estado": "Pendiente de completar", "codigo": COD, "lote": "LTST", "op": op, "cantidad": 2, "devolucion": dv["id"], "registradoPor": "TMPAUX", "observaciones": ""}
    s, r = aux["proto"].guardar(ch("salidas", sal), ch("devoluciones", dv), ch("averias", av))
    assert s == 200, (s, r)
    return sal, dv, av


def p04(b):
    _, _, av = preparar_averia()
    av2 = dict(av, estado="Completa", observaciones="Golpe en transporte", completadaPor="TMPAUX", fechaCompletada=HOY, horaCompletada="10:10")
    s, r = aux[b].guardar(ch("averias", av2))
    return s, f"{r} · SQL: {sql(f'select estado, observaciones from tq_averias where id=' + chr(39) + av['id'] + chr(39))}"
caso("P04", "Auxiliar completa una avería pendiente (flujo permitido)", 200, p04)


def p05(b):
    _, _, av = preparar_averia()
    av2 = dict(av, cantidad=50)
    s, r = aux[b].guardar(ch("averias", av2))
    return s, r
caso("P05", "Auxiliar cambia la cantidad de una avería", 403, p05)


def con_ticket():
    f = entrada("tmpaux", calidad={"requiere": "Sí", "estado": "Pendiente", "ticket": f"CAL-T{next(seq)}", "creado": "2026-11-09T10:00:00Z"})
    s, r = aux["proto"].guardar(ch("recepciones", f)); assert s == 200, (s, r)
    return f


def p06(b):
    f = con_ticket()
    f2 = json.loads(json.dumps(f)); f2["calidad"].update(estado="Aprobado", revisadoPor="TMPCAL", fechaRevision="2026-11-09T11:00:00Z", nota="ok")
    s, r = cal[b].guardar(ch("recepciones", f2))
    return s, f"{r} · SQL: {sql(f'select calidad_estado, calidad_revisado_por from tq_entradas where id=' + chr(39) + f['id'] + chr(39))}"
caso("P06", "Calidad aprueba un ticket pendiente (flujo permitido)", 200, p06)


def p07(b):
    f = con_ticket()
    f2 = dict(f, cantidad=1)
    s, r = cal[b].guardar(ch("recepciones", f2))
    return s, r
caso("P07", "Calidad cambia la cantidad de una entrada", 403, p07)


def p08(b):
    f = con_ticket()
    f2 = json.loads(json.dumps(f)); f2["calidad"].update(estado="Aprobado", revisadoPor="TMPCAL", nota="ok"); f2["lote"] = "OTRO"
    s, r = cal[b].guardar(ch("recepciones", f2))
    return s, r
caso("P08", "Calidad aprueba y a la vez cambia el lote", 403, p08)


def p09(b):
    f = entrada("tmpaux"); nuevo("proto", "recepciones", f)
    s, r = sup[b].guardar(ch("recepciones", dict(f, cantidad=7)))
    return s, f"{r} · SQL cantidad: {sql(f'select cantidad from tq_entradas where id=' + chr(39) + f['id'] + chr(39))}"
caso("P09", "Supervisora aplica una edición aprobada (cantidad 5→7)", 200, p09)


def p10(b):
    h = {"id": nid("H"), "fecha": "2026-11-09T10:00:00Z", "usuario": "TMPAUX", "rol": "Auxiliar", "accion": "x", "tabla": "x", "registro": "", "detalle": ""}
    aux["proto"].guardar(ch("bitacora", h))
    s, r = sup[b].guardar({"tabla": "bitacora", "id": h["id"], "fila": None})
    return s, f"{r} · SQL existe: {sql(f'select count(*) from tq_historial where id=' + chr(39) + h['id'] + chr(39))}"
caso("P10", "Supervisora borra una línea del historial", 403, p10)


def p11(b):
    h = {"id": nid("H"), "fecha": "2026-11-09T10:00:00Z", "usuario": "TMPAUX", "rol": "Auxiliar", "accion": "x", "tabla": "x", "registro": "", "detalle": "original"}
    aux["proto"].guardar(ch("bitacora", h))
    s, r = aux[b].guardar(ch("bitacora", dict(h, detalle="alterado")))
    return s, r
caso("P11", "Auxiliar altera una línea del historial", 403, p11)


def p12(b):
    s, r = prog[b].guardar(ch("recepciones", entrada("tmpprog")))
    return s, r
caso("P12", "Progreso intenta escribir", 403, p12)


def p13(b):
    s, r = anon[b].guardar(ch("recepciones", entrada("x")))
    return s, r
caso("P13", "Sin sesión intenta guardar", 401, p13)

# ---------- Validaciones ----------
V = [
    ("V01", "Cantidad 0", lambda: entrada("tmpaux", cantidad=0)),
    ("V02", "Cantidad decimal 2.5", lambda: entrada("tmpaux", cantidad=2.5)),
    ("V03", "Fabricación futura", lambda: entrada("tmpaux", fechaFabricacion=MANANA, fechaVencimiento="2028-01-01")),
    ("V04", "Vencimiento antes de fabricación", lambda: entrada("tmpaux", fechaFabricacion="2026-05-01", fechaVencimiento="2026-04-01")),
    ("V06", "Fecha imposible 2026-02-30", lambda: entrada("tmpaux", fechaVencimiento="2026-02-30")),
    ("V07", "Bodega que no existe", lambda: entrada("tmpaux", bodega="XX")),
    ("V08", "Insumo inexistente", lambda: entrada("tmpaux", codigo="999999")),
    ("V09", "Registro a nombre de otro usuario", lambda: entrada("tmpaux", recibidoPor="OTRO")),
    ("V10", "Entrada nueva ya 'Aprobada' por calidad", lambda: entrada("tmpaux", calidad={"requiere": "Sí", "estado": "Aprobado"})),
    ("V11", "Fecha de registro de hace un mes", lambda: entrada("tmpaux", fecha="2026-10-01")),
    ("V12", "Campo obligatorio vacío (factura)", lambda: entrada("tmpaux", factura="  ")),
    ("V13", "Texto de más de 190 caracteres", lambda: entrada("tmpaux", proveedor="X" * 300)),
]
for cid, desc, gen in V:
    def fn(b, gen=gen):
        f = gen(); s, r = nuevo(b, "recepciones", f)
        return s, f"{r} · guardado en SQL: {sql(f'select count(*) from tq_entradas where id=' + chr(39) + f['id'] + chr(39))}"
    caso(cid, desc, 422, fn)


def v05(b):
    f = entrada("tmpaux", fechaFabricacion="N/A", fechaVencimiento="N/A"); s, r = nuevo(b, "recepciones", f)
    return s, f"{r} · SQL extra: {sql(f'select extra from tq_entradas where id=' + chr(39) + f['id'] + chr(39))}"
caso("V05", "Fechas N/A (permitido)", 200, v05)


def v14(b):
    sal, dv, _ = preparar_averia()  # salió 10, devueltas 3
    d2 = dict(dv, id=nid("DV"), buenas=8, malas=0)
    s, r = aux[b].guardar(ch("devoluciones", d2))
    return s, r
caso("V14", "Devolución mayor a lo que salió (10 salió, 3 ya devueltas, devuelve 8)", 422, v14)


def v15(b):
    sal = {"id": nid("S"), "fecha": HOY, "hora": "10:00", "ordenProduccion": "OPX", "destino": "L1", "codigo": COD, "cantidad": 3, "unidad": "UND",
           "lote": "LTST", "entregadoPor": "TMPAUX", "recibidoPor": "YO", "recibido": {"estado": "Recibido", "por": "YO"}, "observaciones": ""}
    return nuevo(b, "salidas", sal)
caso("V15", "Auxiliar crea una salida ya firmada", 422, v15)


def v16(b):
    ok, malo = entrada("tmpaux"), entrada("tmpaux", cantidad=-1)
    s, r = aux[b].guardar(ch("recepciones", ok), ch("recepciones", malo))
    return s, f"{r} · fila válida guardada?: {sql(f'select count(*) from tq_entradas where id=' + chr(39) + ok['id'] + chr(39))}"
caso("V16", "Lote con una fila válida y una inválida: no se guarda nada", 422, v16)

# ---------- Respaldo ----------
def r01(b):
    s, body = aux[b].get("respaldo")
    return s, body[:80].decode(errors="ignore")
caso("R01", "Auxiliar intenta descargar el respaldo", 401, r01)


def r02(b):
    s, body = prog[b].get("respaldo")
    if b == "proto" and s == 200:
        open(sys.argv[1], "wb").write(body)
    return s, f"{len(body)} bytes · {body[:60].decode(errors='ignore')!r}"
caso("R02", "Progreso descarga el respaldo", 200, r02)

print(json.dumps(resultados, ensure_ascii=False, indent=1, default=str))
