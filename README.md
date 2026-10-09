# VETA — Atlas de superficies

Concepto de producto digital para una marca cerámica **ficticia**: un catálogo de 48 superficies porcelánicas que se recorre como un mapa infinito, no como una lista de referencias. Pensado para arquitectos e interioristas.

## La idea

- **La posición significa algo.** De arriba abajo, de claro a oscuro; de izquierda a derecha, de frío a cálido (medido en espacio CIELAB a partir de cada textura). El minimapa lo hace explícito.
- **Los filtros reorganizan el mapa en lugar de vaciarlo.** Cada celda se voltea hacia la nueva disposición en una onda desde el centro.
- **La luz revela el acabado.** Una luz puntual sigue al cursor (o al dedo) e ilumina los mapas de normales: el pulido brilla, el mate se difumina y el estructurado muestra su relieve.
- **La ficha es una herramienta, no un póster.** Formatos reales con juntas, traba aleatoria en tablones y caras distintas por pieza, escala 1:1, color de junta, una estancia 3D con sol y reflejos planares en el pulido, ficha técnica (resbaladicidad CTE, absorción, variación de tono…), calculadora de cajas y peso, combinaciones sugeridas, texturas para render en ZIP y ficha imprimible.
- **La selección se convierte en un pedido de muestras**, con moodboard descargable en PNG y enlace compartible.

## Tecnología

- Vite + TypeScript, sin framework. JS inicial: ~44 KB gzip. CSS: ~6 KB gzip.
- **Atlas en WebGL 2 puro**: las 48 superficies viven en dos `TEXTURE_2D_ARRAY` (color sRGB + normales) y se dibujan en **una sola llamada instanciada**. La disposición y la animación de volteo se resuelven en el *vertex shader* con una textura de orden entera.
- **Render bajo demanda**: un único bucle `requestAnimationFrame` que se detiene cuando no hay nada en movimiento (0 fotogramas en reposo) y se pausa con la pestaña oculta.
- Resolución adaptativa: baja el *pixel ratio* si encadena fotogramas lentos.
- Texturas en 4 niveles (256/512 px para el grid según densidad de pantalla; 1024/2048 px para el detalle) en WebP, decodificadas fuera del hilo principal con `createImageBitmap` y subidas con presupuesto de tiempo por fotograma. Se respeta `Save-Data`.
- La vista 3D (Three.js) y el generador de ZIP se cargan de forma diferida solo si se usan.
- Transición continua grid → ficha: la misma pieza se desplaza y se abre en el mismo canvas, sin cambio de imagen.

**Lighthouse** (build de producción, local): escritorio 94 · 100 · 100 · 100; móvil 97 · 100 · 100 · 100.

## Accesibilidad

- Retícula accesible paralela al canvas (`role="grid"`) con foco itinerante: flechas para moverse, Intro para abrir y anillo de foco real sobre la celda.
- Índice alternativo en HTML (`I`), enlace de salto y ordenación.
- Diálogos nativos (`<dialog>`) con gestión de foco, Esc y retorno del foco.
- Formulario con errores en línea y resumen enlazado.
- Movimiento reducido: respeta `prefers-reduced-motion` y además se puede activar desde «Proyecto».
- Español e inglés (`?lang=en`), contraste AA, objetivos táctiles ≥ 40 px y soporte de `forced-colors`.
- Si el navegador no tiene WebGL 2, se muestra el índice.

## Atajos

`/` o `Ctrl K` buscar · `F` filtros · `I` atlas/índice · `+` `−` zoom · `0` centrar · flechas para moverse · `Intro` abrir · `Esc` cerrar · `?` proyecto y atajos.

Los atajos de una sola tecla se pueden desactivar en «Proyecto» → «Atajos de una tecla» (siguen `Ctrl K` y las teclas de la retícula cuando tiene el foco). En la ficha, con el foco en el visor o en la estancia 3D: flechas para desplazar o girar, `+` `−` para acercar y alejar, `Inicio` para volver la cámara. Las mismas acciones tienen botones en el visor.

## Desarrollo

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # genera dist/ (estático, base relativa)
npm run preview
```

`dist/` es estático y funciona en cualquier hosting (Vercel, Netlify, GitHub Pages…), también en una subcarpeta.

### Regenerar texturas

Las texturas de `public/tex/` ya están generadas. Para rehacerlas o cambiar materiales:

1. Descarga los ZIP `2K-JPG` de ambientCG de cada `asset` listado en `src/data/catalog.json` y extrae en `<raw>/<AssetId>/` los archivos `Color.jpg` y `NormalGL.jpg`.
2. `python scripts/build_textures.py <raw>` (requiere Pillow y NumPy). Genera los cuatro niveles y `src/data/textures.json` (color medio, CIELAB y recorte de la muestra).

El catálogo (nombres, colecciones, formatos, acabados y textos en ES/EN) está en `src/data/catalog.json`.

## Estructura

```
src/
  atlas/atlas.ts      cámara, gestos, teclado, picking, retícula accesible, overlays
  gl/                 renderer WebGL 2, shaders, carga de texturas
  ui/                 ficha, filtros, búsqueda, selección, índice, minimapa, proyecto
  space/space.ts      estancia 3D (Three.js, carga diferida)
  data/               catálogo, estadísticas de color, lógica de filtros y ficha técnica
  i18n.ts  state.ts  main.ts
scripts/build_textures.py
```

## Créditos

- Texturas: [ambientCG](https://ambientcg.com) (CC0).
- Tipografías: Instrument Serif, Geist y Geist Mono (SIL Open Font License).
- VETA es una marca ficticia; los datos técnicos son verosímiles pero inventados. El formulario no envía datos.
- Concepto, diseño y desarrollo: Javier.
