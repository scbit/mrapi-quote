# MRAPI Quotes MVP v28

## Fix productos / Firestore
- El SKU deja de usarse como ID interno de Firestore.
- MRAPI genera un ID interno seguro para cada producto nuevo.
- Evita errores `products/.`, `products/..` y otros IDs inválidos.
- SKU queda como dato comercial editable y puede incluso quedar vacío.
- Aplica tanto a Productos como al uso de productos dentro de Logística.
