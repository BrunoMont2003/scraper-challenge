import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunReporter, terminalState } from "../src/reporter";

function capture(tty: boolean) {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { reporter: new RunReporter({ stream, tty, now: () => 10_000 }), output: () => output };
}

describe("RunReporter", () => {
  afterEach(() => vi.useRealTimers());

  it("does not draw a fake empty phase before work starts", () => {
    const view = capture(true);
    view.reporter.info("Preparando espacio de trabajo");
    expect(view.output()).not.toContain("Trabajando");
    expect(view.output()).not.toContain("0 de 0");
  });

  it("explains skipped work without rendering a zero-sized progress bar", () => {
    const view = capture(true);
    view.reporter.phaseStarted("Search", 1);
    view.reporter.phaseSkipped("Details", "30 detalles reutilizados · Nada pendiente");
    const output = view.output();
    expect(output).toContain("30 detalles reutilizados · Nada pendiente");
    expect(output).not.toContain("Detalles 0 de 0");
  });

  it("shows a live human-readable countdown for deferred work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
    const reporter = new RunReporter({ stream, tty: true, now: () => Date.now() });
    reporter.phaseWaiting("PDFs", 10, 30_000);
    expect(output).toContain("10 archivos en pausa");
    expect(output).toContain("Reintento automático en 20 s");
    vi.advanceTimersByTime(5_000);
    expect(output).toContain("Reintento automático en 15 s");
    reporter.phaseSkipped("PDFs", "espera terminada");
  });

  it("emits stable ANSI-free milestones outside a TTY and bounds repeated 429 notices", () => {
    const view = capture(false);
    view.reporter.phaseStarted("PDFs", 10);
    for (let index = 0; index < 8; index++) view.reporter.requestObserved(429, true, 12_000);
    view.reporter.progress(3);
    const output = view.output();
    expect(output).toContain("Descargando documentos PDF · 0 de 10 PDFs");
    expect(output).toContain("Progreso: 3 de 10 PDFs");
    expect(output.match(/reducir el ritmo/g)).toHaveLength(1);
    expect(output).not.toContain(String.fromCharCode(27));
  });

  it("renders a legible Spanish dashboard without unexplained abbreviations", () => {
    let now = 1_000;
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
    const reporter = new RunReporter({ stream, tty: true, now: () => now });
    reporter.phaseStarted("PDFs", 4);
    now = 3_000;
    reporter.requestObserved(429, false, 5_000);
    reporter.progress(2);
    expect(output).toContain("Descargando documentos PDF");
    expect(output).toContain("2 de 4 PDFs");
    expect(output).toContain("1.0 por segundo");
    expect(output).toContain("Tiempo restante: 2 s");
    expect(output).toContain("Pausa del servidor: 2 s");
    expect(output).not.toContain("ETA");
    expect(output).toContain("\r\x1b[2K");
  });

  it("keeps redrawing while a long operation has no network feedback", () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
    const reporter = new RunReporter({ stream, tty: true, now: () => Date.now() });
    reporter.phaseStarted("PDFs", 10);
    const before = output.length;
    vi.advanceTimersByTime(2_100);
    expect(output.length).toBeGreaterThan(before);
    expect(output).toContain("Trabajando");
    reporter.finish(
      "COMPLETED",
      {
        pagesDone: 1,
        pagesFailed: 0,
        docsTotal: 1,
        detailDone: 1,
        detailFailed: 0,
        pdfsDone: 1,
        wordsDone: 0,
        filesFailed: 0,
        filesDeferred: 0,
        requestedArtifacts: 1,
        filesDownloadedNow: 1,
        filesReused: 0,
        httpAttempts: 1,
        retries: 0,
        rateLimited: 0,
        startedAt: 0,
      },
      "data/results",
    );
    const finishedAt = output.length;
    vi.advanceTimersByTime(2_000);
    expect(output).toHaveLength(finishedAt);
  });

  it("prints the result directory once and separates reused files from new downloads", () => {
    const view = capture(false);
    view.reporter.finish(
      "COMPLETED",
      {
        pagesDone: 3,
        pagesFailed: 0,
        docsTotal: 30,
        detailDone: 30,
        detailFailed: 0,
        pdfsDone: 30,
        wordsDone: 0,
        filesFailed: 0,
        filesDeferred: 0,
        requestedArtifacts: 30,
        filesDownloadedNow: 10,
        filesReused: 20,
        httpAttempts: 13,
        retries: 0,
        rateLimited: 0,
        startedAt: 10_000,
      },
      "data/penal",
    );
    const output = view.output();
    expect(output).toContain("descargados ahora     10");
    expect(output).toContain("reutilizados          20");
    expect(output.match(/data\/penal/g)).toHaveLength(1);
    expect(output).not.toContain("failed.jsonl");
  });

  it("keeps search indeterminate and names every determinate progress unit", () => {
    const view = capture(true);
    view.reporter.phaseStarted("Search");
    expect(view.output()).toContain("Consultando el sitio");
    expect(view.output()).not.toMatch(/0 de 0|1 de 1/);

    view.reporter.phaseStarted("Details", 3);
    view.reporter.progress(2);
    expect(view.output()).toContain("Procesando páginas");
    expect(view.output()).toContain("2 de 3 páginas");
  });

  it("explains a partial result and gives a truthful recovery action", () => {
    const view = capture(false);
    view.reporter.finish(
      "COMPLETED WITH FAILURES",
      {
        pagesDone: 3,
        pagesFailed: 0,
        docsTotal: 30,
        detailDone: 30,
        detailFailed: 0,
        pdfsDone: 20,
        wordsDone: 0,
        filesFailed: 0,
        filesDeferred: 10,
        requestedArtifacts: 30,
        filesDownloadedNow: 20,
        filesReused: 0,
        httpAttempts: 67,
        retries: 8,
        rateLimited: 12,
        startedAt: 0,
      },
      "data/penal",
    );
    const output = view.output();
    expect(output).toContain("Completado parcialmente");
    expect(output).toContain("Archivos disponibles      20 / 30");
    expect(output).toContain("Servidor: pidió reducir el ritmo 12 veces");
    expect(output).toContain("Detalle                    unresolved.jsonl");
    expect(output).toContain("reintentar 10 archivos pendientes");
  });

  it("renders only the three truthful terminal states", () => {
    expect(terminalState({ aborted: false, failures: 0, deferred: 0 })).toBe("COMPLETED");
    expect(terminalState({ aborted: false, failures: 1, deferred: 0 })).toBe(
      "COMPLETED WITH FAILURES",
    );
    expect(terminalState({ aborted: true, failures: 0, deferred: 0 })).toBe("ABORTED");
  });
});
