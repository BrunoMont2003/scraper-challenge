import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "./config";
import type { HttpClient } from "./http/client";

export type FileKind = "pdf" | "word";

export interface DownloadOutcome {
  ok: boolean;
  path?: string;
  missing?: boolean;
  error?: string;
}

/**
 * Descarga de archivos vía ServletDescarga?uuid= (docs/spec.md §6).
 * No requiere sesión: el uuid es direccionable globalmente.
 */
export class Downloader {
  private readonly pdfDir: string;
  private readonly wordDir: string;

  constructor(
    private readonly http: HttpClient,
    private readonly outDir: string,
  ) {
    this.pdfDir = join(outDir, "pdfs");
    this.wordDir = join(outDir, "words");
    mkdirSync(this.pdfDir, { recursive: true });
    mkdirSync(this.wordDir, { recursive: true });
  }

  async download(uuid: string, kind: FileKind, nroexp: string): Promise<DownloadOutcome> {
    const url = `${SITE.descarga}?uuid=${encodeURIComponent(uuid)}`;
    const res = await this.http.getBinary(url);

    const contentType = (res.headers["content-type"] ?? "").toLowerCase();
    if (res.status !== 200 || contentType.includes("text/html")) {
      return { ok: false, missing: res.status === 404, error: `HTTP ${res.status} (${contentType})` };
    }
    if (!Buffer.isBuffer(res.data) || res.data.length < 1000) {
      return { ok: false, error: `respuesta inválida (${Buffer.isBuffer(res.data) ? res.data.length : 0} bytes)` };
    }

    const ext = inferExtension(res.headers["content-disposition"] ?? "", kind);
    const safe = sanitizeName(nroexp || "sin-expediente");
    const fileName = `${safe}__${uuid}.${ext}`;
    const dir = kind === "pdf" ? this.pdfDir : this.wordDir;
    const path = join(dir, fileName);
    writeFileSync(path, res.data);
    return { ok: true, path };
  }
}

function inferExtension(contentDisposition: string, kind: FileKind): string {
  const match = /filename="?[^"\\]*\.([a-z0-9]+)"?/i.exec(contentDisposition);
  if (match) return match[1]!.toLowerCase();
  return kind === "pdf" ? "pdf" : "doc";
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}
