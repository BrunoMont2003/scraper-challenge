import { buildSearchFormValues, type SearchFilters, SITE } from "./config";
import type { HttpClient } from "./http/client";
import { SiteSession } from "./http/session";
import { type ParsedResultsPage, parseResultsPage } from "./parser";

/**
 * Flujo de búsqueda (docs/spec.md §2):
 * GET inicio (sesión) → POST inicio con coordenadas del botón imagen →
 * 302 a resultado.xhtml (Location http:// → https://) → HTML de resultados.
 */
export class SearchClient {
  constructor(
    private readonly http: HttpClient,
    private readonly session: SiteSession,
  ) {}

  /** Ejecuta una búsqueda y devuelve la primera página parseada. */
  async search(filters: SearchFilters): Promise<ParsedResultsPage> {
    await this.session.login();

    const data = buildSearchFormValues(filters);
    Object.assign(data, {
      "formBuscador:j_idt31": "formBuscador:j_idt31",
      "formBuscador:j_idt31.x": "1",
      "formBuscador:j_idt31.y": "1",
      forward: "buscar",
      busqueda: "especializada",
      "formBuscador:j_idt34": "21",
      "formBuscador:j_idt35": "DESC",
      "formBuscador:j_idt36": "Principal",
      "formBuscador:j_idt37": "1",
      "javax.faces.ViewState": this.session.viewStateValue,
    });

    // POST a inicio → 302 → GET resultado (client reescribe http→https)
    const res = await this.http.postText(SITE.inicio, data);
    const body = String(res.data);

    if (SiteSession.isViewExpired(body)) {
      throw new Error("ViewExpiredException durante la búsqueda");
    }

    // Si el resultado sigue siendo la página de inicio (búsqueda no disparada)
    // puede ser un POST incompleto — reintento controlado por el caller.
    const parsed = parseResultsPage(body, { expectedPage: 1 });
    this.session.setViewState(parsed.viewState);
    return parsed;
  }
}
