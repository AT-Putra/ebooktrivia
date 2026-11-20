// Client-side checks, for the visitor's benefit only: the server validates everything again and
// stays the authority (AC-S4). The phone goes through the same normaliser as the server.
import { normalizeIdMobile } from "@ebooktrivia/core/phone";
import { SDK_LIMITS, SDK_PATTERNS, type SdkFieldErrors } from "@ebooktrivia/core/sdk-contract";
import { fill, text } from "./messages.ts";

export interface FormValues {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly consent: boolean;
}

export type Checked = { readonly ok: true; readonly name: string; readonly phone: string; readonly email: string } | { readonly ok: false; readonly errors: SdkFieldErrors };

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const NAME_FILLER = new RegExp(SDK_PATTERNS.nameFiller, "gu");
const NOT_TEXT = new RegExp(SDK_PATTERNS.labelForbidden, "u");

export function checkForm(values: FormValues): Checked {
  const errors: { -readonly [K in keyof SdkFieldErrors]: SdkFieldErrors[K] } = {};
  // The server's rule (apps/public request.ts normalizeName): fillers and control / format characters
  // become spaces; a name that still holds a lone surrogate, private-use or unassigned code point is missing.
  const name = values.name.replace(NAME_FILLER, " ").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  if (name === "" || NOT_TEXT.test(name)) errors.name = "required";
  else if (name.length > SDK_LIMITS.name) errors.name = "too_long";

  const phone = normalizeIdMobile(values.phone);
  if (!phone.ok) errors.phone = phone.error;

  const email = values.email.trim();
  if (email === "" || HAS_CONTROL.test(email)) errors.email = "required";
  else if (email.length > SDK_LIMITS.email || !EMAIL.test(email)) errors.email = "invalid";

  if (!values.consent) errors.consent = "required";
  return Object.keys(errors).length > 0 || !phone.ok ? { ok: false, errors } : { ok: true, name, phone: phone.e164, email };
}

/** The Bahasa Indonesia message for a field error code (from the SDK's own checks or the API's). */
export function fieldMessage(field: keyof SdkFieldErrors, code: string): string {
  const f = text.field;
  switch (field) {
    case "name":
      return code === "too_long" ? fill(f.name.tooLong, { max: SDK_LIMITS.name }) : f.name.required;
    case "phone":
      return (
        { empty: f.phone.empty, invalid_characters: f.phone.invalidCharacters, not_indonesian: f.phone.notIndonesian, not_mobile: f.phone.notMobile, invalid_length: f.phone.invalidLength } as Readonly<
          Record<string, string>
        >
      )[code] ?? f.phone.invalidLength;
    case "email":
      return code === "invalid" ? f.email.invalid : f.email.required;
    case "consent":
      return code === "outdated" ? f.consent.outdated : f.consent.required;
  }
}
