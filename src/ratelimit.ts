/**
 * Rate limiting adaptativo (AIMD) + backoff exponencial con full jitter.
 *
 * AIMD (additive increase / multiplicative decrease), igual que TCP:
 * - Tras `rampUpAfter` éxitos consecutivos, sube la concurrencia en 1
 *   (probe de capacidad).
 * - Ante un 429/5xx, divide la concurrencia a la mitad (reacción rápida).
 * - Piso 1, techo configurable; cooldown para evitar oscilación.
 *
 * Backoff por request: full jitter de Marc Brooker
 * `random(0, min(cap, base * 2^attempt))` — evita thundering herd.
 * `Retry-After` (segundos o fecha HTTP) tiene prioridad sobre el cálculo.
 */

export interface AimdOptions {
  initialConcurrency: number;
  maxConcurrency: number;
  /** Éxitos consecutivos necesarios para subir la concurrencia. */
  rampUpAfter: number;
  /** Segundos mínimos entre una bajada y una posible subida (cooldown). */
  cooldownMs: number;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_AIMD: AimdOptions = {
  initialConcurrency: 2,
  maxConcurrency: 6,
  rampUpAfter: 10,
  cooldownMs: 10_000,
};

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 60_000,
  maxAttempts: 5,
};

/** Parse del header Retry-After: segundos o fecha HTTP (RFC 7231). */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 3_600) * 1000; // clamp 1h
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delay = date - now;
    if (delay > 0 && delay < 3_600_000) return delay;
  }
  return null;
}

/** Delay de backoff con full jitter para el intento `attempt` (0-based). */
export function jitteredBackoff(opts: BackoffOptions, attempt: number): number {
  const cap = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

/** Señal para el controller: qué pasó con el último request. */
export type RateSignal = "success" | "rate-limited" | "server-error" | "network-error";

export class AimdController {
  private readonly opts: AimdOptions;
  private consecutiveSuccesses = 0;
  private lastDecreaseAt = 0;
  private _concurrency: number;

  constructor(opts: Partial<AimdOptions> = {}) {
    this.opts = { ...DEFAULT_AIMD, ...opts };
    this._concurrency = this.opts.initialConcurrency;
  }

  get concurrency(): number {
    return this._concurrency;
  }

  get maxConcurrency(): number {
    return this.opts.maxConcurrency;
  }

  /** Registrar el resultado de un request y ajustar la concurrencia. */
  report(signal: RateSignal): void {
    switch (signal) {
      case "success":
        this.consecutiveSuccesses += 1;
        if (
          this.consecutiveSuccesses >= this.opts.rampUpAfter &&
          this._concurrency < this.opts.maxConcurrency &&
          Date.now() - this.lastDecreaseAt > this.opts.cooldownMs
        ) {
          this._concurrency += 1;
          this.consecutiveSuccesses = 0;
        }
        break;
      case "rate-limited":
      case "server-error":
      case "network-error":
        this.consecutiveSuccesses = 0;
        this.lastDecreaseAt = Date.now();
        if (this._concurrency > 1) {
          this._concurrency = Math.max(1, Math.floor(this._concurrency / 2));
        }
        break;
    }
  }
}

/**
 * Delay entre corridas para un doc que ya falló `attempts` veces.
 * El reintento se espacia exponencialmente (cap 60s) para no martillar
 * un recurso que sigue fallando, sin abandonarlo nunca.
 */
export function crossRunDelay(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** (attempts - 1));
}

/**
 * Semáforo adaptativo: la capacidad se lee por callback en cada `acquire`,
 * así AIMD puede subir/bajar la concurrencia en caliente sin reconstruir
 * el pool. Polling corto a propósito (el límite cambia en cualquier momento).
 */
export class AdaptiveSemaphore {
  private active = 0;

  constructor(private readonly limit: () => number) {}

  async acquire(): Promise<void> {
    for (;;) {
      if (this.active < this.limit()) {
        this.active++;
        return;
      }
      await sleep(50);
    }
  }

  release(): void {
    if (this.active > 0) this.active--;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
