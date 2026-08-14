import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { describe, expect, it, vi } from "vitest";

vi.mock("axios", () => ({ default: { request: vi.fn() } }));

import { EMPTY_DETAIL } from "../src/config";
import { main, toOutputRecord } from "../src/index";
import type { DocRow } from "../src/queue";

const argv = (out: string): string[] => ["node", "scraper", "--out", out, "--quiet"];

describe("main process contract", () => {
  it("has no network or process side effect when imported", () => {
    expect(axios.request).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps live verification out of default tests and CI", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(pkg.scripts.test).not.toContain("live");
    expect(pkg.scripts["test:live"]).toBe("tsx tests/live-smoke.ts");
    expect(ci).not.toContain("test:live");
  });

  it("returns 0 for a complete run and 1 for preserved partial failures", async () => {
    const complete = await main(
      argv(mkdtempSync(join(tmpdir(), "scraper-main-ok-"))),
      async () => 0,
    );
    const partial = await main(
      argv(mkdtempSync(join(tmpdir(), "scraper-main-partial-"))),
      async () => 3,
    );

    expect(complete).toBe(0);
    expect(partial).toBe(1);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it("exports the persisted detail scrape timestamp instead of generating one", () => {
    const row = {
      run_id: 1,
      uuid: "doc-1",
      query: "laboral",
      page: 1,
      row_index: 0,
      metadata: "",
      detail_status: "done",
      pdf_status: "missing",
      word_status: "missing",
      detail_attempts: 1,
      pdf_attempts: 0,
      word_attempts: 0,
      detail_error: null,
      pdf_error: null,
      word_error: null,
      pdf_path: null,
      word_path: null,
      detail_scraped_at: "2026-06-01 02:03:04",
      updated_at: "2026-08-13 19:00:00",
    } satisfies DocRow;

    const output = toOutputRecord(row, {
      card: { recurso: "Casación", nroexp: "1-2026" },
      detail: EMPTY_DETAIL,
    });

    expect(output.scraped_at).toBe("2026-06-01 02:03:04");
    expect(output.scraped_at).not.toBe(row.updated_at);
  });

  it("returns 2 for invalid configuration or a fatal runtime failure", async () => {
    const invalid = await main(["node", "scraper", "--pages", "-1"], async () => 0);
    const fatal = await main(argv(mkdtempSync(join(tmpdir(), "scraper-main-fatal-"))), async () => {
      throw new Error("database unavailable");
    });

    expect(invalid).toBe(2);
    expect(fatal).toBe(2);
    expect(axios.request).not.toHaveBeenCalled();
  });
});
