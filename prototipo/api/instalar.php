<?php
/* Instalación única desde cero: pide los datos de la base (MySQL o PostgreSQL), crea las tablas y carga los datos iniciales (semilla.php).
   Para migrar una instalación existente NO se usa: se importa el respaldo .sql y se crea config.php (ver DESPLIEGUE.md).
   Con config.php creado ya no hace nada. */
require __DIR__ . '/bd.php';
$ruta = __DIR__ . '/config.php';
$msg = '';
if (is_file($ruta)) { $msg = 'Trazza ya está instalada.'; }
elseif (!is_file(__DIR__ . '/semilla.php')) { $msg = 'Esta copia no trae datos iniciales (semilla.php). Para instalar con los datos actuales: importa el respaldo .sql en la base y crea api/config.php desde api/config.ejemplo.php (ver DESPLIEGUE.md).'; }
elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $motor = ($_POST['motor'] ?? '') === 'pgsql' ? 'pgsql' : 'mysql';
  $c = ['motor' => $motor, 'host' => trim($_POST['host'] ?? ''), 'puerto' => (int)($_POST['puerto'] ?? ($motor === 'pgsql' ? 5432 : 3306)), 'base' => trim($_POST['base'] ?? ''), 'usuario' => trim($_POST['usuario'] ?? ''), 'clave' => $_POST['clave'] ?? '', 'esquema' => $motor === 'pgsql' ? trim($_POST['esquema'] ?? '') : ''];
  try {
    $pdo = conectar($c);
    foreach (sql_crear() as $sql) $pdo->exec($sql);
    $s = require __DIR__ . '/semilla.php';
    $pdo->beginTransaction();
    $u = $pdo->prepare('INSERT INTO usuarios (usuario, nombre, rol, planta, clave_hash) VALUES (?,?,?,?,?)');
    foreach ($s['usuarios'] as $x) $u->execute([$x['usuario'], $x['nombre'], $x['rol'], $x['planta'], $x['hash']]);
    foreach ($s['plantas'] as $planta => $e) {
      foreach ($e['tablas'] as $tabla => $filas) foreach ($filas as $fila) escribir_fila($pdo, $planta, $tabla, $fila);
      $pdo->prepare('INSERT INTO secuencias (planta, valor) VALUES (?,?)')->execute([$planta, $e['seq']]);
    }
    $pdo->commit();
    if (file_put_contents($ruta, '<?php return ' . var_export($c, true) . ";\n") === false) throw new RuntimeException('No se pudo escribir config.php');
    $msg = 'Listo: tablas creadas y datos cargados.';
  } catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    error_log('Trazza instalar: ' . $e->getMessage());
    $msg = 'No se pudo instalar. Revisa los datos e intenta de nuevo.';
  }
}
$instalada = is_file($ruta);
?><!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Instalar Trazza</title>
<style>body{font-family:Arial,sans-serif;background:#EDF2FB;color:#1f2d4d;display:grid;place-items:center;min-height:100vh;margin:0}form,div{background:#fff;padding:28px;border-radius:14px;width:min(380px,90vw);box-sizing:border-box}label{display:block;margin:12px 0 4px;font-weight:700}input,select{width:100%;padding:10px;box-sizing:border-box}button{margin-top:18px;width:100%;padding:12px;background:#3A62AA;color:#fff;border:0;border-radius:8px;font-weight:700}p{font-weight:700}</style>
<?php if ($instalada): ?><div><h1>Trazza</h1><p id="resultado"><?= htmlspecialchars($msg) ?></p></div>
<?php elseif (!is_file(__DIR__ . '/semilla.php')): ?><div><h1>Instalar Trazza</h1><p id="resultado"><?= htmlspecialchars($msg) ?></p></div>
<?php else: ?><form method="post" autocomplete="off"><h1>Instalar Trazza</h1><?php if ($msg): ?><p id="resultado"><?= htmlspecialchars($msg) ?></p><?php endif; ?>
<label>Motor<select name="motor"><option value="mysql">MySQL / MariaDB</option><option value="pgsql" <?= ($_POST['motor'] ?? '') === 'pgsql' ? 'selected' : '' ?>>PostgreSQL</option></select></label>
<label>Servidor<input name="host" value="<?= htmlspecialchars($_POST['host'] ?? 'localhost') ?>" required></label>
<label>Puerto<input name="puerto" value="<?= htmlspecialchars($_POST['puerto'] ?? '3306') ?>" required></label>
<label>Base de datos<input name="base" value="<?= htmlspecialchars($_POST['base'] ?? '') ?>" required></label>
<label>Esquema (solo PostgreSQL, opcional)<input name="esquema" value="<?= htmlspecialchars($_POST['esquema'] ?? '') ?>" placeholder="public"></label>
<label>Usuario<input name="usuario" value="<?= htmlspecialchars($_POST['usuario'] ?? '') ?>" required></label>
<label>Contraseña<input name="clave" type="password" required></label>
<button>Instalar</button></form><?php endif; ?></html>
