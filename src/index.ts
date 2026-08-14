import { writeFileSync } from "node:fs";
import { parseCli } from "./cli";
import { type CliOptions, normalizeRunScope, type SearchFilters } from "./config";
import { Downloader, type FileKind } from "./download";
import { HttpClient } from "./http/client";
import { Logger, type RunStats } from "./logger";
import { OutputWriter, toFlatRecord } from "./output";
import { JobQueue } from "./queue";
import { AdaptiveSemaphore, AimdController, crossRunDelay, HostPacer } from "./ratelimit";
import { processPageIsolated, SessionWorker } from "./session-worker";
import { ScraperWorkspace } from "./workspace";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Context {
  opts: CliOptions;
  filters: SearchFilters;
  logger: Logger;
  aimd: AimdController;
  queue: JobQueue;
  runId: number;
  workspace: ScraperWorkspace;
  workers: SessionWorker[];
  downloader: Downloader;
  output: OutputWriter;
  stats: RunStats;
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
    logger.progress(`pág ${page} | docs ${stats.detailDone} | fallos ${stats.detailFailed}`);
  }
}

/**
 * Fase 1: reparte las páginas entre las N sesiones y extrae card + ficha.
 * Cada sesión paginación e ViewState propios → paralelo sin pisarse.
 */
async function crawlPhase(ctx: Context): Promise<void> {
  const { opts, filters, logger, workers } = ctx;

  const primary = workers[0]!;
  logger.info(`Búsqueda: "${filters.query}" (corte=${filters.corte})`);
  const pageData = await primary.ensureSearched(filters);
  if (pageData.lastPage === 0 || pageData.cards.length === 0) {
    throw new Error(
      "La búsqueda no devolvió resultados (¿formulario incompleto? Ver docs/spec.md §2)",
    );
  }
  logger.info(
    `Total: ${pageData.totalResults.toLocaleString("en")} resultados | ${pageData.lastPage.toLocaleString("en")} páginas`,
  );

  const lastPage = opts.pages > 0 ? Math.min(pageData.lastPage, opts.pages) : pageData.lastPage;

  const pendingPages = ctx.queue.pendingPages(ctx.runId, lastPage);
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
  let jobs = ctx.queue.pendingDownloads(ctx.runId, kind);
  if (ctx.opts.maxFiles > 0) {
    const done = ctx.queue.countFiles(ctx.runId, kind, "done");
    jobs = jobs.slice(0, Math.max(0, ctx.opts.maxFiles - done));
  }
  if (jobs.length === 0) return;

  ctx.logger.info(`Descargando ${jobs.length} archivos ${kind.toUpperCase()}...`);

  const sem = new AdaptiveSemaphore(() => ctx.aimd.concurrency);
  let idx = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      await sem.acquire();
      const job = jobs[idx];
      if (!job) {
        sem.release();
        break;
      }
      idx += 1;

      if (job.attempts > 0) await sleep(crossRunDelay(job.attempts));

      try {
        if (!job.fileUuid) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "missing");
          continue;
        }
        const outcome = await ctx.downloader.download(job.fileUuid, kind, job.nroexp);
        if (outcome.ok) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "done", outcome.path);
          if (kind === "pdf") ctx.stats.pdfsDone++;
          else ctx.stats.wordsDone++;
        } else if (outcome.missing) {
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "missing");
        } else {
          ctx.queue.incrementAttempts(ctx.runId, job.docUuid, kind);
          ctx.queue.markFile(ctx.runId, job.docUuid, kind, "failed", undefined, outcome.error);
          ctx.stats.filesFailed++;
          ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${outcome.error}`);
        }
      } catch (err) {
        ctx.queue.incrementAttempts(ctx.runId, job.docUuid, kind);
        ctx.queue.markFile(ctx.runId, job.docUuid, kind, "failed", undefined, errorMessage(err));
        ctx.stats.filesFailed++;
        ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${errorMessage(err)}`);
      } finally {
        sem.release();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(ctx.aimd.maxConcurrency, jobs.length) }, worker));
}

/** Fase 3: export final JSONL/CSV + manifest de fallidos. */
function exportPhase(ctx: Context): void {
  const records = ctx.queue.rowsForOutput(ctx.runId).map(({ row, metadata }) => {
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
      scrapedAt: new Date().toISOString(),
    });
  });

  ctx.logger.info(
    `Escribiendo ${records.length} registros a ${ctx.output.jsonlPath} y ${ctx.output.csvPath}`,
  );
  ctx.output.writeJsonl(records);
  ctx.output.writeCsv(records);

  const failed = ctx.queue.failedRows(ctx.runId);
  const failedPath = ctx.workspace.failedPath;
  writeFileSync(
    failedPath,
    failed.length > 0
      ? failed
          .map((row) =>
            JSON.stringify({
              uuid: row.uuid,
              page: row.page,
              detail_status: row.detail_status,
              pdf_status: row.pdf_status,
              word_status: row.word_status,
              detail_error: row.detail_error,
              pdf_error: row.pdf_error,
              word_error: row.word_error,
            }),
          )
          .join("\n") + "\n"
      : "",
  );
  if (failed.length > 0) {
    ctx.logger.warn(`${failed.length} documentos con fallos → ${failedPath}`);
  }
}

async function main(): Promise<void> {
  const parsedOptions = parseCli(process.argv);
  const workspace = ScraperWorkspace.open(parsedOptions.out);
  const opts: CliOptions = { ...parsedOptions, out: workspace.root };
  const logger = new Logger();
  logger.setSilent(opts.quiet);

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
  const workers = Array.from(
    { length: opts.sessions },
    () => new SessionWorker({ minDelayMs: opts.minDelay, pacer }),
  );
  const downloadHttp = new HttpClient({
    cookie: () => "",
    minDelayMs: opts.minDelay,
    aimd,
    pacer,
  });

  const queue = new JobQueue(workspace.databasePath);
  const ctx: Context = {
    opts,
    filters,
    logger,
    aimd,
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
      startedAt: Date.now(),
    },
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
      logger.summarize(ctx.stats, { query: filters.query, concurrency: aimd.concurrency });
    } catch {
      /* la DB puede estar a media escritura */
    }
    closeQueue();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    await crawlPhase(ctx);
    await downloadPhase(ctx, "pdf");
    await downloadPhase(ctx, "word");
    exportPhase(ctx);

    // Recomputar desde la cola: fuente de verdad, no contadores volátiles.
    ctx.stats.docsTotal = ctx.queue.countDocs(ctx.runId);
    ctx.stats.detailDone = ctx.queue.countDetails(ctx.runId, "done");
    ctx.stats.detailFailed = ctx.queue.countDetails(ctx.runId, "failed");
    ctx.stats.pdfsDone = ctx.queue.countFiles(ctx.runId, "pdf", "done");
    ctx.stats.wordsDone = ctx.queue.countFiles(ctx.runId, "word", "done");
    ctx.stats.filesFailed = ctx.queue.countFailed(ctx.runId);
    ctx.stats.pagesDone = ctx.queue.countPages(ctx.runId, "done");
    ctx.stats.pagesFailed = ctx.queue.countPages(ctx.runId, "failed");
    logger.summarize(ctx.stats, { query: filters.query, concurrency: aimd.concurrency });
  } catch (err) {
    logger.error(`Corrida abortada: ${errorMessage(err)}`);
    process.exitCode = 1;
  } finally {
    closeQueue();
    process.off("SIGINT", onSigint);
  }
}

void main();
