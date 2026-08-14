import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { commitTemporary, removeTemporary, temporarySibling } from "./atomic-file";
import type { DetailRecord } from "./config";

/** Registro plano de salida (1 por documento). */
export interface FlatRecord {
  uuid: string;
  recurso: string;
  nro_expediente: string;
  pretension_delito: string;
  tipo_resolucion: string;
  fecha_resolucion: string;
  sala: string;
  norma_derecho_interno: string;
  sumilla: string;
  palabras_clave: string;
  fallo_sentido: string;
  jueces_supremos: string;
  ponente: string;
  dirimente: string;
  discordia: string;
  voto_concordado: string;
  fundamentos_adicionales: string;
  jurisprudencia_nacional_acuerdo_plenario: string;
  norma_derecho_internacional: string;
  organismo_emisor_jurisprudencia_internacional: string;
  relevante: string;
  vinculante: string;
  fecha_publicacion_el_peruano: string;
  distrito_judicial_procedencia: string;
  especialidad: string;
  materia_causa: string;
  regimen_procesal: string;
  tipo_proceso: string;
  nro_expediente_sala_superior: string;
  fecha_demanda: string;
  fecha_calificacion: string;
  organo_jurisdiccional_procedencia: string;
  fallo: string;
  tipo_resolucion_procedencia: string;
  expediente_procedencia: string;
  fecha_resolucion_procedencia: string;
  organo_jurisdiccional_origen: string;
  fallo_origen: string;
  tipo_resolucion_origen: string;
  expediente_origen: string;
  fecha_resolucion_origen: string;
  fecha_denuncia_origen: string;
  uuid_pdf: string;
  uuid_word: string;
  query: string;
  pagina: number;
  row_index: number;
  pdf_path: string;
  word_path: string;
  scraped_at: string;
}

export const CSV_COLUMNS: Array<keyof FlatRecord> = [
  "uuid",
  "recurso",
  "nro_expediente",
  "pretension_delito",
  "tipo_resolucion",
  "fecha_resolucion",
  "sala",
  "norma_derecho_interno",
  "sumilla",
  "palabras_clave",
  "fallo_sentido",
  "jueces_supremos",
  "ponente",
  "dirimente",
  "discordia",
  "voto_concordado",
  "fundamentos_adicionales",
  "jurisprudencia_nacional_acuerdo_plenario",
  "norma_derecho_internacional",
  "organismo_emisor_jurisprudencia_internacional",
  "relevante",
  "vinculante",
  "fecha_publicacion_el_peruano",
  "distrito_judicial_procedencia",
  "especialidad",
  "materia_causa",
  "regimen_procesal",
  "tipo_proceso",
  "nro_expediente_sala_superior",
  "fecha_demanda",
  "fecha_calificacion",
  "organo_jurisdiccional_procedencia",
  "fallo",
  "tipo_resolucion_procedencia",
  "expediente_procedencia",
  "fecha_resolucion_procedencia",
  "organo_jurisdiccional_origen",
  "fallo_origen",
  "tipo_resolucion_origen",
  "expediente_origen",
  "fecha_resolucion_origen",
  "fecha_denuncia_origen",
  "uuid_pdf",
  "uuid_word",
  "query",
  "pagina",
  "row_index",
  "pdf_path",
  "word_path",
  "scraped_at",
];

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toFlatRecord(input: {
  uuid: string;
  recurso: string;
  nroexp: string;
  card: Record<string, string>;
  detail: DetailRecord;
  query: string;
  page: number;
  rowIndex: number;
  pdfPath: string;
  wordPath: string;
  scrapedAt: string;
}): FlatRecord {
  const d = input.detail;
  return {
    uuid: input.uuid,
    recurso: input.recurso,
    nro_expediente: input.nroexp,
    pretension_delito: d.pretensionDelito || (input.card.pretensiones ?? ""),
    tipo_resolucion: d.tipoResolucion || (input.card.tipoResolucion ?? ""),
    fecha_resolucion: d.fechaResolucion || (input.card.fechaResolucion ?? ""),
    sala: d.sala || (input.card.sala ?? ""),
    norma_derecho_interno: d.normaDerechoInterno || (input.card.normaDI ?? ""),
    sumilla: d.sumilla || (input.card.sumilla ?? ""),
    palabras_clave: d.palabrasClave || (input.card.palabras ?? ""),
    fallo_sentido: d.falloSentido,
    jueces_supremos: d.juecesSupremos,
    ponente: d.ponente,
    dirimente: d.dirimente,
    discordia: d.discordia,
    voto_concordado: d.votoConcordado,
    fundamentos_adicionales: d.fundamentosAdicionales,
    jurisprudencia_nacional_acuerdo_plenario: d.jurisprudenciaNacionalAcuerdoPlenario,
    norma_derecho_internacional: d.normaDerechoInternacional,
    organismo_emisor_jurisprudencia_internacional: d.organismoEmisorJurisprudenciaInternacional,
    relevante: d.relevante,
    vinculante: d.vinculante,
    fecha_publicacion_el_peruano: d.fechaPublicacionElPeruano,
    distrito_judicial_procedencia: d.distritoJudicialProcedencia,
    especialidad: d.especialidad,
    materia_causa: d.materiaCausa,
    regimen_procesal: d.regimenProcesal,
    tipo_proceso: d.tipoProceso,
    nro_expediente_sala_superior: d.nroExpedienteSalaSuperior,
    fecha_demanda: d.fechaDemanda,
    fecha_calificacion: d.fechaCalificacion,
    organo_jurisdiccional_procedencia: d.organoJurisdiccionalProcedencia,
    fallo: d.fallo,
    tipo_resolucion_procedencia: d.tipoResolucionProcedencia,
    expediente_procedencia: d.expedienteProcedencia,
    fecha_resolucion_procedencia: d.fechaResolucionProcedencia,
    organo_jurisdiccional_origen: d.organoJurisdiccionalOrigen,
    fallo_origen: d.falloOrigen,
    tipo_resolucion_origen: d.tipoResolucionOrigen,
    expediente_origen: d.expedienteOrigen,
    fecha_resolucion_origen: d.fechaResolucionOrigen,
    fecha_denuncia_origen: d.fechaDenunciaOrigen,
    uuid_pdf: d.uuidPdf,
    uuid_word: d.uuidWord,
    query: input.query,
    pagina: input.page,
    row_index: input.rowIndex,
    pdf_path: input.pdfPath,
    word_path: input.wordPath,
    scraped_at: input.scrapedAt,
  };
}

export class OutputWriter {
  readonly jsonlPath: string;
  readonly csvPath: string;

  constructor(outDir: string) {
    mkdirSync(outDir, { recursive: true });
    this.jsonlPath = join(outDir, "results.jsonl");
    this.csvPath = join(outDir, "results.csv");
  }

  /** Writes both complete exports from a single bounded-memory iterable. */
  write(records: Iterable<FlatRecord>): number {
    const jsonlTemporary = temporarySibling(this.jsonlPath);
    const csvTemporary = temporarySibling(this.csvPath);
    removeTemporary(jsonlTemporary);
    removeTemporary(csvTemporary);

    let jsonlFd: number | undefined;
    let csvFd: number | undefined;
    let count = 0;
    try {
      jsonlFd = openSync(jsonlTemporary, "wx");
      csvFd = openSync(csvTemporary, "wx");
      writeSync(csvFd, `${CSV_COLUMNS.join(",")}\n`);
      for (const record of records) {
        writeSync(jsonlFd, `${JSON.stringify(record)}\n`);
        writeSync(csvFd, `${CSV_COLUMNS.map((column) => csvEscape(record[column])).join(",")}\n`);
        count++;
      }
      closeSync(jsonlFd);
      jsonlFd = undefined;
      closeSync(csvFd);
      csvFd = undefined;
      if (statSync(csvTemporary).size === 0) throw new Error("CSV export validation failed");
      commitTemporary(jsonlTemporary, this.jsonlPath);
      commitTemporary(csvTemporary, this.csvPath);
      return count;
    } catch (error) {
      if (jsonlFd !== undefined) closeSync(jsonlFd);
      if (csvFd !== undefined) closeSync(csvFd);
      removeTemporary(jsonlTemporary);
      removeTemporary(csvTemporary);
      throw error;
    }
  }

  writeFailures(records: Iterable<Record<string, unknown>>, targetPath: string): number {
    const temporary = temporarySibling(targetPath);
    removeTemporary(temporary);
    let fd: number | undefined;
    let count = 0;
    try {
      fd = openSync(temporary, "wx");
      for (const record of records) {
        writeSync(fd, `${JSON.stringify(record)}\n`);
        count++;
      }
      closeSync(fd);
      fd = undefined;
      commitTemporary(temporary, targetPath);
      return count;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      removeTemporary(temporary);
      throw error;
    }
  }
}
