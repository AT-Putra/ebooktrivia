// The Owner's customer-service (CS) contact (Owner decision 2026-11-24): where a buyer who has a problem reaches a human. One WhatsApp
// number (an Indonesian mobile number, E.164), one e-mail address and the opening hours as one line of free text; each may be empty, and
// an empty one is shown nowhere. Pure helpers shared by the console (validation, preview), the worker (the {cs} line of its fixed WhatsApp
// replies, the {cs_whatsapp} / {cs_email} template variables) and the buyer site (the help block's links).
//
// The number is shown to a buyer in the local format with dashes ("0812-3456-7890") and as plain text in WhatsApp (no wa.me link in a
// WhatsApp message: the WAHA anti-blocking guide warns about links); the buyer site links to https://wa.me/<digits>.
//
// {cs} is Bahasa Indonesia, the buyer-facing locale (like core greeting.ts): "WhatsApp 0812-3456-7890 atau email cs@contoh.id", only the
// parts that are set, and " (<hours>)" after them when hours are set. Hours alone are no contact: with neither a number nor an address
// there is no line at all.
import { isIdMobileE164 } from "./phone.ts";

export interface CsContact {
  /** E.164 (+62...), or null. */
  readonly whatsapp: string | null;
  readonly email: string | null;
  /** One line, e.g. "Senin–Jumat 09.00–17.00 WIB"; null when not set. */
  readonly hours: string | null;
}

/** No contact set: nothing is shown anywhere, and the replies stay as they were. */
export const NO_CS_CONTACT: CsContact = Object.freeze({ whatsapp: null, email: null, hours: null });

/** The longest opening-hours text (cs_contact_hours_check). */
export const CS_HOURS_MAX = 80;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The local format with dashes the buyer reads (and {cs_whatsapp} holds): a leading 0, then groups of digits. */
export const CS_LOCAL_PHONE = /^0[0-9]{3}(?:-[0-9]{3,5}){1,2}$/;

/** True for an address the console and the database (cs_contact_email_check) accept. */
export const isCsEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value);

/** True for hours the database accepts (cs_contact_hours_check): 1 to 80 characters, no control character. */
export const isCsHours = (value: string): boolean => {
  const length = Array.from(value).length;
  return length >= 1 && length <= CS_HOURS_MAX && !/\p{Cc}/u.test(value);
};

/**
 * "+6281234567890" -> "0812-3456-7890": the trunk 0, the operator block (4 digits with the 0), then the rest in two groups (3-3, 3-4,
 * 4-4 or 4-5 by its length). Throws RangeError for anything that is not a canonical Indonesian mobile number.
 */
export function csLocalPhone(e164: string): string {
  if (!isIdMobileE164(e164)) throw new RangeError("not a canonical Indonesian mobile number");
  const local = `0${e164.slice(3)}`;
  const head = local.slice(0, 4);
  const rest = local.slice(4);
  if (rest.length <= 4) return `${head}-${rest}`;
  const split = Math.floor(rest.length / 2);
  return `${head}-${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** "+6281234567890" -> "6281234567890": what a wa.me link wants. Throws RangeError like csLocalPhone. */
export function csWaMeDigits(e164: string): string {
  if (!isIdMobileE164(e164)) throw new RangeError("not a canonical Indonesian mobile number");
  return e164.slice(1);
}

/** True when a buyer has something to reach: a number or an address (hours alone are not). */
export const hasCsContact = (contact: CsContact): boolean => contact.whatsapp !== null || contact.email !== null;

/** "WhatsApp 0812-3456-7890 atau email cs@contoh.id (Senin–Jumat 09.00–17.00 WIB)": the {cs} of the replies; null when there is no contact. */
export function csLine(contact: CsContact): string | null {
  const parts: string[] = [];
  if (contact.whatsapp !== null) parts.push(`WhatsApp ${csLocalPhone(contact.whatsapp)}`);
  if (contact.email !== null) parts.push(`email ${contact.email}`);
  if (parts.length === 0) return null;
  const line = parts.join(" atau ");
  return contact.hours === null ? line : `${line} (${contact.hours})`;
}

/**
 * The {cs_whatsapp} and {cs_email} template variables: the local number with dashes and the address, each an empty string when not set,
 * so a template still reads well (the Owner words it for that: the console says so).
 */
export function csTemplateValues(contact: CsContact): { readonly cs_whatsapp: string; readonly cs_email: string } {
  return { cs_whatsapp: contact.whatsapp === null ? "" : csLocalPhone(contact.whatsapp), cs_email: contact.email ?? "" };
}
