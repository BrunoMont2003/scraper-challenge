import { describe, expect, it } from "vitest";
import { JobQueue } from "../src/queue";
import { EMPTY_DETAIL, type CardRecord } from "../src/config";
import { SiteSession } from "../src/http/session";

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
    expect(q.insertCard("penal", 1, makeCard("uuid-1"))).toBe(true);
    expect(q.insertCard("penal", 2, makeCard("uuid-1"))).toBe(false);
    expect(q.countDocs()).toBe(1);
    q.close();
  });

  it("self-heal: in_progress se resetea a pending al abrir", () => {
    const q = new JobQueue(":memory:");
    q.markPage("penal", 1, "in_progress");
    q.close();
    const q2 = new JobQueue(":memory:");
    expect(q2.isPageDone("penal", 1)).toBe(false);
    q2.close();
  });

  it("isPageDone reconoce páginas completadas", () => {
    const q = new JobQueue(":memory:");
    q.markPage("penal", 1, "done");
    expect(q.isPageDone("penal", 1)).toBe(true);
    expect(q.isPageDone("penal", 2)).toBe(false);
    q.close();
  });

  it("setDetail guarda metadata y pendingDownloads lista solo pendientes", () => {
    const q = new JobQueue(":memory:");
    q.insertCard("penal", 1, makeCard("uuid-1", 0));
    const detail = { ...EMPTY_DETAIL, uuidPdf: "pdf-uuid-1", uuidWord: "word-uuid-1" };
    q.setDetail("uuid-1", detail);

    const pdfJobs = q.pendingDownloads("pdf");
    expect(pdfJobs).toHaveLength(1);
    expect(pdfJobs[0]!.fileUuid).toBe("pdf-uuid-1");
    expect(pdfJobs[0]!.nroexp).toBe("00000-2026");

    q.markFile("uuid-1", "pdf", "done", "data/pdfs/x.pdf");
    expect(q.pendingDownloads("pdf")).toHaveLength(0);
    q.close();
  });

  it("doc sin uuid de archivo queda como missing al marcar", () => {
    const q = new JobQueue(":memory:");
    q.insertCard("penal", 1, makeCard("uuid-2"));
    q.setDetail("uuid-2", { ...EMPTY_DETAIL });
    const jobs = q.pendingDownloads("word");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.fileUuid).toBe("");
    q.close();
  });

  it("counts por query no mezclan otras búsquedas", () => {
    const q = new JobQueue(":memory:");
    q.insertCard("penal", 1, makeCard("p-1", 0));
    q.insertCard("penal", 1, makeCard("p-2", 1));
    q.insertCard("homicidio", 1, makeCard("h-1", 0));
    q.setDetail("p-1", { ...EMPTY_DETAIL, uuidPdf: "pdf-p1" });
    q.setDetail("p-2", { ...EMPTY_DETAIL, uuidPdf: "pdf-p2" });
    q.markFile("p-1", "pdf", "done", "x.pdf");
    q.markFile("p-2", "pdf", "failed");

    expect(q.countDocsForQuery("penal")).toBe(2);
    expect(q.countDocsForQuery("homicidio")).toBe(1);
    expect(q.countDetailDoneForQuery("penal")).toBe(2);
    expect(q.countDetailDoneForQuery("homicidio")).toBe(0);
    expect(q.countFileDoneForQuery("pdf", "penal")).toBe(1);
    expect(q.countFailedForQuery("penal")).toBe(1);
    expect(q.rowsForOutputForQuery("penal")).toHaveLength(2);
    expect(q.failedRowsForQuery("penal")).toHaveLength(1);
    q.close();
  });
});

describe("SiteSession.isViewExpired", () => {
  it("detecta ViewExpiredException en body", () => {
    expect(
      SiteSession.isViewExpired(
        '<partial-response><error><error-name>class javax.faces.application.ViewExpiredException</error-name></error></partial-response>',
      ),
    ).toBe(true);
  });

  it("no marca páginas normales", () => {
    expect(SiteSession.isViewExpired("<html><body>resultados</body></html>")).toBe(false);
  });
});
