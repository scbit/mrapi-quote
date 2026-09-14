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


## v0.2.0 — AI Aduanera / MRAPI AI Core

Integración con `Aduanero AR` de MRAPI AI Core.

Variables nuevas:
- `AI_CORE_BASE_URL=https://mrapi-ai-core-604957912671.us-central1.run.app`
- `AI_CORE_QUOTES_SECRET=<mismo valor configurado como MRAPI_QUOTES_SECRET en AI Core>`
- `AI_CORE_CUSTOMS_TIMEOUT_MS=90000` (opcional)

Endpoints locales:
- `GET /api/customs-ai/health`
- `POST /api/customs-ai/analyze`

En la cotización:
- cada ítem permite ingresar SIM completo y ejecutar `IA Aduanera`;
- el resultado aplica automáticamente NCM, uso tributario y perfil MANUAL con tasas oficiales;
- se guarda el resultado consolidado y `run_id` de AI Core dentro del DRAFT/cotización;
- en cotización logística manual existe un bloque `IA Aduanera · AI Core + VUCE`.

Limitación actual:
AI Core v0.15.0 todavía exige SIM completo. La resolución automática del SIM vendrá después.
