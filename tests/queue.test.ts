import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type CardRecord, EMPTY_DETAIL, normalizeRunScope, type RunScope } from "../src/config";
import { SiteSession } from "../src/http/session";
import { JobQueue } from "../src/queue";

const DEFAULT_SCOPE: RunScope = normalizeRunScope({
  query: " penal ",
  corte: "1",
  especialidad: "",
  anio: "",
});

function makeCard(uuid: string, rowIndex = 0): CardRecord {
  return {
    uuid,
    recurso: "Apelación",
    nroexp: `0000${rowIndex}-2026`,
    palabras: "",
    pretensiones: "Acción de Amparo",
    normaDI: "",
    tipoResolucion: "Ejecutoria Suprema",
    fechaResolucion: "03/08/2026",
    sala: "Sala Penal",
    sumilla: "test",
    rowIndex,
  };
}

describe("JobQueue (in-memory)", () => {
  it("dedupe por uuid: insertCard devuelve false la segunda vez", () => {
    const q = new JobQueue(":memory:");
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    expect(q.insertCard(runId, 1, makeCard("uuid-1"))).toBe(true);
    expect(q.insertCard(runId, 2, makeCard("uuid-1"))).toBe(false);
    expect(q.countDocs(runId)).toBe(1);
    q.close();
  });

  it("self-heal: in_progress se resetea a pending al reabrir", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-queue-"));
    const dbPath = join(directory, "scraper.sqlite");
    const q = new JobQueue(dbPath);
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    q.markPage(runId, 1, "in_progress");
    q.close();
    const q2 = new JobQueue(dbPath);
    const resumedRunId = q2.getOrCreateRun(DEFAULT_SCOPE);
    expect(q2.isPageDone(resumedRunId, 1)).toBe(false);
    q2.close();
  });

  it("isPageDone reconoce páginas completadas", () => {
    const q = new JobQueue(":memory:");
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    q.markPage(runId, 1, "done");
    expect(q.isPageDone(runId, 1)).toBe(true);
    expect(q.isPageDone(runId, 2)).toBe(false);
    q.close();
  });

  it("setDetail guarda metadata y pendingDownloads lista solo pendientes", () => {
    const q = new JobQueue(":memory:");
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    q.insertCard(runId, 1, makeCard("uuid-1", 0));
    const detail = { ...EMPTY_DETAIL, uuidPdf: "pdf-uuid-1", uuidWord: "word-uuid-1" };
    q.setDetail(runId, "uuid-1", detail);

    const pdfJobs = q.pendingDownloads(runId, "pdf");
    expect(pdfJobs).toHaveLength(1);
    expect(pdfJobs[0]!.fileUuid).toBe("pdf-uuid-1");
    expect(pdfJobs[0]!.nroexp).toBe("00000-2026");

    q.markFile(runId, "uuid-1", "pdf", "done", "data/pdfs/x.pdf");
    expect(q.pendingDownloads(runId, "pdf")).toHaveLength(0);
    q.close();
  });

  it("doc sin uuid de archivo queda como missing al marcar", () => {
    const q = new JobQueue(":memory:");
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    q.insertCard(runId, 1, makeCard("uuid-2"));
    q.setDetail(runId, "uuid-2", { ...EMPTY_DETAIL });
    const jobs = q.pendingDownloads(runId, "word");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.fileUuid).toBe("");
    q.close();
  });

  it("isolates state by query, court, specialty, and year", () => {
    const q = new JobQueue(":memory:");
    const scopes = [
      DEFAULT_SCOPE,
      normalizeRunScope({ ...DEFAULT_SCOPE, corte: "2" }),
      normalizeRunScope({ ...DEFAULT_SCOPE, especialidad: "penal" }),
      normalizeRunScope({ ...DEFAULT_SCOPE, anio: "2025" }),
      normalizeRunScope({ ...DEFAULT_SCOPE, query: "civil" }),
    ];
    const runIds = scopes.map((scope) => q.getOrCreateRun(scope));
    for (const [index, runId] of runIds.entries()) {
      q.insertCard(runId, 1, makeCard("shared-uuid", index));
    }

    expect(new Set(runIds).size).toBe(5);
    for (const runId of runIds) expect(q.countDocs(runId)).toBe(1);
    expect(q.getDoc(runIds[0]!, "shared-uuid")?.row_index).toBe(0);
    expect(q.getDoc(runIds[4]!, "shared-uuid")?.row_index).toBe(4);
    q.close();
  });

  it("resumes the same normalized scope without refreshing completed pages", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-resume-"));
    const dbPath = join(directory, "scraper.sqlite");
    const first = new JobQueue(dbPath);
    const runId = first.getOrCreateRun(DEFAULT_SCOPE);
    first.markPage(runId, 1, "done");
    const completedAt = first.getPage(runId, 1)?.scraped_at;
    first.close();

    const resumed = new JobQueue(dbPath);
    const resumedRunId = resumed.getOrCreateRun(
      normalizeRunScope({ ...DEFAULT_SCOPE, query: "  penal  " }),
    );
    expect(resumedRunId).toBe(runId);
    expect(resumed.pendingPages(resumedRunId, 2)).toEqual([2]);
    expect(resumed.getPage(resumedRunId, 1)?.scraped_at).toBe(completedAt);
    resumed.close();
  });

  it("tracks detail, PDF, and Word attempts and errors independently", () => {
    const q = new JobQueue(":memory:");
    const runId = q.getOrCreateRun(DEFAULT_SCOPE);
    q.insertCard(runId, 1, makeCard("uuid-operations"));
    q.incrementAttempts(runId, "uuid-operations", "detail");
    q.markDetail(runId, "uuid-operations", "failed", "detail error");
    q.incrementAttempts(runId, "uuid-operations", "pdf");
    q.incrementAttempts(runId, "uuid-operations", "pdf");
    q.markFile(runId, "uuid-operations", "pdf", "failed", undefined, "pdf error");

    const failed = q.getDoc(runId, "uuid-operations")!;
    expect(failed.detail_attempts).toBe(1);
    expect(failed.pdf_attempts).toBe(2);
    expect(failed.word_attempts).toBe(0);
    expect(failed.detail_error).toBe("detail error");
    expect(failed.pdf_error).toBe("pdf error");
    expect(failed.word_error).toBeNull();

    q.setDetail(runId, "uuid-operations", { ...EMPTY_DETAIL, uuidPdf: "pdf-id" });
    const scrapedAt = q.getDoc(runId, "uuid-operations")!.detail_scraped_at;
    q.markFile(runId, "uuid-operations", "pdf", "done", "pdfs/file.pdf");
    const completed = q.getDoc(runId, "uuid-operations")!;
    expect(completed.detail_scraped_at).toBe(scrapedAt);
    expect(completed.detail_error).toBeNull();
    expect(completed.pdf_error).toBeNull();
    expect(completed.word_attempts).toBe(0);
    q.close();
  });

  it("rejects incompatible persisted schemas with --fresh guidance", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-old-schema-"));
    const dbPath = join(directory, "scraper.sqlite");
    const old = new Database(dbPath);
    old.exec("CREATE TABLE pages (query TEXT NOT NULL, page INTEGER NOT NULL)");
    old.close();

    expect(() => new JobQueue(dbPath)).toThrow(/incompatible.*--fresh/i);
  });
});

describe("SiteSession.isViewExpired", () => {
  it("detecta ViewExpiredException en body", () => {
    expect(
      SiteSession.isViewExpired(
        "<partial-response><error><error-name>class javax.faces.application.ViewExpiredException</error-name></error></partial-response>",
      ),
    ).toBe(true);
  });

  it("no marca páginas normales", () => {
    expect(SiteSession.isViewExpired("<html><body>resultados</body></html>")).toBe(false);
  });
});
