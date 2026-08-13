import { load } from "cheerio";
import { type CardRecord, RESULTS_PER_PAGE } from "./config";
import { extractViewState } from "./http/session";

export interface ParsedResultsPage {
  /** Total de resultados de la búsqueda. */
  totalResults: number;
  /** Página actual (valor del spinner). */
  currentPage: number;
  /** Última página disponible. */
  lastPage: number;
  /** ViewState rotado por el servidor en esta respuesta. */
  viewState: string;
  /** Cards de las 10 filas. */
  cards: CardRecord[];
}

/** Labels de la card → keys del CardRecord. */
const CARD_FIELDS: Record<string, keyof CardRecord> = {
  "Pretensión/Delito:": "pretensiones",
  "Tipo Resolución:": "tipoResolucion",
  "Fecha Resolución:": "fechaResolucion",
  "Sala Suprema:": "sala",
  "Norma de Derecho Interno:": "normaDI",
  "Sumilla:": "sumilla",
  "Palabras Clave:": "palabras",
};

export interface ParseResultsOptions {
  expectedPage?: number;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function requireViewState(body: string): string {
  const value =
    extractViewState(body) ||
    /<update\s+id="javax\.faces\.ViewState"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/
      .exec(body)?.[1]
      ?.trim() ||
    "";
  if (!value) throw new ProtocolError("Respuesta JSF sin javax.faces.ViewState");
  return value;
}

function requireProtocol(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProtocolError(message);
}

export function parseResultsPage(
  html: string,
  options: ParseResultsOptions = {},
): ParsedResultsPage {
  const $ = load(html);

  const totalText = $('span[id$="optResultado"]').first().text().trim();
  requireProtocol(totalText, "Estructura de resultados inválida: falta el total");
  const totalResults = parseNumber(totalText.match(/se obtuvieron\s+([\d.]+)\s+resultados/)?.[1]);

  const spinnerValue = $('input[name="formBuscador:spinner"]').attr("value");
  const currentPage = parseNumber(spinnerValue);
  requireProtocol(currentPage > 0, "Estructura de resultados inválida: falta la página actual");

  // La celda "de N" está antes del botón IR (j_idt447).
  const lastPageCell = $('input[name="formBuscador:j_idt447"]').closest("td").prev("td");
  const lastPage = parseNumber(lastPageCell.text());
  requireProtocol(
    lastPage >= currentPage,
    "Estructura de resultados inválida: paginación inconsistente",
  );

  const viewState = requireViewState(html);

  const cards: CardRecord[] = [];
  $('div[id^="formBuscador:repeat:"][id$=":j_idt455"]').each((_, el) => {
    const panel = $(el);
    const id = panel.attr("id") ?? "";
    const rowIndex = parseNumber(id.match(/repeat:(\d+):/)?.[1]) ?? -1;

    // Header: "  Recurso de Nulidad    000724-2025"
    const headerSpans = panel.find(".rf-p-hdr span[style*='font-weight:bold']");
    const recurso = (headerSpans.eq(0).text() ?? "").trim();
    const nroexp = (headerSpans.eq(1).text() ?? "").trim();

    const card = {
      uuid: "",
      recurso,
      nroexp,
      palabras: "",
      pretensiones: "",
      normaDI: "",
      tipoResolucion: "",
      fechaResolucion: "",
      sala: "",
      sumilla: "",
      rowIndex,
    } as CardRecord;

    panel.find("div.txtbold").each((_, labelEl) => {
      const label = $(labelEl).text().trim();
      const key = CARD_FIELDS[label];
      if (!key) return;
      const value = $(labelEl).next("div").text().trim();
      (card as unknown as Record<string, string>)[key] = value;
    });

    // uuid desde los params del onclick del link "Ver" (j_idt491)
    const verLink = panel.find(`a[id$=":j_idt491"]`).first();
    const params = extractAjaxParams(verLink.attr("onclick") ?? "");
    card.uuid = params.uuid ?? "";

    // fallback: link directo ServletDescarga?uuid=
    if (!card.uuid) {
      const link = panel.find('a[href*="ServletDescarga?uuid="]').first().attr("href") ?? "";
      card.uuid = /uuid=([a-f0-9-]+)/i.exec(link)?.[1] ?? "";
    }

    requireProtocol(card.uuid, `Card ${rowIndex} sin UUID`);

    cards.push(card);
  });

  requireProtocol(
    totalResults === 0 || (cards.length > 0 && cards.length <= RESULTS_PER_PAGE),
    "Estructura de resultados inválida: cantidad de cards inesperada",
  );
  if (options.expectedPage !== undefined) {
    requireProtocol(
      currentPage === options.expectedPage,
      `Se solicitó la página ${options.expectedPage}, pero la respuesta corresponde a la página ${currentPage}`,
    );
  }

  return { totalResults, currentPage, lastPage, viewState, cards };
}

/**
 * Extrae el objeto "parameters" del onclick de un comando JSF/RichFaces.
 * Ej: ...ajax("id",event,{"parameters":{"uuid":"...","recurso":"..."},"incId":"1"})
 */
export function extractAjaxParams(onclick: string): Record<string, string> {
  const match = /"parameters"\s*:\s*\{([\s\S]*?)\}\s*,\s*"incId"/.exec(onclick);
  if (!match) return {};
  const params: Record<string, string> = {};
  const re = /\\?"(\w+)\\?"\s*:\s*\\?"(.*?)\\?"\s*(?=,|\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1]!)) !== null) {
    const key = m[1]!;
    const value = decodeJsString(m[2] ?? "");
    params[key] = value;
  }
  return params;
}

/** Decodifica escapes JS dentro de strings de parámetros (\\u002D → -, \\/ → /). */
function decodeJsString(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/\./g, "").replace(/[^\d]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}
