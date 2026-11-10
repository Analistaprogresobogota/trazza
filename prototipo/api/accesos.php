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
  try { $pdo->query('SELECT 1 FROM accesos LIMIT 1'); }
  catch (Throwable $e) {
    $pdo->exec('CREATE TABLE IF NOT EXISTS accesos (
      usuario VARCHAR(60) NOT NULL PRIMARY KEY,
      fallos INT NOT NULL DEFAULT 0,
      ultimo_fallo DATETIME NULL,
      bloqueado_hasta DATETIME NULL,
      ultimo_ok DATETIME NULL,
      clave_debil TINYINT NULL
    ) DEFAULT CHARSET=utf8mb4');
  }
  $listo = true;
}

/* Contraseña débil: menos de 8 caracteres, sin letras o sin números, muy común o igual al usuario */
function clave_debil(string $clave, string $usuario): bool {
  $c = mb_strtolower(trim($clave));
  return mb_strlen($c) < 8 || !preg_match('/\pL/u', $c) || !preg_match('/\d/', $c) || in_array($c, CLAVES_COMUNES, true) || $c === mb_strtolower($usuario);
}

/* Minutos de bloqueo que le quedan al usuario (0 si puede intentar) */
function minutos_bloqueo(PDO $pdo, string $usuario): int {
  accesos_bd($pdo);
  $st = $pdo->prepare('SELECT TIMESTAMPDIFF(SECOND, NOW(), bloqueado_hasta) FROM accesos WHERE usuario = ? AND bloqueado_hasta > NOW()');
  $st->execute([$usuario]);
  $s = $st->fetchColumn();
  return $s === false ? 0 : max(1, (int)ceil($s / 60));
}

/* Registra un fallo; devuelve [intentos que quedan, minutos de bloqueo si se acaba de bloquear] */
function registrar_fallo(PDO $pdo, string $usuario): array {
  accesos_bd($pdo);
  $pdo->prepare('INSERT INTO accesos (usuario, fallos, ultimo_fallo) VALUES (?, 1, NOW())
    ON DUPLICATE KEY UPDATE fallos = IF(ultimo_fallo IS NULL OR ultimo_fallo < NOW() - INTERVAL ' . VENTANA_MIN . ' MINUTE, 1, fallos + 1), ultimo_fallo = NOW()')->execute([$usuario]);
  $st = $pdo->prepare('SELECT fallos FROM accesos WHERE usuario = ?');
  $st->execute([$usuario]);
  $fallos = (int)$st->fetchColumn();
  if ($fallos >= MAX_FALLOS) {
    $pdo->prepare('UPDATE accesos SET bloqueado_hasta = NOW() + INTERVAL ' . BLOQUEO_MIN . ' MINUTE, fallos = 0 WHERE usuario = ?')->execute([$usuario]);
    error_log("Trazza: usuario bloqueado por intentos fallidos: $usuario");
    return [0, BLOQUEO_MIN];
  }
  return [MAX_FALLOS - $fallos, 0];
}

function registrar_ingreso(PDO $pdo, string $usuario, bool $debil): void {
  accesos_bd($pdo);
  $pdo->prepare('INSERT INTO accesos (usuario, fallos, ultimo_ok, clave_debil) VALUES (?, 0, NOW(), ?)
    ON DUPLICATE KEY UPDATE fallos = 0, bloqueado_hasta = NULL, ultimo_ok = NOW(), clave_debil = VALUES(clave_debil)')->execute([$usuario, $debil ? 1 : 0]);
}

/* Al cambiar la contraseña desde el panel: se desbloquea y se recalcula si es débil */
function clave_cambiada(PDO $pdo, string $usuario, string $clave): void {
  accesos_bd($pdo);
  $pdo->prepare('INSERT INTO accesos (usuario, fallos, clave_debil) VALUES (?, 0, ?)
    ON DUPLICATE KEY UPDATE fallos = 0, bloqueado_hasta = NULL, clave_debil = VALUES(clave_debil)')->execute([$usuario, clave_debil($clave, $usuario) ? 1 : 0]);
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
  foreach ($pdo->query('SELECT usuario, clave_debil, IF(bloqueado_hasta > NOW(), DATE_FORMAT(bloqueado_hasta, "%H:%i"), NULL) AS hasta FROM accesos') as $f)
    $out[$f['usuario']] = ['debil' => $f['clave_debil'] === null ? null : (int)$f['clave_debil'] === 1, 'bloqueado' => $f['hasta']];
  $limite = microtime(true) + 2.0;
  foreach ($usuarios as $u) {
    if (($out[$u['usuario']]['debil'] ?? null) !== null) continue;
    if (microtime(true) > $limite) break;
    $debil = password_verify('1234', $u['clave_hash']);
    $pdo->prepare('INSERT INTO accesos (usuario, clave_debil) VALUES (?, ?) ON DUPLICATE KEY UPDATE clave_debil = IFNULL(clave_debil, VALUES(clave_debil))')->execute([$u['usuario'], $debil ? 1 : 0]);
    $out[$u['usuario']] = ['debil' => $debil, 'bloqueado' => $out[$u['usuario']]['bloqueado'] ?? null];
  }
  return $out;
}
