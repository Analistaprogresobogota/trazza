<?php
/* Migración de datos de Trazza: respaldo de MySQL (botón «Descargar respaldo» del panel de Progreso) → PostgreSQL.

   Uso (desde la terminal del servidor, en la carpeta api/):
     php migrar_a_postgresql.php <respaldo.sql>               carga en una base PostgreSQL vacía
     php migrar_a_postgresql.php <respaldo.sql> --reemplazar  borra y vuelve a crear las tablas de Trazza que ya existan

   Usa los datos de conexión de config.php (con 'motor' => 'pgsql').
   Todo corre en UNA transacción: si algo falla o los conteos no cuadran, no queda nada a medias (ROLLBACK).
   Al final imprime la verificación tabla por tabla (filas y sumas de cantidades) con PASS / FAIL. */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/bd.php';
require __DIR__ . '/accesos.php';

$args = array_slice($argv, 1);
$reemplazar = in_array('--reemplazar', $args, true);
$archivo = current(array_filter($args, fn($a) => $a !== '--reemplazar'));
if (!$archivo || !is_file($archivo)) { fwrite(STDERR, "Uso: php migrar_a_postgresql.php <respaldo.sql> [--reemplazar]\n"); exit(2); }
$cfg = is_file(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : null;
if (!$cfg || ($cfg['motor'] ?? '') !== 'pgsql') { fwrite(STDERR, "config.php debe existir y tener 'motor' => 'pgsql'.\n"); exit(2); }

/* ---------- 1. Leer el respaldo de MySQL ---------- */
function leer_respaldo(string $sql): array {
  $tablas = [];
  /* Columnas de cada tabla, en el orden del CREATE TABLE (los INSERT del respaldo no traen nombres de columnas) */
  preg_match_all('/CREATE TABLE `([^`]+)` \((.*?)\n\) ENGINE/s', $sql, $m, PREG_SET_ORDER);
  foreach ($m as [, $t, $cuerpo]) {
    preg_match_all('/^\s*`([^`]+)`/m', $cuerpo, $c);
    $tablas[$t] = ['columnas' => $c[1], 'filas' => [], 'declaradas' => null];
  }
  preg_match_all('/^-- Tabla (\S+): (\d+) filas$/m', $sql, $m, PREG_SET_ORDER);
  foreach ($m as [, $t, $n]) if (isset($tablas[$t])) $tablas[$t]['declaradas'] = (int)$n;
  /* Valores de los INSERT: NULL o texto entre comillas simples con escapes de MySQL */
  $esc = ['n' => "\n", 'r' => "\r", '0' => "\0", 'Z' => "\x1a", 't' => "\t", 'b' => "\x08"];
  $pos = 0;
  while (preg_match('/^INSERT INTO `([^`]+)` VALUES\n/m', $sql, $mm, PREG_OFFSET_CAPTURE, $pos)) {
    $t = $mm[1][0];
    $i = $mm[0][1] + strlen($mm[0][0]);
    $largo = strlen($sql);
    $fila = null; $valor = null;
    while ($i < $largo) {
      $ch = $sql[$i];
      if ($ch === '(') { $fila = []; $i++; continue; }
      if ($ch === "'") {
        $buf = ''; $i++;
        while ($i < $largo) {
          $c = $sql[$i];
          if ($c === '\\') { $sig = $sql[$i + 1]; $buf .= $esc[$sig] ?? $sig; $i += 2; continue; }
          if ($c === "'") { if (($sql[$i + 1] ?? '') === "'") { $buf .= "'"; $i += 2; continue; } $i++; break; }
          $buf .= $c; $i++;
        }
        $fila[] = $buf; continue;
      }
      if (substr($sql, $i, 4) === 'NULL') { $fila[] = null; $i += 4; continue; }
      if ($ch === ')') { $tablas[$t]['filas'][] = $fila; $fila = null; $i++; continue; }
      if ($ch === ';') { $i++; break; }
      if ($ch === ',' || $ch === "\n" || $ch === ' ') { $i++; continue; }
      throw new RuntimeException("Formato inesperado en el respaldo (tabla $t, posición $i).");
    }
    $pos = $i;
  }
  return $tablas;
}
$origen = leer_respaldo(file_get_contents($archivo));
if (!isset($origen['usuarios'], $origen['secuencias'])) { fwrite(STDERR, "El archivo no parece un respaldo de Trazza (faltan usuarios/secuencias).\n"); exit(2); }

/* ---------- 2. Conectar a PostgreSQL y armar las tablas destino con la definición del código ---------- */
$pdo = conectar($cfg);
$ddl = ['usuarios' => sql_crear()[0], 'secuencias' => sql_crear()[1], 'plantas' => sql_tabla_plantas(), 'accesos' => sql_tabla_accesos()];
$prefijos = array_values(PLANTAS);
if (isset($origen['plantas'])) {
  $ip = array_search('prefijo', $origen['plantas']['columnas'], true);
  foreach ($origen['plantas']['filas'] as $f) $prefijos[] = $f[$ip];
}
foreach (array_unique($prefijos) as $pre) { $i = 0; $sqls = sql_tablas_planta($pre); foreach (TABLAS as $def) $ddl[$pre . '_' . $def['sql']] = $sqls[$i++]; }

$omitidas = array_diff(array_keys($origen), array_keys($ddl));
foreach ($omitidas as $t) echo "AVISO  la tabla $t del respaldo no es de Trazza: se omite.\n";

$ya = array_filter(array_keys($ddl), fn($t) => isset($origen[$t]) && tabla_existe($pdo, $t) && (int)$pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn() > 0);
if ($ya && !$reemplazar) {
  fwrite(STDERR, "La base destino ya tiene datos en: " . implode(', ', $ya) . ".\nNo se cambió nada. Si de verdad se quieren reemplazar, repetir con --reemplazar (hacer antes un respaldo de PostgreSQL).\n");
  exit(1);
}

/* ---------- 3. Cargar todo en una sola transacción ---------- */
$fallas = 0; $informe = [];
try {
  $pdo->beginTransaction();
  foreach ($ddl as $t => $crear) {
    if (!isset($origen[$t])) { if (!tabla_existe($pdo, $t)) $pdo->exec($crear); continue; } // la crea vacía (p. ej. accesos)
    $pdo->exec("DROP TABLE IF EXISTS $t");
    $pdo->exec($crear);
    $cols = $origen[$t]['columnas'];
    $destino = $pdo->query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$t'")->fetchAll(PDO::FETCH_COLUMN);
    if ($faltan = array_diff($cols, $destino)) throw new RuntimeException("La tabla $t del respaldo tiene columnas que esta versión no conoce: " . implode(', ', $faltan));
    $fechas = $pdo->query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '$t' AND data_type IN ('date','timestamp without time zone')")->fetchAll(PDO::FETCH_COLUMN);
    $ins = $pdo->prepare("INSERT INTO $t (" . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')');
    foreach ($origen[$t]['filas'] as $f) {
      foreach ($cols as $k => $c) if (in_array($c, $fechas, true) && $f[$k] !== null && str_starts_with($f[$k], '0000-00-00')) $f[$k] = null; // fechas vacías de MySQL
      $ins->execute($f);
    }
    if (str_contains($crear, 'IDENTITY')) $pdo->query("SELECT setval(pg_get_serial_sequence('$t', 'n'), COALESCE((SELECT MAX(n) FROM $t), 0) + 1, false)");

    /* Verificación: filas (respaldo, leídas, en PostgreSQL) y suma de cantidades */
    $enPg = (int)$pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn();
    $leidas = count($origen[$t]['filas']);
    $decl = $origen[$t]['declaradas'] ?? $leidas;
    $ok = $enPg === $leidas && $leidas === $decl;
    $detalle = "filas: respaldo $decl · leídas $leidas · PostgreSQL $enPg";
    foreach (['cantidad', 'buenas', 'malas', 'stock_inicial'] as $c) {
      $k = array_search($c, $cols, true);
      if ($k === false) continue;
      $a = round(array_sum(array_map(fn($f) => (float)($f[$k] ?? 0), $origen[$t]['filas'])), 4);
      $b = round((float)$pdo->query("SELECT COALESCE(SUM($c),0) FROM $t")->fetchColumn(), 4);
      $ok = $ok && abs($a - $b) < 0.0001;
      $detalle .= " · suma $c " . rtrim(rtrim(number_format($a, 4, '.', ''), '0'), '.') . ' = ' . rtrim(rtrim(number_format($b, 4, '.', ''), '0'), '.');
    }
    if (!$ok) $fallas++;
    $informe[] = sprintf('%-5s %-28s %s', $ok ? 'PASS' : 'FAIL', $t, $detalle);
  }
  if ($fallas) throw new RuntimeException("$fallas tabla(s) no cuadran");
  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  echo implode("\n", $informe) . "\n";
  fwrite(STDERR, "\nMIGRACIÓN CANCELADA (ROLLBACK, la base quedó como estaba): " . $e->getMessage() . "\n");
  exit(1);
}
echo implode("\n", $informe) . "\n\nMIGRACIÓN COMPLETA: " . count($informe) . " tablas cargadas y verificadas en PostgreSQL" . ($omitidas ? ' (' . count($omitidas) . ' omitidas)' : '') . ".\n";
