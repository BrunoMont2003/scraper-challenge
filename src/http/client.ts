import axios from "axios";
import { USER_AGENT } from "../config";
import {
  type AimdController,
  type BackoffOptions,
  DEFAULT_BACKOFF,
  HostPacer,
  jitteredBackoff,
  parseRetryAfter,
  type RateSignal,
} from "../ratelimit";

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  data: string | Buffer;
}

export interface ClientOptions {
  cookie?: () => string;
  minDelayMs: number;
  backoff?: Partial<BackoffOptions>;
  aimd?: AimdController;
  timeoutMs?: number;
  pacer?: HostPacer;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_TIMEOUT = 30_000;

/**
 * Cliente HTTP con:
 * - cookie de sesión inyectada por callback (la sesión rota),
 * - redirects manuales: el 302 del sitio viene con Location `http://`
 *   (puerto 80 cerrado) — siempre se reescribe a https,
 * - retry con full-jitter backoff para 429/5xx/errores de red,
 *   honorando Retry-After,
 * - delay mínimo entre requests (politeness).
 */
export class HttpClient {
  private readonly backoff: BackoffOptions;
  private readonly aimd: AimdController | undefined;
  private readonly pacer: HostPacer;

  constructor(private readonly opts: ClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.aimd = opts.aimd;
    this.pacer = opts.pacer ?? new HostPacer(opts.minDelayMs);
  }

  /** Un request sin retry ni redirects (uso interno). */
  private async requestOnce(
    method: "GET" | "POST",
    url: string,
    data?: Record<string, string>,
    responseType: "text" | "arraybuffer" = "text",
    extraHeaders: Record<string, string> = {},
  ): Promise<HttpResult> {
    try {
      const res = await this.pacer.start(() =>
        axios.request({
          method,
          url,
          data: data ?? undefined,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "*/*",
            "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
            ...(data ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
            ...(this.opts.cookie?.() ? { Cookie: this.opts.cookie() } : {}),
            ...extraHeaders,
          },
          maxRedirects: 0,
          validateStatus: () => true,
          timeout: this.opts.timeoutMs ?? DEFAULT_TIMEOUT,
          responseType,
          transitional: { clarifyTimeoutError: true },
        }),
      );
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k] = String(v);
      }
      const body = responseType === "arraybuffer" ? Buffer.from(res.data) : String(res.data ?? "");
      return { status: res.status, headers, data: body };
    } catch (err) {
      throw new NetworkError(err);
    }
  }

  /** Request con retry (429/5xx/red) y backoff. Sin seguir redirects. */
  async request(
    method: "GET" | "POST",
    url: string,
    data?: Record<string, string>,
    responseType: "text" | "arraybuffer" = "text",
    extraHeaders: Record<string, string> = {},
  ): Promise<HttpResult> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.requestOnce(method, url, data, responseType, extraHeaders);
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          const signal: RateSignal = res.status === 429 ? "rate-limited" : "server-error";
          this.aimd?.report(signal);
          if (attempt >= this.backoff.maxAttempts) {
            return res; // agotado: devolver y dejar que el caller decida
          }
          const retryAfter = parseRetryAfter(res.headers["retry-after"]);
          const delay = retryAfter ?? jitteredBackoff(this.backoff, attempt);
          await sleep(delay);
          attempt += 1;
          continue;
        }
        this.aimd?.report("success");
        return res;
      } catch (err) {
        this.aimd?.report("network-error");
        if (attempt >= this.backoff.maxAttempts) {
          throw err;
        }
        await sleep(jitteredBackoff(this.backoff, attempt));
        attempt += 1;
      }
    }
  }

  /**
   * Request siguiendo redirects manualmente (máx 10 hops).
   * Tras un 301/302/303 el siguiente hop es GET (comportamiento de browser);
   * un 307/308 preserva método y body.
   */
  async requestWithRedirects(
    method: "GET" | "POST",
    url: string,
    data?: Record<string, string>,
    responseType: "text" | "arraybuffer" = "text",
  ): Promise<{ result: HttpResult; finalUrl: string }> {
    let currentUrl = url;
    let currentMethod = method;
    let currentData = data;
    for (let hop = 0; hop < 10; hop++) {
      const res = await this.request(currentMethod, currentUrl, currentData, responseType);
      const location = res.headers["location"];
      if (REDIRECT_CODES.has(res.status) && location) {
        const preserveBody = res.status === 307 || res.status === 308;
        currentUrl = new URL(rewriteToHttps(location), currentUrl).toString();
        if (!preserveBody) {
          currentMethod = "GET";
          currentData = undefined;
        }
        continue;
      }
      return { result: res, finalUrl: currentUrl };
    }
    throw new Error("Demasiados redirects");
  }

  /** GET siguiendo redirects, devuelve texto. */
  async getText(url: string): Promise<HttpResult> {
    const { result } = await this.requestWithRedirects("GET", url);
    return result;
  }

  /** POST siguiendo redirects, devuelve texto. */
  async postText(url: string, data: Record<string, string>): Promise<HttpResult> {
    const { result } = await this.requestWithRedirects("POST", url, data);
    return result;
  }

  /** GET binario (descargas), siguiendo redirects. */
  async getBinary(url: string): Promise<HttpResult> {
    const { result } = await this.requestWithRedirects("GET", url, undefined, "arraybuffer");
    return result;
  }
}

/** El sitio redirige a http:// (puerto 80 cerrado) — siempre https. */
export function rewriteToHttps(url: string): string {
  return url.replace(/^http:\/\//i, "https://");
}

export class NetworkError extends Error {
  constructor(public override readonly cause: unknown) {
    super(axios.isAxiosError(cause) && cause.code === "ETIMEDOUT" ? "timeout" : "network error");
    this.name = "NetworkError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
