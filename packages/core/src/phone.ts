// Indonesian WhatsApp numbers (spec AC-S4: invalid Indonesian WA numbers are rejected; plan M6:
// E.164 phone). Mobile only. Rule: the national significant number (NSN, after +62 / trunk 0)
// matches 8[1-35-9] followed by 7 to 10 digits, i.e. NSN 9 to 12 digits (10 to 13 with the trunk
// 0; +62 + 9..12 digits in E.164).
// Sources: Wikipedia "Telephone numbers in Indonesia" (mobile 9-11 digits postpaid / 10-12
// prepaid, NSN up to 12, format 8xx-xxxx-xxxxx; operator blocks 081x, 082x, 083x, 085x, 086x
// (e.g. 0868), 087x, 088x, 089x; 080x is not a mobile block and 084 appears only as a landline
// area code) and the libphonenumber ID mobile pattern 8[1-35-9]\d{7,10}. The rule is by second
// digit, not an operator allowlist, so new blocks inside 081x..089x (except 084x) keep working.
//
// Accepted input forms, with spaces, NBSP, dashes, dots and parentheses as separators:
//   08xx..., 628xx..., +62 8xx..., (+62) 8xx..., 0062 8xx..., and the common mistake
//   +62 08xx... (the trunk 0 after the country code is dropped). A bare 8xx... (no 0, 62 or
//   +62) is rejected. "+" may only appear first, or right after one leading "(". Parentheses
//   must be balanced and not nested, and "(" may not follow "+".

export type IdMobileE164 = string & { readonly __brand: "IdMobileE164" };

export type PhoneError = "empty" | "invalid_characters" | "not_indonesian" | "not_mobile" | "invalid_length";

export type PhoneResult = { readonly ok: true; readonly e164: IdMobileE164 } | { readonly ok: false; readonly error: PhoneError };

const MAX_INPUT_LENGTH = 32;
const NSN_MIN = 9;
const NSN_MAX = 12;
const ALLOWED = /^(?:\(?\+)?[0-9 \u{A0}().-]+$/u;
const PLUS_FORM = /^\(?\+/;
const MOBILE_NSN_PREFIX = /^8[1-35-9]/;
const CANONICAL = /^\+628[1-35-9][0-9]{7,10}$/;

const fail = (error: PhoneError): PhoneResult => ({ ok: false, error });

export function normalizeIdMobile(input: string): PhoneResult {
  const trimmed = input.trim();
  if (trimmed === "") return fail("empty");
  if (trimmed.length > MAX_INPUT_LENGTH) return fail("invalid_length");
  if (!ALLOWED.test(trimmed) || !parenthesesOk(trimmed)) return fail("invalid_characters");
  const digits = trimmed.replace(/[^0-9]/g, "");
  let nsn: string;
  if (PLUS_FORM.test(trimmed)) {
    if (!digits.startsWith("62")) return fail("not_indonesian");
    nsn = digits.slice(2);
  } else if (digits.startsWith("0062")) {
    nsn = digits.slice(4);
  } else if (digits.startsWith("62")) {
    nsn = digits.slice(2);
  } else if (digits.startsWith("0")) {
    return checkNsn(digits.slice(1));
  } else {
    return fail("not_indonesian");
  }
  // After a country code only: "+62 0812..." -> "812...".
  if (nsn.startsWith("0")) nsn = nsn.slice(1);
  return checkNsn(nsn);
}

/** One level of balanced parentheses, never opened right after "+" (rejects "+(62) 812"). */
function parenthesesOk(value: string): boolean {
  let open = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") {
      if (open || value[i - 1] === "+") return false;
      open = true;
    } else if (ch === ")") {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

function checkNsn(nsn: string): PhoneResult {
  if (!MOBILE_NSN_PREFIX.test(nsn)) return fail("not_mobile");
  if (nsn.length < NSN_MIN || nsn.length > NSN_MAX) return fail("invalid_length");
  return { ok: true, e164: `+62${nsn}` as IdMobileE164 };
}

/** True for the canonical form produced by normalizeIdMobile (e.g. a value read from the DB). */
export function isIdMobileE164(value: string): value is IdMobileE164 {
  return CANONICAL.test(value);
}

/** WAHA chat id for a number: digits without "+", suffix "@c.us" (deliveries.wa_chat_id). */
export function toWaChatId(phone: IdMobileE164): string {
  if (!isIdMobileE164(phone)) throw new RangeError("not a canonical Indonesian mobile number");
  return `${phone.slice(1)}@c.us`;
}
