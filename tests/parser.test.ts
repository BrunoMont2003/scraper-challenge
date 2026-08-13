import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResultsPage } from "../src/parser";

const FIXTURES = join(__dirname, "fixtures");

describe("parseResultsPage", () => {
  const html = readFileSync(join(FIXTURES, "results-page1.html"), "utf8");
  const page = parseResultsPage(html);

  it("extrae total y páginas", () => {
    expect(page.totalResults).toBe(4094);
    expect(page.currentPage).toBe(1);
    expect(page.lastPage).toBe(410);
  });

  it("extrae las 10 cards con metadata", () => {
    expect(page.cards).toHaveLength(10);
    const first = page.cards[0]!;
    expect(first.nroexp).toBe("000724-2025");
    expect(first.recurso).toBe("Recurso de Nulidad");
    expect(first.tipoResolucion).toBe("Ejecutoria Suprema");
    expect(first.fechaResolucion).toBe("24/07/2026");
    expect(first.sala).toBe("Sala Penal Transitoria");
    expect(first.pretensiones).toContain("Homicidio Calificado");
    expect(first.sumilla).toContain("nulidad de la sentencia");
  });

  it("extrae uuid de cada fila (formato uuid4)", () => {
    const uuidRe = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    for (const card of page.cards) {
      expect(card.uuid).toMatch(uuidRe);
    }
  });

  it("los rowIndex son 0..9", () => {
    expect(page.cards.map((c) => c.rowIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("extrae el ViewState", () => {
    expect(page.viewState.length).toBeGreaterThan(10);
    expect(page.viewState).toMatch(/^-?\d+:-?\d+$/);
  });
});

describe("parseResultsPage (página 2)", () => {
  const html = readFileSync(join(FIXTURES, "results-page2.html"), "utf8");
  const page = parseResultsPage(html);

  it("detecta página 2 y expedientes distintos", () => {
    expect(page.currentPage).toBe(2);
    const firstNroexp = page.cards[0]!.nroexp;
    expect(firstNroexp).toBe("000096-2026");
  });
});

describe("parseResultsPage protocol invariants", () => {
  const pageOne = readFileSync(join(FIXTURES, "results-page1.html"), "utf8");
  const pageTwo = readFileSync(join(FIXTURES, "results-page2.html"), "utf8");

  it("rechaza respuestas sin ViewState", () => {
    const withoutViewState = pageOne.replace(/<input[^>]+name="javax\.faces\.ViewState"[^>]*>/, "");
    expect(() => parseResultsPage(withoutViewState)).toThrow(/ViewState/);
  });

  it("rechaza cards sin UUID", () => {
    const firstUuid = parseResultsPage(pageOne).cards[0]!.uuid;
    const encodedUuid = firstUuid.replace(/-/g, "\\\\u002D");
    const withoutUuid = pageOne.replaceAll(encodedUuid, "").replaceAll(firstUuid, "");
    expect(() => parseResultsPage(withoutUuid)).toThrow(/UUID/);
  });

  it("rechaza una página distinta de la solicitada", () => {
    expect(() => parseResultsPage(pageTwo, { expectedPage: 1 })).toThrow(/página 1.*página 2/i);
  });

  it("rechaza una forma de resultados incompatible", () => {
    const withoutCards = pageOne.replace(/formBuscador:repeat:/g, "formBuscador:removed:");
    expect(() => parseResultsPage(withoutCards)).toThrow(/estructura.*resultados/i);
  });
});
