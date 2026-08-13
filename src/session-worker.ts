import type { SearchFilters } from "./config";
import { DetailClient } from "./detail";
import { HttpClient } from "./http/client";
import { SiteSession } from "./http/session";
import { Paginator } from "./paginate";
import type { ParsedResultsPage } from "./parser";
import type { AimdController } from "./ratelimit";
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

  constructor(opts: { minDelayMs: number; aimd?: AimdController }) {
    const cookieHolder = { value: "" };
    this.http = new HttpClient({
      cookie: () => cookieHolder.value,
      minDelayMs: opts.minDelayMs,
      aimd: opts.aimd,
    });
    this.session = new SiteSession(this.http, cookieHolder);
    this.searchClient = new SearchClient(this.http, this.session);
    this.paginator = new Paginator(this.http, this.session);
    this.detailClient = new DetailClient(this.http, this.session);
  }

  /** Busca (login + POST + 302) si esta sesión aún no lo hizo; devuelve página 1. */
  async ensureSearched(filters: SearchFilters): Promise<ParsedResultsPage> {
    if (!this.searched) {
      this.searched = await this.searchClient.search(filters);
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
    this.searched = await this.searchClient.search(filters);
    return this.searched;
  }
}
