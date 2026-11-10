#!/bin/bash
# R03: restaura el respaldo descargado en una base vacía y compara cada tabla (filas + checksum)
SP="$(dirname "$0")"
M() { mariadb --socket=/tmp/tzdb.sock -u root "$@"; }
M -e "DROP DATABASE IF EXISTS trazza_restore_prueba; CREATE DATABASE trazza_restore_prueba CHARACTER SET utf8mb4;"
M trazza_restore_prueba < "$SP/respaldo_prueba.sql" && echo "IMPORT-OK"
ok=0; bad=0
for t in $(M -N trazza_prueba -e "show tables"); do
  a=$(M -N trazza_prueba -e "select count(*) from \`$t\`")
  b=$(M -N trazza_restore_prueba -e "select count(*) from \`$t\`" 2>&1)
  ca=$(M -N -e "checksum table trazza_prueba.\`$t\`" | cut -f2)
  cb=$(M -N -e "checksum table trazza_restore_prueba.\`$t\`" | cut -f2)
  if [ "$a" = "$b" ] && [ "$ca" = "$cb" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "DIF $t filas $a/$b checksum $ca/$cb"; fi
done
echo "tablas iguales=$ok distintas=$bad"
