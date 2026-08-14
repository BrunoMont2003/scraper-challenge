import axios from "axios";
import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/http/client";
import {
  AdaptiveSemaphore,
  AimdController,
  DEFAULT_BACKOFF,
  HostPacer,
  jitteredBackoff,
  parseRetryAfter,
} from "../src/ratelimit";
import { SessionWorker } from "../src/session-worker";

vi.mock("axios", () => ({
  default: {
    isAxiosError: vi.fn(() => false),
    request: vi.fn(),
  },
}));

describe("HostPacer", () => {
  it("observes navigation attempts through SessionWorker", async () => {
    const statuses: number[] = [];
    vi.mocked(axios.request).mockResolvedValue({ status: 200, headers: {}, data: "ok" });
    const worker = new SessionWorker({
      minDelayMs: 0,
      onRequest: (observation) => statuses.push(observation.status),
    });
    await worker.http.getText("https://example.test");
    expect(statuses).toEqual([200]);
  });
  it("shares Retry-After cooldown across every admitted request", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const pacer = new HostPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      random: () => 0.5,
    });
    await pacer.start(async () => "first");
    pacer.report("rate-limited", "2");
    await pacer.start(async () => "second");
    expect(waits).toEqual([2_000]);
    expect(pacer.cooldownUntil).toBe(3_000);
  });

  it("applies exponential full-jitter backoff in the production HTTP retry path", async () => {
    const waits: number[] = [];
    let now = 1_000;
    vi.mocked(axios.request).mockClear();
    vi.mocked(axios.request)
      .mockResolvedValueOnce({ status: 429, headers: {}, data: "limited" })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: "ok" });
    const client = new HttpClient({
      minDelayMs: 0,
      backoff: { baseMs: 1_000, maxMs: 10_000, maxAttempts: 1 },
      random: () => 0.5,
      pacer: new HostPacer(0, {
        now: () => now,
        random: () => 0,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      }),
    });

    await expect(client.getText("https://example.test")).resolves.toMatchObject({ status: 200 });
    expect(waits).toEqual([500]);
    expect(axios.request).toHaveBeenCalledTimes(2);
  });

  it("increases its interval under pressure and recovers after successful requests", () => {
    let now = 10_000;
    const pacer = new HostPacer(100, { now: () => now, sleep: async () => {}, random: () => 0 });
    pacer.report("rate-limited");
    expect(pacer.intervalMs).toBe(200);
    for (let index = 0; index < 2; index++) {
      now += 1_000;
      pacer.report("success");
    }
    expect(pacer.intervalMs).toBe(100);
  });

  it("bounds adaptive spacing without turning cooldown into minute-long success delays", () => {
    const pacer = new HostPacer(100, { now: () => 1_000, sleep: async () => {}, random: () => 0 });
    pacer.report("rate-limited");
    pacer.report("rate-limited");
    expect(pacer.intervalMs).toBe(400);
    for (let index = 0; index < 20; index++) pacer.report("rate-limited");
    expect(pacer.intervalMs).toBe(400);
  });
  it("preserva el delay mínimo entre clientes concurrentes del mismo host", async () => {
    const starts: number[] = [];
    let now = 0;
    vi.mocked(axios.request).mockImplementation(async () => {
      starts.push(now);
      return { status: 200, headers: {}, data: "ok" };
    });
    const pacer = new HostPacer(25, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    const first = new HttpClient({ minDelayMs: 25, pacer });
    const second = new HttpClient({ minDelayMs: 25, pacer });

    await Promise.all([
      first.getText("https://jurisprudencia.pj.gob.pe/one"),
      second.getText("https://jurisprudencia.pj.gob.pe/two"),
      first.getText("https://jurisprudencia.pj.gob.pe/three"),
    ]);

    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(25);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(25);
  });

  it("no comparte esperas entre pacers independientes", async () => {
    const starts: number[] = [];
    vi.mocked(axios.request).mockImplementation(async () => {
      starts.push(Date.now());
      return { status: 200, headers: {}, data: "ok" };
    });
    const first = new HttpClient({ minDelayMs: 100, pacer: new HostPacer(100) });
    const second = new HttpClient({ minDelayMs: 100, pacer: new HostPacer(100) });

    await Promise.all([
      first.getText("https://one.example.test"),
      second.getText("https://two.example.test"),
    ]);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeLessThan(50);
  });
});

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
    const c = new AimdController({
      initialConcurrency: 1,
      maxConcurrency: 4,
      rampUpAfter: 5,
      cooldownMs: 0,
    });
    for (let i = 0; i < 5; i++) c.report("success");
    expect(c.concurrency).toBe(2);
    for (let i = 0; i < 5; i++) c.report("success");
    expect(c.concurrency).toBe(3);
  });

  it("no supera maxConcurrency", () => {
    const c = new AimdController({
      initialConcurrency: 1,
      maxConcurrency: 2,
      rampUpAfter: 1,
      cooldownMs: 0,
    });
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

describe("AdaptiveSemaphore", () => {
  it("respeta el límite concurrente", async () => {
    const sem = new AdaptiveSemaphore(() => 2);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      sem.release();
    };
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
  });

  it("sigue el límite dinámico (AIMD sube la capacidad)", async () => {
    let limit = 1;
    const sem = new AdaptiveSemaphore(() => limit);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      sem.release();
    };
    const running = Promise.all(Array.from({ length: 8 }, task));
    await new Promise((r) => setTimeout(r, 15));
    limit = 3;
    await running;
    expect(peak).toBeGreaterThan(1);
  });
});
