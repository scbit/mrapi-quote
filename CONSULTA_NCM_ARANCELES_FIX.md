# v0.2.5 — Aranceles en Consulta NCM

Problema:
AI Core devuelve `taxes` como una lista:
- duty
- vat
- vat_additional
- earnings
- iibb
- statistical_fee

La pantalla de Consulta NCM esperaba un objeto (`taxes.duty`, etc.),
por eso mostraba guiones aunque VUCE sí había devuelto los aranceles.

Corrección:
QUOTES ahora convierte la lista de tributos oficiales a los seis campos visibles.

No cambia la lógica de cotización existente.
