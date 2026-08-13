/** Base URLs del sitio (JSF/RichFaces). */
export const SITE = {
  baseUrl: "https://jurisprudencia.pj.gob.pe",
  inicio: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/inicio.xhtml",
  resultado: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml",
  descarga: "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga",
} as const;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15";

export const RESULTS_PER_PAGE = 10;

/** Opciones de línea de comandos. */
export interface CliOptions {
  /** Texto de búsqueda (vacío = búsqueda general completa). */
  query: string;
  /** Corte: 1 = Suprema (default), 2 = Superior. */
  corte: string;
  especialidad: string;
  anio: string;
  /** Limitar número de páginas (demo). 0 = todas. */
  pages: number;
  /** Limitar número de descargas de archivos (demo). 0 = todos. */
  maxFiles: number;
  /** Concurrencia inicial de descargas. */
  concurrency: number;
  /** Sesiones de navegación paralelas (cada una con su propia JSESSIONID). */
  sessions: number;
  /** Delay mínimo entre requests (ms). */
  minDelay: number;
  /** Directorio de salida. */
  out: string;
  /** Borrar el estado previo (scraper.sqlite) y scrapear desde cero. */
  fresh: boolean;
  /** Solo errores y resumen. */
  quiet: boolean;
}

export const DEFAULT_OPTIONS: CliOptions = {
  query: "",
  corte: "1",
  especialidad: "",
  anio: "",
  pages: 0,
  maxFiles: 0,
  concurrency: 2,
  sessions: 1,
  minDelay: 500,
  out: "data",
  fresh: false,
  quiet: false,
};

/** Metadata de la card de resultados (una fila). */
export interface CardRecord {
  uuid: string;
  recurso: string;
  nroexp: string;
  palabras: string;
  pretensiones: string;
  normaDI: string;
  tipoResolucion: string;
  fechaResolucion: string;
  sala: string;
  sumilla: string;
  /** Índice de fila dentro de la página (repeat:N). */
  rowIndex: number;
}

/** Metadata de la ficha "Ver Ficha" (popup). */
export interface DetailRecord {
  // DATOS DE LA RESOLUCIÓN
  fechaResolucion: string;
  tipoResolucion: string;
  falloSentido: string;
  juecesSupremos: string;
  ponente: string;
  dirimente: string;
  discordia: string;
  votoConcordado: string;
  fundamentosAdicionales: string;
  sumilla: string;
  normaDerechoInterno: string;
  jurisprudenciaNacionalAcuerdoPlenario: string;
  normaDerechoInternacional: string;
  organismoEmisorJurisprudenciaInternacional: string;
  palabrasClave: string;
  relevante: string;
  vinculante: string;
  fechaPublicacionElPeruano: string;
  // DATOS DEL PROCESO
  sala: string;
  distritoJudicialProcedencia: string;
  especialidad: string;
  materiaCausa: string;
  pretensionDelito: string;
  regimenProcesal: string;
  tipoProceso: string;
  nroExpedienteSalaSuperior: string;
  uuidPdf: string;
  uuidWord: string;
  // DATOS DE PROCEDENCIA
  fechaDemanda: string;
  fechaCalificacion: string;
  organoJurisdiccionalProcedencia: string;
  fallo: string;
  tipoResolucionProcedencia: string;
  expedienteProcedencia: string;
  fechaResolucionProcedencia: string;
  organoJurisdiccionalOrigen: string;
  falloOrigen: string;
  tipoResolucionOrigen: string;
  expedienteOrigen: string;
  fechaResolucionOrigen: string;
  fechaDenunciaOrigen: string;
}

export const EMPTY_DETAIL: DetailRecord = {
  fechaResolucion: "",
  tipoResolucion: "",
  falloSentido: "",
  juecesSupremos: "",
  ponente: "",
  dirimente: "",
  discordia: "",
  votoConcordado: "",
  fundamentosAdicionales: "",
  sumilla: "",
  normaDerechoInterno: "",
  jurisprudenciaNacionalAcuerdoPlenario: "",
  normaDerechoInternacional: "",
  organismoEmisorJurisprudenciaInternacional: "",
  palabrasClave: "",
  relevante: "",
  vinculante: "",
  fechaPublicacionElPeruano: "",
  sala: "",
  distritoJudicialProcedencia: "",
  especialidad: "",
  materiaCausa: "",
  pretensionDelito: "",
  regimenProcesal: "",
  tipoProceso: "",
  nroExpedienteSalaSuperior: "",
  uuidPdf: "",
  uuidWord: "",
  fechaDemanda: "",
  fechaCalificacion: "",
  organoJurisdiccionalProcedencia: "",
  fallo: "",
  tipoResolucionProcedencia: "",
  expedienteProcedencia: "",
  fechaResolucionProcedencia: "",
  organoJurisdiccionalOrigen: "",
  falloOrigen: "",
  tipoResolucionOrigen: "",
  expedienteOrigen: "",
  fechaResolucionOrigen: "",
  fechaDenunciaOrigen: "",
};

/** Registro completo de salida: card + detalle + derivados. */
export interface FullRecord {
  uuid: string;
  recurso: string;
  nro_expediente: string;
  card: CardRecord;
  detail: DetailRecord;
  query: string;
  pagina: number;
  row_index: number;
  scraped_at: string;
  pdf_path: string;
  word_path: string;
}

/** Filtros de búsqueda (lo que llena el form). */
export interface SearchFilters {
  query: string;
  corte: string;
  especialidad?: string;
  anio?: string;
}

/**
 * Campos base del formulario de búsqueda que el servidor JSF espera.
 * Ver docs/spec.md §2 (búsqueda), §4 (paginación) y §5 (Ver Ficha).
 */
export function buildSearchFormValues(f: SearchFilters): Record<string, string> {
  return {
    formBuscador: "formBuscador",
    "formBuscador:tabpanel-value": "general",
    "formBuscador:txtBusqueda": f.query,
    "formBuscador:buNroExpediente": "",
    "formBuscador:buPretensionDelitoSupInput": "",
    "formBuscador:buPretensionDelitoSupValue": "",
    "formBuscador:buPretensionInput": "",
    "formBuscador:buPretensionValue": "",
    "formBuscador:buPalabraClaveInput": "",
    "formBuscador:buPalabraClaveValue": "",
    "formBuscador:buCorte": f.corte,
    "formBuscador:buDistrito": "",
    "formBuscador:buEspecialidad": f.especialidad ?? "",
    "formBuscador:buSala": "",
    "formBuscador:buAnio": f.anio ?? "",
  };
}

/**
 * Campos completos del POST de paginación a resultado.xhtml
 * (verificado: POST con spinner=N + j_idt447 devuelve la página N).
 */
export function buildPaginationFormValues(f: SearchFilters, page: number): Record<string, string> {
  return {
    ...buildSearchFormValues(f),
    "formBuscador:buDistrito": "0",
    "formBuscador:buEspecialidad": f.especialidad ?? "0",
    "formBuscador:buSala": "0",
    "formBuscador:buNcpp": "0",
    "formBuscador:buNlpt": "0",
    "formBuscador:buTipoRecurso": "0",
    "formBuscador:buTipoResolucion": "",
    "formBuscador:buTipoResolucionInput": "",
    "formBuscador:buOrden": "21",
    "formBuscador:buOrdenForma": "DESC",
    "formBuscador:buPaginas": String(RESULTS_PER_PAGE),
    "formBuscador:spinner": String(page),
    "formBuscador:j_idt447": "formBuscador:j_idt447",
  };
}

/**
 * Campos completos del POST AJAX de "Ver Ficha"
 * (params exactos del request real capturado — ver docs/spec.md §5).
 */
export function buildDetailFormValues(
  f: SearchFilters,
  page: number,
  card: CardRecord,
): Record<string, string> {
  return {
    ...buildSearchFormValues(f),
    "formBuscador:buDistrito": "0",
    "formBuscador:buEspecialidad": f.especialidad ?? "0",
    "formBuscador:buPretensionValue": "",
    "formBuscador:buPretensionInput": "",
    "formBuscador:buPalabraClaveValue": "",
    "formBuscador:buPalabraClaveInput": "",
    "formBuscador:buSala": "0",
    "formBuscador:buPretensionDelitoSupValue": "",
    "formBuscador:buPretensionDelitoSupInput": "",
    "formBuscador:buTipoRecurso": "0",
    "formBuscador:buTipoResolucion": "0",
    "formBuscador:buTipoResolucionInput": "-- Todos --",
    "formBuscador:buOrden": "21",
    "formBuscador:buOrdenForma": "DESC",
    "formBuscador:j_idt434": "on",
    "formBuscador:spinner": String(page),
    "formBuscador:j_idt540": "on",
    "formBuscador:spinner2": String(page),
    "javax.faces.source": `formBuscador:repeat:${card.rowIndex}:j_idt491`,
    "javax.faces.partial.event": "click",
    "javax.faces.partial.execute": `formBuscador:repeat:${card.rowIndex}:j_idt491 @component`,
    "javax.faces.partial.render": "@component",
    "org.richfaces.ajax.component": `formBuscador:repeat:${card.rowIndex}:j_idt491`,
    [`formBuscador:repeat:${card.rowIndex}:j_idt491`]: `formBuscador:repeat:${card.rowIndex}:j_idt491`,
    "AJAX:EVENTS_COUNT": "1",
    "javax.faces.partial.ajax": "true",
    uuid: card.uuid,
    recurso: card.recurso,
    nroexp: card.nroexp,
    palabras: card.palabras,
    pretensiones: card.pretensiones,
    normaDI: card.normaDI,
    tipoResolucion: card.tipoResolucion,
    fechaResolucion: card.fechaResolucion,
    sala: card.sala,
    sumilla: card.sumilla,
  };
}
