import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli";

describe("parseCli", () => {
  it("aplica defaults", () => {
    const opts = parseCli(["node", "index.js"]);
    expect(opts.query).toBe("");
    expect(opts.corte).toBe("1");
    expect(opts.pages).toBe(0);
    expect(opts.maxFiles).toBe(0);
    expect(opts.concurrency).toBe(2);
    expect(opts.sessions).toBe(1);
    expect(opts.minDelay).toBe(500);
    expect(opts.out).toBe("data");
    expect(opts.fresh).toBe(false);
    expect(opts.word).toBe(false);
  });

  it("downloads PDF by default and makes Word additive", () => {
    expect(parseCli(["node", "index.js"]).word).toBe(false);
    expect(parseCli(["node", "index.js", "--word"]).word).toBe(true);
  });

  it("parsea --sessions", () => {
    const opts = parseCli(["node", "index.js", "--sessions", "3"]);
    expect(opts.sessions).toBe(3);
    expect(parseCli(["node", "index.js", "--sessions", "0"]).sessions).toBe(1);
    expect(() => parseCli(["node", "index.js", "--sessions", "-2"])).toThrow();
  });

  it("parsea flags kebab-case (commander los camelCasea)", () => {
    const opts = parseCli([
      "node",
      "index.js",
      "--query",
      "homicidio",
      "--pages",
      "3",
      "--max-files",
      "25",
      "--min-delay",
      "800",
      "--fresh",
    ]);
    expect(opts.query).toBe("homicidio");
    expect(opts.pages).toBe(3);
    expect(opts.maxFiles).toBe(25);
    expect(opts.minDelay).toBe(800);
    expect(opts.fresh).toBe(true);
  });

  it("valida enteros no negativos", () => {
    expect(() => parseCli(["node", "index.js", "--pages", "-1"])).toThrow();
  });
});
