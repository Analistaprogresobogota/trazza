"""Pruebas de acceso (puntos 5-6): bloqueo por intentos fallidos y contraseñas débiles.
Corre contra la versión anterior (/base) y la nueva (/proto) sobre la base local de prueba."""
import json, subprocess, urllib.request, urllib.error, http.cookiejar

HOST = "http://localhost:5181"
BUENA = "Prueba-local-99"


def sql(q):
    return subprocess.run(["mariadb", "--socket=/tmp/tzdb.sock", "-u", "root", "-N", "trazza_prueba", "-e", q], capture_output=True, text=True).stdout.strip()


def sesion():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def post(op, base, accion, cuerpo):
    req = urllib.request.Request(f"{HOST}/{base}/api/api.php?a={accion}", data=json.dumps(cuerpo).encode(),
                                 headers={"Content-Type": "application/json", "X-Trazza": "1"}, method="POST")
    try:
        with op.open(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b.decode()[:120]


def login(base, u, k):
    return post(sesion(), base, "login", {"usuario": u, "clave": k})


def admin(base):
    op = sesion(); s, _ = post(op, base, "login", {"usuario": "tmpprog", "clave": BUENA}); assert s == 200
    return op


def reset():
    sql("DELETE FROM accesos") if sql("SHOW TABLES LIKE 'accesos'") else None


res = []


def caso(cid, desc, esperado, fn, bases=("base", "proto")):
    fila = {"id": cid, "desc": desc, "esperado": esperado}
    for b in bases:
        reset(); fila[b] = fn(b)
    fila["status"] = "PASS" if fila["proto"][0] == esperado else "FAIL"
    res.append(fila)


def l01(b):
    out = [login(b, "tmpaux", "mala")[0] for _ in range(5)]
    s, r = login(b, "tmpaux", BUENA)
    return s, f"5 fallos → {out}; luego clave correcta → {s} {r}"
caso("L01", "5 claves erradas bloquean: luego ni la correcta entra", 429, l01)


def l02(b):
    msgs = [login(b, "tmpaux", "mala")[1].get("error", "") for _ in range(4)]
    return (200 if "Te quedan 1" in msgs[3] else 0), msgs[2:]
caso("L02", "Avisa cuántos intentos quedan (3.º y 4.º fallo)", 200, l02)


def l03(b):
    out = [login(b, "noexiste", "x")[0] for _ in range(6)]
    return out[-1], f"usuario inexistente: {out}"
caso("L03", "Usuario inexistente se bloquea igual (no revela si existe)", 429, l03)


def l04(b):
    for _ in range(5): login(b, "tmpaux", "mala")
    op = admin(b); s, r = post(op, b, "desbloquear_usuario", {"usuario": "tmpaux"})
    s2, _ = login(b, "tmpaux", BUENA)
    return s2, f"desbloquear → {s} {r}; login → {s2}"
caso("L04", "Progreso desbloquea y el usuario entra", 200, l04)


def l05(b):
    for _ in range(4): login(b, "tmpaux", "mala")
    login(b, "tmpaux", BUENA)
    out = [login(b, "tmpaux", "mala")[0] for _ in range(4)]
    s, _ = login(b, "tmpaux", BUENA)
    return s, f"4 fallos, ingreso OK, 4 fallos más → sigue entrando: {s}"
caso("L05", "Un ingreso correcto reinicia el contador", 200, l05)


def l06(b):
    for _ in range(4): login(b, "tmpaux", "mala")
    sql("UPDATE accesos SET ultimo_fallo = NOW() - INTERVAL 16 MINUTE WHERE usuario='tmpaux'") if b == "proto" else None
    s1 = login(b, "tmpaux", "mala")[0]; s2 = login(b, "tmpaux", BUENA)[0]
    return s2, f"fallos de hace 16 min ya no cuentan: fallo={s1}, ingreso={s2}"
caso("L06", "Fallos viejos (fuera de 15 min) no suman", 200, l06)


def l07(b):
    for _ in range(5): login(b, "tmpaux", "mala")
    sql("UPDATE accesos SET bloqueado_hasta = NOW() - INTERVAL 1 MINUTE WHERE usuario='tmpaux'") if b == "proto" else None
    s = login(b, "tmpaux", BUENA)[0]
    return s, f"bloqueo vencido → {s}"
caso("L07", "Al vencer los 15 minutos vuelve a entrar", 200, l07)


def l08(b):
    for _ in range(5): login(b, "tmpaux", "mala")
    s = login(b, "tmpsup", BUENA)[0]
    return s, f"otro usuario de la misma planta → {s}"
caso("L08", "El bloqueo de un usuario no afecta a los demás", 200, l08)


def c01(b):
    s, _ = login(b, "tmpdebil", "1234")
    flag = sql("SELECT clave_debil FROM accesos WHERE usuario='tmpdebil'") if b == "proto" else "-"
    return (200 if flag == "1" else 0), f"login con 1234 → {s}; marcado débil en SQL: {flag}"
caso("C01", "Quien entra con 1234 queda marcado como clave débil", 200, c01)


def c02(b):
    op = admin(b); cargas = 0
    for cargas in range(1, 7):  # el panel revisa los que alcance en ~2 s por carga; sigue en la siguiente
        s, r = post(op, b, "admin_plantas", {})
        us = {u["usuario"]: u for p in r["plantas"] for u in p["usuarios"]}
        if all(u.get("debil") is not None for u in us.values()): break
    d = us.get("tmpdebil2", {}).get("debil"); n = us.get("tmpaux", {}).get("debil")
    return (200 if d is True and n is False else 0), f"tmpdebil2 (nunca entró, clave 1234) debil={d}; tmpaux debil={n}; cargas del panel={cargas}, usuarios={len(us)}"
caso("C02", "El panel detecta claves 1234 aunque el usuario no haya entrado", 200, c02)


def c03(b):
    op = admin(b); out = {}
    for k in ["1234", "12345678", "abcdefgh", "tmpaux", "Tz4821-kmp"]:
        out[k] = post(op, b, "guardar_usuario", {"usuario": "tmpaux", "nombre": "Tmp Aux", "rol": "Auxiliar", "clave": k})[0]
    post(op, b, "guardar_usuario", {"usuario": "tmpaux", "nombre": "Tmp Aux", "rol": "Auxiliar", "clave": BUENA})
    ok = all(v == 400 for k, v in out.items() if k != "Tz4821-kmp") and out["Tz4821-kmp"] == 200
    return (200 if ok else 0), out
caso("C03", "No deja asignar claves débiles (1234, solo números, solo letras, = usuario)", 200, c03)


def c04(b):
    op = admin(b)
    s, r = post(op, b, "crear_planta", {"nombre": "PLANTA DEBIL TEST", "modulos": ["entradas"], "usuarios": [{"usuario": "tmpnueva", "nombre": "Tmp Nueva", "rol": "Auxiliar", "clave": "1234"}]})
    existe = sql("SELECT COUNT(*) FROM plantas WHERE nombre='PLANTA DEBIL TEST'")
    return s, f"{r} · planta creada: {existe}"
caso("C04", "Crear planta con clave débil se rechaza (no crea nada)", 400, c04)


def c05(b):
    for _ in range(5): login(b, "tmpdebil", "mala")
    op = admin(b); s, r = post(op, b, "guardar_usuario", {"usuario": "tmpdebil", "nombre": "Tmp Debil", "rol": "Auxiliar", "clave": "Tz9911-wqe"})
    s2, _ = login(b, "tmpdebil", "Tz9911-wqe")
    flag = sql("SELECT clave_debil FROM accesos WHERE usuario='tmpdebil'") if b == "proto" else "-"
    # deja a tmpdebil otra vez con 1234 (la API ya no permite asignarla) para que C01 sea repetible
    w = subprocess.run(["php", "-r", "echo password_hash('1234', PASSWORD_BCRYPT);"], capture_output=True, text=True).stdout
    sql(f"UPDATE usuarios SET clave_hash='{w}' WHERE usuario='tmpdebil'")
    return s2, f"cambio de clave → {s}; login con la nueva → {s2}; débil en SQL: {flag}"
caso("C05", "Cambiar la clave desbloquea y quita la marca de débil", 200, c05)

print(json.dumps(res, ensure_ascii=False, indent=1, default=str))
