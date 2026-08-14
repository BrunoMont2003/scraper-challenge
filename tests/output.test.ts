import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicReplaceSync } from "../src/atomic-file";
import { type FlatRecord, OutputWriter } from "../src/output";

function record(overrides: Partial<FlatRecord> = {}): FlatRecord {
  return {
    uuid: "doc-1",
    recurso: "Casación",
    nro_expediente: "1-2026",
    pretension_delito: "",
    tipo_resolucion: "",
    fecha_resolucion: "",
    sala: "",
    norma_derecho_interno: "",
    sumilla: "",
    palabras_clave: "",
    fallo_sentido: "",
    jueces_supremos: "",
    ponente: "",
    dirimente: "",
    discordia: "",
    voto_concordado: "",
    fundamentos_adicionales: "",
    jurisprudencia_nacional_acuerdo_plenario: "",
    norma_derecho_internacional: "",
    organismo_emisor_jurisprudencia_internacional: "",
    relevante: "",
    vinculante: "",
    fecha_publicacion_el_peruano: "",
    distrito_judicial_procedencia: "",
    especialidad: "",
    materia_causa: "",
    regimen_procesal: "",
    tipo_proceso: "",
    nro_expediente_sala_superior: "",
    fecha_demanda: "",
    fecha_calificacion: "",
    organo_jurisdiccional_procedencia: "",
    fallo: "",
    tipo_resolucion_procedencia: "",
    expediente_procedencia: "",
    fecha_resolucion_procedencia: "",
    organo_jurisdiccional_origen: "",
    fallo_origen: "",
    tipo_resolucion_origen: "",
    expediente_origen: "",
    fecha_resolucion_origen: "",
    fecha_denuncia_origen: "",
    uuid_pdf: "",
    uuid_word: "",
    query: "laboral",
    pagina: 1,
    row_index: 0,
    pdf_path: "",
    word_path: "",
    scraped_at: "2026-08-13 19:00:00",
    ...overrides,
  };
}

describe("atomic artifact publication", () => {
  it("keeps the previous artifact when replacement is interrupted", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-atomic-"));
    const target = join(directory, "results.jsonl");
    writeFileSync(target, "valid\n");

    expect(() =>
      atomicReplaceSync(target, (temporaryPath) => {
        writeFileSync(temporaryPath, "partial");
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");

    expect(readFileSync(target, "utf8")).toBe("valid\n");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

describe("OutputWriter", () => {
  it("streams a one-shot iterable to JSONL and correctly escaped CSV", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-output-"));
    const writer = new OutputWriter(directory);
    let iterations = 0;
    const records: Iterable<FlatRecord> = {
      *[Symbol.iterator]() {
        iterations++;
        if (iterations > 1) throw new Error("iterated more than once");
        yield record({ sumilla: 'línea 1, "citada"\nlínea 2' });
        yield record({ uuid: "doc-2", scraped_at: "2026-08-12 10:11:12" });
      },
    };

    expect(writer.write(records)).toBe(2);
    expect(iterations).toBe(1);
    expect(readFileSync(writer.jsonlPath, "utf8").trim().split("\n")).toHaveLength(2);
    const csv = readFileSync(writer.csvPath, "utf8");
    expect(csv).toContain('"línea 1, ""citada""\nlínea 2"');
    expect(csv).toContain("2026-08-12 10:11:12");
  });

  it("preserves persisted scrape timestamps across repeated exports", () => {
    const directory = mkdtempSync(join(tmpdir(), "scraper-output-time-"));
    const writer = new OutputWriter(directory);
    const persisted = record({ scraped_at: "2026-07-01 01:02:03" });

    writer.write([persisted]);
    const first = readFileSync(writer.jsonlPath, "utf8");
    writer.write([persisted]);

    expect(readFileSync(writer.jsonlPath, "utf8")).toBe(first);
    expect(JSON.parse(first).scraped_at).toBe("2026-07-01 01:02:03");
  });
});
