# v0.2.1 — Pending taxes + manual logistics profile

## Impuestos
Si AI Core todavía no resolvió una tasa:
- QUOTES muestra `PENDIENTE`
- no muestra `0.00%`

Estados visibles:
- `VUCE RESUELTO`
- `VUCE PENDIENTE`
- `NCM/SIM PENDIENTE`

0% queda reservado para una tasa realmente cero.

## Perfil logístico
La IA no selecciona perfil.

- Si el trato CRM ya tiene un `Tipo` que coincide con un perfil real de QUOTES, se respeta.
- Si no coincide, queda sin selección para que lo defina el operador.
