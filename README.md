# MRAPI Quotes

MVP multi-tenant para cotizaciones de productos y logística.

## Cloud Run
Variables recomendadas:
- `FIRESTORE_DATABASE_ID=mrapi-quote`
- `BUCKET_NAME=mrapi-quote`
- `DEFAULT_TENANT=sentire-customs-broker`

El servicio usa las credenciales nativas de Cloud Run para Firestore y Cloud Storage.

## Colecciones Firestore
Todo queda bajo `tenants/{tenantId}`:
- products
- taxProfiles
- logisticsProfiles
- quotes
- clients
- users

Las cotizaciones guardan snapshot de perfiles para no cambiar al editar un perfil.


## Logistics profile AI context patch

El endpoint existente `GET /api/crm-quote/deals/:dealId/ai-payload` ahora agrega `logistics_profiles` con los perfiles activos reales de QUOTES.

No modifica UI, fórmulas, perfiles, cotizaciones ni cálculos.
