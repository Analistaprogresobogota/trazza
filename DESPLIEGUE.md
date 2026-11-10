# Desplegar Trazza en un servidor de Tecnología

Guía para instalar Trazza en un servidor nuevo con los datos actuales de producción. Tiempo estimado: 30 minutos. Durante la migración nadie debe registrar movimientos, para que no queden datos por fuera del respaldo.

## Requisitos

| Componente | Versión |
|---|---|
| PHP | 8.1 o superior, con `pdo_mysql` y `mbstring` |
| Base de datos | MySQL 8 o MariaDB 10.5 o superior, motor InnoDB |
| Servidor web | Apache o Nginx sirviendo PHP. HTTPS recomendado: la cookie de sesión se marca segura con HTTPS |

No hay Node, Composer ni compilación: son archivos HTML/JS estáticos más una API en PHP.

## 1. Sacar el respaldo de producción

1. Avisar a la planta que no registre nada hasta terminar.
2. Entrar a Trazza con el usuario **progreso** y pulsar **⬇ Respaldo BD**.
3. Se descarga `trazza-respaldo-AAAA-MM-DD_HHMM.sql`. Es confidencial: trae los usuarios con la contraseña cifrada.

## 2. Crear la base y su usuario

```sql
CREATE DATABASE trazza CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'trazza_app'@'localhost' IDENTIFIED BY '<contraseña segura>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON trazza.* TO 'trazza_app'@'localhost';
```

`CREATE` es necesario: la app crea las tablas de cada planta nueva desde el panel de Progreso, y su tabla de control de accesos la primera vez.

## 3. Importar el respaldo (convirtiéndolo a InnoDB)

El hosting actual usa MyISAM, que no tiene transacciones. Al importar se convierte a InnoDB:

```bash
sed 's/ENGINE=MyISAM/ENGINE=InnoDB/g' trazza-respaldo-AAAA-MM-DD_HHMM.sql > trazza-innodb.sql
mysql -u root -p trazza < trazza-innodb.sql
```

Comprobar que la tabla `usuarios` tiene filas y que todas las tablas quedaron en InnoDB:

```sql
SELECT COUNT(*) FROM trazza.usuarios;
SELECT engine, COUNT(*) FROM information_schema.tables WHERE table_schema = 'trazza' GROUP BY engine;
```

El resultado esperado es solo InnoDB.

## 4. Copiar los archivos

Copiar el contenido de la carpeta `prototipo/` de este repositorio a la carpeta pública del servidor, por ejemplo `/var/www/trazza/`. **No** se copia nada más del repositorio.

## 5. Configurar la conexión

```bash
cd /var/www/trazza/api
cp config.ejemplo.php config.php
# editar config.php: host, puerto, base, usuario y clave del paso 2
chmod 640 config.php
```

`config.php` nunca va al repositorio. `instalar.php` no se usa en una migración; con `config.php` creado queda inactivo.

## 6. Verificar

| Prueba | Resultado esperado |
|---|---|
| Abrir `https://<servidor>/trazza/` | Pantalla de ingreso de Trazza |
| `https://<servidor>/trazza/api/api.php?a=respaldo` sin sesión | `{"error":"sesion"}` (401) |
| Entrar con **progreso** | Panel de plantas con TQ Devoluciones y Progreso |
| Panel → **⬇ Respaldo BD** | Descarga un `.sql` con todas las tablas |
| Entrar con un auxiliar y registrar una entrada | «Entrada guardada» y aparece en la tabla |
| 5 claves erradas seguidas con un usuario | Al 5.º intento: «usuario bloqueado» (429) |

Si todo da lo esperado, avisar a la planta que pueden volver a registrar.

## Actualizar a una versión nueva más adelante

1. Sacar un respaldo con **⬇ Respaldo BD**.
2. Reemplazar los archivos de la carpeta del servidor por los de `prototipo/`, **sin tocar** `api/config.php`.
3. Repetir la verificación del paso 6.

No hay migraciones: las tablas nuevas que necesite una versión las crea la app sola.

## Volver atrás

- **Archivos:** restaurar los de la versión anterior. Cada versión es un commit en Git.
- **Datos:** importar el último respaldo `.sql`, que reemplaza las tablas que contiene.

## Pruebas automáticas

`pruebas/` trae las pruebas de la API y de restauración del respaldo. Se corren contra una base local de prueba, nunca contra producción. Ver el `README.md` de la raíz.
