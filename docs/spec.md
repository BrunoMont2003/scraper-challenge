# Spec: Scraper Jurisprudencia PJ

Scraper TypeScript (HTTP puro, sin browser) para
`https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/`
— desafío técnico de scraping.

## Objective

Dado una búsqueda, el scraper debe:

1. Paginar **todas** las páginas de resultados (hasta el final).
2. Extraer **toda** la información disponible de cada documento
   (card de resultados + ficha detallada "Ver Ficha").
3. Descargar los archivos asociados (PDF y Word).
4. Manejar correctamente rate limiting (429) y errores transitorios (5xx)
   con reintentos y backoff.
5. Ser resumible (checkpoint), idempotente (dedupe por uuid) y observable.

Restricciones del desafío: TypeScript obligatorio, **prohibido** Puppeteer /
Playwright / Selenium. Solo requests HTTP (`axios`) y parsing (`cheerio`).

## Tech Stack

- `typescript`, `ts-node`
- `axios` (HTTP), `cheerio` (parsing HTML/XML)
- `better-sqlite3` (cola de trabajo / estado resumible)
- `commander` (CLI), `p-limit` (pool de concurrencia)
- `vitest` (tests offline con fixtures)

## Mecánica del sitio (reverse-engineering verificado)

Stack del sitio: JSF/Mojarra + RichFaces 4.2.2 (Java EE). Los resultados de
búsqueda viven en la **sesión del servidor** (`JSESSIONID`); por eso recargar
`resultado.xhtml` directamente muestra la página vacía.

### 1. Sesión

```
GET /jurisprudenciaweb/faces/page/inicio.xhtml
→ Set-Cookie: JSESSIONID=...
→ HTML contiene <input name="javax.faces.ViewState" value="<VS>">
```

### 2. Búsqueda

```
POST /jurisprudenciaweb/faces/page/inicio.xhtml
Content-Type: application/x-www-form-urlencoded

Campos del formulario (todos):
  formBuscador=formBuscador
  formBuscador:tabpanel-value=general
  formBuscador:txtBusqueda=<query>
  formBuscador:buNroExpediente=
  formBuscador:buPretensionDelitoSupInput= / ...Value=
  formBuscador:buPretensionInput= / ...Value=
  formBuscador:buPalabraClaveInput= / ...Value=
  formBuscador:buCorte=1            (1=Corte Suprema, 2=Corte Superior)
  formBuscador:buDistrito=
  formBuscador:buEspecialidad=
  formBuscador:buSala=
  formBuscador:buAnio=
  formBuscador:j_idt31=formBuscador:j_idt31
  formBuscador:j_idt31.x=1          ← coordenadas del botón imagen (¡requerido!)
  formBuscador:j_idt31.y=1
  forward=buscar
  busqueda=especializada
  formBuscador:j_idt34=21
  formBuscador:j_idt35=DESC
  formBuscador:j_idt36=Principal
  formBuscador:j_idt37=1
  javax.faces.ViewState=<VS>

→ 302 Location: http://.../resultado.xhtml   ← ¡el Location viene en HTTP!
  Reescribir a https:// antes de seguir el redirect.
```

Sin las coordenadas `.x`/`.y`, el servidor re-renderiza `inicio.xhtml` sin
buscar (el action no se dispara).

### 3. Página de resultados

`GET resultado.xhtml` (misma sesión). Contiene:

- Total: `De un total de NNNNNN resoluciones, se obtuvieron X resultados.`
- 10 filas por página (`formBuscador:repeat:N:j_idt455`, N=0..9).
- Cada card trae metadata inline + el `uuid` en el onclick del link
  "Ver" (j_idt491) y en el link directo de descarga.

### 4. Paginación

```
POST /jurisprudenciaweb/faces/page/resultado.xhtml
Todos los campos del form (los mismos de búsqueda, con valores actuales:
buCorte=1, buDistrito=0, buEspecialidad=0, buSala=0, buTipoRecurso=0,
buTipoResolucion=0, buOrden=21, buOrdenForma=DESC, buPaginas=10, ...)
  formBuscador:spinner=<pagina>
  formBuscador:j_idt447=formBuscador:j_idt447
  javax.faces.ViewState=<VS actual>
→ 200 con la página N (filas renumeradas N*10..N*10+9)
```

Verificado: página 1 expedientes `000724-2025, ...`; página 2
`000096-2026, 000095-2026, ...`.

### 5. Ficha detallada ("Ver Ficha") — AJAX

Cada fila tiene un link `formBuscador:repeat:N:j_idt491` que dispara un
request AJAX parcial (JSF/RichFaces):

```
POST /jurisprudenciaweb/faces/page/resultado.xhtml
Headers: Content-Type: application/x-www-form-urlencoded;charset=UTF-8
         Faces-Request: partial/ajax
         X-Requested-With: XMLHttpRequest

Data (form completo + parámetros del comando):
  formBuscador=formBuscador
  javax.faces.ViewState=<VS>
  formBuscador:txtBusqueda=<query>
  formBuscador:buCorte=1 / buDistrito=0 / buEspecialidad=0 / buSala=0
  formBuscador:buPretensionValue= / ...Input=
  formBuscador:buPalabraClaveValue= / ...Input=
  formBuscador:buNroExpediente=
  formBuscador:buPretensionDelitoSupValue= / ...Input=
  formBuscador:buTipoRecurso=0
  formBuscador:buTipoResolucion=0 / ...Input=-- Todos --
  formBuscador:buAnio=
  formBuscador:buOrden=21 / buOrdenForma=DESC
  formBuscador:j_idt434=on
  formBuscador:spinner=<pagina>
  formBuscador:j_idt540=on
  formBuscador:spinner2=<pagina>
  javax.faces.source=formBuscador:repeat:N:j_idt491
  javax.faces.partial.event=click
  javax.faces.partial.execute=formBuscador:repeat:N:j_idt491 @component
  javax.faces.partial.render=@component
  org.richfaces.ajax.component=formBuscador:repeat:N:j_idt491
  formBuscador:repeat:N:j_idt491=formBuscador:repeat:N:j_idt491
  AJAX:EVENTS_COUNT=1
  javax.faces.partial.ajax=true
  # + parámetros de metadata de la fila:
  uuid=<uuid>
  recurso=<recurso>
  nroexp=<nroexp>
  palabras=<palabras>
  pretensiones=<pretensiones>
  normaDI=<normaDI>
  tipoResolucion=<tipoResolucion>
  fechaResolucion=<fechaResolucion>
  sala=<sala>
  sumilla=<sumilla>

→ 200 XML partial-response. El update id="formBuscador:popupResolucion"
  contiene la ficha completa (3 paneles). El header del popup muestra
  "<recurso> - <nroexp>".
```

La respuesta devuelve el mismo `javax.faces.ViewState` (no rota entre
requests AJAX de la misma página). El detalle de las 10 filas debe pedirse
mientras la página/ViewState está vivo.

### 6. Descarga de archivos — sin sesión

```
GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>
→ 200 application/octet-stream
  Content-Disposition: attachment;filename=Resolucion_<n>_<timestamp>.pdf
```

Verificado: funciona **sin cookie y sin búsqueda previa** — el uuid es
direccionable globalmente. Por lo tanto la descarga de archivos es una fase
independiente de la extracción de metadata.

Cada documento tiene **dos archivos** (en la ficha "Archivo de la Resolución"):

- PDF: `ServletDescarga?uuid=<uuid_pdf>` (icono iconpdf.png)
- Word: `ServletDescarga?uuid=<uuid_word>` (icono iconword.png)

### 7. Errores y sesión

- **ViewExpiredException** (`javax.faces.application.ViewExpiredException`):
  la sesión/ViewState expiró. Recuperación: nueva sesión (GET inicio) →
  re-ejecutar búsqueda → retomar la página.
- **HTTP→HTTPS**: el redirect 302 del POST de búsqueda viene con Location
  `http://`; el puerto 80 no responde — siempre reescribir a `https://`.
- **500 intermitentes**: observados bajo carga. Tratar 5xx/429/timeouts con
  el mismo retry/backoff.
- La búsqueda vacía (`txtBusqueda=""`, Corte Suprema) devuelve ~209K
  resultados — el default de "correr todo".

## Data Schema (por documento)

Un documento produce un registro con ~40 campos, de 3 fuentes:

**Card de resultados (inline):**

| Campo | Tipo | Fuente |
|---|---|---|
| `uuid` | string | onclick "Ver" / ServletDescarga |
| `recurso` | string | header card (ej: "Apelación") |
| `nro_expediente` | string | header card (ej: "032957-2025") |
| `pretension_delito` | string | card |
| `tipo_resolucion` | string | card |
| `fecha_resolucion` | string (dd/MM/yyyy) | card |
| `sala` | string | card |
| `norma_derecho_interno` | string | card |
| `sumilla` | string | card |
| `palabras_clave` | string | card |

**Ficha "Ver Ficha" — DATOS DE LA RESOLUCIÓN:**

`fecha_resolucion`, `tipo_resolucion`, `fallo_sentido`, `jueces_supremos`,
`ponente`, `dirimente`, `discordia`, `voto_concordado`,
`fundamentos_adicionales`, `sumilla`, `norma_derecho_interno`,
`jurisprudencia_nacional_acuerdo_plenario`, `norma_derecho_internacional`,
`organismo_emisor_jurisprudencia_internacional`, `palabras_clave`,
`relevante` (Sí/No), `vinculante` (Sí/No), `fecha_publicacion_el_peruano`.

**Ficha — DATOS DEL PROCESO:**

`sala`, `distrito_judicial_procedencia`, `especialidad`, `materia_causa`,
`pretension_delito`, `regimen_procesal`, `tipo_proceso`,
`nro_expediente_sala_superior`, `uuid_pdf`, `uuid_word`.

**Ficha — DATOS DE PROCEDENCIA:**

`fecha_demanda`, `fecha_calificacion`, `organo_jurisdiccional_procedencia`,
`fallo`, `tipo_resolucion_procedencia`, `expediente_procedencia`,
`fecha_resolucion_procedencia`, `organo_jurisdiccional_origen`,
`fallo_origen`, `tipo_resolucion_origen`, `expediente_origen`,
`fecha_resolucion_origen`, `fecha_denuncia_origen`.

**Derivados de extracción:**

`query` (la búsqueda), `pagina`, `row_index`, `scraped_at`,
`pdf_path`, `word_path`.

## Commands

```bash
npm install

# Demo: búsqueda acotada (metadata + archivos de las primeras páginas)
npm run scrape -- --query "homicidio" --pages 3

# Correr TODO una búsqueda (paginación completa + todos los archivos)
npm run scrape -- --query "homicidio"

# Correr todo el sitio (búsqueda vacía, Corte Suprema ~209K docs)
npm run scrape

# Re-correr es seguro: retoma y reintenta fallidos (idempotente)
npm run scrape -- --query "homicidio"

# Empezar de cero
npm run scrape -- --query "homicidio" --fresh

npm run build          # tsc
npm run typecheck      # tsc --noEmit
npm test               # vitest (offline, fixtures)
```

Flags: `--query <texto>` (default vacío), `--corte <1|2>`,
`--especialidad <id>`, `--anio <aaaa>`, `--pages <N>` (limitar demo),
`--max-files <N>` (limitar descargas), `--concurrency <N>`,
`--min-delay <ms>`, `--out <dir>`, `--fresh`, `--quiet`.

## Project Structure

```
scraper-challenge/
├── src/
│   ├── index.ts          # entrypoint
│   ├── cli.ts            # commander: flags/help
│   ├── config.ts         # defaults y tipos compartidos
│   ├── http/session.ts   # cookie jar + ViewState + re-login (ViewExpired)
│   ├── http/client.ts    # wrapper axios: retry, redirect http→https, timeouts
│   ├── search.ts         # flujo inicio → POST buscar → 302 → resultado
│   ├── paginate.ts       # loop de páginas (spinner + j_idt447)
│   ├── detail.ts         # "Ver Ficha": POST AJAX parcial → parse popup
│   ├── parser.ts         # cheerio: card metadata + uuid + total/páginas
│   ├── download.ts       # ServletDescarga (pdf + word)
│   ├── queue.ts          # SQLite: estado, retry, dedupe
│   ├── ratelimit.ts      # AIMD + full-jitter backoff + Retry-After
│   ├── output.ts         # writers JSONL/CSV incrementales
│   └── logger.ts         # log estructurado + resumen final
├── tests/
│   ├── fixtures/         # HTML/XML reales capturados del sitio
│   └── *.test.ts         # vitest
├── docs/
│   └── spec.md           # este documento
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

## Code Style

TypeScript estricto (`strict: true`), ES2022, CommonJS. Sin `any` salvo
justificación. Nombres en inglés. Clases pequeñas, inyección de dependencias
por constructor. Un ejemplo del estilo:

```ts
import type { DocumentRecord } from "./config";

export function parseResultsPage(html: string): {
  total: number;
  viewState: string;
  rows: DocumentRecord[];
} {
  const $ = load(html);
  const total = $('span[id$="optResultado"]')
    .text()
    .match(/se obtuvieron ([\d.]+) resultados/);
  // ...
  return { total: Number(total?.[1] ?? 0), viewState, rows };
}
```

## Rate Limiting (AIMD + backoff con jitter)

- Pool de workers para descargas: arranca en `concurrency=2`.
- N éxitos consecutivos → `concurrency+1` (additive increase, probe).
- 429 → `concurrency = max(1, floor(concurrency/2))` (multiplicative
  decrease) + honorar `Retry-After` (segundos o fecha HTTP, con clamp).
- Retry por request: full-jitter exponential backoff
  (`random(0, min(cap, base * 2^attempt))`), máx 5-7 intentos.
- Tras agotar intentos → marcar `failed` en la cola (se reintenta en la
  siguiente corrida, la cola es idempotente), nunca abortar la corrida.
- Delay mínimo entre requests (`--min-delay`, default 500ms) + jitter.
- 5xx y timeouts: mismo tratamiento que 429 (el sitio arroja 500 bajo carga).

## Queue / Resume (SQLite)

```sql
CREATE TABLE IF NOT EXISTS pages (
  query      TEXT NOT NULL,
  page       INTEGER NOT NULL,
  status     TEXT NOT NULL,          -- pending|in_progress|done|failed
  attempts   INTEGER DEFAULT 0,
  last_error TEXT,
  scraped_at TEXT,
  PRIMARY KEY (query, page)
);

CREATE TABLE IF NOT EXISTS docs (
  uuid       TEXT PRIMARY KEY,       -- dedupe natural
  query      TEXT NOT NULL,
  page       INTEGER NOT NULL,
  row_index  INTEGER NOT NULL,
  nro_expediente TEXT,
  metadata   TEXT,                   -- JSON completo (~40 campos)
  detail_status TEXT,                -- pending|done|failed
  pdf_status TEXT,                   -- pending|done|failed|missing
  word_status TEXT,
  pdf_path   TEXT,
  word_path  TEXT,
  attempts   INTEGER DEFAULT 0,
  last_error TEXT,
  updated_at TEXT
);
```

- `INSERT OR IGNORE` → idempotente (mismo uuid desde múltiples queries).
- Al iniciar: `UPDATE ... SET status='pending' WHERE status='in_progress'`
  (self-healing tras kill).
- Checkpoint por página y por documento (flush inmediato).

## Output

```
data/
├── results.jsonl      # 1 doc por línea: metadata completa + paths
├── results.csv        # mismo schema (entrega "formato estructurado")
├── pdfs/<nro_exp>__<uuid>.pdf
├── words/<nro_exp>__<uuid>.doc
├── failed.jsonl       # fallidos para reintento
└── scraper.sqlite     # cola/estado
```

## Testing Strategy

- **Vitest, offline**: fixtures HTML/XML reales capturados (página de
  resultados, página 2, partial-response de "Ver Ficha", ViewExpired).
- `parser.test.ts`: card + popup detail → campos correctos, 10 filas.
- `ratelimit.test.ts`: AIMD sube/baja, jitter dentro de bounds,
  `Retry-After` parseado (segundos y fecha).
- `queue.test.ts`: SQLite in-memory — dedupe, self-heal, retry failed.
- `session.test.ts`: recuperación ViewExpired (fixture) → re-login.
- Integración real **opcional** (`RUN_INTEGRATION=1`): 1 búsqueda + 1 página
  contra el sitio, para no pegarle al server en cada `npm test`.

## Boundaries

- **Always**: delays + jitter; dedupe por uuid; checkpoint por página;
  validar campos (formato `nroexp`, fechas); log estructurado.
- **Ask first**: agregar dependencias, cambiar schema de salida, tocar CI.
- **Never**: browser automation (Puppeteer/Playwright/Selenium); subir
  datos/PDFs al repo; requests sin delay; commits con secrets.

## Success Criteria

- [ ] `--query "homicidio"` → 410 páginas, 4.094 registros únicos (0 dup uuid).
- [ ] Por documento: card + ficha completa (~40 campos) + PDF + Word.
- [ ] Descargas de muestra sin 429 sostenido (AIMD regula).
- [ ] Interrumpir a mitad → re-correr retoma sin re-crawlear ni re-descargar.
- [ ] 429/5xx → retry con jitter; `failed.jsonl` con los fallidos.
- [ ] ViewExpired → nueva sesión + re-buscar + retomar página.
- [ ] `npm test` verde offline; `npm run typecheck` limpio.
- [ ] README: setup, uso, mecánica del sitio (reverse-engineering), nota VPN.

## Open Questions

- VPN Perú: el sitio respondió sin VPN durante el desarrollo; documentar en
  README que puede requerir VPN según la red del usuario.
- Sitio alternativo OEFA: queda como fallback de desarrollo/tests, no como
  target del scraper.
