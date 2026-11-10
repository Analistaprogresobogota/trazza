<?php
/* Tablas de Trazza. Cada planta tiene su propio juego de tablas (prefijo); "usuarios" y "secuencias" son comunes.
   Cada campo: ruta en la app => [columna SQL, tipo]. Lo que no esté aquí se guarda en la columna "extra" (JSON). */
/* Plantas iniciales (id => prefijo de tablas). Las demás se crean desde el panel de Progreso y viven en la tabla "plantas". */
const PLANTAS = ['PRUEBA' => 'tq', 'PROGRESO' => 'progreso'];
const NOMBRES_INICIALES = ['PRUEBA' => 'Planta TQ Devoluciones', 'PROGRESO' => 'Planta Progreso'];
/* Módulos que se pueden activar o quitar por planta (los demás son fijos: inicio, inventario, insumos, proveedores, solicitudes, bitácora) */
const MODULOS = ['entradas' => 'Entradas', 'salidas' => 'Salidas', 'devoluciones' => 'Devoluciones', 'averias' => 'Averías',
  'lotes' => 'Control lotes FIFO', 'kits' => 'Códigos kits', 'historial' => 'Historial de movimientos', 'calidad' => 'Calidad'];
const ROLES_PLANTA = ['Supervisor', 'Auxiliar', 'Calidad'];
const TIPOS_SQL = ['T' => 'VARCHAR(190)', 'L' => 'TEXT', 'M' => 'MEDIUMTEXT', 'N' => 'DECIMAL(18,4)', 'F' => 'DATE', 'H' => 'VARCHAR(8)', 'I' => 'VARCHAR(40)'];
const TABLAS = [
  'recepciones' => ['sql' => 'entradas', 'campos' => [
    'id' => ['id', 'I'], 'origen' => ['origen', 'I'], 'fecha' => ['fecha', 'F'], 'hora' => ['hora', 'H'], 'bodega' => ['bodega', 'I'],
    'ordenCompra' => ['orden_compra', 'T'], 'factura' => ['factura', 'T'], 'proveedor' => ['proveedor', 'T'], 'remision' => ['remision', 'T'],
    'codigo' => ['codigo', 'I'], 'cantidad' => ['cantidad', 'N'], 'unidad' => ['unidad', 'I'], 'lote' => ['lote', 'T'],
    'recibidoPor' => ['recibido_por', 'T'], 'observaciones' => ['observaciones', 'L'],
    'calidad.requiere' => ['calidad_requiere', 'I'], 'calidad.estado' => ['calidad_estado', 'I'], 'calidad.ticket' => ['calidad_ticket', 'I'],
    'calidad.revisadoPor' => ['calidad_revisado_por', 'T'], 'calidad.nota' => ['calidad_nota', 'L']]],
  'salidas' => ['sql' => 'salidas', 'campos' => [
    'id' => ['id', 'I'], 'fecha' => ['fecha', 'F'], 'hora' => ['hora', 'H'], 'ordenProduccion' => ['orden_produccion', 'T'], 'destino' => ['destino', 'T'],
    'codigo' => ['codigo', 'I'], 'cantidad' => ['cantidad', 'N'], 'unidad' => ['unidad', 'I'], 'lote' => ['lote', 'T'],
    'entregadoPor' => ['entregado_por', 'T'], 'recibidoPor' => ['recibido_por', 'T'], 'observaciones' => ['observaciones', 'L'],
    'recibido.estado' => ['recibido_estado', 'I'], 'recibido.firmadoPor' => ['firmado_por', 'T'], 'recibido.firma' => ['firma', 'M']]],
  'devoluciones' => ['sql' => 'devoluciones', 'campos' => [
    'id' => ['id', 'I'], 'fecha' => ['fecha', 'F'], 'hora' => ['hora', 'H'], 'op' => ['orden_produccion', 'T'], 'codigo' => ['codigo', 'I'], 'lote' => ['lote', 'T'],
    'buenas' => ['buenas', 'N'], 'malas' => ['malas', 'N'], 'motivo' => ['motivo', 'L'], 'registradoPor' => ['registrado_por', 'T'], 'observaciones' => ['observaciones', 'L']]],
  'averias' => ['sql' => 'averias', 'campos' => [
    'id' => ['id', 'I'], 'fecha' => ['fecha', 'F'], 'hora' => ['hora', 'H'], 'tipo' => ['tipo', 'I'], 'estado' => ['estado', 'I'], 'codigo' => ['codigo', 'I'],
    'lote' => ['lote', 'T'], 'op' => ['orden_produccion', 'T'], 'cantidad' => ['cantidad', 'N'], 'registradoPor' => ['registrado_por', 'T'], 'observaciones' => ['observaciones', 'L']]],
  'insumos' => ['sql' => 'insumos', 'campos' => [
    'id' => ['id', 'I'], 'codigo' => ['codigo', 'I'], 'descripcion' => ['descripcion', 'T'], 'tipo' => ['tipo', 'I'], 'grupo' => ['grupo', 'I'], 'unidad' => ['unidad', 'I'],
    'stockInicial' => ['stock_inicial', 'N'], 'salidasHistoricas' => ['salidas_historicas', 'N'],
    'baseFechaEntrada' => ['base_fecha_entrada', 'F'], 'baseFechaSalida' => ['base_fecha_salida', 'F'], 'observaciones' => ['observaciones', 'L']]],
  'proveedores' => ['sql' => 'proveedores', 'campos' => ['id' => ['id', 'I'], 'nombre' => ['nombre', 'T'], 'nit' => ['nit', 'I'], 'contacto' => ['contacto', 'T']]],
  'kits' => ['sql' => 'kits', 'campos' => ['id' => ['id', 'T'], 'kit' => ['kit', 'T']]],
  'solicitudes' => ['sql' => 'solicitudes', 'campos' => [
    'id' => ['id', 'I'], 'fecha' => ['fecha', 'I'], 'usuario' => ['usuario', 'T'], 'tabla' => ['tabla', 'I'], 'registroId' => ['registro_id', 'I'], 'tipo' => ['tipo', 'I'],
    'motivo' => ['motivo', 'L'], 'resumen' => ['resumen', 'L'], 'estado' => ['estado', 'I'], 'resueltoPor' => ['resuelto_por', 'T'], 'fechaResolucion' => ['fecha_resolucion', 'I']]],
  'bitacora' => ['sql' => 'historial', 'campos' => [
    'id' => ['id', 'I'], 'fecha' => ['fecha', 'I'], 'usuario' => ['usuario', 'T'], 'rol' => ['rol', 'I'], 'accion' => ['accion', 'T'], 'tabla' => ['tabla', 'T'],
    'registro' => ['registro', 'T'], 'detalle' => ['detalle', 'L']]],
];
/* Qué tablas puede escribir cada rol (Progreso solo ve). Solo la supervisora elimina. */
const ESCRIBE = [
  'Auxiliar' => ['recepciones', 'salidas', 'devoluciones', 'averias', 'solicitudes', 'bitacora'],
  'Supervisor' => ['recepciones', 'salidas', 'devoluciones', 'averias', 'insumos', 'proveedores', 'solicitudes', 'bitacora'],
  'Calidad' => ['recepciones', 'bitacora'],
];
/* Tabla "plantas": se crea sola la primera vez, con TQ Devoluciones y Progreso */
function plantas_bd(bool $recargar = false): array {
  static $cache = null;
  if ($cache !== null && !$recargar) return $cache;
  $pdo = bd();
  /* Solo la primera vez se crea la tabla (un CREATE dentro de un guardado cerraría su transacción) */
  try { $pdo->query('SELECT 1 FROM plantas LIMIT 1'); $existe = true; } catch (PDOException $e) { $existe = false; }
  if (!$existe) {
  $pdo->exec("CREATE TABLE IF NOT EXISTS plantas (id VARCHAR(30) PRIMARY KEY, nombre VARCHAR(120) NOT NULL, prefijo VARCHAR(20) NOT NULL UNIQUE, modulos TEXT NULL, activa TINYINT NOT NULL DEFAULT 1, creada DATETIME NULL) DEFAULT CHARSET=utf8mb4");
  $todos = json_encode(array_keys(MODULOS));
  foreach (PLANTAS as $id => $pre) $pdo->prepare('INSERT IGNORE INTO plantas (id, nombre, prefijo, modulos, activa, creada) VALUES (?,?,?,?,1,NOW())')->execute([$id, NOMBRES_INICIALES[$id], $pre, $todos]);
  }
  $cache = [];
  foreach ($pdo->query('SELECT * FROM plantas ORDER BY creada, id = \'PRUEBA\' DESC, id') as $f) {
    $f['modulos'] = array_values(array_intersect(json_decode($f['modulos'] ?: '[]', true) ?: [], array_keys(MODULOS)));
    $f['activa'] = (int)$f['activa'] === 1;
    $cache[$f['id']] = $f;
  }
  return $cache;
}
function nombre_tabla(string $planta, string $tabla): string {
  if (isset(PLANTAS[$planta])) return PLANTAS[$planta] . '_' . TABLAS[$tabla]['sql']; // las iniciales no necesitan consultar la base
  $p = plantas_bd()[$planta] ?? null;
  if (!$p) throw new RuntimeException("Planta desconocida: $planta");
  return $p['prefijo'] . '_' . TABLAS[$tabla]['sql'];
}
/* CREATE TABLE de todas las tablas de una planta */
function sql_tablas_planta(string $prefijo): array {
  $out = [];
  foreach (TABLAS as $def) {
    $cols = ['n INT AUTO_INCREMENT UNIQUE'];
    foreach ($def['campos'] as [$col, $tipo]) $cols[] = "$col " . TIPOS_SQL[$tipo] . ($col === 'id' ? ' NOT NULL PRIMARY KEY' : ' NULL');
    $cols[] = 'extra MEDIUMTEXT NULL';
    $out[] = "CREATE TABLE IF NOT EXISTS {$prefijo}_{$def['sql']} (" . implode(', ', $cols) . ') DEFAULT CHARSET=utf8mb4';
  }
  return $out;
}
function sql_crear(): array {
  $out = [
    "CREATE TABLE IF NOT EXISTS usuarios (usuario VARCHAR(60) PRIMARY KEY, nombre VARCHAR(190) NOT NULL, rol VARCHAR(30) NOT NULL, planta VARCHAR(30) NULL, clave_hash VARCHAR(255) NOT NULL, activo TINYINT NOT NULL DEFAULT 1) DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE IF NOT EXISTS secuencias (planta VARCHAR(30) PRIMARY KEY, valor INT NOT NULL DEFAULT 1, version INT NOT NULL DEFAULT 1) DEFAULT CHARSET=utf8mb4",
  ];
  foreach (PLANTAS as $prefijo) $out = array_merge($out, sql_tablas_planta($prefijo));
  return $out;
}
