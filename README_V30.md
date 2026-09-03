# MRAPI Quotes MVP v30

## Trading - múltiples precios por producto
Un mismo producto puede tener varias listas/precios.

Cada precio puede guardar:
- Lista / condición comercial
- Proveedor
- Moneda
- Precio FOB
- MOQ
- Vigencia desde / hasta
- Notas
- Precio por defecto

Al cotizar Trading se elige Producto -> Lista/Proveedor/Precio.
Dos listas distintas del mismo producto pueden agregarse como líneas independientes.

## Honorarios - corrección de base declarada
Antes:
- Impuestos declarados 70% = impuestos normales x 70%

Ahora:
- Impuestos normales = recalculados con FOB 100%
- Impuestos declarados = recalculados desde cero con FOB 50% o 70%
- El flete internacional real permanece al 100%
- Seguro y comisión proporcionales al FOB acompañan la base declarada
- Ahorro = impuestos normales - impuestos declarados
- Honorarios = ahorro x porcentaje de honorarios

El resumen web y el PDF muestran FOB normal, FOB declarado e impuestos de ambos escenarios.
