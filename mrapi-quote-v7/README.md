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
