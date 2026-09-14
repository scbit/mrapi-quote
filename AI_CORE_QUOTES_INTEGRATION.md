# MRAPI QUOTES → AI Core

## Flujo operativo

El operador trabaja solamente en QUOTES.

Desde `CRM · Para cotizar`:
1. Abrir un trato.
2. Pulsar `⚡ Borrador IA`.
3. QUOTES toma trato + notas + conversación + metadatos de adjuntos.
4. QUOTES llama a AI Core.
5. Core devuelve un borrador por ítem.
6. QUOTES carga esos ítems dentro del DRAFT actual.

Cada ítem queda editable con:
- cantidad
- FOB unitario
- CBM unitario
- KG unitario
- NCM / SIM
- Derecho
- IVA
- IVA Adicional
- Ganancias
- IIBB
- Tasa estadística
- Uso

## Regla Uso

QUOTES conserva todas las tasas del producto pero calcula según Uso:

- COMERCIAL: Derecho + IVA + IVA Adicional + Ganancias + IIBB + Tasa.
- BIEN DE USO: Derecho + IVA.
- PARTICULAR: Derecho + IVA + Ganancias 11%.

Cambiar Uso no borra las tasas originales del ítem.

## Perfil logístico y Honorarios

Por ahora siguen siendo manuales.

## Variables requeridas en QUOTES

- `AI_CORE_BASE_URL`
- `AI_CORE_QUOTES_SECRET`

El secret debe ser el mismo valor que `MRAPI_QUOTES_SECRET` en AI Core.

## Archivos

Esta versión envía a Core el texto del trato, notas, chat y metadatos/nombres de adjuntos.
No hace OCR ni extracción binaria de PDFs/imágenes dentro de QUOTES todavía.
