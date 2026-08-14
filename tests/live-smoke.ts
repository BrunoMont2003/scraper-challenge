import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRunScope } from "../src/config";
import { Downloader, type FileKind } from "../src/download";
import { OutputWriter, toFlatRecord } from "../src/output";
import { HostPacer } from "../src/ratelimit";
import { SessionWorker } from "../src/session-worker";

const POLITE_DELAY_MS = 1_000;

async function liveSmoke(): Promise<void> {
  const outputDirectory = mkdtempSync(join(tmpdir(), "scraper-live-"));
  try {
    const pacer = new HostPacer(POLITE_DELAY_MS);
    const worker = new SessionWorker({ minDelayMs: POLITE_DELAY_MS, pacer });
    const filters = normalizeRunScope({ query: "", corte: "1", especialidad: "", anio: "" });
    const page = await worker.ensureSearched(filters);
    const card = page.cards[0];
    if (!card) throw new Error("Live search returned no document on page one");

    const detail = await worker.fetchDetailWithRecovery(filters, 1, card, 1);
    let downloadedPath = "";
    const candidate: { uuid: string; kind: FileKind } | undefined = detail.uuidPdf
      ? { uuid: detail.uuidPdf, kind: "pdf" }
      : detail.uuidWord
        ? { uuid: detail.uuidWord, kind: "word" }
        : undefined;
    if (candidate) {
      const outcome = await new Downloader(worker.http, outputDirectory).download(
        candidate.uuid,
        candidate.kind,
        card.nroexp,
      );
      if (!outcome.ok) throw new Error(`Live download failed: ${outcome.error}`);
      downloadedPath = outcome.path ?? "";
    }

    const writer = new OutputWriter(outputDirectory);
    writer.write([
      toFlatRecord({
        uuid: card.uuid,
        recurso: card.recurso,
        nroexp: card.nroexp,
        card,
        detail,
        query: filters.query,
        page: 1,
        rowIndex: card.rowIndex,
        pdfPath: candidate?.kind === "pdf" ? downloadedPath : "",
        wordPath: candidate?.kind === "word" ? downloadedPath : "",
        scrapedAt: new Date().toISOString(),
      }),
    ]);
    process.stdout.write(
      `Live smoke passed: one session, one page, one detail, ${candidate ? "one file" : "no available file"}.\n`,
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

void liveSmoke().catch((error: unknown) => {
  process.stderr.write(
    `Live smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
