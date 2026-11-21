import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import snapFixture from "../fixtures/snap-create.json" with { type: "json" };
import statusFixture from "../fixtures/status.json" with { type: "json" };
import { basicAuthHeader, midtransSignature } from "./signature.ts";

// Every answer shape here replays a RECORDING of the Midtrans sandbox (fixtures/*.json, US-005, 2026-11-21):
//   - Get Status answers HTTP 200 for everything found OR not found; a Snap order whose buyer has not picked a
//     method yet (and any unknown order) is {status_code: "404", status_message, id} in the body;
//   - the same order_id again: 201 with a NEW token while no method was chosen, else 400, and the text depends on
//     the transaction (settled: "has already been taken", anything else: "sudah digunakan"); an expired order_id is
//     refused too (the docs say it can be reused: it could not);
//   - the method-specific fields of a status (VA numbers, bill key, store, QRIS acquirer, card fields) come from
//     the recorded bodies; times are WIB; expiry_time = start_time (or the creation) + the expiry duration.
// Simplification: a created transaction is "pending" at once (the method is chosen). To replay Snap's "no method
// chosen yet", POST /__stub/transactions/:order_id/state {"method_chosen": false}.

export interface MidtransStubOptions {
  serverKey: string;
  fetchImpl?: typeof fetch;
}

interface Txn {
  orderId: string;
  transactionId: string;
  grossAmount: string;
  paymentType: string;
  bank: string;
  transactionStatus: string;
  fraudStatus: string;
  transactionTime: Date;
  expiryTime: Date;
  methodChosen: boolean;
  currency: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

const WIB_OFFSET_MS = 7 * 3_600_000;
/** Midtrans times are WIB wall-clock: "2026-11-21 17:31:18". */
const formatTime = (d: Date): string => new Date(d.getTime() + WIB_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);

const UNIT_MS: Readonly<Record<string, number>> = { minute: 60_000, minutes: 60_000, hour: 3_600_000, hours: 3_600_000, day: 86_400_000, days: 86_400_000 };

/** start_time ("2026-11-21 17:30:00 +0700", or the creation time) + duration; no usable expiry: 24 hours (Snap's default). */
function expiryOf(expiry: unknown, created: Date): Date {
  const e = isRecord(expiry) ? expiry : {};
  const unitMs = UNIT_MS[typeof e["unit"] === "string" ? e["unit"] : ""];
  const duration = e["duration"];
  if (unitMs === undefined || typeof duration !== "number" || !Number.isFinite(duration)) return new Date(created.getTime() + 24 * 3_600_000);
  const start = typeof e["start_time"] === "string" ? Date.parse(e["start_time"].replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2").replace(" ", "T")) : created.getTime();
  return new Date((Number.isNaN(start) ? created.getTime() : start) + duration * unitMs);
}

function statusCodeFor(status: string): string {
  if (status === "pending") return "201";
  if (status === "deny") return "202";
  if (status === "expire") return "407";
  return "200";
}

const FIXTURE_ORDER_KEYS = new Set(["status_code", "status_message", "transaction_id", "order_id", "gross_amount", "currency", "payment_type", "transaction_status", "fraud_status", "transaction_time", "signature_key", "merchant_id", "settlement_time", "expiry_time"]);
const methodFields = (body: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([key]) => !FIXTURE_ORDER_KEYS.has(key)));
const scenarios = statusFixture.scenarios as unknown as Record<string, Record<string, unknown>>;
/** The recorded method-specific fields of each payment_type (the VA numbers are filled in per transaction). */
const METHOD_FIELDS: Readonly<Record<string, Record<string, unknown>>> = {
  bank_transfer: methodFields(scenarios["bca_va_pending_after_deny"] ?? {}),
  echannel: methodFields(scenarios["echannel_pending"] ?? {}),
  cstore: methodFields(scenarios["indomaret_pending"] ?? {}),
  qris: methodFields(scenarios["qris_settlement"] ?? {}),
  credit_card: methodFields(scenarios["card_capture"] ?? {}),
};
const PERMATA_FIELDS = methodFields(scenarios["permata_va_pending"] ?? {});
const MERCHANT_ID = "G000000000";

const NO_SUCH_TRANSACTION = str(scenarios["no_method_chosen"]?.["status_message"]) ?? "Transaction doesn't exist.";
const UNAUTHORIZED = snapFixture.response_401.body;
const DUPLICATE_ORDER_ID = snapFixture.response_400_duplicate_order_id.body;
const DUPLICATE_ORDER_ID_SETTLED = snapFixture.response_400_duplicate_order_id_settled.body;
const MISSING_ORDER_ID = snapFixture.response_400_missing_order_id.body;

const snapAnswer = (token: string) => ({ token, redirect_url: `https://app.sandbox.midtrans.com/snap/v4/redirection/${token}` });

export function createMidtransStubApp(opts: MidtransStubOptions): Hono {
  const app = new Hono();
  const doFetch = opts.fetchImpl ?? fetch;
  const txns = new Map<string, Txn>();
  const expectedAuth = basicAuthHeader(opts.serverKey);

  const statusBody = (t: Txn) => {
    const statusCode = statusCodeFor(t.transactionStatus);
    const settled = t.transactionStatus === "settlement" || t.transactionStatus === "capture";
    const fields: Record<string, unknown> =
      t.paymentType === "bank_transfer" && t.bank === "permata"
        ? { ...PERMATA_FIELDS }
        : t.paymentType === "bank_transfer"
          ? { ...METHOD_FIELDS["bank_transfer"], va_numbers: [{ bank: t.bank, va_number: "00000000000000000000001" }] }
          : { ...METHOD_FIELDS[t.paymentType] };
    // Recorded: a card the bank denied has no approval_code.
    if (t.transactionStatus === "deny") delete fields["approval_code"];
    return {
      status_code: statusCode,
      transaction_id: t.transactionId,
      gross_amount: t.grossAmount,
      currency: t.currency,
      order_id: t.orderId,
      payment_type: t.paymentType,
      signature_key: midtransSignature(t.orderId, statusCode, t.grossAmount, opts.serverKey),
      transaction_status: t.transactionStatus,
      fraud_status: t.fraudStatus,
      status_message: "Success, transaction is found",
      merchant_id: MERCHANT_ID,
      ...fields,
      transaction_time: formatTime(t.transactionTime),
      ...(settled ? { settlement_time: formatTime(t.transactionTime) } : {}),
      expiry_time: formatTime(t.expiryTime),
    };
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  // --- Midtrans-shaped API (Basic auth) ---
  app.use("/snap/*", async (c, next) => {
    if (c.req.header("Authorization") !== expectedAuth) {
      return c.json(UNAUTHORIZED, 401);
    }
    await next();
  });
  app.use("/v2/*", async (c, next) => {
    if (c.req.header("Authorization") !== expectedAuth) {
      return c.json(UNAUTHORIZED, 401);
    }
    await next();
  });

  app.post("/snap/v1/transactions", async (c) => {
    const body = await readJson(c.req.raw);
    const details = body["transaction_details"];
    const orderId = isRecord(details) ? str(details["order_id"]) : undefined;
    const gross = isRecord(details) ? details["gross_amount"] : undefined;
    if (!orderId) return c.json(MISSING_ORDER_ID, 400);
    if (typeof gross !== "number" && typeof gross !== "string") {
      return c.json({ error_messages: ["transaction_details.gross_amount is required"] }, 400);
    }
    const existing = txns.get(orderId);
    if (existing) {
      // Recorded: while the buyer has not picked a method, the same order_id gets a new token.
      if (!existing.methodChosen) return c.json(snapAnswer(randomUUID()), 201);
      const settled = existing.transactionStatus === "settlement" || existing.transactionStatus === "capture";
      return c.json(settled ? DUPLICATE_ORDER_ID_SETTLED : DUPLICATE_ORDER_ID, 400);
    }
    const created = new Date();
    txns.set(orderId, {
      orderId,
      transactionId: randomUUID(),
      grossAmount: Number(gross).toFixed(2),
      paymentType: "bank_transfer",
      bank: "bca",
      transactionStatus: "pending",
      fraudStatus: "accept",
      transactionTime: created,
      expiryTime: expiryOf(body["expiry"], created),
      methodChosen: true,
      currency: "IDR",
    });
    return c.json(snapAnswer(randomUUID()), 201);
  });

  app.get("/v2/:order_id/status", (c) => {
    const t = txns.get(c.req.param("order_id"));
    // Recorded: HTTP 200, the "not found" lives in the body.
    if (!t?.methodChosen) return c.json({ status_code: "404", status_message: NO_SUCH_TRANSACTION, id: randomUUID() });
    return c.json(statusBody(t));
  });

  // --- control plane ---
  app.post("/__stub/transactions/:order_id/state", async (c) => {
    const t = txns.get(c.req.param("order_id"));
    if (!t) return c.json({ error: "unknown order_id" }, 404);
    const body = await readJson(c.req.raw);
    // Snap before the buyer picks a method: Get Status answers "404" and the same order_id may be created again.
    if (typeof body["method_chosen"] === "boolean") t.methodChosen = body["method_chosen"];
    const ts = str(body["transaction_status"]);
    if (!ts) {
      if (typeof body["method_chosen"] === "boolean") return c.json({ method_chosen: t.methodChosen });
      return c.json({ error: "transaction_status required" }, 400);
    }
    t.transactionStatus = ts;
    t.fraudStatus = str(body["fraud_status"]) ?? t.fraudStatus;
    t.paymentType = str(body["payment_type"]) ?? t.paymentType;
    t.bank = str(body["bank"]) ?? t.bank;
    // Test controls beyond Midtrans' own fields: a settlement of another amount or currency (the
    // amount-mismatch cases), and a retry inside Snap with another method, which Midtrans records
    // as a new transaction of the same order_id.
    t.grossAmount = str(body["gross_amount"]) ?? t.grossAmount;
    t.currency = str(body["currency"]) ?? t.currency;
    if (body["new_transaction"] === true) t.transactionId = randomUUID();
    return c.json(statusBody(t));
  });

  app.post("/__stub/notify", async (c) => {
    const body = await readJson(c.req.raw);
    const orderId = str(body["order_id"]);
    const targetUrl = str(body["targetUrl"]);
    const t = orderId ? txns.get(orderId) : undefined;
    if (!targetUrl || !t) return c.json({ error: "known order_id and targetUrl required" }, 400);
    const payload = statusBody(t);
    if (body["forge"] === true) payload.signature_key = "f".repeat(128);
    const res = await doFetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return c.json({ delivered: true, targetStatus: res.status, payload });
  });

  return app;
}
