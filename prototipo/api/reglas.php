<?php
/* Reglas del servidor para "guardar": qué puede cambiar cada rol y qué datos son válidos.
   La interfaz ya valida lo mismo, pero la API no confía en el navegador. */

const MSG_SOLICITUD = '!Los registros guardados solo se cambian con una solicitud de edición aprobada por la supervisora.';
const LARGOS = ['I' => 40, 'T' => 190, 'H' => 8];

/* Fila "aplanada" para comparar: columnas SQL normalizadas + claves que van a "extra" */
function ksort_rec($v) {
  if (!is_array($v)) return $v;
  ksort($v);
  return array_map('ksort_rec', $v);
}
function plano(string $tabla, array $fila): array {
  $out = [];
  foreach (TABLAS[$tabla]['campos'] as $ruta => [$col, $tipo]) {
    $v = a_columna(valor_ruta($fila, $ruta), $tipo);
    $out[$ruta] = $v === null ? null : ($tipo === 'N' ? (string)(float)$v : (string)$v);
    quitar_ruta($fila, $ruta);
  }
  foreach ($fila as $k => $v) {
    if ($v === [] && in_array($k, ['calidad', 'recibido'], true)) continue;
    $out['extra.' . $k] = json_encode(ksort_rec($v), JSON_UNESCAPED_UNICODE);
  }
  return $out;
}
function campos_cambiados(string $tabla, array $vieja, array $nueva): array {
  $a = plano($tabla, $vieja); $b = plano($tabla, $nueva);
  $out = [];
  foreach (array_unique(array_merge(array_keys($a), array_keys($b))) as $k) if (($a[$k] ?? null) !== ($b[$k] ?? null)) $out[] = $k;
  return $out;
}
function solo_estos(array $cambiados, array $permitidos): bool {
  foreach ($cambiados as $k) if (!in_array($k, $permitidos, true)) return false;
  return true;
}

/* ---------- Validaciones de datos ---------- */
function es_fecha(string $f): bool {
  $p = explode('-', $f);
  return preg_match('/^\d{4}-\d{2}-\d{2}$/', $f) && checkdate((int)$p[1], (int)$p[2], (int)$p[0]);
}
function hoy(): string { return (new DateTime('now', new DateTimeZone('America/Bogota')))->format('Y-m-d'); }
function texto($v): string { return is_scalar($v) ? trim((string)$v) : ''; }
function entero_pos($v, bool $cero = false): bool {
  return is_numeric($v) && (float)$v == floor((float)$v) && ($cero ? (float)$v >= 0 : (float)$v > 0);
}
function fecha_registro($v): ?string {
  /* La fecha de un registro nuevo la pone el sistema: debe ser hoy (±1 día por zona horaria del equipo) */
  $f = texto($v);
  if (!es_fecha($f)) return 'La fecha del registro no es válida.';
  $d = abs((new DateTime($f))->getTimestamp() - (new DateTime(hoy()))->getTimestamp()) / 86400;
  return $d > 1 ? 'La fecha del registro debe ser la de hoy.' : null;
}
function obligatorios(array $fila, array $campos): ?string {
  foreach ($campos as $k => $nombre) if (texto(valor_ruta($fila, $k)) === '') return "Falta: $nombre.";
  return null;
}
function largos(string $tabla, array $fila): ?string {
  foreach (TABLAS[$tabla]['campos'] as $ruta => [$col, $tipo]) {
    $v = valor_ruta($fila, $ruta);
    if (isset(LARGOS[$tipo]) && is_scalar($v) && mb_strlen((string)$v) > LARGOS[$tipo]) return "El campo $ruta es demasiado largo (máximo " . LARGOS[$tipo] . ' caracteres).';
  }
  return null;
}
function mismo_usuario($v, string $usuario): bool { return strcasecmp(texto($v), $usuario) === 0; }

/* Fechas de fabricación y vencimiento: fecha real o "N/A" */
function validar_fechas_lote($fab, $venc): ?string {
  $fab = texto($fab); $venc = texto($venc);
  foreach (['fabricación' => $fab, 'vencimiento' => $venc] as $n => $f) if ($f !== 'N/A' && !es_fecha($f)) return "La fecha de $n no es válida (usa una fecha o N/A).";
  if ($fab !== 'N/A' && $fab > hoy()) return 'La fecha de fabricación no puede ser futura.';
  if ($fab !== 'N/A' && $venc !== 'N/A' && $venc <= $fab) return 'La fecha de vencimiento debe ser posterior a la de fabricación.';
  return null;
}

class Contexto {
  public $insumos = [];
  public $pendientes = []; /* filas nuevas ya revisadas en este mismo guardado */
  public $pdo; public $planta; public $usuario; public $rol;
  public function __construct(PDO $pdo, string $planta, string $usuario, string $rol) {
    $this->pdo = $pdo; $this->planta = $planta; $this->usuario = $usuario; $this->rol = $rol;
    foreach ($pdo->query('SELECT codigo FROM ' . nombre_tabla($planta, 'insumos')) as $f) $this->insumos[(string)$f['codigo']] = true;
  }
  public function bodegas(): array { return $this->planta === 'PRUEBA' ? ['KT', 'TQ'] : ['Bodega']; }
}

/* Registro nuevo: datos completos y coherentes */
function validar_nuevo(Contexto $cx, string $tabla, array $f): ?string {
  $u = $cx->usuario;
  switch ($tabla) {
    case 'recepciones':
      if ($cx->rol !== 'Auxiliar') return '!Solo el auxiliar registra entradas.';
      if (($f['origen'] ?? '') !== 'compra') return 'Origen de la entrada no válido.';
      if ($e = obligatorios($f, ['bodega' => 'bodega', 'ordenCompra' => 'orden de compra', 'factura' => 'factura', 'proveedor' => 'proveedor', 'remision' => 'remisión', 'codigo' => 'insumo', 'lote' => 'lote'])) return $e;
      if (!in_array($f['bodega'], $cx->bodegas(), true)) return 'Bodega no válida para esta planta.';
      if (!isset($cx->insumos[texto($f['codigo'])])) return 'El insumo no existe en el catálogo.';
      if (!entero_pos($f['cantidad'] ?? null)) return 'La cantidad debe ser un número entero mayor a 0.';
      if ($e = validar_fechas_lote($f['fechaFabricacion'] ?? '', $f['fechaVencimiento'] ?? '')) return $e;
      if (!mismo_usuario($f['recibidoPor'] ?? '', $u)) return 'El registro debe quedar a nombre de quien lo guarda.';
      $cal = $f['calidad'] ?? [];
      if (!in_array([$cal['requiere'] ?? '', $cal['estado'] ?? ''], [['Sí', 'Pendiente'], ['No', 'No aplica']], true)) return 'Estado de calidad no válido para una entrada nueva.';
      return fecha_registro($f['fecha'] ?? '');
    case 'salidas':
      if ($cx->rol !== 'Auxiliar') return '!Solo el auxiliar registra salidas.';
      if ($e = obligatorios($f, ['ordenProduccion' => 'orden de producción', 'codigo' => 'insumo', 'lote' => 'lote'])) return $e;
      if (!isset($cx->insumos[texto($f['codigo'])])) return 'El insumo no existe en el catálogo.';
      if (!is_numeric($f['cantidad'] ?? null) || (float)$f['cantidad'] <= 0) return 'La cantidad de la salida debe ser mayor a 0.';
      if (!mismo_usuario($f['entregadoPor'] ?? '', $u)) return 'El registro debe quedar a nombre de quien lo guarda.';
      if (($f['recibido']['estado'] ?? '') !== 'Pendiente') return 'Una salida nueva queda pendiente de firma de la supervisora.';
      return fecha_registro($f['fecha'] ?? '');
    case 'devoluciones':
      if ($cx->rol !== 'Auxiliar') return '!Solo el auxiliar registra devoluciones.';
      if ($e = obligatorios($f, ['op' => 'orden de producción', 'codigo' => 'insumo', 'lote' => 'lote'])) return $e;
      if (!entero_pos($f['buenas'] ?? null, true) || !entero_pos($f['malas'] ?? null, true)) return 'Buenas y malas deben ser números enteros (0 o más).';
      $total = (float)$f['buenas'] + (float)$f['malas'];
      if ($total <= 0) return 'La devolución debe tener al menos una unidad.';
      $pr = fn($t) => nombre_tabla($cx->planta, $t);
      $st = $cx->pdo->prepare("SELECT COALESCE(SUM(cantidad),0) FROM {$pr('salidas')} WHERE orden_produccion = ? AND codigo = ? AND UPPER(lote) = UPPER(?)");
      $st->execute([$f['op'], $f['codigo'], $f['lote']]);
      $salio = (float)$st->fetchColumn();
      $st = $cx->pdo->prepare("SELECT COALESCE(SUM(buenas + malas),0) FROM {$pr('devoluciones')} WHERE orden_produccion = ? AND codigo = ? AND UPPER(lote) = UPPER(?)");
      $st->execute([$f['op'], $f['codigo'], $f['lote']]);
      $devuelto = (float)$st->fetchColumn();
      $igual = fn($x) => texto($x['op'] ?? $x['ordenProduccion'] ?? '') === texto($f['op']) && texto($x['codigo'] ?? '') === texto($f['codigo']) && strcasecmp(texto($x['lote'] ?? ''), texto($f['lote'])) === 0;
      foreach ($cx->pendientes as [$t, $x]) {
        if ($t === 'salidas' && $igual($x)) $salio += (float)($x['cantidad'] ?? 0);
        if ($t === 'devoluciones' && $igual($x)) $devuelto += (float)($x['buenas'] ?? 0) + (float)($x['malas'] ?? 0);
      }
      if ($total > $salio - $devuelto + 1e-9) return 'No se puede devolver más de lo que salió para esa OP y lote.';
      if (!mismo_usuario($f['registradoPor'] ?? '', $u)) return 'El registro debe quedar a nombre de quien lo guarda.';
      return fecha_registro($f['fecha'] ?? '');
    case 'averias':
      if ($cx->rol !== 'Auxiliar') return '!Solo el auxiliar registra averías.';
      if (!in_array($f['tipo'] ?? '', ['Conteo', 'Rechazo'], true)) return 'Tipo de avería no válido.';
      if (texto($f['codigo'] ?? '') === '' || !isset($cx->insumos[texto($f['codigo'])])) return 'El insumo no existe en el catálogo.';
      if (!entero_pos($f['cantidad'] ?? null)) return 'La cantidad de la avería debe ser un número entero mayor a 0.';
      if (!mismo_usuario($f['registradoPor'] ?? '', $u)) return 'El registro debe quedar a nombre de quien lo guarda.';
      return fecha_registro($f['fecha'] ?? '');
    case 'solicitudes':
      if ($cx->rol !== 'Auxiliar') return '!Solo el auxiliar crea solicitudes de edición.';
      if (($f['estado'] ?? '') !== 'Pendiente' || !mismo_usuario($f['usuario'] ?? '', $u)) return 'Solicitud no válida.';
      if (!in_array($f['tipo'] ?? '', ['Modificar', 'Eliminar'], true)) return 'Tipo de solicitud no válido.';
      if (texto($f['motivo'] ?? '') === '') return 'Falta el motivo de la solicitud.';
      if (!isset(TABLAS[$f['tabla'] ?? '']) || !leer_fila($cx->pdo, $cx->planta, $f['tabla'], texto($f['registroId'] ?? ''))) return 'El registro de la solicitud no existe.';
      return ($f['tipo'] === 'Modificar' && (!is_array($f['cambios'] ?? null) || !$f['cambios'])) ? 'La solicitud no tiene cambios.' : null;
    case 'bitacora':
      return mismo_usuario($f['usuario'] ?? '', $u) && ($f['rol'] ?? '') === $cx->rol ? null : 'El historial debe quedar a nombre de quien hace la acción.';
    case 'insumos':
      if ($e = obligatorios($f, ['codigo' => 'código', 'descripcion' => 'descripción'])) return $e;
      return null;
    case 'proveedores':
      return obligatorios($f, ['nombre' => 'nombre del proveedor']);
  }
  return 'Tabla no válida.';
}

/* Cambio a un registro que ya existe */
function validar_modificacion(Contexto $cx, string $tabla, array $vieja, array $nueva): ?string {
  $cambiados = campos_cambiados($tabla, $vieja, $nueva);
  if (!$cambiados) return null;
  if ($tabla === 'bitacora') return '!El historial de modificaciones no se puede cambiar.';
  switch ($cx->rol) {
    case 'Auxiliar':
      /* Única excepción: completar una avería que llegó como rechazo desde devoluciones */
      if ($tabla === 'averias' && ($vieja['estado'] ?? '') === 'Pendiente de completar' && ($nueva['estado'] ?? '') === 'Completa'
        && solo_estos($cambiados, ['observaciones', 'estado', 'extra.completadaPor', 'extra.fechaCompletada', 'extra.horaCompletada'])) {
        if (texto($nueva['observaciones'] ?? '') === '') return 'Escribe la causa u observación de la avería.';
        return mismo_usuario($nueva['completadaPor'] ?? '', $cx->usuario) ? null : 'El registro debe quedar a nombre de quien lo guarda.';
      }
      return MSG_SOLICITUD;
    case 'Calidad':
      /* Calidad solo resuelve tickets pendientes: aprueba o rechaza, sin tocar el resto de la entrada */
      if ($tabla === 'recepciones' && ($vieja['calidad']['estado'] ?? '') === 'Pendiente'
        && in_array($nueva['calidad']['estado'] ?? '', ['Aprobado', 'Rechazado'], true)
        && solo_estos($cambiados, ['calidad.estado', 'calidad.revisadoPor', 'calidad.nota', 'extra.calidad'])
        && ($vieja['calidad']['ticket'] ?? null) === ($nueva['calidad']['ticket'] ?? null)) {
        if ($nueva['calidad']['estado'] === 'Rechazado' && texto($nueva['calidad']['nota'] ?? '') === '') return 'Para rechazar escribe el motivo.';
        return mismo_usuario($nueva['calidad']['revisadoPor'] ?? '', $cx->usuario) ? null : 'El ticket debe quedar a nombre de quien lo revisa.';
      }
      return '!Calidad solo puede aprobar o rechazar tickets pendientes.';
    case 'Supervisor':
      /* La supervisora aprueba ediciones y firma: se validan los campos que cambian */
      if ($tabla === 'solicitudes' && !in_array($nueva['estado'] ?? '', ['Pendiente', 'Aprobada', 'Rechazada', 'No aplicable'], true)) return 'Estado de solicitud no válido.';
      foreach (['cantidad', 'buenas', 'malas'] as $k) if (in_array($k, $cambiados, true) && (!is_numeric($nueva[$k] ?? null) || (float)$nueva[$k] < 0)) return 'Las cantidades deben ser números mayores o iguales a 0.';
      if ($tabla === 'recepciones' && array_intersect($cambiados, ['extra.fechaFabricacion', 'extra.fechaVencimiento']))
        return validar_fechas_lote($nueva['fechaFabricacion'] ?? '', $nueva['fechaVencimiento'] ?? '');
      if (in_array('codigo', $cambiados, true) && in_array($tabla, ['recepciones', 'salidas', 'devoluciones', 'averias'], true) && !isset($cx->insumos[texto($nueva['codigo'] ?? '')])) return 'El insumo no existe en el catálogo.';
      return null;
  }
  return MSG_SOLICITUD;
}

/* Punto de entrada: revisa todo el lote antes de escribir nada.
   Devuelve null si todo está bien; los mensajes que empiezan con "!" son falta de permiso (403), los demás datos inválidos (422). */
function validar_cambios(Contexto $cx, array $cambios): ?string {
  $permitidas = ESCRIBE[$cx->rol] ?? [];
  foreach ($cambios as $c) {
    $tabla = $c['tabla'] ?? '';
    $id = texto($c['id'] ?? ($c['fila']['id'] ?? ''));
    if (!in_array($tabla, $permitidas, true)) return '!Tu rol no puede modificar esa información.';
    if ($id === '' || !preg_match('/^[A-Za-z0-9_.\-]{1,40}$/', $id)) return 'Identificador de registro no válido.';
    $vieja = leer_fila($cx->pdo, $cx->planta, $tabla, $id);
    if (!isset($c['fila'])) {
      if ($cx->rol !== 'Supervisor') return '!Solo la supervisora puede eliminar.';
      if ($tabla === 'bitacora') return '!El historial de modificaciones no se puede eliminar.';
      continue;
    }
    if (!is_array($c['fila']) || texto($c['fila']['id'] ?? '') !== $id) return 'Registro no válido.';
    if ($e = largos($tabla, $c['fila'])) return $e;
    $e = $vieja === null ? validar_nuevo($cx, $tabla, $c['fila']) : validar_modificacion($cx, $tabla, $vieja, $c['fila']);
    if ($e) return $e;
    if ($vieja === null) $cx->pendientes[] = [$tabla, $c['fila']];
  }
  return null;
}
