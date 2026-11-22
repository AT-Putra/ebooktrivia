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

/**
 * The signed-in role may not make this change (e.g. Staff on a trivia set with attempts, policy.ts
 * `staff_unlocked`), decided inside the change's transaction. A form shows the message (Staff may
 * have raced the set's first attempt, code review US-018 F9; lib/next/settings-result.ts); a route
 * handler answers 403 with it (lib/next/content-routes.ts). The message is fixed text.
 */
export class NotAllowed extends Error {
  constructor(message = "Your role cannot make this change.") {
    super(message);
    this.name = "NotAllowed";
  }
}

const CONTROL = /\p{Cc}/u;

/**
 * Refuses a form holding any field outside `allowed`, or one field twice (US-018: every field of a
 * new settings form is known, so a tampered form cannot smuggle a value in). React's own
 * `$ACTION_*` fields, which never reach the action, are ignored.
 */
export function onlyFields(form: FormData, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (key.startsWith("$ACTION")) continue;
    if (!allowed.includes(key) || seen.has(key)) throw new InvalidInput("The form has an unexpected field. Reload the page and try again.");
    seen.add(key);
  }
}

/** Like onlyFields, for the query of a route handler. */
export function onlyParams(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw new InvalidInput("The request has an unexpected parameter.");
    seen.add(key);
  }
}

/** The longest text field any settings form accepts, in code points (each field's own limit is lower). */
export const FIELD_MAX_CODE_POINTS = 65_536;

/**
 * A text field of a submitted form ("" when absent). Longer than FIELD_MAX_CODE_POINTS code points
 * is REFUSED, never cut (code review US-018 F11: a cut value could pass a field's own limit, and a
 * cut in the middle of a surrogate pair would corrupt it). Counted in code points, like every limit.
 */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") return "";
  // A string of n UTF-16 units has at most n code points: only a long one needs counting.
  if (value.length > FIELD_MAX_CODE_POINTS && Array.from(value).length > FIELD_MAX_CODE_POINTS) {
    throw new InvalidInput(`A field is longer than ${FIELD_MAX_CODE_POINTS.toLocaleString("en-US")} characters.`);
  }
  return value;
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

/**
 * The SQLSTATE of a PostgreSQL error, else undefined. Also by shape (US-033): the production build can load two copies of
 * postgres.js (the pool's and this module's), and then `instanceof` fails for the pool's errors, so a database refusal
 * (e.g. ET185) would reach the form as a bare "request failed". A PostgresError carries the server's `severity` and a
 * five-character SQLSTATE `code`; a Node system error (EPIPE, ECONNRESET) has no severity.
 */
export const sqlState = (error: unknown): string | undefined => {
  if (error instanceof postgres.PostgresError) return error.code;
  if (!(error instanceof Error)) return undefined;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string" ? code : undefined;
};
