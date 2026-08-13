import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScraperWorkspace } from "../src/workspace";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scraper-workspace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ScraperWorkspace", () => {
  it("rejects a symlink output root", () => {
    const parent = temporaryRoot();
    const target = join(parent, "target");
    const link = join(parent, "output-link");
    mkdirSync(target);
    symlinkSync(target, link, "dir");

    expect(() => ScraperWorkspace.open(link)).toThrow(/symlink/i);
  });

  it("resets only scraper-owned children and preserves unrelated and sibling data", () => {
    const parent = temporaryRoot();
    const output = join(parent, "selected-output");
    const sibling = join(parent, "other-output");
    mkdirSync(join(output, "pdfs"), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(output, "scraper.sqlite"), "database");
    writeFileSync(join(output, "scraper.sqlite-wal"), "wal");
    writeFileSync(join(output, "scraper.sqlite-shm"), "shm");
    writeFileSync(join(output, "results.jsonl"), "result");
    writeFileSync(join(output, "results.csv.tmp"), "partial");
    writeFileSync(join(output, "pdfs", "owned.pdf"), "pdf");
    writeFileSync(join(output, "notes.txt"), "keep me");
    writeFileSync(join(sibling, "scraper.sqlite"), "sibling database");

    ScraperWorkspace.open(output).reset();

    expect(existsSync(join(output, "scraper.sqlite"))).toBe(false);
    expect(existsSync(join(output, "scraper.sqlite-wal"))).toBe(false);
    expect(existsSync(join(output, "scraper.sqlite-shm"))).toBe(false);
    expect(existsSync(join(output, "results.jsonl"))).toBe(false);
    expect(existsSync(join(output, "results.csv.tmp"))).toBe(false);
    expect(existsSync(join(output, "pdfs"))).toBe(false);
    expect(readFileSync(join(output, "notes.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(sibling, "scraper.sqlite"), "utf8")).toBe("sibling database");
  });

  it("unlinks an allowlisted symlink without traversing its external target", () => {
    const parent = temporaryRoot();
    const output = join(parent, "selected-output");
    const external = join(parent, "external-downloads");
    mkdirSync(output);
    mkdirSync(external);
    writeFileSync(join(external, "valuable.pdf"), "external data");
    symlinkSync(external, join(output, "pdfs"), "dir");

    ScraperWorkspace.open(output).reset();

    expect(existsSync(join(output, "pdfs"))).toBe(false);
    expect(readFileSync(join(external, "valuable.pdf"), "utf8")).toBe("external data");
    expect(lstatSync(external).isDirectory()).toBe(true);
  });

  it("removes a dangling allowlisted symlink", () => {
    const parent = temporaryRoot();
    const output = join(parent, "selected-output");
    mkdirSync(output);
    symlinkSync(join(parent, "missing-target"), join(output, "words"), "dir");

    ScraperWorkspace.open(output).reset();

    expect(() => lstatSync(join(output, "words"))).toThrow();
  });
});
