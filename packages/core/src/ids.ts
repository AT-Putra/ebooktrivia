// A lowercase UUID (as PostgreSQL prints uuid), shared by every place that takes an id from a form,
// a job or an outbox payload (code review US-017 L5).
import { randomInt } from "node:crypto";
import { PUBLIC_ID_BODY, PUBLIC_ID_PATTERN } from "./public-id.ts";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

// Order ids (orders_public_id_check, orders_order_code_check; US-020). Both are drawn uniformly from
// a CSPRNG (node:crypto randomInt, no modulo bias):
//   - public_id: 22 base62 characters (about 131 bits). It is the order page's capability
//     (order.<DOMAIN>/{publicId}) and the stem of every Midtrans order id, `{publicId}-{n}`;
//   - order_code: 10 Crockford base32 characters (50 bits, no I, L, O, U), the code a buyer types
//     or reads out in WhatsApp.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PUBLIC_ID_LENGTH = 22;
export const ORDER_CODE_LENGTH = 10;
export { PUBLIC_ID_BODY, PUBLIC_ID_PATTERN };
export const ORDER_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8,16}$/;
/** midtrans_attempts_midtrans_order_id_check (and Midtrans' own limit). */
export const MIDTRANS_ORDER_ID_MAX = 50;

const randomString = (alphabet: string, length: number): string => Array.from({ length }, () => alphabet.charAt(randomInt(alphabet.length))).join("");

export const newPublicId = (): string => randomString(BASE62, PUBLIC_ID_LENGTH);
export const newOrderCode = (): string => randomString(CROCKFORD, ORDER_CODE_LENGTH);

/** `{publicId}-{n}`: the Midtrans order id of attempt n (n >= 1) of an order. */
export function midtransOrderId(publicId: string, n: number): string {
  if (!PUBLIC_ID_PATTERN.test(publicId)) throw new RangeError("publicId has an invalid format");
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  const id = `${publicId}-${String(n)}`;
  if (id.length > MIDTRANS_ORDER_ID_MAX) throw new RangeError("the Midtrans order id is too long");
  return id;
}
