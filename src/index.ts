import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { CliOptions, SearchFilters } from "./config";
import { parseCli } from "./cli";
import { DetailClient } from "./detail";
import { Downloader, type FileKind } from "./download";
import { HttpClient } from "./http/client";
import { SiteSession } from "./http/session";
import { Logger, type RunStats } from "./logger";
import { OutputWriter, toFlatRecord } from "./output";
import { Paginator } from "./paginate";
import { JobQueue, defaultDbPath } from "./queue";
import { AimdController } from "./ratelimit";
import { SearchClient } from "./search";

const MAX_RECOVERIES_PER_PAGE = 3;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isViewExpired(err: unknown): boolean {
  return err instanceof Error && /ViewExpired/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Context {
  opts: CliOptions;
  filters: SearchFilters;
  logger: Logger;
  aimd: AimdController;
  session: SiteSession;
  queue: JobQueue;
  searchClient: SearchClient;
  paginator: Paginator;
  detailClient: DetailClient;
  downloader: Downloader;
  output: OutputWriter;
  stats: RunStats;
}

async function recoverToPage(ctx: Context, page: number) {
  ctx.logger.warn("Sesión/ViewState expirado — nueva sesión y re-búsqueda...");
  await ctx.session.login();
  await ctx.searchClient.search(ctx.filters);
  return ctx.paginator.goToPage(ctx.filters, page);
}

/** Fase 1: paginar + extraer card + ficha detallada de cada documento. */
async function crawlPhase(ctx: Context): Promise<void> {
  const { opts, filters, logger } = ctx;

  logger.info(`Búsqueda: "${filters.query}" (corte=${filters.corte})`);
  const pageData = await ctx.searchClient.search(filters);
  if (pageData.lastPage === 0 || pageData.cards.length === 0) {
    throw new Error(
      "La búsqueda no devolvió resultados (¿formulario incompleto? Ver docs/spec.md §2)",
    );
  }
  logger.info(
    `Total: ${pageData.totalResults.toLocaleString("en")} resultados | ${pageData.lastPage.toLocaleString("en")} páginas`,
  );

  const lastPage = opts.pages > 0 ? Math.min(pageData.lastPage, opts.pages) : pageData.lastPage;

  for (let page = 1; page <= lastPage; page++) {
    if (opts.resume && ctx.queue.isPageDone(filters.query, page)) {
      continue;
    }

    // Página 1 viene de la búsqueda; las demás del paginador.
    let current = page === 1 ? pageData : await ctx.paginator.goToPage(filters, page);
    let recoveries = 0;
    ctx.queue.markPage(filters.query, page, "in_progress");

    for (let i = 0; i < current.cards.length; i++) {
      const card = current.cards[i]!;
      ctx.queue.insertCard(filters.query, page, card);
      const existing = ctx.queue.getDoc(card.uuid);
      if (opts.resume && existing?.detail_status === "done") continue;

      try {
        const detail = await ctx.detailClient.fetchDetail(filters, page, card);
        ctx.queue.setDetail(card.uuid, detail);
        ctx.stats.detailDone++;
      } catch (err) {
        if (isViewExpired(err) && recoveries < MAX_RECOVERIES_PER_PAGE) {
          recoveries++;
          current = await recoverToPage(ctx, page);
          i--; // reintentar esta fila con la página re-cargada
          continue;
        }
        ctx.queue.markDetail(card.uuid, "failed", errorMessage(err));
        ctx.stats.detailFailed++;
        logger.warn(`detalle fallido ${card.nroexp}: ${errorMessage(err)}`);
      }
    }

    ctx.queue.markPage(filters.query, page, "done");
    ctx.stats.pagesDone++;
    logger.progress(
      `pág ${page}/${lastPage} | docs ${ctx.stats.detailDone} | fallos ${ctx.stats.detailFailed}`,
    );
  }
  logger.progressEnd();
}

/** Fase 2: descargar PDF/Word pendientes con pool de concurrencia AIMD. */
async function downloadPhase(ctx: Context, kind: FileKind): Promise<void> {
  let jobs = ctx.queue.pendingDownloads(kind);
  if (ctx.opts.maxFiles > 0) {
    const doneTotal = ctx.queue.countFileDone("pdf") + ctx.queue.countFileDone("word");
    const remaining = Math.max(0, ctx.opts.maxFiles - doneTotal);
    jobs = jobs.slice(0, remaining);
  }
  if (jobs.length === 0) return;

  ctx.logger.info(`Descargando ${jobs.length} archivos ${kind.toUpperCase()}...`);

  let idx = 0;
  let active = 0;
  const workerCount = Math.min(ctx.aimd.concurrency, jobs.length);

  const gate = async (): Promise<void> => {
    while (active >= ctx.aimd.concurrency) await sleep(200);
    active++;
  };
  const release = (): void => {
    active--;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      await gate();
      const job = jobs[idx];
      if (!job) {
        release();
        break;
      }
      idx += 1;
      try {
        if (!job.fileUuid) {
          ctx.queue.markFile(job.docUuid, kind, "missing");
          release();
          continue;
        }
        const outcome = await ctx.downloader.download(job.fileUuid, kind, job.nroexp);
        if (outcome.ok) {
          ctx.queue.markFile(job.docUuid, kind, "done", outcome.path);
          if (kind === "pdf") ctx.stats.pdfsDone++;
          else ctx.stats.wordsDone++;
        } else if (outcome.missing) {
          ctx.queue.markFile(job.docUuid, kind, "missing");
        } else {
          ctx.queue.markFile(job.docUuid, kind, "failed", undefined, outcome.error);
          ctx.stats.filesFailed++;
          ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${outcome.error}`);
        }
      } catch (err) {
        ctx.queue.markFile(job.docUuid, kind, "failed", undefined, errorMessage(err));
        ctx.stats.filesFailed++;
        ctx.logger.warn(`${kind} fallido ${job.nroexp}: ${errorMessage(err)}`);
      } finally {
        release();
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
}

/** Fase 3: export final JSONL/CSV + manifest de fallidos. */
function exportPhase(ctx: Context): void {
  const records = ctx.queue.rowsForOutput().map(({ row, metadata }) => {
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

  ctx.logger.info(`Escribiendo ${records.length} registros a ${ctx.output.jsonlPath} y ${ctx.output.csvPath}`);
  ctx.output.writeJsonl(records);
  ctx.output.writeCsv(records);

  const failed = ctx.queue.failedRows();
  if (failed.length > 0) {
    const failedPath = join(ctx.opts.out, "failed.jsonl");
    appendFileSync(
      failedPath,
      failed
        .map((row) =>
          JSON.stringify({
            uuid: row.uuid,
            page: row.page,
            detail_status: row.detail_status,
            pdf_status: row.pdf_status,
            word_status: row.word_status,
            last_error: row.last_error,
          }),
        )
        .join("\n") + "\n",
    );
    ctx.logger.warn(`${failed.length} documentos con fallos → ${failedPath}`);
  }
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const logger = new Logger();
  logger.setSilent(opts.quiet);

  const filters: SearchFilters = {
    query: opts.query,
    corte: opts.corte,
    especialidad: opts.especialidad,
    anio: opts.anio,
  };

  const aimd = new AimdController({ initialConcurrency: opts.concurrency });
  const cookieHolder = { value: "" };
  const http = new HttpClient({
    cookie: () => cookieHolder.value,
    minDelayMs: opts.minDelay,
    aimd,
  });
  const session = new SiteSession(http, cookieHolder);

  const ctx: Context = {
    opts,
    filters,
    logger,
    aimd,
    session,
    queue: new JobQueue(defaultDbPath(opts.out)),
    searchClient: new SearchClient(http, session),
    paginator: new Paginator(http, session),
    detailClient: new DetailClient(http, session),
    downloader: new Downloader(http, opts.out),
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

  try {
    await crawlPhase(ctx);
    await downloadPhase(ctx, "pdf");
    await downloadPhase(ctx, "word");
    exportPhase(ctx);
    ctx.stats.docsTotal = ctx.queue.countDocs();
    logger.summarize(ctx.stats, { query: filters.query, concurrency: aimd.concurrency });
  } catch (err) {
    logger.error(`Corrida abortada: ${errorMessage(err)}`);
    process.exitCode = 1;
  } finally {
    ctx.queue.close();
  }
}

void main();
