// Client-side feedback checks (the server stays the authority) and the Bahasa Indonesia messages.
import { describe, expect, it } from "vitest";
import { fill, text } from "./messages.ts";
import { checkForm, fieldMessage, type FormValues } from "./validate.ts";

const GOOD: FormValues = { name: "Budi Santoso", phone: "0812-3456-7890", email: "budi@example.co", consent: true };

describe("checkForm", () => {
  it("normalises the phone to E.164 and tidies the name and e-mail", () => {
    expect(checkForm({ ...GOOD, name: "  Budi \t Santoso  ", email: " budi@example.co " })).toEqual({ ok: true, name: "Budi Santoso", phone: "+6281234567890", email: "budi@example.co" });
  });

  it.each([
    ["08123456789", "+628123456789"],
    ["+62 812 3456 7890", "+6281234567890"],
    ["628123456789", "+628123456789"],
  ])("accepts the phone %s", (typed, e164) => {
    expect(checkForm({ ...GOOD, phone: typed })).toMatchObject({ ok: true, phone: e164 });
  });

  it("reports the phone error code of the shared normaliser", () => {
    expect(checkForm({ ...GOOD, phone: "" })).toEqual({ ok: false, errors: { phone: "empty" } });
    expect(checkForm({ ...GOOD, phone: "0212345678" })).toEqual({ ok: false, errors: { phone: "not_mobile" } });
    expect(checkForm({ ...GOOD, phone: "+1 415 555 0100" })).toEqual({ ok: false, errors: { phone: "not_indonesian" } });
    expect(checkForm({ ...GOOD, phone: "0812" })).toEqual({ ok: false, errors: { phone: "invalid_length" } });
    expect(checkForm({ ...GOOD, phone: "0812abc" })).toEqual({ ok: false, errors: { phone: "invalid_characters" } });
  });

  it("requires a name of at most 120 characters", () => {
    expect(checkForm({ ...GOOD, name: "   " })).toEqual({ ok: false, errors: { name: "required" } });
    expect(checkForm({ ...GOOD, name: "​\u0007" })).toEqual({ ok: false, errors: { name: "required" } });
    expect(checkForm({ ...GOOD, name: "a".repeat(120) })).toMatchObject({ ok: true });
    expect(checkForm({ ...GOOD, name: "a".repeat(121) })).toEqual({ ok: false, errors: { name: "too_long" } });
  });

  it("treats invisible fillers as spaces and refuses a name holding a lone surrogate, a private-use or an unassigned code point (the server's rule)", () => {
    for (const filler of ["ᅟ", "ᅠ", "ㅤ", "ﾠ", "⠀"]) {
      expect(checkForm({ ...GOOD, name: `${filler}${filler}` }), filler).toEqual({ ok: false, errors: { name: "required" } });
      expect(checkForm({ ...GOOD, name: `Budi${filler}Santoso` }), filler).toMatchObject({ ok: true, name: "Budi Santoso" });
    }
    for (const bad of ["Budi \ud800", "\udc00Budi", "Budi ", "Budi \u{10ffff}", "Budi ͸"]) {
      expect(checkForm({ ...GOOD, name: bad }), JSON.stringify(bad)).toEqual({ ok: false, errors: { name: "required" } });
    }
    expect(checkForm({ ...GOOD, name: "Siti Nur’aini \u{1f600}" })).toMatchObject({ ok: true });
  });

  it("requires a plausible e-mail address", () => {
    expect(checkForm({ ...GOOD, email: "" })).toEqual({ ok: false, errors: { email: "required" } });
    for (const email of ["budi", "budi@", "@example.co", "budi@example", "bu di@example.co", "a@@b.co", "budi@example..co", "budi@.co"]) {
      expect(checkForm({ ...GOOD, email }), email).toEqual({ ok: false, errors: { email: "invalid" } });
    }
    expect(checkForm({ ...GOOD, email: `${"a".repeat(250)}@b.co` })).toEqual({ ok: false, errors: { email: "invalid" } });
    expect(checkForm({ ...GOOD, email: "bu\u0000di@example.co" })).toEqual({ ok: false, errors: { email: "required" } });
  });

  it("requires the consent box", () => {
    expect(checkForm({ ...GOOD, consent: false })).toEqual({ ok: false, errors: { consent: "required" } });
  });

  it("reports every problem at once", () => {
    expect(checkForm({ name: "", phone: "x", email: "y", consent: false })).toEqual({
      ok: false,
      errors: { name: "required", phone: "invalid_characters", email: "invalid", consent: "required" },
    });
  });
});

describe("messages (Bahasa Indonesia, packages/i18n)", () => {
  it("has a message for every code the SDK and the API can report", () => {
    const codes = {
      name: ["required", "too_long"],
      phone: ["empty", "invalid_characters", "not_indonesian", "not_mobile", "invalid_length"],
      email: ["required", "invalid"],
      consent: ["required", "outdated"],
    } as const;
    for (const [field, list] of Object.entries(codes)) {
      const messages = list.map((code) => fieldMessage(field as keyof typeof codes, code));
      expect(new Set(messages).size, field).toBe(list.length);
      for (const message of messages) expect(message.length).toBeGreaterThan(8);
    }
    expect(fieldMessage("name", "too_long")).toBe("Nama terlalu panjang, maksimal 120 karakter.");
    expect(fieldMessage("phone", "unknown_code")).toBe(text.field.phone.invalidLength);
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    expect(fill("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
  });

  it("is Indonesian, not the English catalog", () => {
    expect(text.submitting).toBe("Memproses pesanan…");
    expect(text.consent.terms).toBe("Syarat & Ketentuan");
  });
});
