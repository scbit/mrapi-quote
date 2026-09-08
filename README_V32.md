# MRAPI Quotes MVP v32

## Trading - variantes / listas de precio
- Corrección de carga masiva: filas con el mismo SKU ya no se pisan.
- Mismo SKU = un producto; cada fila repetida = una lista/precio/variante.
- La importación informa cantidad de productos y cantidad de precios/variantes.
- Soporta columnas Lista/Variante, Proveedor, Moneda, FOB, MOQ y vigencia.

## FOB base
- El campo FOB USD sincroniza el precio marcado como default.
- Cambiar la variante default actualiza el FOB base.

## UX
- Rediseño completo de las variantes como tarjetas amplias con labels.
- Campos: lista/condición, proveedor, moneda, precio FOB, MOQ, vigencia y notas.
