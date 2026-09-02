# MRAPI Quotes MVP v10

Cambio de arquitectura en PRODUCTOS de Shenzhen Sentire Trading:

- Se elimina `Perfil logístico` de la ficha de producto.
- Se elimina `PerfilLogistico` de la carga masiva de productos.
- Al editar/importar un producto se elimina cualquier `logisticsProfileId` legado del documento.
- La logística se selecciona exclusivamente al armar la cotización.
- El mismo producto puede cotizarse por LCL, FCL, FCL + Consolidado, FCL FOB, aéreo, courier, etc. sin modificar su ficha.
- El medidor de contenedor y el costo all-in por CBM siguen funcionando a nivel cotización.
