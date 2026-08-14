# Scraper de jurisprudencia del Poder Judicial del Perú

![CI](https://github.com/BrunoMont2003/scraper-challenge/actions/workflows/ci.yml/badge.svg)

Scraper reanudable en TypeScript para el portal nacional de jurisprudencia del Poder Judicial del Perú. Reproduce el flujo HTTP de JSF/RichFaces sin automatización de navegador, extrae expedientes y detalles, descarga sus PDF y exporta los resultados en JSONL y CSV.

## Cumplimiento del reto


| Criterio      | Implementación                                                                                          | Evidencia                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Funcionalidad | Recorre la paginación, extrae tarjetas y detalles, y descarga PDF                                       | `tests/parser.test.ts`, `tests/detail.test.ts`, `tests/pipeline.test.ts`, `tests/download.test.ts` |
| Errores 429   | Respeta `Retry-After`, aplica backoff exponencial con full jitter y reduce la presión sobre el servidor | `tests/ratelimit.test.ts`                                                                          |
| Código limpio | Responsabilidades separadas, TypeScript estricto y lint automatizado                                    | `npm run typecheck && npm run lint`                                                                |
| Robustez      | Persistencia, reanudación, escrituras atómicas, validación de archivos y aislamiento de fallos          | `tests/queue.test.ts`, `tests/output.test.ts`, `tests/workspace.test.ts`                           |
| Documentación | Ejecución, resultados, decisiones, recuperación y límites documentados                                  | Este README y [`docs/site-protocol.md`](docs/site-protocol.md)                                     |


## Probarlo en dos minutos

Requisitos: Node.js 22 y npm. El sitio puede requerir una VPN con salida en Perú.

```bash
npm ci
npm run scrape -- \
  --query "homicidio" \
  --pages 1 \
  --max-files 2 \
  --out data/homicidio
```

La consola muestra progreso continuo y termina con un resumen orientado a resultados:

```text
╭─ ✓ Finalizado correctamente
│ Expedientes exportados     <cantidad>
│ Archivos disponibles       <descargados> / <solicitados>
│ Archivos pendientes        0
│ Errores definitivos        0
│ Resultados                 data/homicidio
╰─ Listo
```

Para procesar todo el alcance de una consulta, quite los límites:

```bash
npm run scrape -- --query "homicidio" --out data/homicidio
```

Una consulta vacía con los filtros predeterminados solicita todo el corpus de la Corte Suprema y puede tomar bastante tiempo.

## Resultados

```text
<out>/
├── scraper.sqlite
├── results.jsonl
├── results.csv
├── unresolved.jsonl
├── pdfs/<expediente>__<uuid>.pdf
└── words/<expediente>__<uuid>.<extensión>
```

- `scraper.sqlite`: fuente de verdad persistente para reanudar el trabajo.
- `results.jsonl` y `results.csv`: exportaciones atómicas con el mismo esquema plano de 50 columnas.
- `unresolved.jsonl`: documentos con trabajo pendiente o fallido y su diagnóstico.
- `pdfs/`: documentos descargados; `words/` se genera únicamente con `--word`.

El orden oficial de las columnas se encuentra en [`src/output.ts`](src/output.ts).

## Decisiones técnicas


| Decisión                                  | Motivo                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| HTTP puro con Axios y Cheerio             | Cumple la restricción de no usar Puppeteer, Playwright, Selenium ni WebDriver               |
| Sesiones JSF independientes               | Cada sesión conserva su propio `JSESSIONID`, búsqueda y `ViewState`                         |
| SQLite como cola durable                  | Permite reanudar sin repetir páginas, detalles ni descargas completadas                     |
| Regulación compartida por servidor        | Coordina solicitudes concurrentes y evita que cada worker reaccione al 429 de forma aislada |
| Backoff exponencial con full jitter       | Evita reintentos sincronizados y respeta `Retry-After` cuando está disponible               |
| Escrituras temporales y reemplazo atómico | Una interrupción no corrompe descargas ni exportaciones existentes                          |
| Streaming y validación de archivos        | Limita el uso de memoria y rechaza respuestas HTML o binarios inválidos                     |


El protocolo JSF/RichFaces verificado está explicado en [`docs/site-protocol.md`](docs/site-protocol.md).

## Reanudación y recuperación

El alcance normalizado —`query`, `corte`, `especialidad` y `anio`— identifica cada ejecución.

- Repita el mismo comando para reintentar trabajo pendiente o fallido.
- Los elementos completados se reutilizan; no se descargan nuevamente.
- Las pausas breves del servidor esperan y reintentan automáticamente.
- Las pausas largas quedan persistidas para no bloquear la terminal indefinidamente.
- Después de tres intentos, un archivo queda como fallo explícito en `unresolved.jsonl`.

Use `--fresh` para eliminar solamente los artefactos administrados dentro de `--out` y comenzar desde la primera página:

```bash
npm run scrape -- --query "homicidio" --out data/homicidio --fresh
```

## Opciones principales


| Opción                | Predeterminado | Propósito                                       |
| --------------------- | --------------: | ----------------------------------------------- |
| `--query <text>`      | `""`           | Texto de búsqueda                               |
| `--corte <1|2>`       | `1`            | Corte Suprema (`1`) o Superior (`2`)            |
| `--especialidad <id>` | `""`           | Especialidad; vacío significa todas             |
| `--anio <year>`       | `""`           | Año; vacío significa todos                      |
| `--pages <N>`         | `0`            | Máximo de páginas; `0` significa todas          |
| `--max-files <N>`     | `0`            | Máximo por tipo de archivo; `0` significa todos |
| `--sessions <N>`      | `1`            | Sesiones JSF independientes                     |
| `--min-delay <ms>`    | `500`          | Demora mínima entre solicitudes                 |
| `--out <dir>`         | `data`         | Directorio de salida                            |
| `--word`              | desactivado    | También descarga documentos Word                |
| `--quiet`             | desactivado    | Muestra errores y resumen final                 |
| `--fresh`             | desactivado    | Reinicia los artefactos administrados           |


La referencia completa y actualizada está disponible mediante `npm run scrape -- --help`.

## Verificación

La suite predeterminada no utiliza la red:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

La prueba de humo acotada contra el servicio real es opcional y limpia su salida temporal al finalizar:

```bash
npm run test:live
```

No se ejecuta en CI porque depende de la disponibilidad de un servicio externo.

## Códigos de salida


| Código | Significado                                                        |
| ------: | ------------------------------------------------------------------ |
| `0`    | Trabajo solicitado completado                                      |
| `1`    | Resultado parcial conservado; quedan fallos por revisar            |
| `2`    | Error fatal de configuración, esquema, protocolo u orquestación    |
| `130`  | Interrupción mediante `Ctrl+C`; el progreso confirmado se conserva |


## Límites conocidos

- El portal real puede requerir una VPN peruana y cambiar o fallar independientemente.
- Una ejecución normal no actualiza páginas ya completadas; use `--fresh` para extraer nuevamente todo el alcance.
- El repositorio demuestra un recorrido real acotado, pero no afirma haber completado una extracción integral del sitio.
