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
