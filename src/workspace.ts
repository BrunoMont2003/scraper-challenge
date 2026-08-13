import { lstatSync, mkdirSync, rmSync, type Stats, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const OWNED_CHILDREN = [
  "scraper.sqlite",
  "scraper.sqlite-wal",
  "scraper.sqlite-shm",
  "results.jsonl",
  "results.jsonl.tmp",
  "results.csv",
  "results.csv.tmp",
  "failed.jsonl",
  "failed.jsonl.tmp",
  "pdfs",
  "words",
] as const;

export class ScraperWorkspace {
  readonly root: string;
  readonly databasePath: string;
  readonly jsonlPath: string;
  readonly csvPath: string;
  readonly failedPath: string;
  readonly pdfDirectory: string;
  readonly wordDirectory: string;

  private constructor(root: string) {
    this.root = root;
    this.databasePath = join(root, "scraper.sqlite");
    this.jsonlPath = join(root, "results.jsonl");
    this.csvPath = join(root, "results.csv");
    this.failedPath = join(root, "failed.jsonl");
    this.pdfDirectory = join(root, "pdfs");
    this.wordDirectory = join(root, "words");
  }

  static open(outDirectory: string): ScraperWorkspace {
    const root = resolve(outDirectory);
    if (lstatIfPresent(root)?.isSymbolicLink()) {
      throw new Error(`Output workspace cannot be a symlink: ${root}`);
    }
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) {
      throw new Error(`Output workspace cannot be a symlink: ${root}`);
    }
    return new ScraperWorkspace(root);
  }

  reset(): void {
    for (const name of OWNED_CHILDREN) {
      const path = join(this.root, name);
      const stats = lstatIfPresent(path);
      if (!stats) continue;
      if (stats.isSymbolicLink()) {
        unlinkSync(path);
      } else {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
