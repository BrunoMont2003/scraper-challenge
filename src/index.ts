import { relative } from "node:path";
import { parseCli } from "./cli";
import { type CliOptions, normalizeRunScope, type SearchFilters } from "./config";
import { Downloader, type FileKind } from "./download";
import { HttpClient, type RequestObservation } from "./http/client";
import { OutputWriter, toFlatRecord } from "./output";
import { type DocRow, JobQueue } from "./queue";
import { AdaptiveSemaphore, AimdController, HostPacer } from "./ratelimit";
import { type RunPhase, RunReporter, type RunStats, terminalState } from "./reporter";
import { processPageIsolated, SessionWorker } from "./session-worker";
import { ScraperWorkspace } from "./workspace";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function requestedFileKinds(includeWord: boolean): FileKind[] {
  return includeWord ? ["pdf", "word"] : ["pdf"];
}

export function requestedPhases(includeWord: boolean): RunPhase[] {
  return includeWord
    ? ["Search", "Details", "PDFs", "Word", "Export"]
    : ["Search", "Details", "PDFs", "Export"];
}

interface Context {
  opts: CliOptions;
  filters: SearchFilters;
  logger: RunReporter;
  aimd: AimdController;
  pacer: HostPacer;
  queue: JobQueue;
  runId: number;
  workspace: ScraperWorkspace;
  workers: SessionWorker[];
  downloader: Downloader;
  output: OutputWriter;
  stats: RunStats;
}

export function canReuseCompletedCrawl(
  queue: Pick<JobQueue, "pendingPages">,
  runId: number,
  requestedPages: number,
): boolean {
  return requestedPages > 0 && queue.pendingPages(runId, requestedPages).length === 0;
}

/** Procesa las páginas asignadas a una sesión (paginar + ficha de cada card). */
async function crawlPagesWithWorker(
  ctx: Context,
  worker: SessionWorker,
  pages: number[],
): Promise<void> {
  const { filters, logger, queue, stats } = ctx;
  if (pages.length === 0) return;

  let current = await worker.ensureSearched(filters);

  for (const page of pages) {
    if (queue.isPageDone(ctx.runId, page)) {
      stats.pagesDone++;
      continue;
    }
    queue.markPage(ctx.runId, page, "in_progress");
    const fetched = await processPageIsolated(
      page,
      () => worker.fetchPageWithRecovery(filters, page),
      (failedPage, error) => {
        queue.markPage(ctx.runId, failedPage, "failed", errorMessage(error));
        stats.pagesFailed++;
        logger.warn(`página ${failedPage} fallida: ${errorMessage(error)}`);
      },
    );
    if (!fetched) continue;
    current = fetched;

    let pageFailed = false;

    for (const card of current.cards) {
      queue.insertCard(ctx.runId, page, card);
      const existing = queue.getDoc(ctx.runId, card.uuid);
      if (existing?.detail_status === "done") {
        stats.detailDone++;
        continue;
      }

      try {
        queue.incrementAttempts(ctx.runId, card.uuid, "detail");
        const detail = await worker.fetchDetailWithRecovery(filters, page, card);
        queue.setDetail(ctx.runId, card.uuid, detail);
        stats.detailDone++;
      } catch (error) {
        queue.markDetail(ctx.runId, card.uuid, "failed", errorMessage(error));
        pageFailed = true;
        stats.detailFailed++;
        logger.warn(`detalle fallido ${card.nroexp}: ${errorMessage(error)}`);
      }
    }

    queue.markPage(ctx.runId, page, pageFailed ? "failed" : "done");
    if (pageFailed) stats.pagesFailed++;
    else stats.pagesDone++;
    logger.progress(stats.pagesDone + stats.pagesFailed);
  }
}

/**
 * Fase 1: reparte las páginas entre las N sesiones y extrae card + ficha.
 * Cada sesión paginación e ViewState propios → paralelo sin pisarse.
 */
async function crawlPhase(ctx: Context): Promise<void> {
  const { opts, filters, logger, workers } = ctx;

  if (canReuseCompletedCrawl(ctx.queue, ctx.runId, opts.pages)) {
    logger.phaseSkipped(
      "Search",
      `${opts.pages} páginas reutilizadas · No fue necesario consultar el sitio`,
    );
    logger.phaseSkipped(
      "Details",
      `${ctx.queue.countDetails(ctx.runId, "done")} detalles reutilizados · Nada pendiente`,
    );
    return;
  }

  const primary = workers[0]!;
  logger.phaseStarted("Search");
  logger.info(`Consulta: "${filters.query}"`);
  const pageData = await primary.ensureSearched(filters);
  if (pageData.lastPage === 0 || pageData.cards.length === 0) {
    throw new Error(
      "La búsqueda no devolvió resultados (¿formulario incompleto? Ver docs/site-protocol.md)",
    );
  }
  logger.info(
    `Encontrados: ${pageData.totalResults.toLocaleString("en")} expedientes · ${pageData.lastPage.toLocaleString("en")} páginas disponibles`,
  );

  const lastPage = opts.pages > 0 ? Math.min(pageData.lastPage, opts.pages) : pageData.lastPage;

  const pendingPages = ctx.queue.pendingPages(ctx.runId, lastPage);
  if (pendingPages.length === 0) {
    logger.phaseSkipped(
      "Details",
      `${ctx.queue.countDetails(ctx.runId, "done")} detalles reutilizados · Nada pendiente`,
    );
    return;
  }
  logger.phaseStarted("Details", pendingPages.length);
  const assignments: number[][] = workers.map(() => []);
  for (const page of pendingPages) {
    assignments[(page - 1) % workers.length]!.push(page);
  }

  await Promise.all(workers.map((worker, i) => crawlPagesWithWorker(ctx, worker, assignments[i]!)));
}

/** Fase 2: descargar PDF/Word pendientes con pool de concurrencia AIMD.
 *  Los fallidos quedan marcados en la cola y se reintentan en la
 *  siguiente corrida (idempotente), nunca abortan el resto. */
async function downloadPhase(ctx: Context, kind: FileKind): Promise<void> {
  const maxArtifactAttempts = 3;
  ctx.queue.failExhaustedFiles(ctx.runId, kind, maxArtifactAttempts);
  const loadJobs = () => {
    let pending = ctx.queue.pendingDownloads(ctx.runId, kind, Date.now(), maxArtifactAttempts);
    if (ctx.opts.maxFiles > 0) {
      const done = ctx.queue.countFiles(ctx.runId, kind, "done");
      pending = pending.slice(0, Math.max(0, ctx.opts.maxFiles - done));
    }
    return pending;
  };
  let jobs = loadJobs();
  const done = ctx.queue.countFiles(ctx.runId, kind, "done");
  const reused = ctx.opts.maxFiles > 0 ? Math.min(done, ctx.opts.maxFiles) : done;
  ctx.stats.filesReused += reused;
  const phase = kind === "pdf" ? "PDFs" : "Word";
  if (jobs.length === 0) {
    const deferred = ctx.queue.deferredDownloadWindow(
      ctx.runId,
      kind,
      maxArtifactAttempts,
      ctx.opts.maxFiles,
    );
    const waitMs = Math.max(0, (deferred.nextEligibleAt ?? 0) - Date.now());
    if (deferred.count > 0 && waitMs > 0 && waitMs <= 60_000) {
      ctx.logger.phaseWaiting(phase, deferred.count, deferred.nextEligibleAt!);
      await new Promise((resolve) => setTimeout(resolve, waitMs + 25));
      jobs = loadJobs();
    }
    if (jobs.length === 0) {
      const message =
        deferred.count > 0
          ? `${reused} disponibles · ${deferred.count} en pausa por límite del servidor`
          : `${reused} archivos reutilizados · Nada pendiente`;
      ctx.logger.phaseSkipped(phase, message);
      return;
    }
  }
  ctx.logger.phaseStarted(phase, jobs.length);
  if (reused > 0) ctx.logger.info(`${reused} archivos reutilizados · ${jobs.length} por descargar`);

  const sem = new AdaptiveSemaphore(() => ctx.aimd.concurrency);
  let idx = 0;
  let completedJobs = 0;
  let rateLimitCircuitOpen = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      await sem.acquire();
      const job = jobs[idx];
      if (!job) {
        sem.release();
        break;
      }
      idx += 1;

      try {
        if (rateLimitCircuitOpen) {
          ctx.queue.deferFile(
            ctx.runId,
            job.docUuid,
            kind,
            Math.max(Date.now() + 30_000, ctx.pacer.cooldownUntil),
            "Diferido porque el límite del servidor pausó la fase de descargas",
          );
          ctx.stats.filesDeferred++;
          continue;
        }
        if (!job.fileUuid) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "missing");
          continue;
        }
        ctx.queue.incrementAttempts(ctx.runId, job.docUuid, kind);
        const outcome = await ctx.downloader.download(job.fileUuid, kind, job.nroexp);
        if (outcome.ok) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "done", outcome.path);
          if (kind === "pdf") ctx.stats.pdfsDone++;
          else ctx.stats.wordsDone++;
          ctx.stats.filesDownloadedNow++;
        } else if (outcome.missing) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "missing");
        } else {
          if (outcome.error?.includes("HTTP 429")) {
            rateLimitCircuitOpen = true;
            ctx.queue.deferFile(
              ctx.runId,
              job.docUuid,
              kind,
              Math.max(Date.now() + 30_000, ctx.pacer.cooldownUntil),
              outcome.error,
            );
            ctx.stats.filesDeferred++;
          } else {
            ctx.queue.markFile(ctx.runId, job.docUuid, kind, "failed", undefined, outcome.error);
            ctx.stats.filesFailed++;
            ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${outcome.error}`);
          }
        }
      } catch (err) {
        ctx.queue.markFile(ctx.runId, job.docUuid, kind, "failed", undefined, errorMessage(err));
        ctx.stats.filesFailed++;
        ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${errorMessage(err)}`);
      } finally {
        completedJobs += 1;
        ctx.logger.progress(completedJobs, jobs.length);
        sem.release();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(ctx.aimd.maxConcurrency, jobs.length) }, worker));
  ctx.queue.failExhaustedFiles(ctx.runId, kind, maxArtifactAttempts);
}

/** Fase 3: export final JSONL/CSV + manifest de fallidos. */
function exportPhase(ctx: Context): void {
  ctx.logger.phaseStarted("Export");
  const records = function* () {
    for (const { row, metadata } of ctx.queue.iterateRowsForOutput(ctx.runId)) {
      yield toOutputRecord(row, metadata);
    }
  };

  const recordCount = ctx.output.write(records());
  ctx.logger.info(`${recordCount} registros exportados`);

  const unresolvedPath = ctx.workspace.unresolvedPath;
  const failures = function* () {
    for (const row of ctx.queue.iterateFailedRows(ctx.runId)) {
      yield {
        uuid: row.uuid,
        page: row.page,
        detail_status: row.detail_status,
        pdf_status: row.pdf_status,
        word_status: row.word_status,
        detail_error: row.detail_error,
        pdf_error: row.pdf_error,
        word_error: row.word_error,
      };
    }
  };
  const unresolvedCount = ctx.output.writeFailures(failures(), unresolvedPath);
  ctx.workspace.removeLegacyFailedManifest();
  if (unresolvedCount > 0) {
    ctx.logger.warn(`${unresolvedCount} documentos sin resolver registrados en unresolved.jsonl`);
  }
}

export function toOutputRecord(row: DocRow, metadata: Record<string, unknown>) {
  const card = (metadata.card ?? {}) as Record<string, string>;
  const detail = (metadata.detail ?? {}) as Record<string, unknown>;
  return toFlatRecord({
    uuid: row.uuid,
    recurso: String(card.recurso ?? ""),
    nroexp: String(card.nroexp ?? ""),
    card,
    detail: detail as never,
    query: row.query,
    page: row.page,
    rowIndex: row.row_index,
    pdfPath: row.pdf_path ?? "",
    wordPath: row.word_path ?? "",
    scrapedAt: row.detail_scraped_at ?? "",
  });
}

async function runScraper(parsedOptions: CliOptions): Promise<number> {
  const workspace = ScraperWorkspace.open(parsedOptions.out);
  const opts: CliOptions = { ...parsedOptions, out: workspace.root };
  const logger = new RunReporter({ quiet: opts.quiet });

  const filters: SearchFilters = normalizeRunScope({
    query: opts.query,
    corte: opts.corte,
    especialidad: opts.especialidad,
    anio: opts.anio,
  });

  if (opts.fresh) {
    workspace.reset();
    logger.info(`--fresh: artefactos previos eliminados (${workspace.root})`);
  }

  const aimd = new AimdController({ initialConcurrency: opts.concurrency });
  const pacer = new HostPacer(opts.minDelay);
  let observeRequest = (_observation: RequestObservation): void => {
    // Replaced before any network operation starts.
  };
  const workers = Array.from(
    { length: opts.sessions },
    () =>
      new SessionWorker({
        minDelayMs: opts.minDelay,
        pacer,
        onRequest: (observation) => observeRequest(observation),
      }),
  );
  const downloadHttp = new HttpClient({
    cookie: () => "",
    minDelayMs: opts.minDelay,
    aimd,
    pacer,
    backoff: { maxAttempts: 2 },
    onRequest: (observation) => observeRequest(observation),
  });

  const queue = new JobQueue(workspace.databasePath);
  const ctx: Context = {
    opts,
    filters,
    logger,
    aimd,
    pacer,
    queue,
    runId: queue.getOrCreateRun(filters),
    workspace,
    workers,
    downloader: new Downloader(downloadHttp, opts.out),
    output: new OutputWriter(opts.out),
    stats: {
      pagesDone: 0,
      pagesFailed: 0,
      docsTotal: 0,
      detailDone: 0,
      detailFailed: 0,
      pdfsDone: 0,
      wordsDone: 0,
      filesFailed: 0,
      filesDeferred: 0,
      requestedArtifacts: 0,
      filesDownloadedNow: 0,
      filesReused: 0,
      httpAttempts: 0,
      retries: 0,
      rateLimited: 0,
      startedAt: Date.now(),
    },
  };
  observeRequest = (observation): void => {
    ctx.stats.httpAttempts++;
    if (observation.retry) ctx.stats.retries++;
    if (observation.status === 429) ctx.stats.rateLimited++;
    logger.requestObserved(observation.status, observation.retry, pacer.cooldownUntil);
  };

  let queueClosed = false;
  const closeQueue = (): void => {
    if (!queueClosed) {
      queueClosed = true;
      ctx.queue.close();
    }
  };

  // Ctrl+C: resumen parcial + estado ya persistido (la cola hace resume).
  const onSigint = (): void => {
    logger.warn("Interrupción (Ctrl+C) — el estado queda guardado; reintenta al volver a correr");
    try {
      ctx.stats.docsTotal = ctx.queue.countDocs(ctx.runId);
      logger.finish("ABORTED", ctx.stats, displayPath(ctx.workspace.root));
    } catch {
      /* la DB puede estar a media escritura */
    }
    closeQueue();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    await crawlPhase(ctx);
    const requestedKinds = requestedFileKinds(opts.word);
    for (const kind of requestedKinds) await downloadPhase(ctx, kind);
    exportPhase(ctx);

    // Recomputar desde la cola: fuente de verdad, no contadores volátiles.
    ctx.stats.docsTotal = ctx.queue.countDocs(ctx.runId);
    ctx.stats.detailDone = ctx.queue.countDetails(ctx.runId, "done");
    ctx.stats.detailFailed = ctx.queue.countDetails(ctx.runId, "failed");
    ctx.stats.pdfsDone = ctx.queue.countFiles(ctx.runId, "pdf", "done");
    ctx.stats.wordsDone = ctx.queue.countFiles(ctx.runId, "word", "done");
    const artifacts = ctx.queue.artifactMetrics(ctx.runId, requestedKinds, opts.maxFiles);
    ctx.stats.requestedArtifacts = artifacts.requested;
    ctx.stats.filesFailed = artifacts.failed;
    ctx.stats.filesDeferred = artifacts.deferred;
    ctx.stats.pagesDone = ctx.queue.countPages(ctx.runId, "done");
    ctx.stats.pagesFailed = ctx.queue.countPages(ctx.runId, "failed");
    const failures = ctx.stats.pagesFailed + ctx.stats.detailFailed + artifacts.failed;
    const state = terminalState({ aborted: false, failures, deferred: artifacts.deferred });
    logger.finish(state, ctx.stats, displayPath(ctx.workspace.root));
    return failures + artifacts.deferred;
  } finally {
    closeQueue();
    process.off("SIGINT", onSigint);
  }
}

function displayPath(path: string): string {
  const local = relative(process.cwd(), path);
  return local === "" ? "." : local.startsWith("..") ? path : local;
}

export type ExitCode = 0 | 1 | 2;
export type ScraperRunner = (options: CliOptions) => Promise<number>;

export async function main(
  argv: string[] = process.argv,
  runner: ScraperRunner = runScraper,
): Promise<ExitCode> {
  try {
    const failures = await runner(parseCli(argv));
    return failures > 0 ? 1 : 0;
  } catch (error) {
    new RunReporter().error(`Corrida abortada: ${errorMessage(error)}`);
    return 2;
  }
}

if (require.main === module) {
  void main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
