# MRAPI Quotes MVP v7

## Incluye
- PDF de productos mucho más visual y comercial para Shenzhen Sentire Trading.
- Bloques visuales, secciones, resumen final y recupero de impuestos detallado.
- Comisión de agente de compra por producto integrada al cálculo y al PDF.
- Perfiles logísticos FCL + Consolidado y FCL FOB ahora se crean también para tenants existentes.
- Diferencia aplicada:
  - FCL + Consolidado: incluye Gastos a FOB.
  - FCL FOB: no incluye Gastos a FOB.

## Dónde verlo
- Tenant `Shenzhen Sentire Trading` → `Perfiles y permisos` → `Perfiles logísticos`.
- Ahí deben aparecer:
  - China LCL Argentina
  - FCL + Consolidado
  - FCL FOB

## Cloud Run
Variables:
- FIRESTORE_DATABASE_ID=mrapi-quote
- BUCKET_NAME=mrapi-quote
- DEFAULT_TENANT=sentire-customs-broker (o el tenant que uses por defecto)
- PORT=8080
