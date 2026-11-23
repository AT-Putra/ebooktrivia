import { describe, expect, it } from "vitest";
import { freshPhones } from "./seed-lib.ts";

describe("freshPhones", () => {
  it("leaves out a number that a player has OR that an order carries (a buyer who never became a player), and draws another", async () => {
    const queries: string[] = [];
    let taken = "";
    let round = 0;
    // postgres.js' `sql` is called two ways: `sql([...])` (a list for IN) and as a tagged template (the query).
    const sql = ((first: unknown, ...values: unknown[]) => {
      if (Array.isArray(first) && "raw" in first) {
        queries.push((first as unknown as string[]).join("?"));
        round++;
        const phones = values[0] as string[];
        if (round === 1) taken = phones[0] ?? "";
        return Promise.resolve(round === 1 ? [{ phone: taken }] : []);
      }
      return first;
    }) as unknown as Parameters<typeof freshPhones>[0];

    const phones = await freshPhones(sql, 3);
    expect(phones).toHaveLength(3);
    expect(new Set(phones).size).toBe(3);
    expect(round).toBe(2);
    for (const phone of phones) expect(phone).toMatch(/^\+62812\d{8}$/);
    // The first round's taken number is not among the result (a second draw replaced it).
    expect(phones).not.toContain(taken);
    // Both tables are asked, in the one query of each round.
    for (const query of queries) {
      expect(query).toMatch(/FROM public\.players WHERE phone IN/);
      expect(query).toMatch(/SELECT buyer_phone FROM public\.orders WHERE buyer_phone IN/);
    }
  });
});
