import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { basicAuthHeader, midtransSignature } from "./signature.ts";

export interface MidtransStubOptions {
  serverKey: string;
  fetchImpl?: typeof fetch;
}

interface Txn {
  orderId: string;
  transactionId: string;
  grossAmount: string;
  paymentType: string;
  transactionStatus: string;
  fraudStatus: string;
  transactionTime: string;
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

const formatTime = (d: Date): string => d.toISOString().replace("T", " ").slice(0, 19);

function statusCodeFor(status: string): string {
  if (status === "pending") return "201";
  if (status === "deny") return "202";
  if (status === "expire") return "407";
  return "200";
}

const UNAUTHORIZED = "Access denied due to unauthorized transaction, please check client or server key";

export function createMidtransStubApp(opts: MidtransStubOptions): Hono {
  const app = new Hono();
  const doFetch = opts.fetchImpl ?? fetch;
  const txns = new Map<string, Txn>();
  const expectedAuth = basicAuthHeader(opts.serverKey);

  const statusBody = (t: Txn) => {
    const statusCode = statusCodeFor(t.transactionStatus);
    return {
      status_code: statusCode,
      status_message: "Success, transaction is found",
      transaction_id: t.transactionId,
      order_id: t.orderId,
      gross_amount: t.grossAmount,
      currency: "IDR",
      payment_type: t.paymentType,
      transaction_status: t.transactionStatus,
      fraud_status: t.fraudStatus,
      transaction_time: t.transactionTime,
      signature_key: midtransSignature(t.orderId, statusCode, t.grossAmount, opts.serverKey),
    };
  };

  app.get("/healthz", (c) => c.json({ ok: true }));

  // --- Midtrans-shaped API (Basic auth) ---
  app.use("/snap/*", async (c, next) => {
    if (c.req.header("Authorization") !== expectedAuth) {
      return c.json({ error_messages: [UNAUTHORIZED] }, 401);
    }
    await next();
  });
  app.use("/v2/*", async (c, next) => {
    if (c.req.header("Authorization") !== expectedAuth) {
      return c.json({ status_code: "401", status_message: UNAUTHORIZED }, 401);
    }
    await next();
  });

  app.post("/snap/v1/transactions", async (c) => {
    const body = await readJson(c.req.raw);
    const details = body["transaction_details"];
    const orderId = isRecord(details) ? str(details["order_id"]) : undefined;
    const gross = isRecord(details) ? details["gross_amount"] : undefined;
    if (!orderId || (typeof gross !== "number" && typeof gross !== "string")) {
      return c.json({ error_messages: ["transaction_details.order_id dan gross_amount wajib diisi"] }, 400);
    }
    // PROVISIONAL: duplicate order_id behaviour not yet verified against real Midtrans.
    if (txns.has(orderId)) {
      return c.json({ error_messages: ["transaction_details.order_id sudah digunakan"] }, 400);
    }
    txns.set(orderId, {
      orderId,
      transactionId: randomUUID(),
      grossAmount: Number(gross).toFixed(2),
      paymentType: "bank_transfer",
      transactionStatus: "pending",
      fraudStatus: "accept",
      transactionTime: formatTime(new Date()),
    });
    const token = randomUUID();
    return c.json(
      { token, redirect_url: `https://app.sandbox.midtrans.com/snap/v4/redirection/${token}` },
      201,
    );
  });

  app.get("/v2/:order_id/status", (c) => {
    const t = txns.get(c.req.param("order_id"));
    if (!t) return c.json({ status_code: "404", status_message: "Transaction does not exist." }, 404);
    return c.json(statusBody(t));
  });

  // --- control plane ---
  app.post("/__stub/transactions/:order_id/state", async (c) => {
    const t = txns.get(c.req.param("order_id"));
    if (!t) return c.json({ error: "unknown order_id" }, 404);
    const body = await readJson(c.req.raw);
    const ts = str(body["transaction_status"]);
    if (!ts) return c.json({ error: "transaction_status required" }, 400);
    t.transactionStatus = ts;
    t.fraudStatus = str(body["fraud_status"]) ?? t.fraudStatus;
    t.paymentType = str(body["payment_type"]) ?? t.paymentType;
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
