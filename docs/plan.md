# Plan: Scraper Jurisprudencia PJ

Plan de implementación del [spec.md](./spec.md).

## Componentes y dependencias

```
cli ──► orchestration (index.ts)
          ├─► session (cookie + ViewState) ──► search ──► paginate
          │                                        │
          │                                        ▼
          │                              parser (card + total)
          │                                        │
          │                              ┌─────────┴─────────┐
          │                              ▼                   ▼
          │                        detail (Ver Ficha)   queue (SQLite)
          │                              │                   │
          │                              ▼                   ▼
          └─► download (pdf/word) ──► output (jsonl/csv) ── logger
               ▲
          ratelimit (AIMD) ──┘
```

- `config.ts` — tipos y defaults (sin dependencias, todo lo consume).
- `http/session.ts` — mantiene cookie jar + ViewState actual; detecta
  ViewExpired y re-loguea.
- `search.ts` — flujo inicio → POST → 302 (rewrite http→https) → resultado.
- `parser.ts` — extrae de la página: total, viewstate, 10 cards + params de
  cada fila (uuid, recurso, nroexp, ...).
- `paginate.ts` — POST spinner + j_idt447, loop hasta última página.
- `detail.ts` — por fila, POST AJAX "Ver Ficha" (params exactos del spec),
  parsea partial-response XML con cheerio.
- `download.ts` — GET `ServletDescarga?uuid=` para pdf y word.
- `queue.ts` — SQLite (better-sqlite3), tablas `pages` y `docs`.
- `ratelimit.ts` — AIMD controller + full-jitter backoff + Retry-After.
- `output.ts` — escritura incremental JSONL + CSV.
- `logger.ts` — progreso y resumen.

## Orden de implementación

1. **Scaffold** — deps, tsconfig, scripts, estructura de carpetas.
2. **config.ts** — tipos `DocumentRecord`, `DetailRecord`, defaults.
3. **ratelimit.ts** — AIMD + backoff (puro, testeable sin red).
4. **http/session.ts + client.ts** — axios wrapper con retry y redirect.
5. **search.ts + parser.ts** — búsqueda + parse de página (fixture).
6. **paginate.ts** — loop de páginas.
7. **detail.ts** — ficha por fila (fixture partial-response).
8. **queue.ts** — SQLite, dedupe, self-heal.
9. **download.ts** — PDF/Word con rate limit.
10. **output.ts + logger.ts** — JSONL/CSV + resumen.
11. **cli.ts + index.ts** — orquestación completa.
12. **tests** — fixtures + unit tests vitest.
13. **README.md** — setup, uso, mecánica del sitio.

Orden = dependencias (todo lo testeable sin red primero).

## Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Sesión/ViewState expira (ViewExpiredException) | Detectar → nueva sesión → re-buscar → retomar página |
| 302 con Location `http://` (puerto 80 no responde) | Rewrite `http` → `https` siempre |
| 500 intermitentes bajo carga | Mismo retry/backoff que 429 |
| 429 en descargas masivas | AIMD (baja concurrencia) + Retry-After + cola failed |
| Rate limit en desarrollo | Delays por defecto, fixture tests offline, integración opcional |
| Docs sin archivo (pdf/word faltan en ficha) | Estado `missing`, no rompe la corrida |

## Verification checkpoints

- Tras paso 3: `ratelimit` unit tests verdes.
- Tras paso 5: búsqueda real acotada (`--pages 1`) produce 10 registros JSONL.
- Tras paso 7: ficha de 1 fila produce ~40 campos.
- Tras paso 9: PDF + Word descargados en disco para 1 doc.
- Tras paso 11: `--query homicidio --pages 3 --max-files 10` corre
  end-to-end con resume.
- Tras paso 12: `npm test` verde, `npm run typecheck` limpio.

## Tasks

- [ ] T1: Scaffold proyecto (deps: better-sqlite3, commander, p-limit,
      vitest; tsconfig strict; scripts npm)
  - Acceptance: `npm run typecheck` corre sin errores con carpeta `src/` vacía o stub.
  - Verify: `npm install && npm run typecheck`
- [ ] T2: `config.ts` — tipos y defaults
  - Acceptance: `DocumentRecord`, `DetailRecord`, `CliOptions` tipados.
  - Verify: typecheck
- [ ] T3: `ratelimit.ts` — AIMD + full-jitter backoff + parse Retry-After
  - Acceptance: test unit: 429 reduce conc, éxitos suben, jitter en bounds.
  - Verify: `npx vitest run tests/ratelimit.test.ts`
- [ ] T4: `http/client.ts` + `http/session.ts` — axios wrapper, cookies,
      ViewState, re-login en ViewExpired, rewrite http→https
  - Acceptance: `session` expone `getViewState()`, `refresh()`; client
    reintenta 429/5xx.
  - Verify: unit test con axios mock / fixture ViewExpired
- [ ] T5: `search.ts` + `parser.ts` — búsqueda + parse página
  - Acceptance: corre búsqueda real acotada y parsea 10 cards + total + uuids.
  - Verify: `npm run scrape -- --query homicidio --pages 1` imprime 10 docs
- [ ] T6: `paginate.ts` — loop hasta última página
  - Acceptance: recorre N páginas, detecta fin, checkpoint por página.
  - Verify: `--pages 3` produce 30 docs con `page` correcto
- [ ] T7: `detail.ts` — ficha "Ver Ficha" por fila
  - Acceptance: POST AJAX exacto del spec, parsea ~40 campos + uuid_pdf/word.
  - Verify: 1 doc en SQLite con metadata detallada completa
- [ ] T8: `queue.ts` — SQLite, dedupe, self-heal, failed
  - Acceptance: `INSERT OR IGNORE`, reset in_progress, `--resume` retoma.
  - Verify: unit test in-memory
- [ ] T9: `download.ts` — PDF + Word vía ServletDescarga
  - Acceptance: archivos en `data/pdfs|words/` con nombre descriptivo;
    missing si no hay uuid.
  - Verify: descargar 1 doc completo (pdf+word)
- [ ] T10: `output.ts` + `logger.ts` — JSONL/CSV + resumen
  - Acceptance: escritura incremental, resumen final (docs/páginas/fallidos).
  - Verify: `data/results.jsonl` y `results.csv` válidos
- [ ] T11: `cli.ts` + `index.ts` — orquestación
  - Acceptance: todos los flags del spec funcionan; corrida end-to-end
    `--query homicidio --pages 3 --max-files 10`.
  - Verify: ejecución completa + re-ejecución con `--resume`
- [ ] T12: Tests + fixtures
  - Acceptance: `npm test` verde offline (parser, ratelimit, queue, session).
  - Verify: `npm test`
- [ ] T13: `README.md`
  - Acceptance: instalación, uso, mecánica del sitio, VPN nota, entregable.
  - Verify: revisión manual
