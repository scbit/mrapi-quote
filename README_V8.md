# MRAPI Quotes MVP v8

## Correcciones críticas

### 1. Perfiles logísticos ya no se pisan
Los perfiles semilla ahora se crean **solo si no existen**. MRAPI Quotes no vuelve a escribir los valores iniciales al abrir el tenant o refrescar la pantalla.

Esto aplica a:
- China LCL Argentina
- FCL + Consolidado
- FCL FOB
- perfiles SCB existentes

Además, al editar componentes se conserva el `code` interno de cada concepto.

### 2. PDF de productos remaquetado
Se eliminó el diseño de 3 columnas angostas que causaba superposiciones.

Nuevo diseño:
- Header Shenzhen Sentire
- Datos de cliente / operación
- Tabla de productos
- Costos logísticos y base imponible en bloque de ancho completo
- Derechos e impuestos + Recupero detallado en 2 columnas
- Honorarios del envío cuando aplican
- Resumen final destacado
- Saltos de página automáticos si el detalle no entra
- Sin símbolos Unicode problemáticos para PDFKit

### 3. FCL + Consolidado / FCL FOB
- FCL + Consolidado: incluye Gastos a FOB.
- FCL FOB: no incluye Gastos a FOB.
- Los valores son editables y persisten.

## Prueba recomendada
1. Editar FCL + Consolidado y cambiar Flete / Terminal / Despacho / Entrega / Gastos a FOB.
2. Salir a Dashboard y volver a Perfiles.
3. Refrescar navegador.
4. Confirmar que los valores siguen iguales.
5. Emitir una cotización de productos y abrir PDF.
