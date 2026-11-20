import { SDK_LIMITS } from "@ebooktrivia/core/sdk-contract";
import { describe, expect, it } from "vitest";
import { normalizeName, parseCheckoutRequest, sanitizeAttribution } from "./request.ts";

const valid = { v: 1, name: "  Budi\u0007  Santoso ", phone: "0812-3456-7890", email: " budi@example.id ", cap_token: "a:b", consent: { terms: 2, privacy: 1 }, attribution: {} };

describe("parseCheckoutRequest (the contract, server side)", () => {
  it("normalises name, phone (E.164) and e-mail, and ignores unknown top-level keys", () => {
    expect(parseCheckoutRequest({ ...valid, value_idr: 1, visit_id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" })).toEqual({
      kind: "ok",
      input: {
        name: "Budi Santoso",
        phone: "+6281234567890",
        email: "budi@example.id",
        capToken: "a:b",
        consent: { terms: 2, privacy: 1 },
        attribution: {},
        visitId: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      },
    });
  });

  it("ignores a visit_id that is not a lowercase UUID", () => {
    for (const visitId of ["6F1D2C3B-4A5E-4F60-8A7B-9C0D1E2F3A4B", "x", 1, null]) {
      const parsed = parseCheckoutRequest({ ...valid, visit_id: visitId });
      expect(parsed.kind === "ok" ? parsed.input.visitId : "not ok").toBeNull();
    }
  });

  it("names every bad field with the contract's codes", () => {
    expect(parseCheckoutRequest({ ...valid, name: "", phone: "+1 202 555 0100", email: "x@y" })).toEqual({ kind: "invalid", fields: { name: "required", phone: "not_indonesian", email: "invalid" } });
    expect(parseCheckoutRequest({ ...valid, name: "n".repeat(SDK_LIMITS.name + 1) })).toEqual({ kind: "invalid", fields: { name: "too_long" } });
    expect(parseCheckoutRequest({ ...valid, name: 3, phone: null, email: "a​@b.id" })).toEqual({ kind: "invalid", fields: { name: "required", phone: "empty", email: "required" } });
    expect(parseCheckoutRequest({ ...valid, email: `${"a".repeat(SDK_LIMITS.email)}@b.id` })).toEqual({ kind: "invalid", fields: { email: "invalid" } });
    for (const consent of [undefined, null, {}, { terms: 0, privacy: 1 }, { terms: 1.5, privacy: 1 }, { terms: 1, privacy: SDK_LIMITS.policyVersionMax + 1 }, [1, 1]]) {
      expect(parseCheckoutRequest({ ...valid, consent }), JSON.stringify(consent)).toEqual({ kind: "invalid", fields: { consent: "required" } });
    }
  });

  it("maps invisible fillers to spaces and refuses lone surrogates, private-use and unassigned code points in a name (P2-C)", () => {
    for (const filler of ["ᅟ", "ᅠ", "ㅤ", "ﾠ", "⠀"]) {
      expect(normalizeName(`  ${filler}Budi${filler}${filler}Santoso${filler} `), filler).toBe("Budi Santoso");
      expect(parseCheckoutRequest({ ...valid, name: filler.repeat(3) }), filler).toEqual({ kind: "invalid", fields: { name: "required" } });
    }
    for (const bad of ["Budi \ud800", "\udc00Budi", "Budi ", "Budi \u{f0000}", "Budi ͸", `${"a".repeat(130)}`]) {
      expect(parseCheckoutRequest({ ...valid, name: bad }), JSON.stringify(bad)).toEqual({ kind: "invalid", fields: { name: "required" } });
    }
    // Real names keep their letters, marks, apostrophes and even emoji.
    for (const name of ["Siti Nur’aini", "Nguyễn Văn An", "احمد", "Budi \u{1f600}"]) {
      const parsed = parseCheckoutRequest({ ...valid, name });
      expect(parsed.kind === "ok" ? parsed.input.name : parsed, name).toBe(name);
    }
  });

  it("is a captcha error when only the Cap token is missing or malformed; a field error wins", () => {
    for (const token of [undefined, "", 7, "x".repeat(SDK_LIMITS.capToken + 1)]) expect(parseCheckoutRequest({ ...valid, cap_token: token })).toEqual({ kind: "captcha" });
    expect(parseCheckoutRequest({ ...valid, cap_token: "", name: "" })).toEqual({ kind: "invalid", fields: { name: "required" } });
  });

  it("refuses another wire version or a body that is not an object, without fields", () => {
    for (const body of [{ ...valid, v: 2 }, null, [], "x", 1]) expect(parseCheckoutRequest(body)).toEqual({ kind: "invalid" });
  });
});

describe("sanitizeAttribution (drop, never reject)", () => {
  const adnets = new Map([["adn-a", "11111111-1111-4111-8111-111111111111"]]);

  it("keeps allowlisted values in shape and length, and the allowed adnet", () => {
    expect(
      sanitizeAttribution(
        { adnet: "adn-a", clickid: "C1", sub_id: "s", pub: "p", utm_source: " ig ", utm_medium: "m", utm_campaign: "c", utm_content: "x", utm_term: "t", fbclid: "f", fbp: "fb.1.1700000000000.123", fbc: "fb.1.1700000000000.f", ttclid: "tt", gclid: "g" },
        adnets,
      ),
    ).toEqual({
      adnetId: "11111111-1111-4111-8111-111111111111",
      values: { clickid: "C1", sub_id: "s", pub: "p", utm_source: "ig", utm_medium: "m", utm_campaign: "c", utm_content: "x", utm_term: "t", fbclid: "f", fbp: "fb.1.1700000000000.123", fbc: "fb.1.1700000000000.f", ttclid: "tt", gclid: "g" },
    });
  });

  it("drops what is too long, malformed, a contact detail or unknown", () => {
    expect(
      sanitizeAttribution(
        { adnet: "adn-a", clickid: "c".repeat(SDK_LIMITS.clickid + 1), sub_id: "a@b.id", pub: "081234567890", utm_source: "bad‮", utm_term: "", fbclid: "has space", fbp: "fb.1.x", fbc: 5, gclid: "g".repeat(SDK_LIMITS.gclid), evil: "1" },
        adnets,
      ),
    ).toEqual({ adnetId: "11111111-1111-4111-8111-111111111111", values: { gclid: "g".repeat(SDK_LIMITS.gclid) } });
  });

  it("makes an adnet the page does not allow organic: no adnet, no click id; the rest stays", () => {
    expect(sanitizeAttribution({ adnet: "other", clickid: "C1", utm_source: "ig" }, adnets)).toEqual({ adnetId: null, values: { utm_source: "ig" } });
    expect(sanitizeAttribution({ clickid: "C1" }, adnets)).toEqual({ adnetId: null, values: {} });
    expect(sanitizeAttribution({ adnet: "ADN-A", clickid: "C1" }, adnets)).toEqual({ adnetId: null, values: {} });
  });

  it("treats anything but an object as no attribution", () => {
    for (const raw of [undefined, null, "x", 1, ["a"]]) expect(sanitizeAttribution(raw, adnets)).toEqual({ adnetId: null, values: {} });
  });
});
