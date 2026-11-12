<?php
/* Copia este archivo como config.php (en esta misma carpeta api/) y llena los datos de la base.
   config.php NUNCA va al repositorio ni al paquete de despliegue: contiene la contraseña de la base. */
return [
  'motor'   => 'pgsql',       // 'pgsql' = PostgreSQL · 'mysql' = MySQL / MariaDB
  'host'    => 'localhost',   // servidor de la base
  'puerto'  => 5432,          // PostgreSQL 5432 · MySQL 3306
  'base'    => 'trazza',      // base de datos
  'esquema' => 'trazza',      // solo PostgreSQL: esquema donde viven las tablas ('' = public)
  'ssl'     => '',            // solo PostgreSQL: 'require' si el servidor exige SSL (por ejemplo Azure)
  'usuario' => 'trazza_app',  // usuario de la aplicación (solo permisos sobre esa base/esquema)
  'clave'   => '',            // contraseña de ese usuario
];
