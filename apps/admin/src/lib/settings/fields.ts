// Form field parsing for the settings pages (US-017). Every value from a form is untrusted: these
// helpers return the parsed value or throw InvalidInput with a fixed message for the form (never
// the submitted value, which may be PII or a secret).
import { isUuid } from "@ebooktrivia/core";
import postgres from "postgres";

export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInput";
  }
}

const CONTROL = /\p{Cc}/u;

/** A text field of a submitted form ("" when absent), capped at 64 KiB before any parsing. */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, 65_536) : "";
}

export const checkbox = (form: FormData, name: string): boolean => form.get(name) === "on" || form.get(name) === "true";

/** Trimmed single-line text of `min`..`max` code points, no control characters. */
export function singleLine(raw: string, message: string, limits: { readonly min?: number; readonly max: number }): string {
  const value = raw.trim();
  const length = Array.from(value).length;
  if (length < (limits.min ?? 1) || length > limits.max || CONTROL.test(value)) throw new InvalidInput(message);
  return value;
}

/** Like singleLine, but "" (after trimming) is null. */
export function optionalLine(raw: string, message: string, max: number): string | null {
  return raw.trim() === "" ? null : singleLine(raw, message, { max });
}

/** Multi-line text: CR LF normalised to LF; TAB and LF allowed, other controls refused. */
export function multiLine(raw: string, message: string, limits: { readonly min?: number; readonly max: number }): string {
  const value = raw.replace(/\r\n?/g, "\n");
  const length = Array.from(value).length;
  if (length < (limits.min ?? 1) || length > limits.max || /[^\P{Cc}\t\n]/u.test(value) || value.trim() === "") throw new InvalidInput(message);
  return value;
}

/** A whole number in `min`..`max` (decimal digits only, no sign unless min < 0). */
export function wholeNumber(raw: string, message: string, limits: { readonly min: number; readonly max: number }): number {
  const value = raw.trim();
  if (!/^-?\d{1,16}$/.test(value)) throw new InvalidInput(message);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < limits.min || n > limits.max) throw new InvalidInput(message);
  return n;
}

export function uuid(raw: string, message = "The request refers to an unknown item."): string {
  const value = raw.trim().toLowerCase();
  if (!isUuid(value)) throw new InvalidInput(message);
  return value;
}

/** Lowercase slug: a-z 0-9 and single hyphens (the programs / adnets slug CHECK). */
export function slug(raw: string, message: string, max = 64): string {
  const value = raw.trim();
  if (value.length > max || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) throw new InvalidInput(message);
  return value;
}

/** A calendar date "YYYY-MM-DD" (the HTML date input), as y / m / d. */
export function calendarDate(raw: string, message: string): { readonly y: number; readonly m: number; readonly d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (match === null) throw new InvalidInput(message);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new InvalidInput(message);
  return { y, m, d };
}

/** The SQLSTATE of a PostgreSQL error, else undefined. */
export const sqlState = (error: unknown): string | undefined => (error instanceof postgres.PostgresError ? error.code : undefined);
