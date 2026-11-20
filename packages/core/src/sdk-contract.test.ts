// The SDK wire contract is types plus constants (sdk-contract.ts); this pins the constants the SDK,
// the API and the admin console must agree on, and ties them to the database checks they mirror.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_LIMITS, SDK_PATTERNS, SDK_ROUTES, SDK_WIRE_VERSION, type SdkAttribution, type SdkField } from "./index.ts";

const re = (source: string, flags = ""): RegExp => new RegExp(source, flags);

describe("SDK wire contract", () => {
  it("is wire version 1 with the v1 routes", () => {
    expect(SDK_WIRE_VERSION).toBe(1);
    expect(Object.values(SDK_ROUTES)).toEqual([
      "/api/v1/lp/{lp_key}/config",
      "/api/v1/visit/{lp_key}",
      "/api/v1/cap/{lp_key}/",
      "/api/v1/checkout/{lp_key}",
    ]);
    for (const route of Object.values(SDK_ROUTES)) expect(route.startsWith("/api/v1/")).toBe(true);
  });

  it("fits an lp key (lp_ + 40), the adnet columns' checks (64 characters) and the longest fbc", () => {
    expect(SDK_LIMITS.lpKeyMax).toBe("lp_".length + 40);
    expect(SDK_LIMITS.adnetSlug).toBe(64);
    expect(SDK_LIMITS.clickidParam).toBe(64);
    expect(SDK_LIMITS.fbc).toBeGreaterThanOrEqual("fb.1.".length + 13 + 1 + SDK_LIMITS.fbclid);
  });

  it("keeps every attribution key optional (a visit without a click is an empty object)", () => {
    const none: SdkAttribution = {};
    expect(Object.keys(none)).toEqual([]);
    const field: SdkField = "consent";
    expect(field).toBe("consent");
  });
});

describe("pattern sources", () => {
  it("lp key: lp_ and 8 to 40 base62 characters (landing_pages_lp_key_check)", () => {
    const lpKey = re(SDK_PATTERNS.lpKey);
    expect(lpKey.test("lp_Abcdefgh12345678abcdefgh")).toBe(true);
    expect(lpKey.test(`lp_${"a".repeat(40)}`)).toBe(true);
    for (const bad of ["lp_short", `lp_${"a".repeat(41)}`, "lp_abc-defgh1", "LP_abcdefgh12", "xlp_abcdefgh12", "lp_abcdefgh12\n"]) expect(lpKey.test(bad), bad).toBe(false);
    expect("lp_".length + 40).toBe(SDK_LIMITS.lpKeyMax);
  });

  it("uuid: lowercase only, as PostgreSQL prints it", () => {
    const uuid = re(SDK_PATTERNS.uuid);
    expect(uuid.test("0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f")).toBe(true);
    for (const bad of ["0B9F5F0E-2C1D-4E6A-9D3F-1A2B3C4D5E6F", "0b9f5f0e2c1d4e6a9d3f1a2b3c4d5e6f", "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6", "{0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f}", ""]) {
      expect(uuid.test(bad), bad).toBe(false);
    }
  });

  it("slug, click-id parameter and the three pixel id formats", () => {
    expect(re(SDK_PATTERNS.slug).test("adnet-a")).toBe(true);
    expect(["Adnet", "-a", "a-", "a--b", "a_b"].filter((s) => re(SDK_PATTERNS.slug).test(s))).toEqual([]);
    expect(re(SDK_PATTERNS.clickidParam).test("aff_click_id")).toBe(true);
    expect(["", "a b", "a".repeat(65), "a/b"].filter((s) => re(SDK_PATTERNS.clickidParam).test(s))).toEqual([]);
    expect(re(SDK_PATTERNS.metaPixel).test("1234567890123")).toBe(true);
    expect(re(SDK_PATTERNS.metaPixel).test("123456789")).toBe(false);
    expect(re(SDK_PATTERNS.tiktokPixel).test("ABCDEFGH12345678")).toBe(true);
    expect(re(SDK_PATTERNS.tiktokPixel).test("abcdefgh12345678")).toBe(false);
    expect(re(SDK_PATTERNS.googleAds).test("AW-123456789")).toBe(true);
    expect(re(SDK_PATTERNS.googleAds).test("G-123456789")).toBe(false);
  });

  it("character rules: tokens are printable ASCII without spaces; labels refuse control, bidi and private-use characters", () => {
    const token = re(SDK_PATTERNS.token);
    expect(token.test("Ab-1_.~:/=+%")).toBe(true);
    for (const bad of ["", "a b", "é", "a\nb", "a\u0000"]) expect(token.test(bad), JSON.stringify(bad)).toBe(false);
    const forbidden = re(SDK_PATTERNS.labelForbidden, "u");
    for (const bad of ["\u0000", "\n", "‮", "​", ""]) expect(forbidden.test(bad), JSON.stringify(bad)).toBe(true);
    for (const good of ["Promo Besar", "Hari Ibu", "été", "\u{1F389}"]) expect(forbidden.test(good), good).toBe(false);
  });

  it("Meta cookies: fb.<version>.<ms>.<id>", () => {
    expect(re(SDK_PATTERNS.fbp).test("fb.1.1700000000000.1234567890")).toBe(true);
    expect(re(SDK_PATTERNS.fbp).test("fb.1.1700000000000.abc")).toBe(false);
    expect(re(SDK_PATTERNS.fbc).test("fb.1.1700000000000.IwAR_x-1")).toBe(true);
    expect(re(SDK_PATTERNS.fbc).test("fb.1.1700000000000.a b")).toBe(false);
  });

  it("personalParamName: personal-data and credential WHOLE words (delimited by _ . - or the ends), any case", () => {
    const personal = re(SDK_PATTERNS.personalParamName, "i");
    for (const bad of [
      "email", "EMAIL", "e-mail", "user_email", "email_address", "no_hp", "nomor.hp", "no_wa", "wa_number", "phone", "phone_number", "whatsapp", "nama", "nama_lengkap", "full_name", "name",
      "access_token", "token", "otp", "kode_otp", "kode", "nik", "ktp", "card", "card_number", "kartu", "pass", "password", "user-password", "pwd", "secret", "client_secret", "auth", "session_id", "session",
    ]) {
      expect(personal.test(bad), bad).toBe(true);
    }
    for (const good of ["swap_id", "shpclid", "ad_wave", "gwa", "hpid", "clickid", "cid", "click_id", "aff_click_id", "transaction_id", "tid", "sid", "subid", "affid", "pid", "sub.id-1", "oauth", "username", "namaste", "hphone", "passage", "authors", "cardinal", "tokens", "sessions", "otpx", "wave", "awa"]) {
      expect(personal.test(good), good).toBe(false);
    }
  });

  it("personalParamName spells its delimiters out, so the JavaScript RegExp and the PostgreSQL ~* agree (no \\b, \\m or \\M)", () => {
    expect(SDK_PATTERNS.personalParamName).toMatch(/^\(\^\|\[_\.-\]\)\([a-z|]+\)\(\$\|\[_\.-\]\)$/);
    expect(SDK_PATTERNS.personalParamName).not.toMatch(/\\[bBmMyY]/);
  });

  it("the CHECK on adnets.clickid_param (schema and migration 0010) and the runbook's pre-check query hold exactly personalParamName", () => {
    const pattern = SDK_PATTERNS.personalParamName;
    const copies: [string, string][] = [
      ["../../db/src/schema/tracking.ts", `!~* '${pattern}'`],
      ["../../db/migrations/0010_clickid_param_not_personal.sql", `!~* '${pattern}'`],
      ["../../../docs/runbooks/staging-provision.md", `clickid_param ~* '${pattern}'`],
    ];
    for (const [file, expected] of copies) expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).toContain(expected);
  });

  it("limits a response may reach", () => {
    expect(SDK_LIMITS.valueIdrMax).toBe(10_000_000_000);
    expect(SDK_LIMITS.adnetsMax).toBe(100);
    expect(SDK_LIMITS.urlMax).toBe(2048);
  });
});
