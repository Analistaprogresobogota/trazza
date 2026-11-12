# Desplegar Trazza en un servidor de Tecnología (PostgreSQL)

Guía para instalar Trazza en un servidor de Tecnología, sobre **PostgreSQL**, con los datos actuales de producción. Tiempo estimado: 40 minutos.

Durante la migración nadie debe registrar movimientos, para que no queden datos por fuera del respaldo.

El mismo código funciona con PostgreSQL y con MySQL/MariaDB. El motor se elige en `api/config.php`. Hoy producción (InfinityFree) corre en MySQL y sigue funcionando igual mientras se hace este cambio.

## Requisitos

| Componente | Versión |
|---|---|
| PHP | 8.1 o superior, con `pdo_pgsql` y `mbstring` |
| Base de datos | PostgreSQL 13 o superior (probado en 16) |
| Servidor web | Apache o Nginx sirviendo PHP. HTTPS recomendado: la cookie de sesión se marca segura con HTTPS |

No hay Node, Composer ni compilación: son archivos HTML/JS estáticos más una API en PHP.

## 1. Respaldo de toda la información actual (antes de cualquier cambio)

1. Avisar a la planta que no registre nada hasta terminar.
2. Entrar a Trazza en producción con un usuario de **Progreso** y pulsar **⬇ Respaldo BD**.
3. Se descarga `trazza-respaldo-AAAA-MM-DD_HHMM.sql`.
   - Es confidencial: trae los usuarios con la contraseña cifrada.
   - Guardar una copia en un lugar seguro **antes de seguir**. Este archivo es a la vez el respaldo y el origen de la migración.

La producción actual no se toca en ningún paso. Si algo sale mal, se sigue usando como hasta hoy.

## 2. Crear la base, el esquema y el usuario en PostgreSQL

```sql
CREATE DATABASE trazza ENCODING 'UTF8';
\c trazza
CREATE USER trazza_app WITH PASSWORD '<contraseña segura>';
CREATE SCHEMA trazza AUTHORIZATION trazza_app;
```

Notas:
- La app crea las tablas de cada planta nueva desde el panel de Progreso, y su tabla de control de accesos la primera vez. Por eso el usuario debe ser **dueño del esquema** (o tener `CREATE` sobre él).
- Si se prefiere otro nombre de esquema, o `public`, se indica en `config.php`.

## 3. Copiar los archivos

Copiar el contenido de la carpeta `prototipo/` de este repositorio a la carpeta pública del servidor, por ejemplo `/var/www/trazza/`. **No** se copia nada más del repositorio.

## 4. Configurar la conexión

```bash
cd /var/www/trazza/api
cp config.ejemplo.php config.php
chmod 640 config.php
```

Editar `config.php`:

| Campo | Valor |
|---|---|
| `motor` | `pgsql` |
| `host` | servidor de PostgreSQL |
| `puerto` | `5432` |
| `base` | `trazza` |
| `esquema` | `trazza` |
| `ssl` | `require` si el servidor exige SSL (por ejemplo, Azure Database for PostgreSQL) |
| `usuario` | `trazza_app` |
| `clave` | la contraseña del paso 2 |

`config.php` nunca va al repositorio. `instalar.php` no se usa en una migración; con `config.php` creado queda inactivo.

## 5. Migrar los datos

Desde la carpeta `api/` del servidor, con el respaldo del paso 1:

```bash
php migrar_a_postgresql.php /ruta/trazza-respaldo-AAAA-MM-DD_HHMM.sql
```

El script:
- lee el respaldo de MySQL;
- crea las tablas en PostgreSQL con la misma definición que usa la app;
- carga todas las filas;
- verifica **tabla por tabla** que coincidan el número de filas y las sumas de cantidades (entradas, salidas, devoluciones, averías y stock inicial).

Termina con una línea `PASS` o `FAIL` por tabla y el mensaje `MIGRACIÓN COMPLETA`.

**Seguridad del proceso:**
- Todo corre en **una sola transacción**. Si algo falla o una tabla no cuadra, se deshace completo (`ROLLBACK`) y la base queda como estaba.
- Si la base destino ya tiene datos de Trazza, el script **no hace nada** y avisa. Solo con `--reemplazar` borra y vuelve a crear esas tablas. Usarlo únicamente después de sacar un respaldo de PostgreSQL (paso «Actualizar»).
- El script solo corre desde la terminal: si se abre por web, responde 404.

## 6. Verificar

| Prueba | Resultado esperado |
|---|---|
| Abrir `https://<servidor>/trazza/` | Pantalla de ingreso de Trazza |
| `https://<servidor>/trazza/api/api.php?a=respaldo` sin sesión | `{"error":"sesion"}` (401) |
| Entrar con un usuario de **Progreso** | Panel de plantas con TQ Devoluciones y Progreso |
| Entrar con un usuario de planta | Inicio, inventario y lotes con los mismos números que en producción |
| Panel → **⬇ Respaldo BD** | Descarga `trazza-respaldo-pg-….sql` con todas las tablas |
| Entrar con un auxiliar y registrar una entrada | «Entrada guardada» y aparece en la tabla |
| 5 claves erradas seguidas con un usuario | Al 5.º intento: «usuario bloqueado» (429) |

La misma verificación se puede correr de forma automática. El script:
- pide las contraseñas por teclado;
- registra una entrada de prueba con lote `VERIF-DESPLIEGUE`, que la supervisora puede eliminar después;
- termina con `RESULTADO: PASS` o `FAIL`.

```bash
python3 -I pruebas/verificar_despliegue.py https://<servidor>/trazza <usuario_progreso> <usuario_auxiliar>
```

Si todo da lo esperado, avisar a la planta que registre en el servidor nuevo desde ese momento.

## Respaldos en PostgreSQL

- **Desde la app:** Panel de Progreso → **⬇ Respaldo BD**. Descarga un `.sql` que se restaura así (reemplaza las tablas que contiene):

  ```bash
  psql -d trazza -c "SET search_path TO trazza" -f trazza-respaldo-pg-AAAA-MM-DD_HHMM.sql
  ```

- **Desde el servidor:** también sirve el respaldo estándar de PostgreSQL:

  ```bash
  pg_dump -d trazza -n trazza -F c -f trazza-AAAA-MM-DD.dump
  ```

## Actualizar a una versión nueva más adelante

1. Sacar un respaldo (cualquiera de los dos de la sección anterior).
2. Reemplazar los archivos de la carpeta del servidor por los de `prototipo/`, **sin tocar** `api/config.php`.
3. Repetir la verificación del paso 6.

No hay migraciones de esquema: las tablas nuevas que necesite una versión las crea la app sola.

## Volver atrás

- **Archivos:** restaurar los de la versión anterior. Cada versión es un commit en Git; la versión anterior a PostgreSQL tiene la etiqueta `antes-postgresql`.
- **Datos:** restaurar el último respaldo de PostgreSQL. Si hay que volver a la producción en MySQL, esta sigue intacta con su propio respaldo del paso 1.

## Instalación con MySQL / MariaDB (alternativa)

1. En `config.php` usar `'motor' => 'mysql'` y puerto `3306`.
2. Importar el respaldo directamente, convirtiéndolo a InnoDB:

   ```bash
   sed 's/ENGINE=MyISAM/ENGINE=InnoDB/g' trazza-respaldo-AAAA-MM-DD_HHMM.sql > trazza-innodb.sql
   mysql -u root -p trazza < trazza-innodb.sql
   ```

3. El usuario de la app necesita `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX` sobre la base.

## Pruebas realizadas

`pruebas/pruebas_motores.py` corre los mismos casos contra **PostgreSQL 16 y MariaDB** con el mismo código. Las dos bases se cargaron con el respaldo real de producción del 9 de noviembre de 2026.

| Grupo | Casos | Resultado |
|---|---|---|
| Permisos y flujos por rol (auxiliar, supervisora, calidad, Progreso, sin sesión) | 11 | PASS en ambos motores |
| Validaciones de datos (cantidades, fechas, insumo, textos, lote parcial) | 8 | PASS en ambos motores |
| Consecutivos, versión, lectura completa, bloqueo de ingreso, panel de Progreso, crear planta | 6 | PASS en ambos motores |
| Respaldo: permisos, descarga y restauración completa en una base nueva | 3 | PASS en ambos motores |
| **Total** | **28** | **28/28 PASS** |

Migración del respaldo real con `migrar_a_postgresql.php`:
- **21 de 21 tablas en PASS**, con las mismas filas y las mismas sumas de cantidades;
- volver a correrla sobre la base ya cargada **no cambia nada** y avisa.

Las pruebas se corren contra bases locales de prueba, nunca contra producción. Ver el `README.md` de la raíz.
