import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CardRecord, DetailRecord } from "./config";

export type Status = "pending" | "in_progress" | "done" | "failed" | "missing";

export interface DocRow {
  uuid: string;
  query: string;
  page: number;
  row_index: number;
  metadata: string;
  detail_status: Status;
  pdf_status: Status;
  word_status: Status;
  pdf_path: string | null;
  word_path: string | null;
  attempts: number;
  last_error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  query      TEXT NOT NULL,
  page       INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scraped_at TEXT,
  PRIMARY KEY (query, page)
);

CREATE TABLE IF NOT EXISTS docs (
  uuid           TEXT PRIMARY KEY,
  query          TEXT NOT NULL,
  page           INTEGER NOT NULL,
  row_index      INTEGER NOT NULL,
  metadata       TEXT NOT NULL DEFAULT '{}',
  detail_status  TEXT NOT NULL DEFAULT 'pending',
  pdf_status     TEXT NOT NULL DEFAULT 'pending',
  word_status    TEXT NOT NULL DEFAULT 'pending',
  pdf_path       TEXT,
  word_path      TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  updated_at     TEXT
);
`;

/**
 * Cola persistente en SQLite (docs/spec.md §Queue).
 * - INSERT OR IGNORE → idempotente (dedupe natural por uuid).
 * - Al abrir, resetea 'in_progress' → 'pending' (self-healing tras kill).
 */
export class JobQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.db.exec(`UPDATE pages SET status='pending' WHERE status='in_progress'`);
    this.db.exec(`UPDATE docs SET detail_status='pending' WHERE detail_status='in_progress'`);
    this.db.exec(`UPDATE docs SET pdf_status='pending' WHERE pdf_status='in_progress'`);
    this.db.exec(`UPDATE docs SET word_status='pending' WHERE word_status='in_progress'`);
  }

  close(): void {
    this.db.close();
  }

  // ---------- pages ----------

  /** True si la página ya fue procesada con éxito (para --resume). */
  isPageDone(query: string, page: number): boolean {
    const row = this.db
      .prepare(`SELECT status FROM pages WHERE query=? AND page=?`)
      .get(query, page) as { status: Status } | undefined;
    return row?.status === "done";
  }

  markPage(query: string, page: number, status: Status, error?: string): void {
    this.db
      .prepare(
        `INSERT INTO pages (query, page, status, last_error, scraped_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(query, page) DO UPDATE SET
           status=excluded.status,
           last_error=excluded.last_error,
           scraped_at=excluded.scraped_at`,
      )
      .run(query, page, status, error ?? null);
  }

  // ---------- docs ----------

  /** Inserta la card si no existe (dedupe por uuid). Devuelve true si es nueva. */
  insertCard(query: string, page: number, card: CardRecord): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO docs (uuid, query, page, row_index, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(card.uuid, query, page, card.rowIndex, JSON.stringify({ card }));
    return info.changes > 0;
  }

  /** Marca el detalle del doc con la metadata completa. */
  setDetail(uuid: string, detail: DetailRecord): void {
    const prev = this.getMetadata(uuid);
    const merged = { ...prev, detail };
    this.db
      .prepare(
        `UPDATE docs SET metadata=?, detail_status='done', last_error=NULL, updated_at=datetime('now')
         WHERE uuid=?`,
      )
      .run(JSON.stringify(merged), uuid);
  }

  markDetail(uuid: string, status: Status, error?: string): void {
    this.db
      .prepare(`UPDATE docs SET detail_status=?, last_error=?, updated_at=datetime('now') WHERE uuid=?`)
      .run(status, error ?? null, uuid);
  }

  markFile(uuid: string, kind: "pdf" | "word", status: Status, path?: string, error?: string): void {
    const col = kind === "pdf" ? "pdf_status" : "word_status";
    const pathCol = kind === "pdf" ? "pdf_path" : "word_path";
    this.db
      .prepare(`UPDATE docs SET ${col}=?, ${pathCol}=?, last_error=?, updated_at=datetime('now') WHERE uuid=?`)
      .run(status, path ?? null, error ?? null, uuid);
  }

  incrementAttempts(uuid: string): void {
    this.db.prepare(`UPDATE docs SET attempts=attempts+1 WHERE uuid=?`).run(uuid);
  }

  getMetadata(uuid: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT metadata FROM docs WHERE uuid=?`).get(uuid) as
      | { metadata: string }
      | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  getDoc(uuid: string): DocRow | undefined {
    return this.db.prepare(`SELECT * FROM docs WHERE uuid=?`).get(uuid) as DocRow | undefined;
  }

  /** Todos los docs con metadata completa (para export JSONL/CSV). */
  allDocs(): DocRow[] {
    return this.db
      .prepare(`SELECT * FROM docs WHERE detail_status='done' ORDER BY page, row_index`)
      .all() as DocRow[];
  }

  countDocs(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM docs`).get() as { c: number }).c;
  }

  countDetailDone(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) c FROM docs WHERE detail_status='done'`).get() as { c: number }
    ).c;
  }

  countFilePending(kind: "pdf" | "word"): number {
    const col = kind === "pdf" ? "pdf_status" : "word_status";
    return (
      this.db.prepare(`SELECT COUNT(*) c FROM docs WHERE ${col}='pending' OR ${col}='failed'`).get() as {
        c: number;
      }
    ).c;
  }

  countFileDone(kind: "pdf" | "word"): number {
    const col = kind === "pdf" ? "pdf_status" : "word_status";
    return (this.db.prepare(`SELECT COUNT(*) c FROM docs WHERE ${col}='done'`).get() as { c: number }).c;
  }

  countFailed(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM docs WHERE detail_status='failed' OR pdf_status='failed' OR word_status='failed'`,
        )
        .get() as { c: number }
    ).c;
  }

  /** Filas con metadata completa listas para escribir output. */
  rowsForOutput(): Array<{ row: DocRow; metadata: Record<string, unknown> }> {
    return this.allDocs().map((row) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      return { row, metadata };
    });
  }

  /** Docs con detalle listo y archivo pendiente/fallido (para descarga). */
  pendingDownloads(kind: "pdf" | "word"): Array<{
    docUuid: string;
    fileUuid: string;
    nroexp: string;
  }> {
    const col = kind === "pdf" ? "pdf_status" : "word_status";
    const rows = this.db
      .prepare(
        `SELECT uuid, metadata FROM docs WHERE detail_status='done' AND (${col}='pending' OR ${col}='failed')`,
      )
      .all() as Array<{ uuid: string; metadata: string }>;
    const out: Array<{ docUuid: string; fileUuid: string; nroexp: string }> = [];
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const detail = (metadata.detail ?? {}) as Record<string, unknown>;
      const fileUuid = String(detail[kind === "pdf" ? "uuidPdf" : "uuidWord"] ?? "");
      const card = (metadata.card ?? {}) as Record<string, unknown>;
      const nroexp = String(card.nroexp ?? "");
      out.push({ docUuid: row.uuid, fileUuid, nroexp });
    }
    return out;
  }

  /** Docs con cualquier estado failed (para failed.jsonl). */
  failedRows(): DocRow[] {
    return this.db
      .prepare(
        `SELECT * FROM docs WHERE detail_status='failed' OR pdf_status='failed' OR word_status='failed'
         ORDER BY page, row_index`,
      )
      .all() as DocRow[];
  }
}

export function defaultDbPath(outDir: string): string {
  return join(outDir, "scraper.sqlite");
}
