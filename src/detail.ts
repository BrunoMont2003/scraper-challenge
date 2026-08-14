import { load } from "cheerio";
import type { AnyNode } from "domhandler";
import {
  buildDetailFormValues,
  type CardRecord,
  type DetailRecord,
  EMPTY_DETAIL,
  type SearchFilters,
  SITE,
} from "./config";
import type { HttpClient } from "./http/client";
import { SiteSession } from "./http/session";
import { ProtocolError, requireViewState } from "./parser";

const AJAX_HEADERS = {
  "Faces-Request": "partial/ajax",
  "X-Requested-With": "XMLHttpRequest",
  Referer: SITE.resultado,
};

/**
 * "Ver Ficha": POST AJAX parcial (JSF/RichFaces) que devuelve el popup con
 * la ficha completa del documento (docs/site-protocol.md). El request reenvía el
 * formulario completo + ViewState + parámetros de metadata de la fila.
 */
export class DetailClient {
  constructor(
    private readonly http: HttpClient,
    private readonly session: SiteSession,
  ) {}

  async fetchDetail(filters: SearchFilters, page: number, card: CardRecord): Promise<DetailRecord> {
    const data = buildDetailFormValues(filters, page, card);
    data["javax.faces.ViewState"] = this.session.viewStateValue;

    const res = await this.http.request("POST", SITE.resultado, data, "text", AJAX_HEADERS);
    const body = String(res.data);

    if (SiteSession.isViewExpired(body)) {
      throw new Error("ViewExpiredException en Ver Ficha");
    }
    if (/<partial-response>\s*<error>/.test(body)) {
      const name = /<error-name>([^<]*)<\/error-name>/.exec(body)?.[1] ?? "error";
      throw new Error(`Error AJAX: ${name}`);
    }

    const vs = requireViewState(body);
    this.session.setViewState(vs);

    return parseDetail(body);
  }
}

/** Parsea el partial-response XML de "Ver Ficha" y extrae los ~40 campos. */
export function parseDetail(partialXml: string): DetailRecord {
  // El popup viene dentro de <update id="formBuscador:popupResolucion"><![CDATA[...]]>
  const cdata = /id="formBuscador:popupResolucion"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/.exec(
    partialXml,
  )?.[1];
  if (!cdata) throw new ProtocolError("Respuesta de detalle sin popupResolucion");
  requireViewState(partialXml);

  const $ = load(cdata);
  const record: DetailRecord = { ...EMPTY_DETAIL };

  const panels = $(".panel-gris").toArray();
  let hasResolution = false;
  let hasProcess = false;
  for (const panelEl of panels) {
    const heading = normalizeLabel($(panelEl).find(".panel-heading").text());
    if (heading.includes("datos de la resolucion")) {
      hasResolution = true;
      applyPanel($, panelEl, RESOLUCION_FIELDS, record);
    } else if (heading.includes("datos del proceso")) {
      hasProcess = true;
      applyPanel($, panelEl, PROCESO_FIELDS, record);
    } else if (heading.includes("datos de procedencia")) {
      applyPanel($, panelEl, PROCEDENCIA_FIELDS, record);
    }
  }
  if (!hasResolution || !hasProcess) {
    throw new ProtocolError("Estructura de ficha inválida: faltan paneles obligatorios");
  }

  // Archivo de la Resolución: links PDF/Word dentro de cualquier panel.
  const content = load(cdata);
  record.uuidPdf = uuidFromIcon(content, "iconpdf");
  record.uuidWord = uuidFromIcon(content, "iconword");

  return record;
}

type FieldMap = Record<string, keyof DetailRecord>;

/** "*** Ponente:" / "Ponente:" / "N° de..." → "ponente" / "n de ...". */
function normalizeLabel(text: string): string {
  return text
    .replace(/\*\*\*/g, "")
    .replace(/°/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:+$/, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function applyPanel(
  $: ReturnType<typeof load>,
  panel: AnyNode,
  fieldMap: FieldMap,
  record: DetailRecord,
): void {
  const $panel = $(panel);
  $panel.find("div.txtbold").each((_, labelEl) => {
    const label = normalizeLabel($(labelEl).text());
    const key = fieldMap[label];
    if (!key) return;
    const value = $(labelEl).next().find("span.data").first().text().trim();
    (record as unknown as Record<string, string>)[key] = value;
  });
}

function uuidFromIcon($: ReturnType<typeof load>, iconFile: string): string {
  const href = $(`a[href*="ServletDescarga"]:has([src*="${iconFile}"])`).first().attr("href") ?? "";
  return /uuid=([a-f0-9-]+)/i.exec(href)?.[1] ?? "";
}

const RESOLUCION_FIELDS: FieldMap = {
  "fecha de la resolucion": "fechaResolucion",
  "tipo de resolucion": "tipoResolucion",
  "fallo/sentido de la resolucion": "falloSentido",
  "jueces supremos": "juecesSupremos",
  ponente: "ponente",
  dirimente: "dirimente",
  discordia: "discordia",
  "voto concordado": "votoConcordado",
  "fundamentos adicionales": "fundamentosAdicionales",
  sumilla: "sumilla",
  "norma de derecho interno": "normaDerechoInterno",
  "jurisprudencia nacional/acuerdo plenario": "jurisprudenciaNacionalAcuerdoPlenario",
  "norma de derecho internacional": "normaDerechoInternacional",
  "organismo emisor de jursiprudencia internacional": "organismoEmisorJurisprudenciaInternacional",
  "organismo emisor de jurisprudencia internacional": "organismoEmisorJurisprudenciaInternacional",
  "palabras clave": "palabrasClave",
  relevante: "relevante",
  vinculante: "vinculante",
  "fecha de publicacion en el peruano": "fechaPublicacionElPeruano",
};

const PROCESO_FIELDS: FieldMap = {
  sala: "sala",
  "distrito judicial de procedencia": "distritoJudicialProcedencia",
  especialidad: "especialidad",
  "materia de la causa": "materiaCausa",
  "pretension/delito": "pretensionDelito",
  "regimen procesal": "regimenProcesal",
  "tipo de proceso": "tipoProceso",
  "n de expediente de la sala superior": "nroExpedienteSalaSuperior",
};

const PROCEDENCIA_FIELDS: FieldMap = {
  "fecha de demanda": "fechaDemanda",
  "fecha de calificacion": "fechaCalificacion",
  "organo jurisdiccional de procedencia": "organoJurisdiccionalProcedencia",
  fallo: "fallo",
  "tipo de resolucion": "tipoResolucionProcedencia",
  "expediente de procedencia": "expedienteProcedencia",
  "fecha de resolucion de procedencia": "fechaResolucionProcedencia",
  "organo jurisdiccional de origen": "organoJurisdiccionalOrigen",
  "fallo de origen": "falloOrigen",
  "tipo de resolucion de origen": "tipoResolucionOrigen",
  "expediente de origen": "expedienteOrigen",
  "fecha de resolucion de origen": "fechaResolucionOrigen",
  "fecha de denuncia de origen": "fechaDenunciaOrigen",
};
