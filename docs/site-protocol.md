# Verified JSF/RichFaces site protocol

This document records only behavior exercised by the implementation and its captured fixtures. It is a maintenance reference for the HTTP adapter, not a promise that the external site will remain unchanged.

## Request flow

### 1. Establish a JSF session

`SiteSession.login()` sends `GET /jurisprudenciaweb/faces/page/inicio.xhtml` and requires both:

- a `JSESSIONID` from `Set-Cookie`, unless the session already has one;
- a non-empty `javax.faces.ViewState` hidden input.

The search result is server-session state. Each parallel `SessionWorker` therefore owns a separate cookie and ViewState while sharing the host pacer.

**Evidence:** `src/http/session.ts`, `src/session-worker.ts`, `tests/ratelimit.test.ts`.

### 2. Submit the search

`SearchClient.search()` posts the complete search form to `inicio.xhtml`. In addition to the selected filters and current ViewState, the request includes the image-button command and its coordinates:

```text
formBuscador:j_idt31=formBuscador:j_idt31
formBuscador:j_idt31.x=1
formBuscador:j_idt31.y=1
forward=buscar
busqueda=especializada
```

The HTTP client follows redirects and normalizes redirect targets to HTTPS. The returned document must parse as result page 1; remaining on the start page or receiving malformed markup is an error.

**Evidence:** `src/search.ts`, `src/http/client.ts`, `tests/pipeline.test.ts`, `tests/fixtures/results-page1.html`.

### 3. Parse a result page

`parseResultsPage()` requires all of the following:

- the result-total text;
- a positive current page from `formBuscador:spinner`;
- a consistent last-page value;
- a non-empty ViewState;
- a UUID for every result card;
- between one and ten cards when the total is non-zero;
- an exact current-page match when a page was requested explicitly.

Card UUIDs are read from the RichFaces `onclick` parameters, with a `ServletDescarga?uuid=` link as fallback. Missing or inconsistent protocol data raises `ProtocolError`; it is not accepted as an empty success.

**Evidence:** `src/parser.ts`, `tests/parser.test.ts`, `tests/fixtures/results-page1.html`, `tests/fixtures/results-page2.html`.

### 4. Navigate to another page

`Paginator.goToPage()` posts the current search form to `resultado.xhtml` with the requested spinner value, the paginator command `formBuscador:j_idt447`, and the current ViewState. The response must identify itself as the requested page before its ViewState replaces the session value.

**Evidence:** `src/paginate.ts`, `src/parser.ts`, `tests/pipeline.test.ts`, `tests/fixtures/results-page2.html`.

### 5. Fetch “Ver Ficha” details

The detail request is a partial AJAX POST to `resultado.xhtml`. It sends the current form, page, card metadata, ViewState, and RichFaces command parameters with these headers:

```text
Faces-Request: partial/ajax
X-Requested-With: XMLHttpRequest
Referer: .../resultado.xhtml
```

The XML partial response must contain a new ViewState and the `formBuscador:popupResolucion` update. The popup must include the mandatory “Datos de la resolución” and “Datos del proceso” panels. Optional PDF and Word UUIDs are extracted from `ServletDescarga` links containing the corresponding file icons.

**Evidence:** `src/detail.ts`, `tests/detail.test.ts`, `tests/fixtures/detail-popup.xml`.

### 6. Recover invalid session views

A response containing `ViewExpiredException`, `could not be restored`, a missing detail popup, or another invalid JSF result/detail structure is treated as a desynchronized session view. A worker creates a fresh login/search state and, for work beyond page one, navigates back to the requested page before retrying. Recovery is bounded to three attempts by default; exhausted work is persisted as failed and sibling pages continue.

**Evidence:** `src/http/session.ts`, `src/session-worker.ts`, `tests/pipeline.test.ts`, `tests/fixtures/view-expired.xml`.

### 7. Download files

The production download phase uses an HTTP client without a session cookie and requests:

```text
GET /jurisprudenciaweb/ServletDescarga?uuid=<file-uuid>
```

All clients share one host pacer. Retryable 429, 5xx, and network failures use exponential full-jitter backoff; `Retry-After` takes precedence when present. A 429 also opens a host-wide cooldown and the download phase defers sibling artifacts instead of exhausting each one during the same throttle window. Deferred eligibility is persisted. Short remaining waits resume with a visible countdown; an artifact that reaches three attempts transitions to failed with its diagnostic retained.

A response is publishable only when it is HTTP 200, is not HTML, is at least 1,000 bytes, and has the expected magic bytes (`%PDF-` for PDF or OLE2 for Word). The response stream is written to a sibling temporary file and atomically renamed after validation.

**Evidence:** `src/index.ts`, `src/download.ts`, `tests/download.test.ts`.

## Reliability rules derived from the protocol

| Boundary | Implemented rule | Evidence |
|---|---|---|
| Session state | One cookie/ViewState pair per crawl worker | `tests/pipeline.test.ts` |
| Host load | One shared pacer controls actual request starts | `tests/ratelimit.test.ts` |
| Retry pressure | Exponential full-jitter backoff, `Retry-After`, durable cooldown, bounded artifact attempts | `tests/ratelimit.test.ts`, `tests/queue.test.ts` |
| Malformed page | Reject missing ViewState, UUID, page identity, or result shape | `tests/parser.test.ts` |
| Malformed detail | Reject missing popup or mandatory panels | `tests/detail.test.ts` |
| Expired view | Re-login, repeat search, restore page, retry within a bound | `tests/pipeline.test.ts` |
| Failed page | Record the failure and continue unrelated pages | `tests/pipeline.test.ts` |
| Invalid file | Reject HTML, undersized, or wrong-magic content | `tests/download.test.ts` |

## Reproduce the evidence

All fixture-backed checks are offline:

```bash
npm test -- \
  tests/parser.test.ts \
  tests/detail.test.ts \
  tests/pipeline.test.ts \
  tests/ratelimit.test.ts \
  tests/download.test.ts
```

The opt-in real-site smoke uses temporary output, one session, one page, one detail, a 1-second minimum delay, and at most one file:

```bash
npm run test:live
```

The live smoke proves only that bounded path at execution time. It does not validate a complete crawl or run in CI.
