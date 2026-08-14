import { closeSync, createWriteStream, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { atomicReplace } from "./atomic-file";
import { SITE } from "./config";
import type { HttpStreamResult } from "./http/client";

export type FileKind = "pdf" | "word";

export interface DownloadOutcome {
  ok: boolean;
  path?: string;
  missing?: boolean;
  error?: string;
}

export interface StreamingHttpClient {
  getStream(url: string): Promise<HttpStreamResult>;
}

/**
 * Descarga de archivos vía ServletDescarga?uuid= (docs/spec.md §6).
 * No requiere sesión: el uuid es direccionable globalmente.
 */
export class Downloader {
  private readonly pdfDir: string;
  private readonly wordDir: string;

  constructor(
    private readonly http: StreamingHttpClient,
    outDir: string,
  ) {
    this.pdfDir = join(outDir, "pdfs");
    this.wordDir = join(outDir, "words");
    mkdirSync(this.pdfDir, { recursive: true });
    mkdirSync(this.wordDir, { recursive: true });
  }

  async download(uuid: string, kind: FileKind, nroexp: string): Promise<DownloadOutcome> {
    const url = `${SITE.descarga}?uuid=${encodeURIComponent(uuid)}`;
    const res = await this.http.getStream(url);

    const contentType = (res.headers["content-type"] ?? "").toLowerCase();
    if (res.status !== 200 || contentType.includes("text/html")) {
      res.data.destroy();
      return {
        ok: false,
        missing: res.status === 404,
        error: `HTTP ${res.status} (${contentType})`,
      };
    }
    const ext = inferExtension(res.headers["content-disposition"] ?? "", kind);
    const safe = sanitizeName(nroexp || "sin-expediente");
    const fileName = `${safe}__${uuid}.${ext}`;
    const dir = kind === "pdf" ? this.pdfDir : this.wordDir;
    const path = join(dir, fileName);
    try {
      await atomicReplace(
        path,
        async (temporaryPath) =>
          pipeline(res.data, createWriteStream(temporaryPath, { flags: "wx" })),
        (temporaryPath) => validateDownload(temporaryPath, kind),
      );
      return { ok: true, path };
    } catch (error) {
      if (error instanceof InvalidDownloadError) return { ok: false, error: error.message };
      throw error;
    }
  }
}

function inferExtension(contentDisposition: string, kind: FileKind): string {
  const match = /filename="?[^"\\]*\.([a-z0-9]+)"?/i.exec(contentDisposition);
  if (match) return match[1]!.toLowerCase();
  return kind === "pdf" ? "pdf" : "doc";
}

/** Verifica las cabeceras binarias: PDF `%PDF-`, Word OLE2 `D0CF11E0`. */
function hasMagicBytes(buf: Buffer, kind: FileKind): boolean {
  if (kind === "pdf") {
    return buf.subarray(0, 5).toString("latin1") === "%PDF-";
  }
  return buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0;
}

class InvalidDownloadError extends Error {}

function validateDownload(path: string, kind: FileKind): void {
  const size = statSync(path).size;
  if (size < 1000) throw new InvalidDownloadError(`respuesta inválida (${size} bytes)`);
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    if (!hasMagicBytes(header.subarray(0, bytesRead), kind)) {
      throw new InvalidDownloadError(
        `el contenido no parece un ${kind.toUpperCase()} (magic bytes inválidos)`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}
