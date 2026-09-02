# MRAPI Quotes MVP v9

## PRODUCTOS / Shenzhen Sentire Trading

### Nuevo: logística all-in por CBM
La cotización calcula automáticamente:

`Costo logístico all-in por CBM = Total costos logísticos / CBM total del embarque`

Funciona tanto para perfiles LCL como FCL.

### Nuevo: medidor de contenedor
Los perfiles FCL soportan:
- Tipo de contenedor
- Capacidad comercial máxima editable
- 40HQ por defecto = 68 CBM

En cada cotización se muestra:
- CBM cargados
- capacidad total
- porcentaje de ocupación
- CBM disponibles
- cantidad de contenedores requeridos si supera la capacidad de uno

### Perfiles FCL existentes
En Shenzhen Sentire Trading, FCL + Consolidado y FCL FOB reciben 40HQ / 68 CBM únicamente si esos campos todavía no estaban configurados. No se pisan valores ya editados.

### PDF
Incluye:
- costo logístico total
- logística all-in por CBM
- ocupación del contenedor para perfiles FCL
