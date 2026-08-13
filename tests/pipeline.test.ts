import { describe, expect, it } from "vitest";
import { processPageIsolated, withBoundedRecovery } from "../src/session-worker";

describe("bounded JSF recovery", () => {
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
