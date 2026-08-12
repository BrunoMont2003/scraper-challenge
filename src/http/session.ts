import { SITE } from "../config";
import type { HttpClient } from "./client";

/**
 * Sesión del sitio: cookie JSESSIONID + javax.faces.ViewState.
 *
 * El sitio guarda los resultados de búsqueda en la sesión del servidor y
 * cada POST devuelve un ViewState rotado. Esta clase mantiene ambos y
 * detecta la expiración de la vista (ViewExpiredException) para re-login.
 *
 * La cookie vive en `cookieHolder` (propiedad del orquestador) para romper
 * la dependencia circular con HttpClient, que la lee por callback.
 */
export class SiteSession {
  private viewState = "";

  constructor(
    private readonly http: HttpClient,
    private readonly cookieHolder: { value: string },
  ) {}

  get cookieHeader(): string {
    return this.cookieHolder.value;
  }

  get viewStateValue(): string {
    return this.viewState;
  }

  setViewState(value: string): void {
    if (value) this.viewState = value;
  }

  /** GET inicio.xhtml → JSESSIONID + ViewState iniciales. */
  async login(): Promise<void> {
    const res = await this.http.getText(SITE.inicio);
    const body = String(res.data);
    const setCookie = res.headers["set-cookie"] ?? "";
    const match = /JSESSIONID=([^;]+)/.exec(setCookie);
    if (match) {
      this.cookieHolder.value = `JSESSIONID=${match[1]}`;
    } else if (!this.cookieHolder.value) {
      throw new Error("No se obtuvo JSESSIONID del sitio");
    }
    const vs = extractViewState(body);
    if (!vs) throw new Error("No se encontró javax.faces.ViewState en inicio.xhtml");
    this.viewState = vs;
  }

  /** True si el body indica que la vista expiró. */
  static isViewExpired(body: string): boolean {
    return body.includes("ViewExpiredException") || body.includes("could not be restored");
  }
}

/** Extrae el valor de javax.faces.ViewState de un HTML. */
export function extractViewState(html: string): string {
  const match = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/.exec(html);
  return match?.[1] ?? "";
}
