<?php
/* Instalación única: pide los datos de MySQL, crea las tablas y carga los datos iniciales. Con config.php creado ya no hace nada. */
require __DIR__ . '/bd.php';
$ruta = __DIR__ . '/config.php';
$msg = '';
if (is_file($ruta)) { $msg = 'Trazza ya está instalada.'; }
elseif ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $c = ['host' => trim($_POST['host'] ?? ''), 'puerto' => (int)($_POST['puerto'] ?? 3306), 'base' => trim($_POST['base'] ?? ''), 'usuario' => trim($_POST['usuario'] ?? ''), 'clave' => $_POST['clave'] ?? ''];
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
<style>body{font-family:Arial,sans-serif;background:#EDF2FB;color:#1f2d4d;display:grid;place-items:center;min-height:100vh;margin:0}form,div{background:#fff;padding:28px;border-radius:14px;width:min(380px,90vw);box-sizing:border-box}label{display:block;margin:12px 0 4px;font-weight:700}input{width:100%;padding:10px;box-sizing:border-box}button{margin-top:18px;width:100%;padding:12px;background:#3A62AA;color:#fff;border:0;border-radius:8px;font-weight:700}p{font-weight:700}</style>
<?php if ($instalada): ?><div><h1>Trazza</h1><p id="resultado"><?= htmlspecialchars($msg) ?></p></div>
<?php else: ?><form method="post" autocomplete="off"><h1>Instalar Trazza</h1><?php if ($msg): ?><p id="resultado"><?= htmlspecialchars($msg) ?></p><?php endif; ?>
<label>Servidor MySQL<input name="host" value="<?= htmlspecialchars($_POST['host'] ?? 'sql204.infinityfree.com') ?>" required></label>
<label>Puerto<input name="puerto" value="<?= htmlspecialchars($_POST['puerto'] ?? '3306') ?>" required></label>
<label>Base de datos<input name="base" value="<?= htmlspecialchars($_POST['base'] ?? 'if0_42933937_trazza') ?>" required></label>
<label>Usuario MySQL<input name="usuario" value="<?= htmlspecialchars($_POST['usuario'] ?? 'if0_42933937') ?>" required></label>
<label>Contraseña MySQL<input name="clave" type="password" required></label>
<button>Instalar</button></form><?php endif; ?></html>
