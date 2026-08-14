import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Downloader } from "../src/download";

function pdfChunks(): Readable {
  return Readable.from([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1200, 1)]);
}

describe("Downloader", () => {
  it("publishes a streamed download only after validation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-download-"));
    const http = {
      getStream: async () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        data: pdfChunks(),
      }),
    };

    const outcome = await new Downloader(http, directory).download("file-1", "pdf", "1/2026");

    expect(outcome.ok).toBe(true);
    expect(readFileSync(outcome.path!)).toHaveLength(1209);
    expect(readFileSync(outcome.path!).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("keeps a valid existing file when the replacement stream fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-download-fail-"));
    const finalPath = join(directory, "pdfs", "1_2026__file-1.pdf");
    const firstHttp = {
      getStream: async () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        data: pdfChunks(),
      }),
    };
    await new Downloader(firstHttp, directory).download("file-1", "pdf", "1/2026");
    const valid = readFileSync(finalPath);

    const broken = new Readable({
      read() {
        this.push(Buffer.from("%PDF-partial"));
        this.destroy(new Error("connection lost"));
      },
    });
    const secondHttp = {
      getStream: async () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        data: broken,
      }),
    };

    await expect(
      new Downloader(secondHttp, directory).download("file-1", "pdf", "1/2026"),
    ).rejects.toThrow("connection lost");
    expect(readFileSync(finalPath)).toEqual(valid);
    expect(existsSync(`${finalPath}.tmp`)).toBe(false);
  });

  it("does not publish invalid streamed content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-download-invalid-"));
    const http = {
      getStream: async () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        data: Readable.from([Buffer.from("not a pdf"), Buffer.alloc(1200)]),
      }),
    };

    const outcome = await new Downloader(http, directory).download("file-2", "pdf", "2-2026");

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/magic bytes/);
    expect(existsSync(join(directory, "pdfs", "2-2026__file-2.pdf"))).toBe(false);
  });
});
