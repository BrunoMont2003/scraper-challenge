# Peruvian Judiciary Jurisprudence Scraper

[![CI](https://github.com/BrunoMont2003/scraper-challenge/actions/workflows/ci.yml/badge.svg)](https://github.com/BrunoMont2003/scraper-challenge/actions/workflows/ci.yml)

A resumable TypeScript scraper for the Peruvian Judiciary's national jurisprudence portal. It reproduces the JSF/RichFaces HTTP flow without browser automation, extracts result cards and detailed records, downloads PDF files by default (with optional Word downloads), and publishes JSONL/CSV exports.

## Quick evaluation

Use Node.js 22 (the CI version) and npm:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Those checks are offline. To exercise the real site with a temporary directory, one session, one page, one detail, a 1-second request delay, and at most one file:

```bash
npm run test:live
```

The live smoke test is intentionally excluded from CI and `npm test` because it depends on an external service. It removes its temporary output when finished.

## Run the scraper

Start with a bounded run rather than the unfiltered default:

```bash
npm run scrape -- \
  --query "homicidio" \
  --pages 1 \
  --max-files 2 \
  --out data/homicidio
```

Remove `--pages` and `--max-files` only when a complete search is intended:

```bash
npm run scrape -- --query "homicidio" --out data/homicidio
```

An empty query and the default filters request the entire Supreme Court corpus. That can be a large, long-running operation.

### Resume and reset

The complete normalized search scope—`query`, `corte`, `especialidad`, and `anio`—identifies a run in SQLite.

- Running the same scope again resumes pending and failed pages, details, and files.
- Completed pages are not refreshed automatically.
- Different filter combinations do not share queue state, even in the same output directory.
- Exports are regenerated for the current scope, so separate `--out` directories are clearer when results must coexist.

`--fresh` is the only reset flag:

```bash
npm run scrape -- --query "homicidio" --out data/homicidio --fresh
```

It removes only scraper-managed artifacts inside the selected `--out` directory—SQLite and its sidecars, exports, temporary export files, `pdfs/`, and `words/`—then starts from page one. It does **not** refresh only the current query. Unrelated files and other output directories are preserved, and a symlink used as the output root is rejected.

### CLI options

| Option | Default | Purpose |
|---|---:|---|
| `--query <text>` | `""` | Search text; empty means an unfiltered text search |
| `--corte <1\|2>` | `1` | `1` Supreme Court, `2` Superior Court |
| `--especialidad <id>` | `""` | Specialty identifier; empty means all |
| `--anio <year>` | `""` | Resolution year; empty means all |
| `--pages <N>` | `0` | Maximum pages; `0` means all |
| `--max-files <N>` | `0` | Maximum downloads per file kind; `0` means all |
| `--concurrency <N>` | `2` | Initial adaptive download concurrency |
| `--sessions <N>` | `1` | Independent JSF crawl sessions |
| `--min-delay <ms>` | `500` | Minimum delay between starts of requests to the host |
| `--out <dir>` | `data` | Output workspace |
| `--fresh` | off | Reset managed artifacts in `--out` and start over |
| `--word` | off | Also download Word artifacts; PDF remains enabled |
| `--quiet` | off | Print only errors and the final summary |

Show the authoritative CLI help with:

```bash
npm run scrape -- --help
```

## Outputs

```text
<out>/
├── scraper.sqlite
├── results.jsonl
├── results.csv
├── unresolved.jsonl
├── pdfs/<case-number>__<uuid>.pdf
└── words/<case-number>__<uuid>.<server-extension>
```

`scraper.sqlite` is the durable source of truth. JSONL and CSV are complete, atomically replaced exports for the current run scope; they use the same 50-column flat schema. The fields combine card metadata, detail metadata, file UUIDs/paths, `query`, `pagina`, `row_index`, and the persisted `scraped_at` timestamp. See [`src/output.ts`](src/output.ts) for the authoritative column order.

### Console output

Interactive terminals show a live Spanish dashboard for search, page processing, PDFs, optional Word, and export. Every determinate counter names its unit (`pages`, `PDFs`, or `Word documents`); indeterminate operations use a spinner instead of inventing progress. Speed, estimated remaining time, and server pauses stay visible during long waits. Repeated rate-limit responses are aggregated instead of flooding the terminal. Redirected output uses stable newline-delimited records with no ANSI control sequences. `--quiet` keeps errors and the final summary only.

If a resumed run starts during a short persisted server cooldown, the dashboard shows the deferred-file count and a visible countdown, then retries automatically. Longer server-imposed waits remain persisted so the command can exit without holding the terminal indefinitely. HTTP retries use exponential full-jitter backoff and honor `Retry-After`; after three artifact attempts, deferred work becomes an explicit failure instead of remaining pending forever.

Every run ends with one clear Spanish result: successful, partially completed, or interrupted. The summary prioritizes exported records, available files, pending work, and the next recovery action. HTTP requests, retries, and server limits remain visible as secondary diagnostics, and the output directory is printed once.

`unresolved.jsonl` contains one JSON object per document with pending or definitively failed work. It supersedes the older, ambiguous `failed.jsonl` name; after the replacement manifest is written successfully, that legacy file is removed:

```json
{
  "uuid": "document-uuid",
  "page": 1,
  "detail_status": "failed",
  "pdf_status": "done",
  "word_status": "missing",
  "detail_error": "diagnostic message",
  "pdf_error": null,
  "word_error": null
}
```

Downloads and exports are written to sibling temporary files, validated where applicable, and renamed into place only after success. Existing final artifacts therefore survive an interrupted replacement.

## Exit status

| Code | Meaning |
|---:|---|
| `0` | The requested work completed without unresolved failures |
| `1` | Partial result: useful data was preserved, but page/document/file failures remain |
| `2` | Fatal startup, configuration, schema, protocol, or orchestration error |

`Ctrl+C` preserves committed SQLite progress and exits with the conventional signal status `130`.

## How the crawl works

1. Each worker obtains its own `JSESSIONID` and `javax.faces.ViewState`.
2. It submits the search form and parses page one.
3. Pages are distributed across independent sessions; each session maintains its own server-side search and ViewState.
4. Each result card is persisted before its RichFaces partial-AJAX detail request.
5. PDF UUIDs are downloaded with shared host pacing, cooldown, bounded retries, and adaptive pressure; `--word` adds Word UUIDs.
6. SQLite rows are streamed into atomic JSONL, CSV, and failure-manifest exports.

Malformed protocol responses fail diagnostically instead of becoming empty successful records. An exhausted page or document operation is recorded while unrelated work continues. The verified wire-level details are documented in [`docs/site-protocol.md`](docs/site-protocol.md).

## Verification map

| Claim | Reproducible evidence |
|---|---|
| Scope isolation, resume, schema rejection | `npm test -- tests/queue.test.ts tests/workspace.test.ts` |
| JSF parsing, details, recovery, page isolation | `npm test -- tests/parser.test.ts tests/detail.test.ts tests/pipeline.test.ts` |
| Host-wide request spacing | `npm test -- tests/ratelimit.test.ts` |
| Streaming/atomic downloads and exports | `npm test -- tests/download.test.ts tests/output.test.ts` |
| Exit codes and default-test network isolation | `npm test -- tests/index.test.ts` |
| Bounded real-site path | `npm run test:live` |
| Full offline quality gate | `npm run typecheck && npm run lint && npm test && npm run build` |

## Limitations and troubleshooting

- **The live site is unreachable:** confirm DNS/TLS access from your network; a Peruvian VPN may be necessary in some environments. Offline tests do not require site access.
- **A run reports deferred artifacts:** keep the workspace and rerun it. Short remaining cooldowns wait with a visible countdown and retry automatically; longer waits remain persisted. Completed files are always skipped. Once an artifact exhausts its three-attempt budget it is reported as failed, with the last diagnostic in `unresolved.jsonl`.
- **SQLite reports an incompatible schema:** v2 workspaces migrate transactionally to v3. Older or unknown schemas require `--fresh` only if discarding managed state is acceptable.
- **A normal rerun does not detect changes on completed source pages:** use `--fresh` for a complete rescrape.
- **The command exits `1`:** inspect `unresolved.jsonl`, keep the output directory, and rerun the same scope to retry unresolved work.
- **The command exits `2`:** fix the reported fatal/configuration/protocol problem before retrying.
- **Coverage:** the repository has no coverage command; the documented evidence is the offline Vitest suite plus the opt-in bounded live smoke.
- **External service behavior:** the live site can change or fail independently. This repository does not claim a completed full-site crawl.

## Project structure

```text
src/                   scraper implementation
tests/                 offline Vitest suite and captured HTML/XML fixtures
tests/live-smoke.ts    opt-in bounded real-site harness
docs/site-protocol.md  verified JSF/RichFaces protocol notes
.github/workflows/     Node.js 22 CI quality gate
```
