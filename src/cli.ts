import { Command } from "commander";
import { type CliOptions, DEFAULT_OPTIONS } from "./config";

function int(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} debe ser un entero no negativo`);
  }
  return n;
}

export function parseCli(argv: string[]): CliOptions {
  const program = new Command()
    .name("scraper-jurisprudencia")
    .description(
      "Scraper de Jurisprudencia Nacional del Poder Judicial del Perú.\n" +
        "Paginación completa + extracción de metadata (card + ficha 'Ver Ficha')\n" +
        "+ descarga de PDF (Word opcional), con rate limiting adaptativo y cola idempotente.",
    )
    .option(
      "--query <texto>",
      "texto de búsqueda (vacío = búsqueda completa)",
      DEFAULT_OPTIONS.query,
    )
    .option("--corte <1|2>", "corte: 1=Suprema, 2=Superior", DEFAULT_OPTIONS.corte)
    .option("--especialidad <id>", "id de especialidad (vacío = todas)", "")
    .option("--anio <aaaa>", "año de la resolución (vacío = todos)", "")
    .option(
      "--pages <N>",
      "limitar a N páginas (demo). 0 = todas las páginas",
      String(DEFAULT_OPTIONS.pages),
    )
    .option(
      "--max-files <N>",
      "limitar descargas de archivos a N (demo). 0 = todos",
      String(DEFAULT_OPTIONS.maxFiles),
    )
    .option(
      "--concurrency <N>",
      "concurrencia inicial de descargas (AIMD la ajusta)",
      String(DEFAULT_OPTIONS.concurrency),
    )
    .option(
      "--sessions <N>",
      "sesiones de navegación paralelas, cada una con su JSESSIONID. 1 = serial",
      String(DEFAULT_OPTIONS.sessions),
    )
    .option(
      "--min-delay <ms>",
      "delay mínimo entre requests (ms)",
      String(DEFAULT_OPTIONS.minDelay),
    )
    .option("--out <dir>", "directorio de salida", DEFAULT_OPTIONS.out)
    .option("--fresh", "borrar los artefactos del scraper dentro de --out y empezar desde cero")
    .option("--word", "descargar también archivos Word (PDF se descarga siempre)")
    .option("--quiet", "solo errores y resumen final")
    .showHelpAfterError()
    .parse(argv);

  const opts = program.opts<Record<string, string>>();

  return {
    query: opts.query ?? DEFAULT_OPTIONS.query,
    corte: opts.corte ?? DEFAULT_OPTIONS.corte,
    especialidad: opts.especialidad ?? "",
    anio: opts.anio ?? "",
    pages: int(opts.pages ?? "0", "pages"),
    maxFiles: int(opts.maxFiles ?? "0", "max-files"),
    concurrency: Math.max(1, int(opts.concurrency ?? "2", "concurrency")),
    sessions: Math.max(1, int(opts.sessions ?? "1", "sessions")),
    minDelay: int(opts.minDelay ?? "500", "min-delay"),
    out: opts.out ?? DEFAULT_OPTIONS.out,
    fresh: Boolean(opts.fresh),
    quiet: Boolean(opts.quiet),
    word: Boolean(opts.word),
  };
}
