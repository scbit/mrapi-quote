# MRAPI Quotes MVP v11

Cambios:
- Componentes logísticos pueden ser:
  - Neto / sin IVA
  - + IVA 21%
  - IVA incluido
- Cálculo separa:
  - Logística neta
  - IVA servicios logísticos
  - Logística total
- El IVA de servicios logísticos se muestra como recupero separado.
- Logística all-in por m³ real:
  - Total logística / CBM total
- Costo real por producto puesto Argentina:
  - distribuye logística proporcional por CBM del producto
  - distribuye impuestos/recuperos
  - muestra costo neto por unidad
- PDF actualizado con detalle de IVA servicios y costo real por producto.

Prueba recomendada:
1. Editar un perfil logístico.
2. En Componentes del costo, cambiar un concepto a + IVA 21%.
3. Guardar, recargar y validar que persista.
4. Crear cotización de productos con 2 productos de CBM distintos.
5. Validar que el PDF muestre logística proporcional por producto.
