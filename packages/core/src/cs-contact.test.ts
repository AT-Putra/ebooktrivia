import { describe, expect, it } from "vitest";
import {
  CS_HOURS_MAX,
  CS_LOCAL_PHONE,
  csLine,
  csLocalPhone,
  csTemplateValues,
  csWaMeDigits,
  hasCsContact,
  isCsEmail,
  isCsHours,
  NO_CS_CONTACT,
  normalizeIdMobile,
  renderMessage,
  TemplateError,
} from "./index.ts";

const NUMBER = "+6281234567890";
const HOURS = "Senin–Jumat 09.00–17.00 WIB";
/** The hours as a WhatsApp message carries them: a dot between digits or letters is U+2024 (one dot leader), so nothing in them can become a link. */
const HOURS_SENT = "Senin–Jumat 09\u202400–17\u202400 WIB";

describe("csLocalPhone: the local format with dashes", () => {
  it("writes +6281234567890 as 0812-3456-7890", () => {
    expect(csLocalPhone(NUMBER)).toBe("0812-3456-7890");
  });

  it("groups every length a mobile number can have (10 to 13 digits with the 0) as head, then two groups", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["+62812345678", "0812-345-678"], // 9 digits after +62: the shortest
      ["+628123456789", "0812-345-6789"],
      ["+6281234567890", "0812-3456-7890"],
      ["+62812345678901", "0812-3456-78901"], // 12 digits after +62: the longest
    ];
    for (const [e164, local] of cases) {
      expect(csLocalPhone(e164), e164).toBe(local);
      expect(CS_LOCAL_PHONE.test(local), local).toBe(true);
      // The same number again from its local form: nothing was lost, only dashes added.
      const back = normalizeIdMobile(local);
      expect(back.ok && back.e164).toBe(e164);
    }
  });

  it("refuses anything that is not a canonical Indonesian mobile number", () => {
    for (const bad of ["0812-3456-7890", "+62 812 3456 7890", "+6221555123", "", "+441234567890"]) {
      expect(() => csLocalPhone(bad), bad).toThrow(RangeError);
      expect(() => csWaMeDigits(bad), bad).toThrow(RangeError);
    }
  });

  it("gives the digits wa.me wants, without the +", () => {
    expect(csWaMeDigits(NUMBER)).toBe("6281234567890");
  });
});

describe("csLine: the {cs} of the replies", () => {
  it("names a number and an address, joined with atau", () => {
    expect(csLine({ whatsapp: NUMBER, email: "cs@contoh.id", hours: null })).toBe("WhatsApp 0812-3456-7890 atau email cs@contoh.id");
  });

  it("names only the part that is set", () => {
    expect(csLine({ whatsapp: NUMBER, email: null, hours: null })).toBe("WhatsApp 0812-3456-7890");
    expect(csLine({ whatsapp: null, email: "cs@contoh.id", hours: null })).toBe("email cs@contoh.id");
  });

  it("puts the hours in brackets after whatever is set", () => {
    expect(csLine({ whatsapp: NUMBER, email: "cs@contoh.id", hours: HOURS })).toBe(`WhatsApp 0812-3456-7890 atau email cs@contoh.id (${HOURS_SENT})`);
    expect(csLine({ whatsapp: NUMBER, email: null, hours: HOURS })).toBe(`WhatsApp 0812-3456-7890 (${HOURS_SENT})`);
    expect(csLine({ whatsapp: null, email: "cs@contoh.id", hours: HOURS })).toBe(`email cs@contoh.id (${HOURS_SENT})`);
  });

  it("makes no link out of the hours: a dot between letters or digits (www.contoh.id) is neutralised, the address stays copyable", () => {
    const line = csLine({ whatsapp: null, email: "cs@contoh.id", hours: "Info di www.contoh.id, 09.00-17.00" }) ?? "";
    expect(line).toBe("email cs@contoh.id (Info di www\u2024contoh\u2024id, 09\u202400-17\u202400)");
    expect(line.replace("cs@contoh.id", "")).not.toMatch(/[A-Za-z0-9]\.[A-Za-z0-9]/);
  });

  it("has no line without a number or an address, hours alone included", () => {
    expect(csLine(NO_CS_CONTACT)).toBeNull();
    expect(csLine({ whatsapp: null, email: null, hours: HOURS })).toBeNull();
    expect(hasCsContact({ whatsapp: null, email: null, hours: HOURS })).toBe(false);
    expect(hasCsContact({ whatsapp: null, email: "cs@contoh.id", hours: null })).toBe(true);
    expect(hasCsContact({ whatsapp: NUMBER, email: null, hours: null })).toBe(true);
  });

  it("has no link in it: a number and an address as plain text only", () => {
    const line = csLine({ whatsapp: NUMBER, email: "cs@contoh.id", hours: HOURS }) ?? "";
    expect(line).not.toMatch(/https?:|wa\.me|mailto:/i);
  });
});

describe("the hours and the address", () => {
  it("accepts one line of up to 80 characters, with no control character", () => {
    expect(isCsHours(HOURS)).toBe(true);
    expect(isCsHours("x".repeat(CS_HOURS_MAX))).toBe(true);
    expect(isCsHours("x".repeat(CS_HOURS_MAX + 1))).toBe(false);
    expect(isCsHours("")).toBe(false);
    expect(isCsHours("one\ntwo")).toBe(false);
    expect(isCsHours("tab\there")).toBe(false);
  });

  it("refuses invisible and format characters: line and paragraph separators, bidi marks and overrides, zero-width, soft hyphen, BOM", () => {
    for (const probe of ["Senin\u2028Jumat", "Senin\u2029Jumat", "abc\u202efed", "abc\u200bdef", "abc\u200edef", "abc\u2066def", "abc\u00addef", "\ufeffabc", "abc\u0085def", "abc\u007fdef", "a\u{e0041}b", "a\u{1d173}b"]) {
      expect(isCsHours(probe), JSON.stringify(probe)).toBe(false);
    }
    // Plain visible text in other scripts, and a no-break or ideographic space, is fine.
    for (const text of ["Senin–Jumat 09.00–17.00 WIB", "月〜金 9:00–17:00", "Senin\u00a0Jumat", "Senin\u3000Jumat", "é ö ñ"]) expect(isCsHours(text), text).toBe(true);
  });

  it("counts the hours in characters, not code units", () => {
    expect(isCsHours("😀".repeat(CS_HOURS_MAX))).toBe(true);
    expect(isCsHours("😀".repeat(CS_HOURS_MAX + 1))).toBe(false);
  });

  it("accepts an address with an at sign and a dotted domain, not more than 254 characters", () => {
    expect(isCsEmail("cs@contoh.id")).toBe(true);
    expect(isCsEmail("cs.help+toko@sub.contoh.co.id")).toBe(true);
    for (const bad of ["cs", "cs@", "@contoh.id", "cs@contoh", "c s@contoh.id", `${"a".repeat(250)}@b.id`]) expect(isCsEmail(bad), bad).toBe(false);
  });

  it("is ASCII only: a bidi override, a lookalike letter, a quote or an angle bracket is refused (nothing that could reorder or break out of a text)", () => {
    for (const bad of ["cs\u202e@x.id", "cs@x\u202e.id", "c\u0455@x.id", "cs@x\u2024id", "cs@exämple.id", "a<b>@x.id", 'a"b@x.id', "a'b@x.id", "cs@x.id\n", "cs@x.id ", " cs@x.id", "cs@@x.id", "cs@x..id", "cs@.x.id"]) {
      expect(isCsEmail(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["CS@Contoh.ID", "a_b%c+d-e.f@sub-domain.contoh.co.id"]) expect(isCsEmail(ok), ok).toBe(true);
  });
});

describe("{cs_whatsapp} and {cs_email} in a template", () => {
  const base = { nama: "Budi", judul_ebook: "Ebook", order_id: "K7M2Q9XR" };

  it("csTemplateValues: the local number with dashes and the address, each empty when not set", () => {
    expect(csTemplateValues({ whatsapp: NUMBER, email: "cs@contoh.id", hours: HOURS })).toEqual({ cs_whatsapp: "0812-3456-7890", cs_email: "cs@contoh.id" });
    expect(csTemplateValues(NO_CS_CONTACT)).toEqual({ cs_whatsapp: "", cs_email: "" });
    expect(csTemplateValues({ whatsapp: null, email: "cs@contoh.id", hours: null })).toEqual({ cs_whatsapp: "", cs_email: "cs@contoh.id" });
  });

  it("are inserted unchanged in a WhatsApp text: the address keeps its dots and underscore, the number its dashes", () => {
    const text = renderMessage("Bantuan: {cs_whatsapp} / {cs_email}", "whatsapp", { ...base, cs_whatsapp: "0812-3456-7890", cs_email: "cs_toko@contoh.id" });
    expect(text).toBe("Bantuan: 0812-3456-7890 / cs_toko@contoh.id");
  });

  it("are inserted in an e-mail's HTML and subject", () => {
    expect(renderMessage("<p>Hubungi {cs_whatsapp}, {cs_email}</p>", "email_html", { ...base, cs_whatsapp: "0812-3456-7890", cs_email: "cs@contoh.id" })).toBe("<p>Hubungi 0812-3456-7890, cs@contoh.id</p>");
    expect(renderMessage("Pesanan {order_id} (bantuan {cs_email})", "email_subject", { ...base, cs_whatsapp: "", cs_email: "cs@contoh.id" })).toBe("Pesanan K7M2Q9XR (bantuan cs@contoh.id)");
  });

  it("render as an empty string when nothing is set, so the rest of the template reads on", () => {
    const text = renderMessage("Bantuan WA: {cs_whatsapp}. Email: {cs_email}.", "whatsapp", { ...base, cs_whatsapp: "", cs_email: "" });
    expect(text).toBe("Bantuan WA: . Email: .");
  });

  it("refuse a value that is not a local number or an address (nothing else can ride in a template through them)", () => {
    for (const bad of ["+6281234567890", "0812 3456 7890", "08123456789\nx", "<b>0812-3456-7890</b>"]) {
      expect(() => renderMessage("{cs_whatsapp}", "whatsapp", { ...base, cs_whatsapp: bad }), bad).toThrow(TemplateError);
    }
    for (const bad of ["cs", "cs@contoh.id <x>", "cs@contoh.id\nBcc: x@y.id", "<b>x</b>@contoh.id", 'a"onmouseover="x@contoh.id', "cs\u202e@x.id"]) {
      expect(() => renderMessage("{cs_email}", "whatsapp", { ...base, cs_email: bad }), bad).toThrow(TemplateError);
      // The e-mail's HTML is no way round it: markup in an address never reaches the page, because the address is refused.
      expect(() => renderMessage("<p>{cs_email}</p>", "email_html", { ...base, cs_email: bad }), bad).toThrow(TemplateError);
    }
  });

  it("need a value: a template that has the variable and a caller that passes none fails closed (missing_value)", () => {
    try {
      renderMessage("{cs_email}", "whatsapp", base);
      throw new Error("expected a TemplateError");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as TemplateError).code).toBe("missing_value");
    }
  });
});
