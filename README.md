# Trazza: inventario de insumos por planta (IM Ingeniería)

Aplicación web: HTML/JS estático y una API en PHP. Funciona con **PostgreSQL** (servidores de Tecnología) o **MySQL/MariaDB** (InfinityFree, producción actual, en `/htdocs/trazza`); el motor se elige en `api/config.php`. Guía de instalación en PostgreSQL: `DESPLIEGUE.md`.

## Estructura
- `prototipo/`: código fuente de la aplicación (lo que se publica).
  - `api/api.php`: acciones (login, datos, guardar, panel de Progreso, respaldo).
  - `api/reglas.php`: permisos por registro y validaciones de negocio del servidor.
  - `api/esquema.php`: definición de las tablas y de los roles que pueden escribir.
  - `api/bd.php`: conexión, lectura/escritura de filas y las pocas instrucciones SQL que cambian entre PostgreSQL y MySQL.
  - `api/migrar_a_postgresql.php`: carga un respaldo de MySQL en PostgreSQL y verifica tabla por tabla (solo terminal).
  - `api/instalar.php`: instalación única (crea `config.php` en el servidor).
- `pruebas/`: pruebas de API y de restauración del respaldo (ver abajo).
- `actualizar_datos.py`, `generar_semilla.mjs`: regeneran los datos iniciales a partir del Excel (`datos-fuente/`, fuera del repositorio).

## Lo que no está en el repositorio (y por qué)
- `api/config.php`: motor y credenciales de la base. Solo existe en el servidor.
- `api/semilla.php`, `datos-fuente/`: datos de la planta y usuarios con hash. Se generan localmente.
- `respaldos/`, `publicar/`: copias y paquetes generados.

## Probar en local
1. Iniciar MariaDB con la base `trazza_prueba` y servir la carpeta con PHP (configuración `trazza-php`, puerto 5181).
2. Crear usuarios temporales de prueba (`tmpaux`, `tmpsup`, `tmpcal`, `tmpprog`).
3. Ejecutar `python3 -I pruebas/pruebas_api.py <ruta_respaldo.sql>`. Corre cada caso contra la versión anterior (`/base`) y la nueva (`/proto`).
4. Ejecutar `bash pruebas/prueba_restaurar.sh` para importar el respaldo en una base vacía y comparar filas y checksum.
5. Al terminar, `pruebas/limpiar_pruebas.sql` borra los datos de prueba y luego se eliminan los usuarios temporales.

### Los dos motores (PostgreSQL y MySQL)
`pruebas/pruebas_motores.py` corre los casos del protocolo con el mismo código contra `/mysql` (MariaDB) y `/pg` (PostgreSQL 16). Las dos bases se cargan con el mismo respaldo; el servidor de prueba es la configuración `trazza-motores`, en el puerto 5183. Un caso es PASS solo si los dos motores responden lo esperado. Resultado actual: 28/28 PASS.

## Desplegar
1. Copiar los archivos cambiados de `prototipo/` a `publicar/trazza/`.
2. Generar el paquete: `cd publicar/trazza && zip -qr ../Trazza_hosting.zip . -x 'api/config.php' -x '.DS_Store' -x 'datos.js'`.
3. Subirlo en el administrador de archivos de InfinityFree, en `/htdocs/trazza`, con Upload → «Zip & Extract».
4. Si cambió un `.js` o un `.css`, subir el `?v=N` en el HTML: InfinityFree los guarda en caché 30 días.
5. Verificar en línea y dejar un respaldo con el botón «⬇ Respaldo BD» del panel de Progreso.

## Rollback
Subir el zip de la versión anterior (`respaldos/Trazza_rollback_*.zip`) con «Zip & Extract». Si hubo cambios de datos, importar el último respaldo `.sql` en phpMyAdmin.
