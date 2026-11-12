<?php
require __DIR__ . '/esquema.php';
function responder($datos, int $codigo = 200): void {
  http_response_code($codigo);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($datos, JSON_UNESCAPED_UNICODE);
  exit;
}
/* Motor de base de datos: "mysql" (MySQL / MariaDB, el de InfinityFree) o "pgsql" (PostgreSQL). Se elige en config.php con 'motor'. */
function motor(?string $nuevo = null): string {
  static $m = 'mysql';
  if ($nuevo !== null) $m = $nuevo === 'pgsql' ? 'pgsql' : 'mysql';
  return $m;
}
function es_pg(): bool { return motor() === 'pgsql'; }
function conectar(array $c): PDO {
  $opc = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false];
  if (motor($c['motor'] ?? 'mysql') === 'pgsql') {
    $pdo = new PDO("pgsql:host={$c['host']};port={$c['puerto']};dbname={$c['base']}" . (!empty($c['ssl']) ? ";sslmode={$c['ssl']}" : ''), $c['usuario'], $c['clave'], $opc);
    $pdo->exec("SET client_encoding TO 'UTF8'");
    /* Esquema opcional (por ejemplo "trazza"): las tablas se crean y leen ahí */
    if (!empty($c['esquema'])) {
      if (!preg_match('/^[a-z_][a-z0-9_]{0,62}$/', $c['esquema'])) throw new RuntimeException('Nombre de esquema no válido');
      $pdo->exec("CREATE SCHEMA IF NOT EXISTS {$c['esquema']}");
      $pdo->exec("SET search_path TO {$c['esquema']}");
    }
    return $pdo;
  }
  return new PDO("mysql:host={$c['host']};port={$c['puerto']};dbname={$c['base']};charset=utf8mb4", $c['usuario'], $c['clave'], $opc);
}
/* ---------- SQL que cambia entre MySQL y PostgreSQL ---------- */
/* INSERT que, si ya existe la clave, actualiza las columnas indicadas ($actualizar = [] → no hace nada) */
function sql_upsert(string $tabla, array $cols, string $clave, ?array $actualizar = null): string {
  $actualizar = $actualizar ?? array_values(array_filter($cols, fn($c) => $c !== $clave));
  $base = "INSERT INTO $tabla (" . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')';
  if (es_pg()) return $base . " ON CONFLICT ($clave) DO " . ($actualizar ? 'UPDATE SET ' . implode(',', array_map(fn($c) => "$c=EXCLUDED.$c", $actualizar)) : 'NOTHING');
  if (!$actualizar) return 'INSERT IGNORE' . substr($base, 6);
  return $base . ' ON DUPLICATE KEY UPDATE ' . implode(',', array_map(fn($c) => "$c=VALUES($c)", $actualizar));
}
/* Suma $n a secuencias.$col de la planta y devuelve el valor nuevo, en una sola operación atómica
   (en MySQL/MyISAM no hay transacciones: LAST_INSERT_ID hace la reserva; en PostgreSQL, RETURNING) */
function sumar_secuencia(PDO $pdo, string $col, int $n, string $planta): int {
  if (!in_array($col, ['valor', 'version'], true)) throw new InvalidArgumentException('columna');
  if (es_pg()) {
    $st = $pdo->prepare("UPDATE secuencias SET $col = $col + $n WHERE planta = ? RETURNING $col");
    $st->execute([$planta]);
    return (int)$st->fetchColumn();
  }
  $pdo->prepare("UPDATE secuencias SET $col = LAST_INSERT_ID($col + $n) WHERE planta = ?")->execute([$planta]);
  return (int)$pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();
}
/* "Ahora más N minutos" en la sintaxis de cada motor */
function sql_mas_minutos(int $min): string { return es_pg() ? "LOCALTIMESTAMP + INTERVAL '$min minutes'" : "NOW() + INTERVAL $min MINUTE"; }
function sql_ahora(): string { return es_pg() ? 'LOCALTIMESTAMP' : 'NOW()'; }
/* ¿Existe la tabla? (sin provocar errores: en PostgreSQL un error anula la transacción en curso) */
function tabla_existe(PDO $pdo, string $tabla): bool {
  if (es_pg()) { $st = $pdo->prepare('SELECT to_regclass(?) IS NOT NULL'); $st->execute([$tabla]); return (bool)$st->fetchColumn(); }
  try { $pdo->query("SELECT 1 FROM $tabla LIMIT 1"); return true; } catch (PDOException $e) { return false; } // MySQL: igual que antes
}
function bd(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $ruta = __DIR__ . '/config.php';
  if (!is_file($ruta)) responder(['error' => 'Trazza aún no está instalada.'], 503);
  return $pdo = conectar(require $ruta);
}
function valor_ruta(array $fila, string $ruta) {
  foreach (explode('.', $ruta) as $k) { if (!is_array($fila) || !array_key_exists($k, $fila)) return null; $fila = $fila[$k]; }
  return $fila;
}
function quitar_ruta(array &$fila, string $ruta): void {
  $p = explode('.', $ruta);
  if (count($p) === 1) { unset($fila[$p[0]]); return; }
  if (isset($fila[$p[0]]) && is_array($fila[$p[0]])) unset($fila[$p[0]][$p[1]]);
}
function poner_ruta(array &$fila, string $ruta, $valor): void {
  $p = explode('.', $ruta);
  if (count($p) === 1) $fila[$p[0]] = $valor; else $fila[$p[0]][$p[1]] = $valor;
}
function a_columna($v, string $tipo) {
  if ($v === null) return null;
  if ($tipo === 'N') return is_numeric($v) ? $v : null;
  if ($tipo === 'F') return preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$v) ? $v : null;
  return is_scalar($v) ? (string)$v : json_encode($v, JSON_UNESCAPED_UNICODE);
}
/* Guarda o actualiza una fila de la app en su tabla SQL */
function escribir_fila(PDO $pdo, string $planta, string $tabla, array $fila): void {
  $def = TABLAS[$tabla]['campos'];
  $cols = []; $vals = [];
  foreach ($def as $ruta => [$col, $tipo]) {
    $cols[] = $col; $vals[] = a_columna(valor_ruta($fila, $ruta), $tipo);
    quitar_ruta($fila, $ruta);
  }
  foreach ($fila as $k => $v) if ($v === [] && in_array($k, ['calidad', 'recibido'], true)) unset($fila[$k]);
  $cols[] = 'extra'; $vals[] = $fila ? json_encode($fila, JSON_UNESCAPED_UNICODE) : null;
  $pdo->prepare(sql_upsert(nombre_tabla($planta, $tabla), $cols, 'id'))->execute($vals);
}
/* Convierte una fila SQL a la forma que usa la app */
function decodificar_fila(string $tabla, array $f): array {
  $fila = $f['extra'] ? json_decode($f['extra'], true) : [];
  foreach (TABLAS[$tabla]['campos'] as $ruta => [$col, $tipo]) {
    if ($f[$col] === null) continue;
    poner_ruta($fila, $ruta, $tipo === 'N' ? (float)$f[$col] : $f[$col]);
  }
  return $fila;
}
function leer_tabla(PDO $pdo, string $planta, string $tabla): array {
  $orden = in_array($tabla, ['solicitudes', 'bitacora'], true) ? 'n DESC' : 'n';
  $out = [];
  foreach ($pdo->query('SELECT * FROM ' . nombre_tabla($planta, $tabla) . " ORDER BY $orden") as $f) $out[] = decodificar_fila($tabla, $f);
  return $out;
}
/* Una sola fila por id (null si no existe) */
function leer_fila(PDO $pdo, string $planta, string $tabla, string $id): ?array {
  $st = $pdo->prepare('SELECT * FROM ' . nombre_tabla($planta, $tabla) . ' WHERE id = ?');
  $st->execute([$id]);
  $f = $st->fetch();
  return $f ? decodificar_fila($tabla, $f) : null;
}

/* Respaldo en PostgreSQL: tablas creadas con la misma definición del código y datos con INSERT.
   Se restaura con: psql -d <base> -f respaldo.sql  (reemplaza las tablas que contiene). */
function respaldo_pg(PDO $pdo): void {
  $ddl = ['usuarios' => sql_crear()[0], 'secuencias' => sql_crear()[1], 'plantas' => sql_tabla_plantas()];
  if (tabla_existe($pdo, 'accesos')) $ddl['accesos'] = sql_tabla_accesos();
  foreach (plantas_bd() as $p) { $i = 0; $sqls = sql_tablas_planta($p['prefijo']); foreach (TABLAS as $def) $ddl[$p['prefijo'] . '_' . $def['sql']] = $sqls[$i++]; }
  $esquema = $pdo->query('SELECT current_schema()')->fetchColumn();
  echo "-- Respaldo de Trazza (PostgreSQL) · esquema $esquema · " . date('c') . "\n-- CONFIDENCIAL: incluye usuarios (contraseñas cifradas). Guardar en lugar privado.\n";
  echo "-- Restaurar: psql -d <base> -f este_archivo.sql (con el mismo search_path/esquema). Reemplaza las tablas que contiene.\n-- Tablas: " . count($ddl) . "\n\nSET client_encoding = 'UTF8';\nBEGIN;\n\n";
  foreach ($ddl as $t => $crear) {
    $n = (int)$pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn();
    echo "-- Tabla $t: $n filas\nDROP TABLE IF EXISTS $t;\n$crear;\n";
    $cols = null; $lote = [];
    foreach ($pdo->query("SELECT * FROM $t" . (str_contains($crear, 'IDENTITY') ? ' ORDER BY n' : '')) as $f) {
      $cols = $cols ?? implode(',', array_keys($f));
      $lote[] = '(' . implode(',', array_map(fn($v) => $v === null ? 'NULL' : $pdo->quote((string)$v), $f)) . ')';
      if (count($lote) === 100) { echo "INSERT INTO $t ($cols) VALUES\n" . implode(",\n", $lote) . ";\n"; $lote = []; }
    }
    if ($lote) echo "INSERT INTO $t ($cols) VALUES\n" . implode(",\n", $lote) . ";\n";
    if (str_contains($crear, 'IDENTITY')) echo "SELECT setval(pg_get_serial_sequence('$t', 'n'), COALESCE((SELECT MAX(n) FROM $t), 0) + 1, false);\n";
    echo "\n";
  }
  echo "COMMIT;\n-- Fin del respaldo\n";
}
