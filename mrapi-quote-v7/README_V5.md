# MRAPI Quotes MVP v5

## Correcciones
- Cambiar el Uso de un producto (COMERCIAL / BIEN DE USO / PARTICULAR) fuerza automáticamente el modo **Impuestos por producto** y recalcula.
- Cambiar el perfil impositivo de un producto también fuerza modo por producto y recalcula.
- COMERCIAL: aplica todos los tributos del perfil.
- BIEN DE USO: solo Derecho + IVA.
- PARTICULAR: Derecho + IVA + Ganancia 11%.
- Honorarios corregidos:
  - Esquema 50%: impuestos a pagar = 50% de los impuestos normales.
  - Esquema 70%: impuestos a pagar = 70% de los impuestos normales.
  - Ahorro = impuestos normales - impuestos a pagar.
  - Honorarios = 30% del ahorro.
- El resumen muestra impuestos normales, impuestos declarados, ahorro y honorarios.
