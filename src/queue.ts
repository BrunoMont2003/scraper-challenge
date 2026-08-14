import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type CardRecord, type DetailRecord, normalizeRunScope, type RunScope } from "./config";

export type Status = "pending" | "in_progress" | "done" | "failed" | "missing" | "deferred";
export type Operation = "detail" | "pdf" | "word";

export interface PageRow {
  run_id: number;
  page: number;
  status: Status;
  attempts: number;
  last_error: string | null;
  scraped_at: string | null;
}

export interface DocRow {
  run_id: number;
  uuid: string;
  query: string;
  page: number;
  row_index: number;
  metadata: string;
  detail_status: Status;
  pdf_status: Status;
  word_status: Status;
  detail_attempts: number;
  pdf_attempts: number;
  word_attempts: number;
  detail_error: string | null;
  pdf_error: string | null;
  word_error: string | null;
  pdf_path: string | null;
  word_path: string | null;
  pdf_next_eligible_at: number | null;
  word_next_eligible_at: number | null;
  detail_scraped_at: string | null;
  updated_at: string | null;
}

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  query         TEXT NOT NULL,
  corte         TEXT NOT NULL,
  especialidad  TEXT NOT NULL,
  anio          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (query, corte, especialidad, anio)
);

CREATE TABLE pages (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  scraped_at  TEXT,
  PRIMARY KEY (run_id, page)
);

CREATE TABLE docs (
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  uuid               TEXT NOT NULL,
  page               INTEGER NOT NULL,
  row_index          INTEGER NOT NULL,
  metadata           TEXT NOT NULL DEFAULT '{}',
  detail_status      TEXT NOT NULL DEFAULT 'pending',
  pdf_status         TEXT NOT NULL DEFAULT 'pending',
  word_status        TEXT NOT NULL DEFAULT 'pending',
  detail_attempts    INTEGER NOT NULL DEFAULT 0,
  pdf_attempts       INTEGER NOT NULL DEFAULT 0,
  word_attempts      INTEGER NOT NULL DEFAULT 0,
  detail_error       TEXT,
  pdf_error          TEXT,
  word_error         TEXT,
  pdf_path           TEXT,
  word_path          TEXT,
  pdf_next_eligible_at INTEGER,
  word_next_eligible_at INTEGER,
  detail_scraped_at  TEXT,
  updated_at         TEXT,
  PRIMARY KEY (run_id, uuid)
);

CREATE INDEX docs_run_page ON docs(run_id, page, row_index);
`;

export class IncompatibleSchemaError extends Error {
  constructor(version: number) {
    super(
      `Persisted scraper schema is incompatible (version ${version}); rerun with --fresh to reset this output workspace.`,
    );
    this.name = "IncompatibleSchemaError";
  }
}

export class JobQueue {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      const version = this.db.pragma("user_version", { simple: true }) as number;
      const tableCount = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { count: number }
      ).count;
      if (version === 0 && tableCount === 0) {
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version === 2) {
        this.db.transaction(() => {
          this.db.exec("ALTER TABLE docs ADD COLUMN pdf_next_eligible_at INTEGER");
          this.db.exec("ALTER TABLE docs ADD COLUMN word_next_eligible_at INTEGER");
          this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
      } else if (version !== SCHEMA_VERSION) {
        throw new IncompatibleSchemaError(version);
      }

      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.exec("UPDATE pages SET status='pending' WHERE status='in_progress'");
      this.db.exec("UPDATE docs SET detail_status='pending' WHERE detail_status='in_progress'");
      this.db.exec("UPDATE docs SET pdf_status='pending' WHERE pdf_status='in_progress'");
      this.db.exec("UPDATE docs SET word_status='pending' WHERE word_status='in_progress'");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getOrCreateRun(input: RunScope): number {
    const scope = normalizeRunScope(input);
    this.db
      .prepare(`INSERT OR IGNORE INTO runs (query, corte, especialidad, anio) VALUES (?, ?, ?, ?)`)
      .run(scope.query, scope.corte, scope.especialidad, scope.anio);
    const row = this.db
      .prepare(`SELECT id FROM runs WHERE query=? AND corte=? AND especialidad=? AND anio=?`)
      .get(scope.query, scope.corte, scope.especialidad, scope.anio) as { id: number };
    return row.id;
  }

  isPageDone(runId: number, page: number): boolean {
    return this.getPage(runId, page)?.status === "done";
  }

  getPage(runId: number, page: number): PageRow | undefined {
    return this.db.prepare(`SELECT * FROM pages WHERE run_id=? AND page=?`).get(runId, page) as
      | PageRow
      | undefined;
  }

  pendingPages(runId: number, lastPage: number): number[] {
    const done = new Set(
      (
        this.db
          .prepare(`SELECT page FROM pages WHERE run_id=? AND status='done'`)
          .all(runId) as Array<{
          page: number;
        }>
      ).map((row) => row.page),
    );
    return Array.from({ length: lastPage }, (_, index) => index + 1).filter(
      (page) => !done.has(page),
    );
  }

  markPage(runId: number, page: number, status: Status, error?: string): void {
    this.db
      .prepare(
        `INSERT INTO pages (run_id, page, status, attempts, last_error, scraped_at)
         VALUES (?, ?, ?, CASE WHEN ?='in_progress' THEN 1 ELSE 0 END, ?,
                 CASE WHEN ?='done' THEN datetime('now') ELSE NULL END)
         ON CONFLICT(run_id, page) DO UPDATE SET
           status=excluded.status,
           attempts=pages.attempts + CASE WHEN excluded.status='in_progress' THEN 1 ELSE 0 END,
           last_error=excluded.last_error,
           scraped_at=CASE WHEN excluded.status='done'
             THEN COALESCE(pages.scraped_at, datetime('now')) ELSE pages.scraped_at END`,
      )
      .run(runId, page, status, status, error ?? null, status);
  }

  insertCard(runId: number, page: number, card: CardRecord): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO docs (run_id, uuid, page, row_index, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(runId, card.uuid, page, card.rowIndex, JSON.stringify({ card }));
    return info.changes > 0;
  }

  setDetail(runId: number, uuid: string, detail: DetailRecord): void {
    const merged = { ...this.getMetadata(runId, uuid), detail };
    this.db
      .prepare(
        `UPDATE docs SET metadata=?, detail_status='done', detail_error=NULL,
         detail_scraped_at=datetime('now'), updated_at=datetime('now') WHERE run_id=? AND uuid=?`,
      )
      .run(JSON.stringify(merged), runId, uuid);
  }

  markDetail(runId: number, uuid: string, status: Status, error?: string): void {
    this.db
      .prepare(
        `UPDATE docs SET detail_status=?, detail_error=?, updated_at=datetime('now')
         WHERE run_id=? AND uuid=?`,
      )
      .run(status, error ?? null, runId, uuid);
  }

  markFile(
    runId: number,
    uuid: string,
    kind: "pdf" | "word",
    status: Status,
    path?: string,
    error?: string,
  ): void {
    const statusColumn = kind === "pdf" ? "pdf_status" : "word_status";
    const pathColumn = kind === "pdf" ? "pdf_path" : "word_path";
    const errorColumn = kind === "pdf" ? "pdf_error" : "word_error";
    const eligibleColumn = kind === "pdf" ? "pdf_next_eligible_at" : "word_next_eligible_at";
    this.db
      .prepare(
        `UPDATE docs SET ${statusColumn}=?, ${pathColumn}=?, ${errorColumn}=?, ${eligibleColumn}=NULL, updated_at=datetime('now')
         WHERE run_id=? AND uuid=?`,
      )
      .run(status, path ?? null, error ?? null, runId, uuid);
  }

  deferFile(
    runId: number,
    uuid: string,
    kind: "pdf" | "word",
    nextEligibleAt: number,
    error: string,
  ): void {
    const statusColumn = `${kind}_status`;
    const errorColumn = `${kind}_error`;
    const eligibleColumn = `${kind}_next_eligible_at`;
    this.db
      .prepare(
        `UPDATE docs SET ${statusColumn}='deferred', ${errorColumn}=?, ${eligibleColumn}=?, updated_at=datetime('now')
         WHERE run_id=? AND uuid=?`,
      )
      .run(error, nextEligibleAt, runId, uuid);
  }

  incrementAttempts(runId: number, uuid: string, operation: Operation): void {
    const column = `${operation}_attempts`;
    this.db
      .prepare(`UPDATE docs SET ${column}=${column}+1 WHERE run_id=? AND uuid=?`)
      .run(runId, uuid);
  }

  getMetadata(runId: number, uuid: string): Record<string, unknown> {
    const row = this.db
      .prepare(`SELECT metadata FROM docs WHERE run_id=? AND uuid=?`)
      .get(runId, uuid) as { metadata: string } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  getDoc(runId: number, uuid: string): DocRow | undefined {
    return this.selectDocs(`d.run_id=? AND d.uuid=?`).get(runId, uuid) as DocRow | undefined;
  }

  countDocs(runId: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS count FROM docs WHERE run_id=?`).get(runId) as {
        count: number;
      }
    ).count;
  }

  countPages(runId: number, status: Status): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM pages WHERE run_id=? AND status=?`)
        .get(runId, status) as { count: number }
    ).count;
  }

  countDetails(runId: number, status: Status): number {
    return this.countByStatus(runId, "detail_status", status);
  }

  countFiles(runId: number, kind: "pdf" | "word", status: Status): number {
    return this.countByStatus(runId, `${kind}_status`, status);
  }

  countFailed(runId: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM docs WHERE run_id=?
           AND (detail_status='failed' OR pdf_status='failed' OR word_status='failed')`,
        )
        .get(runId) as { count: number }
    ).count;
  }

  *iterateRowsForOutput(runId: number): IterableIterator<{
    row: DocRow;
    metadata: Record<string, unknown>;
  }> {
    const rows = this.selectDocs(
      `d.run_id=? AND d.detail_status='done'`,
      "d.page, d.row_index",
    ).iterate(runId) as IterableIterator<DocRow>;
    for (const row of rows) {
      yield { row, metadata: this.parseMetadata(row.metadata) };
    }
  }

  pendingDownloads(
    runId: number,
    kind: "pdf" | "word",
    now: number = Date.now(),
    maxAttempts: number = Number.MAX_SAFE_INTEGER,
  ): Array<{ docUuid: string; fileUuid: string; nroexp: string; attempts: number }> {
    const statusColumn = kind === "pdf" ? "pdf_status" : "word_status";
    const attemptsColumn = kind === "pdf" ? "pdf_attempts" : "word_attempts";
    const eligibleColumn = kind === "pdf" ? "pdf_next_eligible_at" : "word_next_eligible_at";
    const rows = this.db
      .prepare(
        `SELECT uuid, metadata, ${attemptsColumn} AS attempts FROM docs
         WHERE run_id=? AND detail_status='done'
           AND (${statusColumn}='pending' OR ${statusColumn}='failed' OR ${statusColumn}='deferred')
           AND ${attemptsColumn} < ?
           AND (${eligibleColumn} IS NULL OR ${eligibleColumn} <= ?)
         ORDER BY ${attemptsColumn} ASC, page, row_index`,
      )
      .all(runId, maxAttempts, now) as Array<{ uuid: string; metadata: string; attempts: number }>;
    return rows.map((row) => {
      const metadata = this.parseMetadata(row.metadata);
      const detail = (metadata.detail ?? {}) as Record<string, unknown>;
      const card = (metadata.card ?? {}) as Record<string, unknown>;
      return {
        docUuid: row.uuid,
        fileUuid: String(detail[kind === "pdf" ? "uuidPdf" : "uuidWord"] ?? ""),
        nroexp: String(card.nroexp ?? ""),
        attempts: row.attempts,
      };
    });
  }

  deferredDownloadWindow(
    runId: number,
    kind: "pdf" | "word",
    maxAttempts: number = Number.MAX_SAFE_INTEGER,
    maxFiles = 0,
  ): { count: number; nextEligibleAt: number | null } {
    const statusColumn = `${kind}_status`;
    const attemptsColumn = `${kind}_attempts`;
    const eligibleColumn = `${kind}_next_eligible_at`;
    return this.db
      .prepare(
        `WITH selected AS (
           SELECT * FROM docs WHERE run_id=? AND detail_status='done'
           ORDER BY page, row_index LIMIT ?
         )
         SELECT COUNT(*) AS count, MIN(${eligibleColumn}) AS nextEligibleAt
         FROM selected
         WHERE ${statusColumn}='deferred' AND ${attemptsColumn} < ?`,
      )
      .get(runId, maxFiles > 0 ? maxFiles : -1, maxAttempts) as {
      count: number;
      nextEligibleAt: number | null;
    };
  }

  failExhaustedFiles(runId: number, kind: "pdf" | "word", maxAttempts: number): number {
    const statusColumn = `${kind}_status`;
    const attemptsColumn = `${kind}_attempts`;
    const errorColumn = `${kind}_error`;
    const eligibleColumn = `${kind}_next_eligible_at`;
    return this.db
      .prepare(
        `UPDATE docs SET ${statusColumn}='failed', ${eligibleColumn}=NULL,
           ${errorColumn}=COALESCE(${errorColumn}, 'descarga fallida') || ' · reintentos agotados',
           updated_at=datetime('now')
         WHERE run_id=? AND ${statusColumn}='deferred' AND ${attemptsColumn} >= ?`,
      )
      .run(runId, maxAttempts).changes;
  }

  artifactMetrics(
    runId: number,
    kinds: ReadonlyArray<"pdf" | "word">,
    maxFilesPerKind = 0,
  ): { requested: number; succeeded: number; failed: number; deferred: number; attempts: number } {
    const result = { requested: 0, succeeded: 0, failed: 0, deferred: 0, attempts: 0 };
    for (const kind of kinds) {
      const row = this.db
        .prepare(
          `WITH selected AS (
             SELECT * FROM docs WHERE run_id=? AND detail_status='done'
             ORDER BY page, row_index
             LIMIT ?
           )
           SELECT COUNT(*) AS requested,
             SUM(CASE WHEN ${kind}_status='done' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN ${kind}_status IN ('failed','missing') THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN ${kind}_status='deferred' THEN 1 ELSE 0 END) AS deferred,
             SUM(${kind}_attempts) AS attempts
           FROM selected`,
        )
        .get(runId, maxFilesPerKind > 0 ? maxFilesPerKind : -1) as Record<
        keyof typeof result,
        number | null
      >;
      for (const key of Object.keys(result) as Array<keyof typeof result>)
        result[key] += row[key] ?? 0;
    }
    return result;
  }

  iterateFailedRows(runId: number): IterableIterator<DocRow> {
    return this.selectDocs(
      `d.run_id=? AND (d.detail_status='failed' OR d.pdf_status IN ('failed','deferred') OR d.word_status IN ('failed','deferred'))`,
      "d.page, d.row_index",
    ).iterate(runId) as IterableIterator<DocRow>;
  }

  private countByStatus(runId: number, column: string, status: Status): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM docs WHERE run_id=? AND ${column}=?`)
        .get(runId, status) as { count: number }
    ).count;
  }

  private selectDocs(where: string, orderBy?: string): Database.Statement {
    return this.db.prepare(
      `SELECT d.*, r.query FROM docs d JOIN runs r ON r.id=d.run_id WHERE ${where}${
        orderBy ? ` ORDER BY ${orderBy}` : ""
      }`,
    );
  }

  private parseMetadata(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

export function defaultDbPath(outDir: string): string {
  return join(outDir, "scraper.sqlite");
}
