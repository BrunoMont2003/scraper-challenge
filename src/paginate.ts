import { buildPaginationFormValues, type SearchFilters, SITE } from "./config";
import type { HttpClient } from "./http/client";
import { extractViewState, SiteSession } from "./http/session";
import { type ParsedResultsPage, parseResultsPage } from "./parser";

/**
 * Paginación (docs/spec.md §4): POST resultado.xhtml con spinner=N +
 * botón j_idt447 → 200 con la página N (sin redirect).
 */
export class Paginator {
  constructor(
    private readonly http: HttpClient,
    private readonly session: SiteSession,
  ) {}

  async goToPage(filters: SearchFilters, page: number): Promise<ParsedResultsPage> {
    const data = buildPaginationFormValues(filters, page);
    data["javax.faces.ViewState"] = this.session.viewStateValue;

    const res = await this.http.postText(SITE.resultado, data);
    const body = String(res.data);

    if (SiteSession.isViewExpired(body)) {
      throw new Error("ViewExpiredException en paginación");
    }

    const parsed = parseResultsPage(body);
    this.session.setViewState(extractViewState(body));
    return parsed;
  }
}
