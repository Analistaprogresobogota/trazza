/* ==========================================================
   ÚNICO ARCHIVO QUE CAMBIA EN CADA APLICATIVO DE IM INGENIERÍA
   (login, paleta, logos y tipografía son fijos: ver marca.css)
   ========================================================== */
window.APP_CONFIG = {
  nombre: "Trazza",                                   // nombre del aplicativo
  lema:   "Trazabilidad de inventarios en bodega",    // frase bajo el nombre
  chips: [                                            // cajitas de vidrio del login ([] para ocultarlas)
    { valor: "24/7", texto: "Movimientos<br>en tiempo real" },
    { valor: "100%", texto: "Trazabilidad de<br>entradas y salidas" }
  ],
  /* Plantas (clientes). Cada una tiene sus propias tablas */
  plantas: [
    { id: "PRUEBA", nombre: "Planta TQ Devoluciones" },
    { id: "PROGRESO", nombre: "Planta Progreso" }
  ]
};
