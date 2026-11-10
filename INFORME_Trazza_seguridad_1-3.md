# FINAL ENGINEERING REPORT — Trazza · Seguridad y datos (puntos 1-3)

Fecha: 2026-11-09 · Protocolo: MASTER ENGINEERING PROMPT (Tecnología)

## OBJECTIVE
1. Que el servidor haga cumplir los permisos por registro, no solo la interfaz.
2. Que el servidor valide las reglas de negocio de cada registro.
3. Que exista un respaldo de la base que se pueda descargar, y una restauración comprobada.

## OVERALL STATUS
**PARTIAL**: implementado y probado en local (PASS). El despliegue y la verificación en producción quedan pendientes (NOT TESTED) hasta subir el paquete.

## ROOT CAUSE (hallazgo)
`api.php?a=guardar` solo revisaba la tabla y si la operación era un borrado. Aceptaba cualquier contenido de fila de cualquier usuario con sesión.

Evidencia, versión anterior (`/base`):
- Un auxiliar podía modificar entradas guardadas sin solicitud aprobada (P02 = 200).
- Calidad podía cambiar cantidades (P07 = 200).
- La supervisora podía borrar el historial (P10 = 200).
- Se aceptaban cantidades 0 o decimales, fechas imposibles, bodegas o insumos inexistentes y registros a nombre de otro usuario (V01–V16 = 200).
- Un texto largo producía un error 500 (V13).

## IMPLEMENTATION

| Archivo | Cambio |
|---|---|
| `api/reglas.php` (nuevo) | Reglas por rol y validaciones de negocio. Revisa todo el lote antes de escribir. |
| `api/api.php` | `guardar` usa `validar_cambios()`: 403 si falta permiso, 422 si el dato es inválido, y queda en el log del servidor. Nueva acción `respaldo` (solo Progreso). |
| `api/bd.php` | `decodificar_fila()` y `leer_fila()` para comparar la fila guardada con la que llega. Refactor sin cambio de comportamiento. |
| `panel.html` | Botón «⬇ Respaldo BD». |

### Reglas por rol en el servidor

- **Auxiliar**
  - Solo crea registros nuevos.
  - Única modificación permitida: completar una avería «Pendiente de completar», y solo los campos observaciones, estado, completadaPor y fecha/hora.
- **Calidad**
  - Solo pasa un ticket «Pendiente» a Aprobado o Rechazado, y solo en los campos de calidad.
  - El rechazo exige motivo.
- **Supervisora**
  - Puede editar, firmar y eliminar.
  - Se validan las cantidades, las fechas de lote y el insumo cuando cambian.
- **Historial (bitácora)**
  - Nadie puede modificarlo ni borrarlo.
- **Progreso**
  - No escribe.

### Validaciones en registros nuevos

- **Campos:** obligatorios presentes y largos máximos por columna.
- **Cantidad:** número entero mayor que 0.
- **Fechas de fabricación y vencimiento:** fecha válida o N/A. La de fabricación no puede ser futura y el vencimiento debe ser posterior a la fabricación.
- **Fecha del registro:** la de hoy, con tolerancia de ±1 día.
- **Bodega:** debe existir en la planta.
- **Insumo:** debe existir en el catálogo.
- **Autor:** el registro queda a nombre del usuario de la sesión.
- **Calidad:** una entrada nueva solo puede llegar como «Pendiente» o «No aplica».
- **Salida:** una salida nueva queda pendiente de firma.
- **Devolución:** no puede superar lo que salió. Cuenta también las filas que llegan en el mismo guardado.

## DATABASE CHANGES
Ninguna. No hay migraciones ni cambios de esquema o de datos.

## INFRASTRUCTURE CHANGES
Ninguno.

## SECURITY
- **Corregido (ALTO):** autorización solo en el frontend (IDOR/BOLA sobre registros propios de la planta).
- **Corregido (MEDIO):** ausencia de validación en el backend y error 500 con entradas largas.
- **Respaldo:** el archivo contiene los usuarios con la contraseña cifrada (bcrypt). Es confidencial y no se debe compartir.

## TEST RESULTS (pruebas reales contra MariaDB local con código PHP real; no son mocks)

| Tipo | Resultado |
|---|---|
| API (`pruebas/pruebas_api.py`) | 31/31 PASS. Cada caso corre contra la versión anterior y la nueva, con relectura en SQL. |
| Restauración (`pruebas/prueba_restaurar.sh`) | PASS: 21/21 tablas idénticas (filas + CHECKSUM) tras importar en una base vacía. |
| E2E Auxiliar | PASS: salida, devolución con malas, completar avería, entrada con ticket y fecha N/A, solicitud de edición. Navegar las 9 pantallas genera 0 cambios fantasma. |
| E2E bypass | PASS: modificar R723 por consola devuelve 403, SQL sin cambio y la app recarga. |
| E2E Supervisora | PASS: firmar OP, aprobar solicitud (cantidad 4→6 en SQL), crear y eliminar proveedor. 0 cambios fantasma. |
| E2E Calidad | PASS: aprobar ticket CAL-724. 0 cambios fantasma. |
| E2E Progreso | PASS: el panel carga y el respaldo descarga 21 tablas con marca de fin. |
| Segunda planta (PROGRESO) | PASS: «KT» rechazado, «Bodega» aceptado. |
| Unit / Performance | NOT APPLICABLE / NOT TESTED. Agrega 1 SELECT por fila guardada; el volumen por guardado es pequeño. |

Datos de prueba eliminados. La base local volvió a los conteos de la línea base.

## DEPLOYMENT (pendiente)
Subir el zip con Zip & Extract en `/htdocs/trazza`. Archivos: `api/api.php`, `api/bd.php`, `api/reglas.php` (nuevo) y `panel.html`. `app.js` no cambia.

## POST-DEPLOY (2026-11-09)
1. **PASS:** versión desplegada verificada en producción.
   - `a=respaldo` sin sesión devuelve 401 (la versión anterior devolvía 404 «Acción desconocida»).
   - `a=guardar` sin sesión devuelve 401.
   - `reglas.php` responde 200 sin errores de PHP en el hosting.
   - `panel.html` muestra el botón «Respaldo BD».
2. **NOT TESTED (requiere sesión del usuario):** Progreso descarga el respaldo de producción y lo guarda en un lugar privado. Ese es el primer respaldo real.
3. **NOT TESTED (requiere sesión del usuario):** un auxiliar registra una entrada real. Una entrada válida se guarda y las demás pantallas siguen funcionando.

Pasos 2 y 3 originales (referencia):
1. Verificar que el servidor sirva `reglas.php` y la nueva `api.php` (respuesta 401 sin sesión a `a=respaldo`).
2. Progreso descarga el respaldo de producción y lo guarda en un lugar privado. Ese es el primer respaldo real.
3. Un auxiliar registra una entrada real. Una entrada válida se guarda y las demás pantallas siguen funcionando.

## KNOWN RISKS
- **Pestañas viejas:** si un usuario tiene la app abierta con datos viejos y guarda sobre un registro que otro cambió, ahora recibe un aviso y la página se recarga. Antes sobrescribía en silencio el cambio del otro usuario.
- **Fecha del equipo:** la fecha del registro sale del equipo del usuario. Si está desfasada más de 1 día, el guardado se rechaza.
- **Motor de base de datos:** en el hosting es MyISAM y no tiene transacciones reales. Al validar todo el lote antes de escribir, se reduce el riesgo de guardados parciales, pero no se elimina.

## ROLLBACK
- **Aplicación:** subir `respaldos/Trazza_rollback_v22.zip`, que es la versión publicada antes de este cambio, con Zip & Extract en `/htdocs/trazza`.
- **Datos:** no aplica, porque el cambio no modifica datos.
- **Validación posterior al rollback:** cargar la app y guardar una entrada.

## NEXT ACTION
Desplegar y ejecutar los pasos POST-DEPLOY.
