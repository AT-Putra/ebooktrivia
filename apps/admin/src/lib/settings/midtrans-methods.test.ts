// Owner D11 (US-005): the per-method switch of the Midtrans settings. The default list lives in packages/db/sql/seed.sql; this pins it to the
// Owner's ruling: every method of core MIDTRANS_METHODS is ON except the four the Owner's Midtrans account has not activated.
import { readFileSync } from "node:fs";
import { MIDTRANS_METHODS } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";

const SEED = readFileSync(new URL("../../../../../packages/db/sql/seed.sql", import.meta.url), "utf8");
const OFF_BY_DEFAULT = ["shopeepay", "bri_va", "cimb_va", "kredivo"];

/** The JSON list of one `('midtrans.enabled_methods', '[...]')` row of the seed. */
const seededDefault = (): string[] => {
  const match = /\('midtrans\.enabled_methods', '(\[[^']*\])'\)/.exec(SEED);
  if (match?.[1] === undefined) throw new Error("seed.sql has no midtrans.enabled_methods row");
  return JSON.parse(match[1]) as string[];
};

describe("the seeded default of midtrans.enabled_methods (Owner D11)", () => {
  it("is every known method except shopeepay, bri_va, cimb_va and kredivo", () => {
    const codes = MIDTRANS_METHODS.map((m) => m.code) as string[];
    expect(OFF_BY_DEFAULT.every((c) => codes.includes(c))).toBe(true);
    expect([...seededDefault()].sort()).toEqual(codes.filter((c) => !OFF_BY_DEFAULT.includes(c)).sort());
  });

  it("names every code once, and only codes the system knows", () => {
    const seeded = seededDefault();
    expect(new Set(seeded).size).toBe(seeded.length);
    const codes = MIDTRANS_METHODS.map((m) => m.code) as string[];
    expect(seeded.every((c) => codes.includes(c))).toBe(true);
  });

  it("is migrated from the pre-D11 default only while no admin ever saved the setting", () => {
    // The old default (shopeepay and bri_va on, cimb_va and the rest never listed) is replaced once, and only when untouched by an admin.
    expect(SEED).toMatch(/UPDATE public\.app_settings[\s\S]*?updated_by_admin_user_id IS NULL[\s\S]*?value = '\["other_qris", "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "permata_va", "echannel"\]'::jsonb;/);
  });
});
