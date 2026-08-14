import type { Writable } from "node:stream";

export type RunPhase = "Search" | "Details" | "PDFs" | "Word" | "Export";
export type TerminalState = "COMPLETED" | "COMPLETED WITH FAILURES" | "ABORTED";

export interface RunStats {
  pagesDone: number;
  pagesFailed: number;
  docsTotal: number;
  detailDone: number;
  detailFailed: number;
  pdfsDone: number;
  wordsDone: number;
  filesFailed: number;
  filesDeferred: number;
  requestedArtifacts: number;
  filesDownloadedNow: number;
  filesReused: number;
  httpAttempts: number;
  retries: number;
  rateLimited: number;
  startedAt: number;
}

interface ReporterOptions {
  stream?: Writable;
  tty?: boolean;
  now?: () => number;
  quiet?: boolean;
}

const PHASE_LABEL: Record<RunPhase, string> = {
  Search: "Buscando expedientes",
  Details: "Procesando páginas",
  PDFs: "Descargando documentos PDF",
  Word: "Descargando documentos Word",
  Export: "Preparando resultados",
};

const PHASE_UNIT: Record<RunPhase, string> = {
  Search: "consultas",
  Details: "páginas",
  PDFs: "PDFs",
  Word: "documentos Word",
  Export: "registros",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function terminalState(input: {
  aborted: boolean;
  failures: number;
  deferred: number;
}): TerminalState {
  if (input.aborted) return "ABORTED";
  return input.failures + input.deferred > 0 ? "COMPLETED WITH FAILURES" : "COMPLETED";
}

/** Owns all console output and keeps long-running TTY operations visibly alive. */
export class RunReporter {
  private readonly stream: Writable;
  private readonly tty: boolean;
  private readonly now: () => number;
  private readonly quiet: boolean;
  private completed = 0;
  private total = 0;
  private unit = "elementos";
  private phaseStartedAt = 0;
  private cooldownUntil = 0;
  private rateLimited = 0;
  private frame = 0;
  private active = false;
  private waitingUntil = 0;
  private waitingCount = 0;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(options: ReporterOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.tty = options.tty ?? Boolean(process.stdout.isTTY);
    this.now = options.now ?? Date.now;
    this.quiet = options.quiet ?? false;
  }

  phaseStarted(phase: RunPhase, total = 0): void {
    this.stopHeartbeat();
    if (this.tty && !this.quiet && this.phaseStartedAt > 0) this.stream.write("\n");
    this.completed = 0;
    this.total = total;
    this.unit = PHASE_UNIT[phase];
    this.phaseStartedAt = this.now();
    this.waitingUntil = 0;
    this.waitingCount = 0;
    this.active = true;
    if (this.quiet) return;
    if (this.tty) {
      this.write(`${this.paint("36;1", "◆")} ${this.paint("1", PHASE_LABEL[phase])}`);
      this.redraw();
      this.heartbeat = setInterval(() => this.redraw(), 250);
      this.heartbeat.unref?.();
    } else {
      this.write(
        total > 0
          ? `── ${PHASE_LABEL[phase]} · 0 de ${total} ${this.unit}`
          : `── ${PHASE_LABEL[phase]}`,
      );
    }
  }

  phaseSkipped(phase: RunPhase, message: string): void {
    this.stopHeartbeat();
    this.active = false;
    if (this.quiet) return;
    if (this.tty && this.phaseStartedAt > 0) this.stream.write("\n");
    this.write(`${this.paint("36;1", "◆")} ${this.paint("1", PHASE_LABEL[phase])}`);
    this.write(`  ${this.paint("32;1", "✓")} ${message}`);
  }

  phaseWaiting(phase: RunPhase, count: number, until: number): void {
    this.stopHeartbeat();
    if (this.tty && !this.quiet && this.phaseStartedAt > 0) this.stream.write("\n");
    this.phaseStartedAt = this.now();
    this.waitingUntil = until;
    this.waitingCount = count;
    this.active = true;
    if (this.quiet) return;
    this.write(`${this.paint("36;1", "◆")} ${this.paint("1", PHASE_LABEL[phase])}`);
    if (this.tty) {
      this.redraw();
      this.heartbeat = setInterval(() => this.redraw(), 250);
      this.heartbeat.unref?.();
    } else {
      this.write(`   ${count} archivos en pausa · Esperando para reintentar automáticamente`);
    }
  }

  progress(completed: number, total = this.total): void {
    this.completed = completed;
    this.total = total;
    if (this.quiet) return;
    if (this.tty) this.redraw();
    else this.write(`   Progreso: ${completed} de ${total} ${this.unit}`);
  }

  requestObserved(status: number, _retry: boolean, cooldownUntil?: number): void {
    if (status === 429) {
      this.rateLimited++;
      this.cooldownUntil = Math.max(this.cooldownUntil, cooldownUntil ?? 0);
      if (!this.quiet && !this.tty && this.rateLimited === 1) {
        this.write("   ⚠ El servidor pidió reducir el ritmo; los siguientes avisos se agruparán");
      }
    }
    if (!this.quiet && this.tty) this.redraw();
  }

  info(message: string): void {
    if (!this.quiet) this.message(this.paint("34;1", "ℹ"), message);
  }

  warn(message: string): void {
    if (!this.quiet) this.message(this.paint("33;1", "⚠"), message);
  }

  error(message: string): void {
    this.message(this.paint("31;1", "✖"), message);
  }

  finish(state: TerminalState, stats: RunStats, outputDirectory: string): void {
    this.stopHeartbeat();
    this.active = false;
    if (this.tty && !this.quiet) this.stream.write("\r\x1b[2K\n");
    const elapsed = Math.max(0, Math.round((this.now() - stats.startedAt) / 1_000));
    const title =
      state === "COMPLETED"
        ? "Finalizado correctamente"
        : state === "ABORTED"
          ? "Ejecución interrumpida"
          : "Completado parcialmente";
    const icon = state === "COMPLETED" ? "✓" : state === "ABORTED" ? "✖" : "⚠";
    const color = state === "COMPLETED" ? "32;1" : state === "ABORTED" ? "31;1" : "33;1";
    this.write(`╭─ ${this.paint(color, `${icon} ${title}`)}`);
    this.write(`│ Expedientes exportados     ${stats.docsTotal}`);
    this.write(
      `│ Archivos disponibles      ${stats.pdfsDone + stats.wordsDone} / ${stats.requestedArtifacts}`,
    );
    this.write(`│   ├─ descargados ahora     ${stats.filesDownloadedNow}`);
    this.write(`│   └─ reutilizados          ${stats.filesReused}`);
    this.write(`│ Archivos pendientes        ${stats.filesDeferred}`);
    this.write(`│ Errores definitivos        ${stats.filesFailed}`);
    this.write("│");
    this.write(
      stats.rateLimited > 0 || stats.retries > 0
        ? `│ Servidor: pidió reducir el ritmo ${stats.rateLimited} veces · ${stats.retries} reintentos · ${stats.httpAttempts} solicitudes`
        : `│ Red                        ${stats.httpAttempts} solicitudes · sin límites ni reintentos`,
    );
    this.write(`│ Duración                   ${formatDuration(elapsed)}`);
    this.write(`│ Resultados                 ${outputDirectory}`);
    if (stats.filesDeferred > 0 || stats.filesFailed > 0) {
      this.write("│ Detalle                    unresolved.jsonl");
    }
    this.write(
      stats.filesDeferred > 0
        ? `╰─ Ejecutá nuevamente el mismo comando para reintentar ${stats.filesDeferred} archivos pendientes`
        : stats.filesFailed > 0
          ? "╰─ Revisá unresolved.jsonl para ver los errores definitivos"
          : "╰─ Listo",
    );
  }

  private message(icon: string, message: string): void {
    if (this.tty) this.stream.write("\r\x1b[2K");
    this.write(`${icon} ${message}`);
    if (this.tty && this.active) this.redraw();
  }

  private redraw(): void {
    if (this.waitingUntil > 0) {
      const remaining = Math.max(0, Math.ceil((this.waitingUntil - this.now()) / 1_000));
      const spinner = SPINNER[this.frame++ % SPINNER.length];
      this.stream.write(
        `\r\x1b[2K  ${this.paint("36", spinner!)} Esperando al servidor · ${this.waitingCount} archivos en pausa · Reintento automático en ${formatDuration(remaining)}`,
      );
      return;
    }
    const elapsedSeconds = Math.max(0.001, (this.now() - this.phaseStartedAt) / 1_000);
    const throughput = this.completed / elapsedSeconds;
    const remaining = Math.max(0, this.total - this.completed);
    const percent = this.total > 0 ? Math.min(1, this.completed / this.total) : 0;
    const filled = Math.round(percent * 16);
    const bar = `${"█".repeat(filled)}${"░".repeat(16 - filled)}`;
    const remainingText =
      throughput > 0 && remaining > 0
        ? ` · Tiempo restante: ${formatDuration(Math.ceil(remaining / throughput))}`
        : "";
    const cooldown = Math.max(0, Math.ceil((this.cooldownUntil - this.now()) / 1_000));
    const serverText =
      cooldown > 0
        ? ` · ${this.paint("33", `Pausa del servidor: ${formatDuration(cooldown)}`)}`
        : this.rateLimited > 0
          ? ` · Límites: ${this.rateLimited}`
          : "";
    const spinner = SPINNER[this.frame++ % SPINNER.length];
    if (this.total === 0) {
      this.stream.write(
        `\r\x1b[2K  ${this.paint("36", spinner!)} Consultando el sitio${serverText}`,
      );
      return;
    }
    this.stream.write(
      `\r\x1b[2K  ${this.paint("36", spinner!)} Trabajando  ${this.paint("36", bar)}  ${this.completed} de ${this.total} ${this.unit} · ${throughput.toFixed(1)} por segundo${remainingText}${serverText}`,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private paint(code: string, text: string): string {
    return this.tty ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  private write(line: string): void {
    this.stream.write(`${line}\n`);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
