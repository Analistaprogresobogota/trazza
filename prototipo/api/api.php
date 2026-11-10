<?php
/* API de Trazza: login, datos de la planta de la sesión y guardado fila por fila */
require __DIR__ . '/bd.php';
require __DIR__ . '/reglas.php';
require __DIR__ . '/accesos.php';
session_set_cookie_params(['httponly' => true, 'samesite' => 'Lax', 'secure' => !empty($_SERVER['HTTPS']), 'path' => '/']);
session_name('trazza');
session_start();
$accion = $_GET['a'] ?? '';
$cuerpo = json_decode(file_get_contents('php://input') ?: '[]', true) ?: [];
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_SERVER['HTTP_X_TRAZZA'] ?? '') !== '1') responder(['error' => 'Solicitud no permitida.'], 403);
function exigir_sesion(): array {
  if (empty($_SESSION['usuario']) || empty($_SESSION['planta'])) responder(['error' => 'sesion'], 401);
  return [$_SESSION['usuario'], $_SESSION['rol'], $_SESSION['planta']];
}
/* Plantas activas a las que entra el usuario: Progreso entra a todas; los demás solo a la suya */
function plantas_de(array $u): array {
  $act = array_filter(plantas_bd(), fn($p) => $p['activa']);
  return array_keys($u['planta'] ? array_intersect_key($act, [$u['planta'] => 1]) : $act);
}
function exigir_admin(): void {
  if (empty($_SESSION['usuario']) || ($_SESSION['rol'] ?? '') !== 'Progreso') responder(['error' => 'sesion'], 401);
}
function planta_publica(array $p): array { return ['id' => $p['id'], 'nombre' => $p['nombre'], 'modulos' => $p['modulos'], 'activa' => $p['activa']]; }
/* Valida un usuario nuevo o editado por el panel de Progreso */
function validar_usuario(array $x, bool $nuevo): ?string {
  if ($nuevo && !preg_match('/^[a-z0-9._-]{3,40}$/', $x['usuario'] ?? '')) return 'Usuario "' . ($x['usuario'] ?? '') . '": usa de 3 a 40 letras minúsculas, números, punto, guion o guion bajo (sin espacios ni tildes).';
  if (mb_strlen(trim($x['nombre'] ?? '')) < 3) return 'Escribe el nombre de cada usuario.';
  if (!in_array($x['rol'] ?? '', ROLES_PLANTA, true)) return 'Rol no válido.';
  $k = $x['clave'] ?? '';
  if (($nuevo || $k !== '') && clave_debil($k, $x['usuario'] ?? '')) return 'La contraseña de "' . ($x['usuario'] ?? '') . '" es muy fácil: usa al menos 8 caracteres combinando letras y números, que no sea el usuario ni algo como 1234 (o usa el botón para generarla).';
  return null;
}
/* Deja constancia en el historial de modificaciones de la planta */
function bitacora_admin(PDO $pdo, string $planta, string $accion, string $registro, string $detalle): void {
  escribir_fila($pdo, $planta, 'bitacora', ['id' => 'HADM-' . bin2hex(random_bytes(5)), 'fecha' => gmdate('Y-m-d\TH:i:s.000\Z'), 'usuario' => strtoupper($_SESSION['usuario']),
    'rol' => 'Progreso', 'accion' => $accion, 'tabla' => 'Plantas', 'registro' => $registro, 'detalle' => $detalle]);
  $pdo->prepare('UPDATE secuencias SET version = version + 1 WHERE planta = ?')->execute([$planta]);
}
try {
  switch ($accion) {
    case 'login': {
      $u = mb_substr(strtolower(trim($cuerpo['usuario'] ?? '')), 0, 60);
      $k = preg_replace('/[\x{2010}-\x{2015}\x{2212}]/u', '-', trim($cuerpo['clave'] ?? '')); // al copiar de una imagen el guion llega como "–"
      $pdo = bd();
      /* Bloqueo por intentos fallidos: mientras dure, ni se revisa la contraseña */
      if ($m = minutos_bloqueo($pdo, $u)) responder(['error' => "Usuario bloqueado por varios intentos fallidos. Intenta de nuevo en $m minuto(s) o pide a Progreso que lo desbloquee."], 429);
      $st = $pdo->prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1');
      $st->execute([$u]);
      $fila = $st->fetch();
      if (!$fila || !password_verify($k, $fila['clave_hash'])) {
        [$quedan, $bloqueo] = registrar_fallo($pdo, $u); /* cuenta igual si el usuario no existe: no revela cuáles existen */
        sleep(1);
        if ($bloqueo) responder(['error' => "Demasiados intentos fallidos. El usuario queda bloqueado $bloqueo minutos."], 429);
        responder(['error' => 'Usuario o contraseña incorrectos.' . ($quedan <= 2 ? " Te quedan $quedan intento(s) antes del bloqueo." : '')], 401);
      }
      registrar_ingreso($pdo, $fila['usuario'], clave_debil($k, $fila['usuario']));
      session_regenerate_id(true);
      $_SESSION = ['verificado' => $fila['usuario']];
      if ($fila['rol'] === 'Progreso') { // Progreso va al panel de plantas
        $_SESSION += ['usuario' => $fila['usuario'], 'rol' => $fila['rol']];
        responder(['panel' => true, 'usuario' => strtoupper($fila['usuario']), 'nombre' => $fila['nombre'], 'rol' => $fila['rol']]);
      }
      $todas = plantas_bd();
      if ($fila['planta'] && isset($todas[$fila['planta']]) && !$todas[$fila['planta']]['activa']) responder(['error' => 'Tu planta está desactivada. Habla con Progreso.'], 403);
      responder(['plantas' => array_map(fn($id) => ['id' => $id, 'nombre' => $todas[$id]['nombre']], plantas_de($fila))]);
    }
    case 'planta': {
      if (empty($_SESSION['verificado'])) responder(['error' => 'sesion'], 401);
      $st = bd()->prepare('SELECT * FROM usuarios WHERE usuario = ?');
      $st->execute([$_SESSION['verificado']]);
      $fila = $st->fetch();
      $planta = $cuerpo['planta'] ?? '';
      if (!$fila || !in_array($planta, plantas_de($fila), true)) responder(['error' => 'No tienes acceso a esa planta.'], 403);
      $_SESSION = array_merge($_SESSION, ['usuario' => $fila['usuario'], 'rol' => $fila['rol'], 'planta' => $planta]); // Progreso puede cambiar de planta
      $p = plantas_bd()[$planta];
      responder(['usuario' => strtoupper($fila['usuario']), 'nombre' => $fila['nombre'], 'rol' => $fila['rol'], 'planta' => $planta, 'plantaNombre' => $p['nombre'], 'modulos' => $p['modulos']]);
    }
    case 'salir':
      $_SESSION = [];
      session_destroy();
      responder(['ok' => true]);
    case 'version': {
      [, , $planta] = exigir_sesion();
      $st = bd()->prepare('SELECT version FROM secuencias WHERE planta = ?');
      $st->execute([$planta]);
      responder(['version' => (int)$st->fetchColumn()]);
    }
    case 'datos': {
      [, , $planta] = exigir_sesion();
      $pdo = bd();
      $datos = [];
      foreach (['recepciones', 'salidas', 'devoluciones', 'averias', 'insumos', 'proveedores', 'kits'] as $t) $datos[$t] = leer_tabla($pdo, $planta, $t);
      $st = $pdo->prepare('SELECT version FROM secuencias WHERE planta = ?');
      $st->execute([$planta]);
      $p = plantas_bd()[$planta] ?? null;
      if (!$p || (!$p['activa'] && $_SESSION['rol'] !== 'Progreso')) responder(['error' => 'sesion'], 401);
      responder(['planta' => planta_publica($p), 'datos' => $datos, 'solicitudes' => leer_tabla($pdo, $planta, 'solicitudes'), 'bitacora' => leer_tabla($pdo, $planta, 'bitacora'), 'version' => (int)$st->fetchColumn()]);
    }
    case 'ids': {
      [, $rol, $planta] = exigir_sesion();
      if (empty(ESCRIBE[$rol])) responder(['sig' => 0, 'fin' => 0]);
      /* El hosting usa MyISAM (sin transacciones): LAST_INSERT_ID hace la reserva en una sola operación atómica */
      $pdo = bd();
      $pdo->prepare('UPDATE secuencias SET valor = LAST_INSERT_ID(valor + 30) WHERE planta = ?')->execute([$planta]);
      $sig = (int)$pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn() - 30;
      responder(['sig' => $sig, 'fin' => $sig + 30]);
    }
    case 'guardar': {
      [$usuario, $rol, $planta] = exigir_sesion();
      $cambios = $cuerpo['cambios'] ?? [];
      if (!is_array($cambios) || count($cambios) > 500) responder(['error' => 'Solicitud no válida.'], 400);
      $pdo = bd();
      /* Reglas de negocio y permisos por registro (api/reglas.php): todo el lote se revisa antes de escribir */
      if ($error = validar_cambios(new Contexto($pdo, $planta, $usuario, $rol), $cambios)) {
        error_log("Trazza: cambio rechazado ($planta/$usuario/$rol): " . ltrim($error, "!"));
        responder(['error' => ltrim($error, '!')], $error[0] === '!' ? 403 : 422);
      }
      $pdo->beginTransaction();
      foreach ($cambios as $c) {
        if (isset($c['fila'])) escribir_fila($pdo, $planta, $c['tabla'], $c['fila']);
        else $pdo->prepare('DELETE FROM ' . nombre_tabla($planta, $c['tabla']) . ' WHERE id = ?')->execute([$c['id']]);
      }
      $pdo->prepare('UPDATE secuencias SET version = LAST_INSERT_ID(version + 1) WHERE planta = ?')->execute([$planta]);
      $version = (int)$pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();
      $pdo->commit();
      responder(['version' => $version]);
    }
    /* ---------- Panel de Progreso: plantas, módulos y usuarios ---------- */
    case 'respaldo': {
      /* Copia completa de la base en SQL (todas las plantas, usuarios con contraseña cifrada). Se restaura con Importar en phpMyAdmin. */
      exigir_admin();
      $pdo = bd();
      $base = $pdo->query('SELECT DATABASE()')->fetchColumn();
      $tablas = $pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
      error_log("Trazza: respaldo descargado por {$_SESSION['usuario']}");
      header('Content-Type: application/sql; charset=utf-8');
      header('Cache-Control: no-store');
      header('Content-Disposition: attachment; filename="trazza-respaldo-' . (new DateTime('now', new DateTimeZone('America/Bogota')))->format('Y-m-d_Hi') . '.sql"');
      echo "-- Respaldo de Trazza · base $base · " . date('c') . "\n-- CONFIDENCIAL: incluye usuarios (contraseñas cifradas). Guardar en lugar privado.\n";
      echo "-- Restaurar: phpMyAdmin > base > Importar este archivo. Reemplaza las tablas que contiene.\n-- Tablas: " . count($tablas) . "\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n";
      foreach ($tablas as $t) {
        $q = '`' . str_replace('`', '``', $t) . '`';
        $crear = $pdo->query("SHOW CREATE TABLE $q")->fetch(PDO::FETCH_NUM)[1];
        $n = (int)$pdo->query("SELECT COUNT(*) FROM $q")->fetchColumn();
        echo "-- Tabla $t: $n filas\nDROP TABLE IF EXISTS $q;\n$crear;\n";
        $lote = [];
        foreach ($pdo->query("SELECT * FROM $q") as $f) {
          $lote[] = '(' . implode(',', array_map(fn($v) => $v === null ? 'NULL' : $pdo->quote((string)$v), $f)) . ')';
          if (count($lote) === 100) { echo "INSERT INTO $q VALUES\n" . implode(",\n", $lote) . ";\n"; $lote = []; }
        }
        if ($lote) echo "INSERT INTO $q VALUES\n" . implode(",\n", $lote) . ";\n";
        echo "\n";
      }
      echo "SET FOREIGN_KEY_CHECKS=1;\n-- Fin del respaldo\n";
      exit;
    }
    case 'desbloquear_usuario': {
      exigir_admin();
      $pdo = bd();
      $st = $pdo->prepare("SELECT usuario, planta FROM usuarios WHERE usuario = ? AND rol <> 'Progreso'");
      $st->execute([strtolower(trim($cuerpo['usuario'] ?? ''))]);
      $u = $st->fetch();
      if (!$u) responder(['error' => 'Usuario no encontrado.'], 404);
      desbloquear($pdo, $u['usuario']);
      bitacora_admin($pdo, $u['planta'], 'Usuario desbloqueado', strtoupper($u['usuario']), 'Desbloqueado por Progreso');
      responder(['ok' => true]);
    }
    case 'admin_plantas': {
      exigir_admin();
      $usuarios = [];
      $filas = bd()->query("SELECT usuario, nombre, rol, planta, activo, clave_hash FROM usuarios WHERE rol <> 'Progreso' ORDER BY rol DESC, usuario")->fetchAll();
      $acc = estado_accesos(bd(), $filas);
      foreach ($filas as $u) $usuarios[$u['planta']][] = ['usuario' => $u['usuario'], 'nombre' => $u['nombre'], 'rol' => $u['rol'], 'activo' => (int)$u['activo'] === 1,
        'debil' => $acc[$u['usuario']]['debil'] ?? null, 'bloqueado' => $acc[$u['usuario']]['bloqueado'] ?? null];
      responder(['modulos' => MODULOS, 'roles' => ROLES_PLANTA, 'plantas' => array_values(array_map(fn($p) => planta_publica($p) + ['usuarios' => $usuarios[$p['id']] ?? []], plantas_bd()))]);
    }
    case 'crear_planta': {
      exigir_admin();
      $pdo = bd();
      $nombre = preg_replace('/\s+/u', ' ', trim($cuerpo['nombre'] ?? ''));
      if (mb_strlen($nombre) < 3 || mb_strlen($nombre) > 60) responder(['error' => 'El nombre de la planta debe tener entre 3 y 60 caracteres.'], 400);
      foreach (plantas_bd() as $p) if (mb_strtolower($p['nombre']) === mb_strtolower($nombre)) responder(['error' => 'Ya existe una planta con ese nombre.'], 400);
      $modulos = array_values(array_intersect(array_keys(MODULOS), (array)($cuerpo['modulos'] ?? [])));
      $usuarios = array_map(fn($x) => ['usuario' => strtolower(trim($x['usuario'] ?? '')), 'nombre' => mb_strtoupper(trim($x['nombre'] ?? '')), 'rol' => $x['rol'] ?? '', 'clave' => $x['clave'] ?? ''], (array)($cuerpo['usuarios'] ?? []));
      if (!$usuarios) responder(['error' => 'Agrega al menos un usuario.'], 400);
      $vistos = [];
      foreach ($usuarios as $x) {
        if ($e = validar_usuario($x, true)) responder(['error' => $e], 400);
        if (isset($vistos[$x['usuario']])) responder(['error' => 'El usuario "' . $x['usuario'] . '" está repetido.'], 400);
        $vistos[$x['usuario']] = 1;
      }
      $st = $pdo->prepare('SELECT usuario FROM usuarios WHERE usuario IN (' . implode(',', array_fill(0, count($vistos), '?')) . ')');
      $st->execute(array_keys($vistos));
      if ($ya = $st->fetchAll(PDO::FETCH_COLUMN)) responder(['error' => 'Ya existe el usuario: ' . implode(', ', $ya) . '. Elige otro.'], 400);
      /* id y prefijo de tablas a partir del nombre (sin tildes ni espacios) */
      $base = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $nombre)) ?: 'PLANTA');
      $base = substr(preg_replace('/^PLANTA(?=.)/', '', $base), 0, 14);
      $id = $base; $n = 2;
      $prefijos = array_column(plantas_bd(), 'prefijo');
      while (isset(plantas_bd()[$id]) || in_array('pl' . strtolower($id), $prefijos, true)) $id = substr($base, 0, 12) . $n++;
      $prefijo = 'pl' . strtolower($id);
      foreach (sql_tablas_planta($prefijo) as $sql) $pdo->exec($sql);
      $pdo->prepare('INSERT IGNORE INTO secuencias (planta, valor, version) VALUES (?,1,1)')->execute([$id]);
      $pdo->prepare('INSERT INTO plantas (id, nombre, prefijo, modulos, activa, creada) VALUES (?,?,?,?,1,NOW())')->execute([$id, $nombre, $prefijo, json_encode($modulos)]);
      plantas_bd(true);
      $ins = $pdo->prepare('INSERT INTO usuarios (usuario, nombre, rol, planta, clave_hash, activo) VALUES (?,?,?,?,?,1)');
      foreach ($usuarios as $x) { $ins->execute([$x['usuario'], $x['nombre'], $x['rol'], $id, password_hash($x['clave'], PASSWORD_BCRYPT)]); clave_cambiada($pdo, $x['usuario'], $x['clave']); }
      bitacora_admin($pdo, $id, 'Planta creada', $id, $nombre . ' · módulos: ' . (implode(', ', array_map(fn($m) => MODULOS[$m], $modulos)) ?: 'solo los fijos') . ' · usuarios: ' . implode(', ', array_map(fn($x) => strtoupper($x['usuario']) . " ({$x['rol']})", $usuarios)));
      responder(['id' => $id]);
    }
    case 'editar_planta': {
      exigir_admin();
      $pdo = bd();
      $p = plantas_bd()[$cuerpo['id'] ?? ''] ?? null;
      if (!$p) responder(['error' => 'Planta no encontrada.'], 404);
      $nombre = preg_replace('/\s+/u', ' ', trim($cuerpo['nombre'] ?? $p['nombre']));
      if (mb_strlen($nombre) < 3 || mb_strlen($nombre) > 60) responder(['error' => 'El nombre de la planta debe tener entre 3 y 60 caracteres.'], 400);
      foreach (plantas_bd() as $o) if ($o['id'] !== $p['id'] && mb_strtolower($o['nombre']) === mb_strtolower($nombre)) responder(['error' => 'Ya existe una planta con ese nombre.'], 400);
      $modulos = array_key_exists('modulos', $cuerpo) ? array_values(array_intersect(array_keys(MODULOS), (array)$cuerpo['modulos'])) : $p['modulos'];
      $activa = array_key_exists('activa', $cuerpo) ? (bool)$cuerpo['activa'] : $p['activa'];
      $pdo->prepare('UPDATE plantas SET nombre = ?, modulos = ?, activa = ? WHERE id = ?')->execute([$nombre, json_encode($modulos), $activa ? 1 : 0, $p['id']]);
      $det = [];
      if ($nombre !== $p['nombre']) $det[] = "nombre: {$p['nombre']} → $nombre";
      if ($modulos !== $p['modulos']) { $on = array_diff($modulos, $p['modulos']); $off = array_diff($p['modulos'], $modulos);
        if ($on) $det[] = 'activó: ' . implode(', ', array_map(fn($m) => MODULOS[$m], $on)); if ($off) $det[] = 'quitó: ' . implode(', ', array_map(fn($m) => MODULOS[$m], $off)); }
      if ($activa !== $p['activa']) $det[] = $activa ? 'planta activada' : 'planta desactivada';
      if ($det) bitacora_admin($pdo, $p['id'], 'Planta modificada', $p['id'], implode(' · ', $det));
      responder(['ok' => true]);
    }
    case 'guardar_usuario': {
      exigir_admin();
      $pdo = bd();
      $nuevo = !empty($cuerpo['nuevo']);
      $x = ['usuario' => strtolower(trim($cuerpo['usuario'] ?? '')), 'nombre' => mb_strtoupper(trim($cuerpo['nombre'] ?? '')), 'rol' => $cuerpo['rol'] ?? '', 'clave' => $cuerpo['clave'] ?? ''];
      $st = $pdo->prepare('SELECT * FROM usuarios WHERE usuario = ?');
      $st->execute([$x['usuario']]);
      $previo = $st->fetch();
      if ($nuevo) {
        $planta = $cuerpo['planta'] ?? '';
        if (!isset(plantas_bd()[$planta])) responder(['error' => 'Planta no encontrada.'], 404);
        if ($e = validar_usuario($x, true)) responder(['error' => $e], 400);
        if ($previo) responder(['error' => 'Ya existe el usuario "' . $x['usuario'] . '". Elige otro.'], 400);
        $pdo->prepare('INSERT INTO usuarios (usuario, nombre, rol, planta, clave_hash, activo) VALUES (?,?,?,?,?,1)')->execute([$x['usuario'], $x['nombre'], $x['rol'], $planta, password_hash($x['clave'], PASSWORD_BCRYPT)]);
        clave_cambiada($pdo, $x['usuario'], $x['clave']);
        bitacora_admin($pdo, $planta, 'Usuario creado', strtoupper($x['usuario']), "{$x['nombre']} · {$x['rol']}");
        responder(['ok' => true]);
      }
      if (!$previo || $previo['rol'] === 'Progreso' || !$previo['planta']) responder(['error' => 'Usuario no encontrado.'], 404);
      if ($e = validar_usuario($x, false)) responder(['error' => $e], 400);
      $activo = array_key_exists('activo', $cuerpo) ? ($cuerpo['activo'] ? 1 : 0) : (int)$previo['activo'];
      $pdo->prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE usuario = ?')->execute([$x['nombre'], $x['rol'], $activo, $x['usuario']]);
      if ($x['clave'] !== '') { $pdo->prepare('UPDATE usuarios SET clave_hash = ? WHERE usuario = ?')->execute([password_hash($x['clave'], PASSWORD_BCRYPT), $x['usuario']]); clave_cambiada($pdo, $x['usuario'], $x['clave']); }
      $det = [];
      if ($x['nombre'] !== $previo['nombre']) $det[] = "nombre: {$previo['nombre']} → {$x['nombre']}";
      if ($x['rol'] !== $previo['rol']) $det[] = "rol: {$previo['rol']} → {$x['rol']}";
      if ($activo !== (int)$previo['activo']) $det[] = $activo ? 'activado' : 'desactivado';
      if ($x['clave'] !== '') $det[] = 'contraseña cambiada';
      if ($det) bitacora_admin($pdo, $previo['planta'], 'Usuario modificado', strtoupper($x['usuario']), implode(' · ', $det));
      responder(['ok' => true]);
    }
  }
  responder(['error' => 'Acción desconocida.'], 404);
} catch (Throwable $e) {
  if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
  error_log('Trazza: ' . $e->getMessage());
  responder(['error' => 'Error del servidor'], 500);
}
