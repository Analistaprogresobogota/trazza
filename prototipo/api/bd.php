<?php
require __DIR__ . '/esquema.php';
function responder($datos, int $codigo = 200): void {
  http_response_code($codigo);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($datos, JSON_UNESCAPED_UNICODE);
  exit;
}
function conectar(array $c): PDO {
  return new PDO("mysql:host={$c['host']};port={$c['puerto']};dbname={$c['base']};charset=utf8mb4", $c['usuario'], $c['clave'],
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
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
  $marcas = implode(',', array_fill(0, count($cols), '?'));
  $act = implode(',', array_map(fn($c) => "$c=VALUES($c)", array_filter($cols, fn($c) => $c !== 'id')));
  $pdo->prepare('INSERT INTO ' . nombre_tabla($planta, $tabla) . ' (' . implode(',', $cols) . ") VALUES ($marcas) ON DUPLICATE KEY UPDATE $act")->execute($vals);
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
