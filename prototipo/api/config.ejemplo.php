<?php
/* Copia este archivo como config.php (en esta misma carpeta api/) y llena los datos de MySQL.
   config.php NUNCA va al repositorio ni al paquete de despliegue: contiene la contraseña de la base. */
return [
  'host'    => 'localhost',   // servidor MySQL / MariaDB
  'puerto'  => 3306,
  'base'    => 'trazza',      // base donde se importó el respaldo
  'usuario' => 'trazza_app',  // usuario de la aplicación (solo permisos sobre esa base)
  'clave'   => '',            // contraseña de ese usuario
];
