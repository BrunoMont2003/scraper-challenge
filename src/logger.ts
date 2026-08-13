/**
 * Logger estructurado mínimo: líneas con timestamp, nivel y mensaje,
 * más un resumen final de la corrida.
 */
export type LogLevel = "info" | "warn" | "error" | "success";

export interface RunStats {
  pagesDone: number;
  pagesFailed: number;
  docsTotal: number;
  detailDone: number;
  detailFailed: number;
  pdfsDone: number;
  wordsDone: number;
  filesFailed: number;
  startedAt: number;
}

export class Logger {
  private silent = false;

  constructor(private readonly prefix = "scraper") {}

  setSilent(value: boolean): void {
    this.silent = value;
  }

  log(level: LogLevel, message: string): void {
    if (this.silent && level !== "error") return;
    const ts = new Date().toISOString().slice(11, 19);
    const tag =
      level === "error"
        ? "ERROR"
        : level === "warn"
          ? "WARN "
          : level === "success"
            ? "OK   "
            : "INFO ";
    process.stdout.write(`[${ts}] [${tag}] [${this.prefix}] ${message}\n`);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  success(message: string): void {
    this.log("success", message);
  }

  /** Línea de progreso que se sobrescribe (sin salto de línea). */
  progress(message: string): void {
    if (this.silent) return;
    process.stdout.write(`\r\x1b[2K${message}`);
  }

  progressEnd(): void {
    if (this.silent) return;
    process.stdout.write("\n");
  }

  summarize(stats: RunStats, extra: { query: string; concurrency: number }): void {
    const elapsed = Math.round((Date.now() - stats.startedAt) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    this.progressEnd();
    this.success("========== RESUMEN ==========");
    this.success(`Query: "${extra.query}"`);
    this.success(`Páginas: ${stats.pagesDone} ok, ${stats.pagesFailed} fallidas`);
    this.success(
      `Documentos: ${stats.docsTotal} únicos | detalle: ${stats.detailDone} ok, ${stats.detailFailed} fallidos`,
    );
    this.success(
      `Archivos: ${stats.pdfsDone} PDFs, ${stats.wordsDone} Words | ${stats.filesFailed} fallidos`,
    );
    this.success(`Concurrencia final: ${extra.concurrency}`);
    this.success(`Tiempo: ${minutes}m ${seconds}s`);
    this.success("=============================");
  }
}
