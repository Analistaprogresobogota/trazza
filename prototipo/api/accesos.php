<?php
/* Seguridad de acceso: bloqueo por intentos fallidos y detección de contraseñas débiles.
   Tabla "accesos" (una fila por usuario), se crea sola la primera vez. Nunca se usa dentro de una transacción de guardado. */

const MAX_FALLOS = 5;          // intentos fallidos permitidos...
const VENTANA_MIN = 15;        // ...dentro de esta ventana (minutos)
const BLOQUEO_MIN = 15;        // tiempo de bloqueo (minutos)
const CLAVES_COMUNES = ['1234', '12345', '123456', '1234567', '12345678', '0000', '1111', 'password', 'clave', 'contraseña', 'trazza', 'qwerty', 'admin'];

function accesos_bd(PDO $pdo): void {
  static $listo = false;
  if ($listo) return;
  if (!tabla_existe($pdo, 'accesos')) $pdo->exec(sql_tabla_accesos());
  $listo = true;
}

function sql_tabla_accesos(): string {
  $fh = sql_fecha_hora();
  return "CREATE TABLE IF NOT EXISTS accesos (usuario VARCHAR(60) NOT NULL PRIMARY KEY, fallos INT NOT NULL DEFAULT 0, ultimo_fallo $fh NULL, bloqueado_hasta $fh NULL, ultimo_ok $fh NULL, clave_debil " . sql_entero_corto() . ' NULL)' . sql_fin_tabla();
}

/* Contraseña débil: menos de 8 caracteres, sin letras o sin números, muy común o igual al usuario */
function clave_debil(string $clave, string $usuario): bool {
  $c = mb_strtolower(trim($clave));
  return mb_strlen($c) < 8 || !preg_match('/\pL/u', $c) || !preg_match('/\d/', $c) || in_array($c, CLAVES_COMUNES, true) || $c === mb_strtolower($usuario);
}

/* Minutos de bloqueo que le quedan al usuario (0 si puede intentar) */
function minutos_bloqueo(PDO $pdo, string $usuario): int {
  accesos_bd($pdo);
  $seg = es_pg() ? 'EXTRACT(EPOCH FROM (bloqueado_hasta - LOCALTIMESTAMP))' : 'TIMESTAMPDIFF(SECOND, NOW(), bloqueado_hasta)';
  $st = $pdo->prepare("SELECT $seg FROM accesos WHERE usuario = ? AND bloqueado_hasta > " . sql_ahora());
  $st->execute([$usuario]);
  $s = $st->fetchColumn();
  return $s === false ? 0 : max(1, (int)ceil($s / 60));
}

/* Registra un fallo; devuelve [intentos que quedan, minutos de bloqueo si se acaba de bloquear] */
function registrar_fallo(PDO $pdo, string $usuario): array {
  accesos_bd($pdo);
  /* Si el último fallo fue hace más de la ventana, el conteo vuelve a empezar */
  $st = $pdo->prepare('SELECT CASE WHEN ultimo_fallo IS NULL OR ultimo_fallo < ' . sql_mas_minutos(-VENTANA_MIN) . ' THEN 1 ELSE fallos + 1 END FROM accesos WHERE usuario = ?');
  $st->execute([$usuario]);
  $nuevos = $st->fetchColumn();
  $pdo->prepare(sql_upsert('accesos', ['usuario', 'fallos'], 'usuario'))->execute([$usuario, $nuevos === false ? 1 : (int)$nuevos]);
  $pdo->prepare('UPDATE accesos SET ultimo_fallo = ' . sql_ahora() . ' WHERE usuario = ?')->execute([$usuario]);
  $st = $pdo->prepare('SELECT fallos FROM accesos WHERE usuario = ?');
  $st->execute([$usuario]);
  $fallos = (int)$st->fetchColumn();
  if ($fallos >= MAX_FALLOS) {
    $pdo->prepare('UPDATE accesos SET bloqueado_hasta = ' . sql_mas_minutos(BLOQUEO_MIN) . ', fallos = 0 WHERE usuario = ?')->execute([$usuario]);
    error_log("Trazza: usuario bloqueado por intentos fallidos: $usuario");
    return [0, BLOQUEO_MIN];
  }
  return [MAX_FALLOS - $fallos, 0];
}

function registrar_ingreso(PDO $pdo, string $usuario, bool $debil): void {
  accesos_bd($pdo);
  $pdo->prepare(sql_upsert('accesos', ['usuario', 'fallos', 'clave_debil'], 'usuario'))->execute([$usuario, 0, $debil ? 1 : 0]);
  $pdo->prepare('UPDATE accesos SET bloqueado_hasta = NULL, ultimo_ok = ' . sql_ahora() . ' WHERE usuario = ?')->execute([$usuario]);
}

/* Al cambiar la contraseña desde el panel: se desbloquea y se recalcula si es débil */
function clave_cambiada(PDO $pdo, string $usuario, string $clave): void {
  accesos_bd($pdo);
  $pdo->prepare(sql_upsert('accesos', ['usuario', 'fallos', 'clave_debil'], 'usuario'))->execute([$usuario, 0, clave_debil($clave, $usuario) ? 1 : 0]);
  $pdo->prepare('UPDATE accesos SET bloqueado_hasta = NULL WHERE usuario = ?')->execute([$usuario]);
}

function desbloquear(PDO $pdo, string $usuario): void {
  accesos_bd($pdo);
  $pdo->prepare('UPDATE accesos SET fallos = 0, bloqueado_hasta = NULL WHERE usuario = ?')->execute([$usuario]);
}

/* Estado para el panel. Usuarios que aún no se revisan: se prueba su hash contra "1234" (la clave de prueba
   que se usó al inicio). bcrypt es lento a propósito, así que se revisan los que quepan en ~2 s por consulta;
   el resultado queda guardado y la siguiente carga del panel sigue con los que falten. */
function estado_accesos(PDO $pdo, array $usuarios): array {
  accesos_bd($pdo);
  $out = [];
  $hasta = es_pg() ? "to_char(bloqueado_hasta, 'HH24:MI')" : "DATE_FORMAT(bloqueado_hasta, '%H:%i')";
  foreach ($pdo->query('SELECT usuario, clave_debil, CASE WHEN bloqueado_hasta > ' . sql_ahora() . " THEN $hasta END AS hasta FROM accesos") as $f)
    $out[$f['usuario']] = ['debil' => $f['clave_debil'] === null ? null : (int)$f['clave_debil'] === 1, 'bloqueado' => $f['hasta']];
  $limite = microtime(true) + 2.0;
  foreach ($usuarios as $u) {
    if (($out[$u['usuario']]['debil'] ?? null) !== null) continue;
    if (microtime(true) > $limite) break;
    $debil = password_verify('1234', $u['clave_hash']);
    $pdo->prepare(sql_upsert('accesos', ['usuario', 'clave_debil'], 'usuario', []))->execute([$u['usuario'], $debil ? 1 : 0]); /* si ya existe, no se toca */
    $pdo->prepare('UPDATE accesos SET clave_debil = ? WHERE usuario = ? AND clave_debil IS NULL')->execute([$debil ? 1 : 0, $u['usuario']]);
    $out[$u['usuario']] = ['debil' => $debil, 'bloqueado' => $out[$u['usuario']]['bloqueado'] ?? null];
  }
  return $out;
}
