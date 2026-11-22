# Marine and FFW pricing v1

These businesses use `/api/business/*` with `x-tenant-id: sentire-marine` or `sentire-ffw`. Existing SCB and Shenzhen routes and calculators remain unchanged. Legacy calculator/quote APIs reject the two new businesses to prevent applying DDP formulas or generating the wrong PDF.

- GET `/status`: actual capabilities; no automatic sending, CRM or Drive yet.
- GET `/parts?q=...`: Marine part-code/description lookup, bounded to 20 results.
- POST `/preview`: Marine items `{code, qty}` or FFW exact `{origin,destination,mode,equipment,containers,chargeableKg,cbm,fob}` as appropriate to the rate. USD only.
- POST `/preview.pdf`: draft PDF without persistence or other effects.
- GET `/rates`: FFW rates, capped at 500 with `partial` marker.
- PUT `/rates/:id`: authenticated, version-checked FFW tariff edit. Every version is retained in its own subcollection. Dates and every fee/VAT are explicit; no automatic tariffs or customs charges are seeded.
- POST `/drafts`: authenticated durable draft, with `requestId` (8–160 characters). Same request and content reuse the original date/calculation; changed content returns 409.
- GET `/drafts/:id/pdf`: authenticated access to the stored draft's calculation snapshot.

Writes and stored PDF reads require a server-side `QUOTES_BUSINESS_SECRET`, falling back to the existing `AI_CORE_QUOTES_SECRET`, minimum 32 characters, supplied as a Bearer token. No secret is included in browser assets or this repository. Missing configuration returns 503. UI tariff writes accept an operator credential for that request only and clear it after successful use. This is not an end-user authentication system.

The compressed Marine catalog is derived from the user-provided `VOLVO AGAIN 2026 V2 PARA LA IA .xlsx`, including provenance hash and its original `Retail 2024` column label. USD was explicitly confirmed by the owner; no EUR/ARS conversions are performed. The country-of-origin data is read from column J, avoiding the workbook's incorrect VLOOKUP A:I column 10. Replacements, stock, engine compatibility and delivery time are not inferred from the price list. Outputs remain drafts and `readyToSend:false`.

Marine formula: net = retail × (1 − catalog discount); a = net × 1.16; w = weight × 14; unit = a + w + a/2 + (a+w) × 0.7. Full intermediate precision is preserved. Shipment fee is zero only when subtotal > 550, otherwise USD 100. Do not add VAT again. FFW sums services, per-line VAT and FOB-based insurance; FOB itself is excluded from total. Route matches must be unique and current.

Next integrations: authenticated per-HUB pipeline/contact/deal adapters, Drive with existing folder permissions, persistent follow-up tasks and controlled own-number pilot. Do not enable automatic client sends until these are verified. Each HUB owns its stages, due dates and no-response policy. Never run BOT recontact and Sales Agent follow-up concurrently for the same conversation.

Validation: `npm run check` and `npm test`. Tests cover workbook outputs, catalog identity, invalid inputs, rate expiration/ambiguity, retry snapshots, tenant separation, PDF bytes and HTTP access controls.

## Drive adapter and native HUB operator

Authenticated GET `/drive/status` checks the exact business folder with the runtime identity; POST `/drafts/:id/drive` exports the saved draft. IDs are preallocated and saved before uploading, so a timeout or retry cannot create another file. A retry can repair a missing persisted URL. No public sharing is created. My Drive uploads require user OAuth (`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` configured outside code); a service account alone requires a shared-drive folder. Do not grant domain-wide delegation or broad IAM as a workaround. A connection needing user authorization remains blocked.

The HUB's native admin `/cotizador` proxies permitted requests with its existing authenticated session, avoiding the need to enter internal credentials in that UI. The standalone Quote page remains a preview/operator surface. Authenticated GET `/drafts/:id` supplies the trusted snapshot to the HUB's CRM tool. Marine's verified HUB tenant ID is sm.
# Drive connection with explicit folder consent

The optional OAuth flow uses only `drive.file` and Google's unified Picker to
select the existing configured PDF folder for each business. It does not ask
for broad Drive access or share personal folders with a service account.

Provision the client ID/secret and a private 32-byte `GOOGLE_DRIVE_TOKEN_KEY`
through secure deployment configuration; never put their values in Git or
project documentation. Register the fixed redirect URI
`https://mrapi-quote-604957912671.us-central1.run.app/api/business/drive/oauth/callback`.
Enable the Drive and Picker APIs, then set `GOOGLE_DRIVE_OAUTH_ENABLED=true`.

An authenticated `POST /api/business/drive/oauth/start`, with the business tenant
header, returns a short-lived one-use connection URL. The browser is bound to
the callback with a Secure HttpOnly host cookie; state and PKCE are verified.
The callback requires the exact expected selected folder and writable access.
Refresh tokens are encrypted with AES-256-GCM and tenant-specific associated
data in `business_drive_connections`. No access/refresh token is returned to
the caller. Consent denial, wrong folder/browser, broader scopes, expiration
and replay fail closed. Existing ADC/environment OAuth integrations remain
available when a business has no stored connection.

Google references: https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
and https://developers.google.com/workspace/drive/api/guides/api-specific-auth.



## FFW tariffs edited by the operator

Dates are optional: an active tariff without validUntil remains available until edited or deactivated. Existing dated tariffs keep their original constraints. Saved quote calculations retain their rate/version; later edits affect new calculations only. FFW drafts omit an artificial seven-day expiry when the source rate has none; Marine validity is unchanged.

The initial tariff JSON contains only the three 40HQ prices confirmed by Facundo. Loading requires authenticated operator access, preserves existing documents, and never runs on startup. Chile examples remain pending confirmation.
