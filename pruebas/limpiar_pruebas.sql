DELETE FROM tq_entradas WHERE id LIKE '%TST%';
DELETE FROM tq_salidas WHERE id LIKE '%TST%';
DELETE FROM tq_devoluciones WHERE id LIKE '%TST%';
DELETE FROM tq_averias WHERE id LIKE '%TST%';
DELETE FROM tq_historial WHERE id LIKE '%TST%' OR usuario IN ('TMPAUX','TMPSUP','TMPCAL','tmpaux','tmpsup','tmpcal');
DELETE FROM tq_solicitudes WHERE usuario IN ('TMPAUX','tmpaux');
