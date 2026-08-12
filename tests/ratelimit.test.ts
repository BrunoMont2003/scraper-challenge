import { describe, expect, it } from "vitest";
import {
  AimdController,
  DEFAULT_BACKOFF,
  jitteredBackoff,
  parseRetryAfter,
} from "../src/ratelimit";

describe("parseRetryAfter", () => {
  it("parsea segundos", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
  });

  it("parsea fecha HTTP", () => {
    const now = Date.parse("2026-08-12T10:00:00Z");
    expect(parseRetryAfter("Wed, 12 Aug 2026 10:01:30 GMT", now)).toBe(90_000);
  });

  it("clampa valores absurdos a 1h", () => {
    expect(parseRetryAfter("999999")).toBe(3_600_000);
  });

  it("devuelve null si no hay header o es inválido", () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("abc")).toBeNull();
  });
});

describe("jitteredBackoff", () => {
  it("full jitter: delay dentro de [0, cap]", () => {
    for (let i = 0; i < 200; i++) {
      const delay = jitteredBackoff(DEFAULT_BACKOFF, 2); // cap = 4s
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });

  it("respeta maxMs", () => {
    const opts = { ...DEFAULT_BACKOFF, maxMs: 5_000 };
    for (let i = 0; i < 50; i++) {
      expect(jitteredBackoff(opts, 10)).toBeLessThanOrEqual(5_000);
    }
  });
});

describe("AimdController", () => {
  it("arranca en la concurrencia inicial", () => {
    const c = new AimdController({ initialConcurrency: 3 });
    expect(c.concurrency).toBe(3);
  });

  it("multiplicative decrease: 429 divide a la mitad (piso 1)", () => {
    const c = new AimdController({ initialConcurrency: 4 });
    c.report("rate-limited");
    expect(c.concurrency).toBe(2);
    c.report("rate-limited");
    expect(c.concurrency).toBe(1);
    c.report("rate-limited");
    expect(c.concurrency).toBe(1);
  });

  it("additive increase: sube de a 1 tras rampUpAfter éxitos", () => {
    const c = new AimdController({ initialConcurrency: 1, maxConcurrency: 4, rampUpAfter: 5, cooldownMs: 0 });
    for (let i = 0; i < 5; i++) c.report("success");
    expect(c.concurrency).toBe(2);
    for (let i = 0; i < 5; i++) c.report("success");
    expect(c.concurrency).toBe(3);
  });

  it("no supera maxConcurrency", () => {
    const c = new AimdController({ initialConcurrency: 1, maxConcurrency: 2, rampUpAfter: 1, cooldownMs: 0 });
    for (let i = 0; i < 20; i++) c.report("success");
    expect(c.concurrency).toBe(2);
  });

  it("server-error también baja la concurrencia", () => {
    const c = new AimdController({ initialConcurrency: 4 });
    c.report("server-error");
    expect(c.concurrency).toBe(2);
  });

  it("cooldown: no sube inmediatamente tras una bajada", () => {
    const c = new AimdController({ initialConcurrency: 4, rampUpAfter: 1, cooldownMs: 60_000 });
    c.report("rate-limited");
    expect(c.concurrency).toBe(2);
    c.report("success");
    expect(c.concurrency).toBe(2); // aún en cooldown
  });
});
