# MRAPI Quotes MVP v4

## Cambios
- Impuestos por ENVÍO o por PRODUCTO.
- Cada producto tiene Uso impositivo: COMERCIAL / BIEN DE USO / PARTICULAR.
- COMERCIAL: aplica todo el perfil impositivo.
- BIEN DE USO: solo Derecho + IVA.
- PARTICULAR: Derecho + IVA + Ganancia 11%.
- Cada ítem de una cotización puede elegir un perfil impositivo diferente.
- Honorarios pasan a nivel ENVÍO, no al perfil impositivo.
- Honorarios configurables: aplica Sí/No; base 50% o 70% del FOB; honorario = 30% de los impuestos simulados sobre esa base.
- Cálculo de honorarios respeta perfiles y usos distintos cuando los impuestos son por producto.
- Resumen muestra Total impuestos, impuestos simulados para honorarios y honorarios.
- Carga masiva acepta columna Uso / TipoUso.

## Variables Cloud Run
FIRESTORE_DATABASE_ID=mrapi-quote
BUCKET_NAME=mrapi-quote
DEFAULT_TENANT=sentire-customs-broker
PORT=8080
