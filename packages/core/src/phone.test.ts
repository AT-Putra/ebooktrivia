import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isIdMobileE164, maskPhoneTail, normalizeIdMobile, toWaChatId, type IdMobileE164, type PhoneError } from "./phone.ts";

/** packages/db e164Check: '^\+[1-9][0-9]{7,14}$'. */
const DB_E164 = /^\+[1-9][0-9]{7,14}$/;

const ok = (input: string): string => {
  const result = normalizeIdMobile(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be valid, got ${result.error}`);
  return result.e164;
};
const err = (input: string): PhoneError | undefined => {
  const result = normalizeIdMobile(input);
  return result.ok ? undefined : result.error;
};

describe("normalizeIdMobile", () => {
  it.each([
    ["08123456789", "+628123456789"],
    ["0812-3456-789", "+628123456789"],
    ["0812.3456.789", "+628123456789"],
    ["(0812) 3456 789", "+628123456789"],
    ["628123456789", "+628123456789"],
    ["+62 812-3456-789", "+628123456789"],
    ["+62 (812) 3456 7890", "+6281234567890"],
    ["0062 812 3456 789", "+628123456789"],
    ["+62 0812 3456 789", "+628123456789"],
    ["  0812 3456 789\u{A0}", "+628123456789"],
    ["0812\u{A0}3456\u{A0}789", "+628123456789"],
    ["0811234567", "+62811234567"], // NSN 9 digits: shortest mobile
    ["0812345678901", "+62812345678901"], // NSN 12 digits: longest mobile
    ["0895-1234-5678", "+6289512345678"], // Tri
    ["0881 2345 6789", "+6288123456789"], // Smartfren
  ])("accepts %j as %s", (input, expected) => {
    expect(ok(input)).toBe(expected);
    expect(expected).toMatch(DB_E164);
  });

  // Every operator block listed on Wikipedia "Telephone numbers in Indonesia".
  it.each([
    ...["0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853"], // Telkomsel
    ...["0814", "0815", "0816", "0855", "0856", "0857", "0858"], // IM3
    ...["0817", "0818", "0819", "0859", "0877", "0878"], // XL
    ...["0831", "0832", "0833", "0838"], // AXIS
    ...["0895", "0896", "0897", "0898", "0899"], // Tri
    ...["0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889"], // Smartfren
  ])("accepts the operator block %s", (prefix) => {
    expect(ok(`${prefix}-1234-5678`)).toBe(`+62${prefix.slice(1)}12345678`);
  });

  it.each<[string, PhoneError]>([
    ["", "empty"],
    ["   ", "empty"],
    ["081234567", "invalid_length"], // NSN 8 digits
    ["08123456789012", "invalid_length"], // NSN 13 digits
    ["+62 812 3456 7890 1234 5678 9012 34", "invalid_length"], // > 32 characters
    ["021-1234567", "not_mobile"], // Jakarta landline
    ["+62 21 1234 5678", "not_mobile"],
    ["(022) 7654321", "not_mobile"], // Bandung landline
    ["0800-1-234-567", "not_mobile"], // toll-free
    ["0809 1234 5678", "not_mobile"], // premium
    ["0804 1500 123", "not_mobile"], // 080x is not a mobile block
    ["0841 2345 6789", "not_mobile"], // 084x: no mobile block (landline area code only)
    ["+62 841 2345 6789", "not_mobile"],
    ["00812345678", "not_mobile"],
    ["+62 00812345678", "not_mobile"],
    ["+1 415 555 0100", "not_indonesian"],
    ["+60 12-345 6789", "not_indonesian"], // Malaysia
    ["+0062 812 3456 789", "not_indonesian"],
    ["8123456789", "not_indonesian"], // bare NSN, no prefix
    ["0812 3456 789 ext 1", "invalid_characters"],
    ["0812+3456789", "invalid_characters"],
    ["++628123456789", "invalid_characters"],
    ["0812\n3456789", "invalid_characters"],
    ["0812/3456/789", "invalid_characters"],
    ["\u{FF10}\u{FF18}\u{FF11}\u{FF12}\u{FF13}\u{FF14}\u{FF15}\u{FF16}\u{FF17}\u{FF18}\u{FF19}", "invalid_characters"], // full-width digits
  ])("rejects %j (%s)", (input, error) => {
    expect(err(input)).toBe(error);
  });

  it("property: every accepted format of a mobile NSN normalizes to the same canonical number", () => {
    const nsn = fc
      .tuple(fc.constantFrom(1, 2, 3, 5, 6, 7, 8, 9), fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 7, maxLength: 10 }))
      .map(([second, rest]) => `8${String(second)}${rest.join("")}`);
    const sep = fc.constantFrom("", " ", "-", ".");
    fc.assert(
      fc.property(nsn, sep, (n, s) => {
        const grouped = n.replace(/(\d{3})(?=\d)/g, `$1${s}`);
        const expected = `+62${n}`;
        for (const form of [`0${grouped}`, `62${grouped}`, `+62 ${grouped}`, `+62${s}0${grouped}`, `0062 ${grouped}`]) {
          expect(ok(form)).toBe(expected);
        }
        expect(isIdMobileE164(expected)).toBe(true);
        expect(expected).toMatch(DB_E164);
      }),
    );
  });

  it("property: output is always canonical or an error, never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (input) => {
        const result = normalizeIdMobile(input);
        if (result.ok) expect(isIdMobileE164(result.e164)).toBe(true);
      }),
    );
  });
});

describe("isIdMobileE164 / toWaChatId", () => {
  it("recognizes only the canonical form", () => {
    expect(isIdMobileE164("+628123456789")).toBe(true);
    expect(isIdMobileE164("628123456789")).toBe(false);
    expect(isIdMobileE164("+62212345678")).toBe(false);
    expect(isIdMobileE164("+6281234567")).toBe(false);
    expect(isIdMobileE164("+628412345678")).toBe(false);
  });

  it("builds the WAHA chat id", () => {
    expect(toWaChatId(ok("0812-3456-789") as IdMobileE164)).toBe("628123456789@c.us");
  });

  it("refuses a non-canonical value smuggled in by a cast", () => {
    expect(() => toWaChatId("+12025550123" as IdMobileE164)).toThrow(RangeError);
  });
});

describe("review item 10: (+62) form and 086x", () => {
  it.each([
    ["(+62) 812-3456-789", "+628123456789"],
    ["(+62)8123456789", "+628123456789"],
    ["(+62) 0812 3456 789", "+628123456789"],
    ["0868 1234 5678", "+6286812345678"], // 086x block (e.g. 0868)
  ])("accepts %j as %s", (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it.each<[string, PhoneError]>([
    ["(+1) 415 555 0100", "not_indonesian"],
    ["0812 (+62) 3456", "invalid_characters"],
    ["((+62) 812 3456 789", "invalid_characters"],
  ])("rejects %j (%s)", (input, error) => {
    expect(err(input)).toBe(error);
  });
});

describe("review round 2: unbalanced or misplaced parentheses", () => {
  it.each(["(+62 812 3456 789", "+(62) 812 3456 789", "0812) 3456 789", "(0812 3456 789", "0812 (3456)) 789", "((0812)) 3456 789"])(
    "rejects %j",
    (input) => {
      expect(err(input)).toBe("invalid_characters");
    },
  );

  it.each([
    ["(+62) 812 3456 789", "+628123456789"],
    ["(0812) 3456 789", "+628123456789"],
    ["+62 (812) 3456 789", "+628123456789"],
  ])("still accepts %j", (input, expected) => {
    expect(ok(input)).toBe(expected);
  });
});

describe("maskPhoneTail (the same rules as SQL public.mask_phone_tail)", () => {
  it("hides the last 4 digits of the local form, grouped 4 / the rest / 4", () => {
    expect(maskPhoneTail("+6281234567890")).toBe("0812-3456-****");
    expect(maskPhoneTail("+62 812-3113-1319")).toBe("0812-3113-****");
    expect(maskPhoneTail("+628123456789")).toBe("0812-345-****");
    expect(maskPhoneTail("081234567890")).toBe("0812-3456-****");
  });

  it("keeps a number outside +62 in its own digits, hides the last 4 of a short one, and shows *** for too short or none", () => {
    expect(maskPhoneTail("+14155552671")).toBe("1415-555-****");
    expect(maskPhoneTail("12345678")).toBe("1234-****");
    expect(maskPhoneTail("123456")).toBe("12-****");
    expect(maskPhoneTail("12345")).toBe("***");
    expect(maskPhoneTail(null)).toBe("***");
  });
});
