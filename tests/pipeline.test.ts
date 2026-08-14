import { describe, expect, it, vi } from "vitest";
import { processPageIsolated, SessionWorker, withBoundedRecovery } from "../src/session-worker";

describe("bounded JSF recovery", () => {
  it("retries a malformed search response with a fresh site search", async () => {
    const worker = new SessionWorker({ minDelayMs: 0 });
    const search = vi
      .spyOn(worker.searchClient, "search")
      .mockRejectedValueOnce(new Error("Estructura de resultados inválida: falta el total"))
      .mockResolvedValueOnce({
        cards: [],
        currentPage: 1,
        lastPage: 1,
        totalResults: 1,
        viewState: "ok",
      });

    await expect(
      worker.ensureSearched({ query: "penal", corte: "1", especialidad: "", anio: "" }),
    ).resolves.toMatchObject({ totalResults: 1 });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("recupera una vez y limita un fallo persistente", async () => {
    let attempts = 0;
    const recovered = await withBoundedRecovery(
      async () => {
        if (++attempts === 1) throw new Error("ViewExpiredException");
        return "restored";
      },
      async () => undefined,
      2,
    );
    expect([recovered, attempts]).toEqual(["restored", 2]);

    attempts = 0;
    await expect(
      withBoundedRecovery(
        async () => {
          attempts++;
          throw new Error("ViewExpiredException");
        },
        async () => undefined,
        2,
      ),
    ).rejects.toThrow(/ViewExpired/);
    expect(attempts).toBe(3);
  });

  it("recovers transient JSF detail structures before declaring a document failed", async () => {
    let attempts = 0;
    let recoveries = 0;
    const detail = await withBoundedRecovery(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("Respuesta de detalle sin popupResolucion");
        return "detail restored";
      },
      async () => {
        recoveries++;
      },
      3,
    );

    expect(detail).toBe("detail restored");
    expect({ attempts, recoveries }).toEqual({ attempts: 2, recoveries: 1 });
  });
});

describe("page failure isolation", () => {
  it("registra una página intermedia agotada y continúa", async () => {
    const visited: number[] = [];
    const failed: number[] = [];
    for (const page of [1, 2, 3]) {
      await processPageIsolated(
        page,
        async () => {
          visited.push(page);
          if (page === 2) throw new Error("recovery exhausted");
        },
        (failedPage) => failed.push(failedPage),
      );
    }
    expect(visited).toEqual([1, 2, 3]);
    expect(failed).toEqual([2]);
  });
});
