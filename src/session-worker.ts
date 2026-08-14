import type { CardRecord, DetailRecord, SearchFilters } from "./config";
import { DetailClient } from "./detail";
import { HttpClient, type RequestObservation } from "./http/client";
import { SiteSession } from "./http/session";
import { Paginator } from "./paginate";
import type { ParsedResultsPage } from "./parser";
import type { AimdController, HostPacer } from "./ratelimit";
import { SearchClient } from "./search";

/**
 * Una "sesión" de navegación: su propia cookie JSESSIONID + ViewState.
 *
 * El sitio guarda el resultado de búsqueda en la sesión del servidor, así
 * que dos sesiones independientes pueden paginar en paralelo sin pisarse:
 * cada una mantiene su ViewState rotante. `--sessions N` lanza N de estas.
 *
 * La cookie vive en un holder privado; HttpClient la lee por callback para
 * romper la dependencia circular (igual que en SiteSession).
 */
export class SessionWorker {
  readonly http: HttpClient;
  readonly session: SiteSession;
  readonly searchClient: SearchClient;
  readonly paginator: Paginator;
  readonly detailClient: DetailClient;

  private searched: ParsedResultsPage | null = null;

  constructor(opts: {
    minDelayMs: number;
    aimd?: AimdController;
    pacer?: HostPacer;
    onRequest?: (observation: RequestObservation) => void;
  }) {
    const cookieHolder = { value: "" };
    this.http = new HttpClient({
      cookie: () => cookieHolder.value,
      minDelayMs: opts.minDelayMs,
      aimd: opts.aimd,
      pacer: opts.pacer,
      onRequest: opts.onRequest,
    });
    this.session = new SiteSession(this.http, cookieHolder);
    this.searchClient = new SearchClient(this.http, this.session);
    this.paginator = new Paginator(this.http, this.session);
    this.detailClient = new DetailClient(this.http, this.session);
  }

  /** Busca (login + POST + 302) si esta sesión aún no lo hizo; devuelve página 1. */
  async ensureSearched(filters: SearchFilters): Promise<ParsedResultsPage> {
    if (!this.searched) {
      let attempts = 0;
      for (;;) {
        try {
          this.searched = await this.searchClient.search(filters);
          break;
        } catch (error) {
          attempts++;
          if (!isRecoverableSearchError(error) || attempts >= 3) throw error;
        }
      }
    }
    return this.searched;
  }

  /** Devuelve la página pedida: la 1 sale de la búsqueda, el resto del paginador. */
  async page(filters: SearchFilters, page: number): Promise<ParsedResultsPage> {
    if (page === 1) {
      if (!this.searched) throw new Error("SessionWorker.page(1) sin búsqueda previa");
      return this.searched;
    }
    return this.paginator.goToPage(filters, page);
  }

  /** Re-login + re-búsqueda tras ViewExpired; la sesión queda en la página 1. */
  async recover(filters: SearchFilters): Promise<ParsedResultsPage> {
    this.searched = null;
    return this.ensureSearched(filters);
  }

  async fetchPageWithRecovery(
    filters: SearchFilters,
    page: number,
    maxRecoveries = 3,
  ): Promise<ParsedResultsPage> {
    return withBoundedRecovery(
      () => this.page(filters, page),
      () => this.recover(filters),
      maxRecoveries,
    );
  }

  async fetchDetailWithRecovery(
    filters: SearchFilters,
    page: number,
    card: CardRecord,
    maxRecoveries = 3,
  ): Promise<DetailRecord> {
    return withBoundedRecovery(
      () => this.detailClient.fetchDetail(filters, page, card),
      async () => {
        await this.recover(filters);
        if (page > 1) await this.page(filters, page);
      },
      maxRecoveries,
    );
  }
}

function isRecoverableSearchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ViewExpired/i.test(error.message) || /Estructura de resultados inválida/i.test(error.message))
  );
}

function isRecoverableSessionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ViewExpired/i.test(error.message) ||
      /Respuesta de detalle sin popupResolucion/i.test(error.message) ||
      /Estructura de ficha inválida/i.test(error.message) ||
      /Estructura de resultados inválida/i.test(error.message) ||
      /Error AJAX/i.test(error.message))
  );
}

export async function withBoundedRecovery<T>(
  operation: () => Promise<T>,
  recover: () => Promise<unknown>,
  maxRecoveries: number,
): Promise<T> {
  let recoveries = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableSessionError(error) || recoveries >= maxRecoveries) throw error;
      recoveries++;
      await recover();
    }
  }
}

export async function processPageIsolated<T>(
  page: number,
  processPage: () => Promise<T>,
  recordFailure: (page: number, error: unknown) => Promise<void> | void,
): Promise<T | undefined> {
  try {
    return await processPage();
  } catch (error) {
    await recordFailure(page, error);
    return undefined;
  }
}
