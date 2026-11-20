// Midtrans adapter (plan M3.2; AC-S5/S6): Snap create, status re-query, notification signature.
//
//   - Auth is HTTP Basic with the server key as user name and an empty password.
//   - The signature is sha512hex(order_id + status_code + gross_amount + server_key), compared in
//     constant time. gross_amount is used EXACTLY as the string Midtrans sent and signed (e.g.
//     "50000.00"); it is never parsed and re-formatted before the check, and the order amount is
//     compared against that same string (grossAmountMatches).
//   - An order becomes PAID only after the worker re-queries the status (getTransactionStatus) and
//     confirmSettlement() says "paid" for that status (AC-S6: settlement, this order, status 200,
//     the exact amount, currency IDR). The worker MUST use confirmSettlement and nothing else to
//     decide "paid"; "review" means money arrived that does not match the order. A notification
//     alone never decides anything.
//   - Every call goes through the injected HttpFetch (createSafeFetch in production).

import { createHash, timingSafeEqual } from "node:crypto";
import { type HttpFetch, type HttpResponse, isRecord, stringField } from "./http.ts";
import { SafeFetchError } from "./safe-fetch.ts";

export type MidtransErrorCode = "rejected" | "unauthorized" | "unavailable" | "bad_response" | "bad_signature";

export class MidtransError extends Error {
  readonly code: MidtransErrorCode;
  /** Safe to retry later (network, timeout, 5xx); a rejection or a bad signature is not. */
  readonly retryable: boolean;
  readonly messages: readonly string[];
  constructor(code: MidtransErrorCode, message: string, options: { retryable?: boolean; messages?: readonly string[]; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "MidtransError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.messages = options.messages ?? [];
  }
}

/**
 * The Midtrans hosts of each environment (fixed here, never configurable per landing page; the
 * environment itself is the deployment's app_settings midtrans.environment).
 */
export const MIDTRANS_ENDPOINTS = {
  sandbox: { snapBaseUrl: "https://app.sandbox.midtrans.com", apiBaseUrl: "https://api.sandbox.midtrans.com" },
  production: { snapBaseUrl: "https://app.midtrans.com", apiBaseUrl: "https://api.midtrans.com" },
} as const satisfies Readonly<Record<"sandbox" | "production", { readonly snapBaseUrl: string; readonly apiBaseUrl: string }>>;

export interface MidtransConfig {
  readonly serverKey: string;
  /** https://app.sandbox.midtrans.com or https://app.midtrans.com */
  readonly snapBaseUrl: string;
  /** https://api.sandbox.midtrans.com or https://api.midtrans.com */
  readonly apiBaseUrl: string;
  readonly fetch: HttpFetch;
}

export interface SnapCreateInput {
  /** `{orders.public_id}-{n}` (midtrans_attempts.midtrans_order_id). */
  readonly midtransOrderId: string;
  /** Integer IDR. */
  readonly grossAmountIdr: number;
  readonly expiryMinutes: number;
  readonly item: { readonly id: string; readonly name: string };
  readonly customer: { readonly firstName: string; readonly email: string; readonly phone: string };
  /** Where Snap sends the buyer when done (the order status page). */
  readonly finishUrl?: string;
  /** Snap `enabled_payments` codes (core MIDTRANS_METHODS); omitted = Snap's own default list. */
  readonly enabledPayments?: readonly string[];
}

export interface SnapTransaction {
  readonly token: string;
  readonly redirectUrl: string;
}

export interface MidtransStatus {
  readonly orderId: string;
  readonly statusCode: string;
  /** Exactly as Midtrans sent and signed it, e.g. "50000.00". */
  readonly grossAmount: string;
  readonly transactionStatus: string;
  readonly fraudStatus: string | undefined;
  readonly transactionId: string | undefined;
  readonly paymentType: string | undefined;
  readonly currency: string | undefined;
  readonly transactionTime: string | undefined;
}

/** The fields a notification or status body must carry for its signature to be checked. */
export interface SignedPayload {
  readonly order_id: string;
  readonly status_code: string;
  readonly gross_amount: string;
  readonly signature_key: string;
}

/** Unreserved URL characters, but never "." or ".." (they would rewrite the /v2/{id}/status path). */
const MIDTRANS_ORDER_ID = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,50}$/;

function authHeader(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`;
}

function headers(serverKey: string): Record<string, string> {
  return { authorization: authHeader(serverKey), accept: "application/json", "content-type": "application/json" };
}

function signatureOf(orderId: string, statusCode: string, grossAmount: string, serverKey: string): Buffer {
  return Buffer.from(createHash("sha512").update(orderId + statusCode + grossAmount + serverKey).digest("hex"), "ascii");
}

/** Constant-time check of a Midtrans signature_key; gross_amount is taken as the signed string. */
export function verifySignature(payload: SignedPayload, serverKey: string): boolean {
  const expected = signatureOf(payload.order_id, payload.status_code, payload.gross_amount, serverKey);
  const given = Buffer.from(payload.signature_key.toLowerCase(), "ascii");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What Midtrans reports as gross_amount for an integer IDR amount. */
export function expectedGrossAmount(amountIdr: number): string {
  if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0) throw new RangeError("amountIdr must be a positive safe integer");
  return `${amountIdr.toString()}.00`;
}

/** String comparison against the signed gross_amount (never a float comparison). */
export function grossAmountMatches(amountIdr: number, grossAmount: string): boolean {
  return grossAmount === expectedGrossAmount(amountIdr);
}

/** The signed fields of an untrusted notification or status body, or undefined if any is missing. */
export function signedFields(body: unknown): SignedPayload | undefined {
  if (!isRecord(body)) return undefined;
  const orderId = stringField(body, "order_id");
  const statusCode = stringField(body, "status_code");
  const grossAmount = stringField(body, "gross_amount");
  const signature = stringField(body, "signature_key");
  if (orderId === undefined || statusCode === undefined || grossAmount === undefined || signature === undefined) return undefined;
  return { order_id: orderId, status_code: statusCode, gross_amount: grossAmount, signature_key: signature };
}

async function send(cfg: MidtransConfig, url: string, init: { method: string; body?: string }): Promise<HttpResponse> {
  try {
    return await cfg.fetch(url, { ...init, headers: headers(cfg.serverKey) });
  } catch (error) {
    throw new MidtransError("unavailable", "Midtrans could not be reached", { retryable: true, cause: error });
  }
}

/** The body could not be read (timeout, abort, reset): transient, unlike a body that is not JSON. */
function isTransientReadError(error: unknown): boolean {
  if (error instanceof SafeFetchError) return error.code === "timeout" || error.code === "request_failed";
  if (error instanceof DOMException) return error.name === "TimeoutError" || error.name === "AbortError";
  return error instanceof TypeError;
}

/** Statuses that ask the client to come back later. */
const RETRY_LATER = new Set([408, 429]);

async function jsonOf(response: HttpResponse): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isTransientReadError(error)) throw new MidtransError("unavailable", "Midtrans answer could not be read", { retryable: true, cause: error });
    throw new MidtransError("bad_response", `Midtrans answered ${String(response.status)} without JSON`, {
      retryable: response.status >= 500 || RETRY_LATER.has(response.status),
      cause: error,
    });
  }
  if (!isRecord(body)) throw new MidtransError("bad_response", "Midtrans answered with a non-object body", { retryable: response.status >= 500 });
  return body;
}

function errorMessages(body: Record<string, unknown>): string[] {
  const list = body["error_messages"];
  if (Array.isArray(list)) return list.filter((m): m is string => typeof m === "string");
  const single = stringField(body, "status_message");
  return single === undefined ? [] : [single];
}

function failure(response: HttpResponse, body: Record<string, unknown>, what: string): MidtransError {
  const messages = errorMessages(body);
  if (response.status === 401) return new MidtransError("unauthorized", `${what}: server key refused`, { messages });
  if (response.status >= 500 || RETRY_LATER.has(response.status)) {
    return new MidtransError("unavailable", `${what}: Midtrans error ${String(response.status)}`, { retryable: true, messages });
  }
  return new MidtransError("rejected", `${what}: rejected (${String(response.status)})`, { messages });
}

/** POST /snap/v1/transactions. A 4xx (e.g. duplicate order_id) is a non-retryable rejection. */
export async function createSnapTransaction(cfg: MidtransConfig, input: SnapCreateInput): Promise<SnapTransaction> {
  if (!MIDTRANS_ORDER_ID.test(input.midtransOrderId)) throw new RangeError("midtransOrderId has an invalid format");
  if (!Number.isInteger(input.expiryMinutes) || input.expiryMinutes < 1) throw new RangeError("expiryMinutes must be a positive integer");
  const gross = Number(expectedGrossAmount(input.grossAmountIdr).slice(0, -3));
  const body = {
    transaction_details: { order_id: input.midtransOrderId, gross_amount: gross },
    item_details: [{ id: input.item.id, name: input.item.name.slice(0, 50), price: gross, quantity: 1 }],
    customer_details: { first_name: input.customer.firstName, email: input.customer.email, phone: input.customer.phone },
    expiry: { unit: "minutes", duration: input.expiryMinutes },
    ...(input.enabledPayments === undefined ? {} : { enabled_payments: [...input.enabledPayments] }),
    ...(input.finishUrl === undefined ? {} : { callbacks: { finish: input.finishUrl } }),
  };
  const response = await send(cfg, `${cfg.snapBaseUrl}/snap/v1/transactions`, { method: "POST", body: JSON.stringify(body) });
  const json = await jsonOf(response);
  if (response.status !== 201 && response.status !== 200) throw failure(response, json, "Snap create");
  const token = stringField(json, "token");
  const redirectUrl = stringField(json, "redirect_url");
  if (token === undefined || redirectUrl === undefined || !isSnapRedirect(redirectUrl, cfg.snapBaseUrl)) {
    throw new MidtransError("bad_response", "Snap create: token or an https redirect_url on the Snap host missing");
  }
  return { token, redirectUrl };
}

/** The buyer is sent to redirect_url, so it must be https on the configured Snap host. */
function isSnapRedirect(redirectUrl: string, snapBaseUrl: string): boolean {
  try {
    const url = new URL(redirectUrl);
    return url.protocol === "https:" && url.host === new URL(snapBaseUrl).host && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * GET /v2/{order_id}/status, the authoritative re-query (AC-S6). Returns undefined when Midtrans
 * does not know the transaction (404). The response's own signature is checked too.
 */
export async function getTransactionStatus(cfg: MidtransConfig, midtransOrderId: string): Promise<MidtransStatus | undefined> {
  if (!MIDTRANS_ORDER_ID.test(midtransOrderId)) throw new RangeError("midtransOrderId has an invalid format");
  const response = await send(cfg, `${cfg.apiBaseUrl}/v2/${encodeURIComponent(midtransOrderId)}/status`, { method: "GET" });
  const json = await jsonOf(response);
  if (response.status === 404 || stringField(json, "status_code") === "404") return undefined;
  if (response.status !== 200) throw failure(response, json, "status re-query");
  const signed = signedFields(json);
  const transactionStatus = stringField(json, "transaction_status");
  if (signed === undefined || transactionStatus === undefined) throw new MidtransError("bad_response", "status re-query: signed fields missing");
  if (signed.order_id !== midtransOrderId) throw new MidtransError("bad_response", "status re-query: answer is for another order");
  if (!verifySignature(signed, cfg.serverKey)) throw new MidtransError("bad_signature", "status re-query: signature does not verify");
  return {
    orderId: signed.order_id,
    statusCode: signed.status_code,
    grossAmount: signed.gross_amount,
    transactionStatus,
    fraudStatus: stringField(json, "fraud_status"),
    transactionId: stringField(json, "transaction_id"),
    paymentType: stringField(json, "payment_type"),
    currency: stringField(json, "currency"),
    transactionTime: stringField(json, "transaction_time"),
  };
}

export interface SettlementExpectation {
  /** The attempt's midtrans_order_id. */
  readonly midtransOrderId: string;
  /** The order amount, integer IDR. */
  readonly amountIdr: number;
}

export type SettlementReviewReason = "order_mismatch" | "status_code_mismatch" | "fraud_review" | "amount_mismatch" | "currency_mismatch";

export type SettlementCheck =
  | { readonly kind: "paid" }
  /** Money is reported but something does not match the order: never paid, the Owner reviews it. */
  | { readonly kind: "review"; readonly reason: SettlementReviewReason }
  /** Not (yet) a settlement; core classifyMidtransStatus decides the order transition. */
  | { readonly kind: "not_settled"; readonly transactionStatus: string };

/**
 * THE paid predicate (AC-S6) for a re-queried status. Paid only when the status is for this
 * order, transaction_status is settlement (fraud accept or absent) - or capture + accept when the
 * Owner opted in with treatCardCaptureAsPaid (default false, as in core classifyMidtransStatus) -,
 * status_code is "200", gross_amount equals expectedGrossAmount(amountIdr) as a string and
 * currency is "IDR". A missing or other currency or amount is review, never paid.
 */
export function confirmSettlement(status: MidtransStatus, expected: SettlementExpectation, options: { readonly treatCardCaptureAsPaid?: boolean } = {}): SettlementCheck {
  const fraud = status.fraudStatus ?? "";
  const settled = status.transactionStatus === "settlement" || (status.transactionStatus === "capture" && fraud === "accept" && options.treatCardCaptureAsPaid === true);
  if (!settled) return { kind: "not_settled", transactionStatus: status.transactionStatus };
  if (status.orderId !== expected.midtransOrderId) return { kind: "review", reason: "order_mismatch" };
  if (status.statusCode !== "200") return { kind: "review", reason: "status_code_mismatch" };
  if (fraud !== "" && fraud !== "accept") return { kind: "review", reason: "fraud_review" };
  if (!grossAmountMatches(expected.amountIdr, status.grossAmount)) return { kind: "review", reason: "amount_mismatch" };
  if (status.currency !== "IDR") return { kind: "review", reason: "currency_mismatch" };
  return { kind: "paid" };
}
