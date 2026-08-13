import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDetail } from "../src/detail";

const FIXTURES = join(__dirname, "fixtures");

describe("parseDetail (ficha Ver Ficha)", () => {
  const xml = readFileSync(join(FIXTURES, "detail-popup.xml"), "utf8");
  const detail = parseDetail(xml);

  it("extrae DATOS DE LA RESOLUCIÓN", () => {
    expect(detail.fechaResolucion).toBe("03/08/2026");
    expect(detail.tipoResolucion).toBe("Ejecutoria Suprema");
    expect(detail.juecesSupremos).toBe(
      "YAYA ZUMAETA, BUSTAMANTE DEL CASTILLO, DELGADO AYBAR, GUTIERREZ REMON, TOVAR BUENDIA",
    );
    expect(detail.ponente).toBe("GUTIERREZ REMON");
    expect(detail.relevante).toBe("No");
    expect(detail.vinculante).toBe("No");
  });

  it("extrae DATOS DEL PROCESO", () => {
    expect(detail.sala).toBe("Quinta Sala de Derecho Constitucional y Social Transitoria");
    expect(detail.distritoJudicialProcedencia).toBe("Piura");
    expect(detail.especialidad).toBe("Constitucional");
    expect(detail.pretensionDelito).toBe("Acción de Amparo");
    expect(detail.regimenProcesal).toBe("Tradicional");
    expect(detail.tipoProceso).toBe("Amparo");
    expect(detail.nroExpedienteSalaSuperior).toBe("17-2024-0");
  });

  it("extrae DATOS DE PROCEDENCIA (labels duplicados bien discriminados)", () => {
    expect(detail.fechaDemanda).toBe("12/02/2024");
    expect(detail.organoJurisdiccionalProcedencia).toBe("2 SALA CIVIL");
    expect(detail.fallo).toBe("Infundada la demanda");
    expect(detail.tipoResolucionProcedencia).toBe("Sentencia");
    // El "Tipo de Resolución:" del panel RESOLUCIÓN no debe pisar el de PROCEDENCIA
    expect(detail.tipoResolucion).toBe("Ejecutoria Suprema");
  });

  it("extrae uuid_pdf y uuid_word de los links del archivo", () => {
    expect(detail.uuidPdf).toBe("915c3959-f776-4f6e-8437-41aeb9814f13");
    expect(detail.uuidWord).toBe("718e272f-f400-458e-96b9-3f6dcd973f67");
  });
});

describe("parseDetail protocol invariants", () => {
  const xml = readFileSync(join(FIXTURES, "detail-popup.xml"), "utf8");

  it("rechaza una respuesta sin popup", () => {
    const withoutPopup = xml.replace('id="formBuscador:popupResolucion"', 'id="removed"');
    expect(() => parseDetail(withoutPopup)).toThrow(/popup/i);
  });

  it("rechaza una respuesta sin ViewState rotado", () => {
    const withoutViewState = xml.replace(
      /<update id="javax\.faces\.ViewState"><!\[CDATA\[[\s\S]*?\]\]><\/update>/,
      "",
    );
    expect(() => parseDetail(withoutViewState)).toThrow(/ViewState/);
  });

  it("rechaza un popup sin la estructura de ficha esperada", () => {
    const malformed = xml.replace(
      /<div class="panel panel-gris">[\s\S]*<\/div>\]\]><\/update>/,
      "</div>]]></update>",
    );
    expect(() => parseDetail(malformed)).toThrow(/estructura.*ficha/i);
  });
});
