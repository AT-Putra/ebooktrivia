// US-012 criterion 2: Midtrans adapter against the infra/midtrans-stub app (in-process), which replays
// the fixtures RECORDED from the Midtrans sandbox in US-005.
import { createMidtransStubApp } from "@ebooktrivia/midtrans-stub/src/app.ts";
import { midtransSignature } from "@ebooktrivia/midtrans-stub/src/signature.ts";
import { describe, expect, it } from "vitest";
import notifications from "../../../infra/midtrans-stub/fixtures/notification.json" with { type: "json" };
import type { HttpFetch, HttpResponse } from "./http.ts";
import {
  confirmSettlement,
  createSnapTransaction,
  expectedGrossAmount,
  getTransactionStatus,
  grossAmountMatches,
  isMidtransOrderId,
  isSignatureShape,
  MIDTRANS_ENDPOINTS,
  MIDTRANS_TRANSACTION_STATUSES,
  type MidtransConfig,
  MidtransError,
  type MidtransStatus,
  parseNotification,
  signedFields,
  verifySignature,
} from "./midtrans.ts";
import { SafeFetchError } from "./safe-fetch.ts";

const SERVER_KEY = "SB-Mid-server-TEST-0123456789";
const stub = createMidtransStubApp({ serverKey: SERVER_KEY });
const stubFetch: HttpFetch = async (url, init) =>
  await stub.fetch(new Request(url, { method: init.method, headers: init.headers, body: init.body ?? null }));

const config = (overrides: Partial<MidtransConfig> = {}): MidtransConfig => ({
  serverKey: SERVER_KEY,
  snapBaseUrl: "https://app.sandbox.midtrans.com",
  apiBaseUrl: "https://api.sandbox.midtrans.com",
  fetch: stubFetch,
  ...overrides,
});

let seq = 0;
const snapInput = (amount = 50_000) => ({
  midtransOrderId: `ord-${Date.now().toString(36)}-${(seq++).toString()}-1`,
  grossAmountIdr: amount,
  expiryMinutes: 60,
  item: { id: "ebook-1", name: "Ebook Trivia Nusantara Juara" },
  customer: { firstName: "Budi", email: "budi@example.com", phone: "+6281234567890" },
  finishUrl: "https://order.example.id/o/abc",
});

async function midtransError(p: Promise<unknown>): Promise<MidtransError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MidtransError);
    return e as MidtransError;
  }
  throw new Error("expected a MidtransError");
}

const respond =
  (status: number, body: unknown): HttpFetch =>
  () =>
    Promise.resolve<HttpResponse>({
      status,
      json: () => (typeof body === "string" ? Promise.reject(new SyntaxError("not JSON")) : Promise.resolve(body)),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    });

describe("Snap create and status re-query (against midtrans-stub)", () => {
  it("creates a Snap transaction and re-queries its signed status", async () => {
    const input = snapInput();
    const snap = await createSnapTransaction(config(), input);
    expect(snap.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.redirectUrl).toMatch(/^https:\/\/app\.sandbox\.midtrans\.com\/snap\/v4\/redirection\//);
    const status = await getTransactionStatus(config(), input.midtransOrderId);
    expect(status).toMatchObject({ orderId: input.midtransOrderId, transactionStatus: "pending", statusCode: "201", grossAmount: "50000.00" });
  });

  it("sends the order id, integer amount, expiry in minutes, enabled payments and the finish callback", async () => {
    const bodies: unknown[] = [];
    const recording: HttpFetch = async (url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return stubFetch(url, init);
    };
    const input = { ...snapInput(49_000), expiryMinutes: 44, startTime: new Date("2026-11-21T10:30:00.900Z"), enabledPayments: ["other_qris", "bca_va"] };
    await createSnapTransaction(config({ fetch: recording }), input);
    expect(bodies[0]).toEqual({
      transaction_details: { order_id: input.midtransOrderId, gross_amount: 49_000 },
      item_details: [{ id: "ebook-1", name: "Ebook Trivia Nusantara Juara", price: 49_000, quantity: 1 }],
      customer_details: { first_name: "Budi", email: "budi@example.com", phone: "+6281234567890" },
      // The window starts at start_time (WIB, whole seconds): recorded, Midtrans otherwise starts it when the buyer picks a method.
      expiry: { start_time: "2026-11-21 17:30:00 +0700", unit: "minutes", duration: 44 },
      enabled_payments: ["other_qris", "bca_va"],
      callbacks: { finish: "https://order.example.id/o/abc" },
    });
    const { finishUrl, ...withoutFinish } = snapInput();
    expect(finishUrl).toMatch(/^https:/);
    await createSnapTransaction(config({ fetch: recording }), withoutFinish);
    expect(bodies[1]).not.toHaveProperty("enabled_payments");
    expect(bodies[1]).not.toHaveProperty("callbacks");
    // Without a startTime the window starts now.
    expect((bodies[1] as { expiry: { start_time: string } }).expiry.start_time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+0700$/);
  });

  it("asks for 3-D Secure explicitly whenever cards can be offered (the sandbox account does not default to it): credit_card in the list, or no list", async () => {
    const bodies: { credit_card?: unknown }[] = [];
    const recording: HttpFetch = async (url, init) => {
      bodies.push(JSON.parse(String(init.body)) as { credit_card?: unknown });
      return stubFetch(url, init);
    };
    await createSnapTransaction(config({ fetch: recording }), { ...snapInput(), enabledPayments: ["credit_card", "bca_va"] });
    await createSnapTransaction(config({ fetch: recording }), { ...snapInput(), enabledPayments: ["bca_va", "other_qris"] });
    await createSnapTransaction(config({ fetch: recording }), snapInput());
    await createSnapTransaction(config({ fetch: recording }), { ...snapInput(), enabledPayments: ["credit_card"] });
    expect(bodies[0]?.credit_card).toEqual({ secure: true });
    expect(bodies[1]).not.toHaveProperty("credit_card"); // no card offered: nothing to secure
    expect(bodies[2]?.credit_card).toEqual({ secure: true }); // Snap's own list includes cards
    expect(bodies[3]?.credit_card).toEqual({ secure: true });
  });

  it("the stub's expiry_time is start_time plus the duration, as Midtrans recorded it (the window is not counted from the method choice)", async () => {
    const input = { ...snapInput(), expiryMinutes: 45, startTime: new Date("2026-11-21T10:30:00Z") };
    await createSnapTransaction(config(), input);
    const answer = (await (await stubFetch(`https://api.sandbox.midtrans.com/v2/${input.midtransOrderId}/status`, { method: "GET", headers: { authorization: `Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}` } })).json()) as { expiry_time: string };
    expect(answer.expiry_time).toBe("2026-11-21 18:15:00");
  });

  it("rejects a startTime that is not a date", async () => {
    await expect(createSnapTransaction(config(), { ...snapInput(), startTime: new Date(Number.NaN) })).rejects.toThrow(RangeError);
  });

  it("has fixed Snap and API hosts per environment", () => {
    expect(MIDTRANS_ENDPOINTS.sandbox).toEqual({ snapBaseUrl: "https://app.sandbox.midtrans.com", apiBaseUrl: "https://api.sandbox.midtrans.com" });
    expect(MIDTRANS_ENDPOINTS.production).toEqual({ snapBaseUrl: "https://app.midtrans.com", apiBaseUrl: "https://api.midtrans.com" });
  });

  it("reports a settlement that the stub's control plane sets, with the amount as the signed string", async () => {
    const input = snapInput(49_000);
    await createSnapTransaction(config(), input);
    await stub.fetch(
      new Request(`https://stub/__stub/transactions/${input.midtransOrderId}/state`, {
        method: "POST",
        body: JSON.stringify({ transaction_status: "settlement", payment_type: "qris" }),
      }),
    );
    const status = await getTransactionStatus(config(), input.midtransOrderId);
    expect(status).toMatchObject({ transactionStatus: "settlement", statusCode: "200", grossAmount: "49000.00", paymentType: "qris" });
    expect(status !== undefined && grossAmountMatches(49_000, status.grossAmount)).toBe(true);
    expect(status !== undefined && grossAmountMatches(50_000, status.grossAmount)).toBe(false);
  });

  it("refuses a duplicate order_id as a non-retryable rejection", async () => {
    const input = snapInput();
    await createSnapTransaction(config(), input);
    const error = await midtransError(createSnapTransaction(config(), input));
    expect(error).toMatchObject({ code: "rejected", retryable: false });
    expect(error.messages.join(" ")).toMatch(/sudah digunakan/);
  });

  it("reports a refused server key as unauthorized", async () => {
    const error = await midtransError(createSnapTransaction(config({ serverKey: "SB-Mid-server-WRONG" }), snapInput()));
    expect(error).toMatchObject({ code: "unauthorized", retryable: false });
    expect((await midtransError(getTransactionStatus(config({ serverKey: "wrong" }), "ord-x-1"))).code).toBe("unauthorized");
  });

  it("returns undefined for a transaction Midtrans does not know", async () => {
    expect(await getTransactionStatus(config(), "ord-unknown-1")).toBeUndefined();
  });
});

describe("status re-query hardening", () => {
  const signedBody = (orderId: string, overrides: Record<string, string> = {}) => {
    const body = { order_id: orderId, status_code: "200", gross_amount: "50000.00", transaction_status: "settlement", ...overrides };
    return { ...body, signature_key: overrides["signature_key"] ?? midtransSignature(body.order_id, body.status_code, body.gross_amount, SERVER_KEY) };
  };

  it("refuses a status whose signature does not verify", async () => {
    const forged = signedBody("ord-a-1", { signature_key: "f".repeat(128) });
    expect((await midtransError(getTransactionStatus(config({ fetch: respond(200, forged) }), "ord-a-1"))).code).toBe("bad_signature");
  });

  it("refuses a status for another order, or without the signed fields", async () => {
    const other = signedBody("ord-b-1");
    expect((await midtransError(getTransactionStatus(config({ fetch: respond(200, other) }), "ord-a-1"))).code).toBe("bad_response");
    expect((await midtransError(getTransactionStatus(config({ fetch: respond(200, { order_id: "ord-a-1" }) }), "ord-a-1"))).code).toBe("bad_response");
  });

  it("treats 5xx, network failures and non-JSON 5xx answers as retryable", async () => {
    expect(await midtransError(getTransactionStatus(config({ fetch: respond(503, { status_message: "busy" }) }), "ord-a-1"))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    const down: HttpFetch = () => Promise.reject(new Error("ECONNRESET"));
    expect(await midtransError(createSnapTransaction(config({ fetch: down }), snapInput()))).toMatchObject({ code: "unavailable", retryable: true });
    expect(await midtransError(getTransactionStatus(config({ fetch: respond(502, "<html>bad gateway</html>") }), "ord-a-1"))).toMatchObject({
      code: "bad_response",
      retryable: true,
    });
    expect((await midtransError(getTransactionStatus(config({ fetch: respond(200, [1, 2]) }), "ord-a-1"))).code).toBe("bad_response");
  });

  it("refuses a Snap answer without a token or with a non-https redirect", async () => {
    const plain = respond(201, { token: "t", redirect_url: "http://app.sandbox.midtrans.com/x" });
    expect((await midtransError(createSnapTransaction(config({ fetch: plain }), snapInput()))).code).toBe("bad_response");
    expect((await midtransError(createSnapTransaction(config({ fetch: respond(201, {}) }), snapInput()))).code).toBe("bad_response");
  });

  it("validates its own inputs", async () => {
    await expect(createSnapTransaction(config(), { ...snapInput(), midtransOrderId: "bad id/../x" })).rejects.toThrow(RangeError);
    await expect(createSnapTransaction(config(), { ...snapInput(), expiryMinutes: 0 })).rejects.toThrow(RangeError);
    await expect(createSnapTransaction(config(), { ...snapInput(), grossAmountIdr: 1.5 })).rejects.toThrow(RangeError);
    await expect(getTransactionStatus(config(), "x".repeat(51))).rejects.toThrow(RangeError);
  });
});

describe("M3: confirmSettlement is the one paid predicate (AC-S6: settlement, amount and currency)", () => {
  const status = (overrides: Partial<MidtransStatus> = {}): MidtransStatus => ({
    orderId: "ord-a-1",
    statusCode: "200",
    grossAmount: "50000.00",
    transactionStatus: "settlement",
    fraudStatus: undefined,
    transactionId: "tx-1",
    paymentType: "qris",
    currency: "IDR",
    transactionTime: undefined,
    ...overrides,
  });
  const expected = { midtransOrderId: "ord-a-1", amountIdr: 50_000 };

  it("is paid only for a settlement of this order, status 200, the exact amount, in IDR", () => {
    expect(confirmSettlement(status(), expected)).toEqual({ kind: "paid" });
    expect(confirmSettlement(status({ fraudStatus: "accept" }), expected)).toEqual({ kind: "paid" });
  });

  it.each([
    [{ currency: undefined }, "currency_mismatch"],
    [{ currency: "USD" }, "currency_mismatch"],
    [{ currency: "idr" }, "currency_mismatch"],
    [{ grossAmount: "49000.00" }, "amount_mismatch"],
    [{ grossAmount: "50000" }, "amount_mismatch"],
    [{ orderId: "ord-b-1" }, "order_mismatch"],
    [{ statusCode: "201" }, "status_code_mismatch"],
    [{ fraudStatus: "challenge" }, "fraud_review"],
  ] as const)("a settlement with %j is review (%s), never paid", (overrides, reason) => {
    expect(confirmSettlement(status(overrides), expected)).toEqual({ kind: "review", reason });
  });

  it("anything but a settlement or a card capture with fraud accept is not settled", () => {
    expect(confirmSettlement(status({ transactionStatus: "pending", statusCode: "201" }), expected)).toEqual({ kind: "not_settled", transactionStatus: "pending" });
    for (const transactionStatus of ["deny", "cancel", "expire", "failure", "refund", "authorize"]) {
      expect(confirmSettlement(status({ transactionStatus }), expected)).toEqual({ kind: "not_settled", transactionStatus });
    }
  });

  it("Owner D10: a card capture with fraud accept is paid by default (the settlement comes the next day); the opt-out waits; challenge and deny never pay", () => {
    const capture = status({ transactionStatus: "capture", fraudStatus: "accept" });
    expect(confirmSettlement(capture, expected)).toEqual({ kind: "paid" });
    expect(confirmSettlement(capture, expected, { treatCardCaptureAsPaid: true })).toEqual({ kind: "paid" });
    expect(confirmSettlement(capture, expected, { treatCardCaptureAsPaid: false })).toEqual({ kind: "not_settled", transactionStatus: "capture" });
    // The same checks as a settlement: amount, currency, status code.
    expect(confirmSettlement({ ...capture, currency: undefined }, expected)).toEqual({ kind: "review", reason: "currency_mismatch" });
    expect(confirmSettlement({ ...capture, grossAmount: "49000.00" }, expected)).toEqual({ kind: "review", reason: "amount_mismatch" });
    expect(confirmSettlement({ ...capture, statusCode: "201" }, expected)).toEqual({ kind: "review", reason: "status_code_mismatch" });
    for (const fraudStatus of ["challenge", "deny", undefined]) {
      expect(confirmSettlement(status({ transactionStatus: "capture", fraudStatus }), expected)).toEqual({ kind: "not_settled", transactionStatus: "capture" });
    }
  });

  it("decides on the stub's re-queried capture of a card: paid", async () => {
    const input = snapInput(49_000);
    await createSnapTransaction(config(), input);
    await stub.fetch(new Request(`https://stub/__stub/transactions/${input.midtransOrderId}/state`, { method: "POST", body: JSON.stringify({ transaction_status: "capture", payment_type: "credit_card" }) }));
    const requeried = await getTransactionStatus(config(), input.midtransOrderId);
    if (requeried === undefined) throw new Error("expected a status");
    expect(requeried).toMatchObject({ transactionStatus: "capture", fraudStatus: "accept", paymentType: "credit_card", statusCode: "200" });
    expect(confirmSettlement(requeried, { midtransOrderId: input.midtransOrderId, amountIdr: 49_000 })).toEqual({ kind: "paid" });
  });

  it("decides on the stub's re-queried, signed status", async () => {
    const input = snapInput(49_000);
    await createSnapTransaction(config(), input);
    await stub.fetch(new Request(`https://stub/__stub/transactions/${input.midtransOrderId}/state`, { method: "POST", body: JSON.stringify({ transaction_status: "settlement" }) }));
    const requeried = await getTransactionStatus(config(), input.midtransOrderId);
    if (requeried === undefined) throw new Error("expected a status");
    expect(confirmSettlement(requeried, { midtransOrderId: input.midtransOrderId, amountIdr: 49_000 })).toEqual({ kind: "paid" });
    expect(confirmSettlement(requeried, { midtransOrderId: input.midtransOrderId, amountIdr: 50_000 })).toEqual({ kind: "review", reason: "amount_mismatch" });
  });
});

describe("M5: transient failures stay retryable", () => {
  const failingBody =
    (status: number, error: Error): HttpFetch =>
    () =>
      Promise.resolve<HttpResponse>({ status, json: () => Promise.reject(error), text: () => Promise.reject(error) });

  it.each([
    ["a body timeout (DOMException TimeoutError)", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["an aborted body (DOMException AbortError)", new DOMException("This operation was aborted", "AbortError")],
    ["a terminated body (TypeError)", new TypeError("terminated")],
    ["a safe-fetch body timeout", new SafeFetchError("timeout", "no complete response")],
  ])("%s after HTTP 200 is unavailable and retryable", async (_name, error) => {
    expect(await midtransError(getTransactionStatus(config({ fetch: failingBody(200, error) }), "ord-a-1"))).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("408 and 429 are retryable", async () => {
    for (const status of [408, 429]) {
      expect(await midtransError(getTransactionStatus(config({ fetch: respond(status, { status_message: "slow down" }) }), "ord-a-1"))).toMatchObject({ code: "unavailable", retryable: true });
    }
  });

  it("a 200 that is not JSON is still a non-retryable bad response", async () => {
    expect(await midtransError(getTransactionStatus(config({ fetch: respond(200, "<html>") }), "ord-a-1"))).toMatchObject({ code: "bad_response", retryable: false });
  });
});

describe("A2 / A11: order id and Snap redirect checks", () => {
  it("refuses the order ids '.' and '..'", async () => {
    await expect(getTransactionStatus(config(), ".")).rejects.toThrow(RangeError);
    await expect(getTransactionStatus(config(), "..")).rejects.toThrow(RangeError);
    await expect(createSnapTransaction(config(), { ...snapInput(), midtransOrderId: ".." })).rejects.toThrow(RangeError);
    expect(await getTransactionStatus(config(), "a.b")).toBeUndefined();
  });

  it("pins the Snap redirect_url to the Snap host", async () => {
    for (const redirect of ["https://evil.example/snap/v4/redirection/t", "https://app.sandbox.midtrans.com.evil.example/x", "https://app.midtrans.com/x"]) {
      expect((await midtransError(createSnapTransaction(config({ fetch: respond(201, { token: "t", redirect_url: redirect }) }), snapInput()))).code).toBe("bad_response");
    }
  });
});

describe("notification signature (constant-time, gross_amount as the signed string)", () => {
  const settlement = notifications.settlement;
  const signed = { ...settlement, signature_key: midtransSignature(settlement.order_id, settlement.status_code, settlement.gross_amount, SERVER_KEY) };

  it("verifies the fixture notification signed with the server key", () => {
    const fields = signedFields(signed);
    expect(fields).toBeDefined();
    expect(fields !== undefined && verifySignature(fields, SERVER_KEY)).toBe(true);
    expect(fields !== undefined && verifySignature({ ...fields, signature_key: fields.signature_key.toUpperCase() }, SERVER_KEY)).toBe(true);
  });

  it("refuses a forged signature, another key, or an amount re-formatted from the signed string", () => {
    const fields = signedFields(signed);
    if (fields === undefined) throw new Error("fixture");
    expect(verifySignature({ ...fields, signature_key: "f".repeat(128) }, SERVER_KEY)).toBe(false);
    expect(verifySignature({ ...fields, signature_key: "abc" }, SERVER_KEY)).toBe(false);
    expect(verifySignature(fields, "SB-Mid-server-OTHER")).toBe(false);
    // "50000" and "50000.0" are the same number but not the signed string.
    expect(verifySignature({ ...fields, gross_amount: "50000" }, SERVER_KEY)).toBe(false);
    expect(verifySignature({ ...fields, gross_amount: "50000.0" }, SERVER_KEY)).toBe(false);
  });

  it("P1-1: accepts only 128 hex digits, so no character aliases a hex digit", () => {
    const fields = signedFields(signed);
    if (fields === undefined) throw new Error("fixture");
    const good = fields.signature_key;
    // U+0239 keeps 0x39 ("9") as its low byte: an "ascii" Buffer used to read it as "9".
    const alias = good.replace(/9/, "\u0239");
    expect(alias).not.toBe(good);
    expect(verifySignature({ ...fields, signature_key: alias }, SERVER_KEY)).toBe(false);
    expect(isSignatureShape(alias)).toBe(false);
    expect(verifySignature({ ...fields, signature_key: `${good} ` }, SERVER_KEY)).toBe(false);
    expect(verifySignature({ ...fields, signature_key: good.slice(0, 127) }, SERVER_KEY)).toBe(false);
    expect(verifySignature({ ...fields, signature_key: `${good.slice(0, 127)}g` }, SERVER_KEY)).toBe(false);
    expect(isSignatureShape(good)).toBe(true);
    expect(isSignatureShape(good.toUpperCase())).toBe(true);
  });

  it("needs every signed field to be a non-empty string", () => {
    expect(signedFields({ ...signed, gross_amount: 50_000 })).toBeUndefined();
    expect(signedFields({ ...signed, signature_key: "" })).toBeUndefined();
    expect(signedFields("not an object")).toBeUndefined();
  });

  it("parseNotification: the signed fields, a known status label and a short whitelisted copy, nothing else", () => {
    const body = {
      ...signed,
      fraud_status: "accept",
      payment_type: "qris",
      transaction_id: "tx-1",
      customer_details: { first_name: "Budi", email: "budi@example.com" },
      va_numbers: [{ bank: "bca", va_number: "12345678901" }],
      transaction_time: "x".repeat(500),
    };
    const parsed = parseNotification(body);
    expect(parsed?.signed).toEqual(signedFields(signed));
    expect(parsed?.transactionStatus).toBe("settlement");
    expect(parsed?.summary).toEqual({
      order_id: settlement.order_id,
      status_code: "200",
      gross_amount: "50000.00",
      transaction_status: "settlement",
      fraud_status: "accept",
      payment_type: "qris",
      transaction_id: "tx-1",
      transaction_time: "x".repeat(64),
      currency: "IDR",
    });
    // The label is not signed: anything outside the known list collapses to one value.
    expect(parseNotification({ ...signed, transaction_status: "settlement2" })?.transactionStatus).toBe("unknown");
    expect(parseNotification({ ...signed, transaction_status: 1 })?.transactionStatus).toBe("unknown");
    for (const status of MIDTRANS_TRANSACTION_STATUSES) expect(parseNotification({ ...signed, transaction_status: status })?.transactionStatus).toBe(status);
    expect(parseNotification({ ...signed, status_code: 200 })).toBeUndefined();
    expect(parseNotification(["not", "an", "object"])).toBeUndefined();
  });

  it("isMidtransOrderId accepts what getTransactionStatus can re-query", () => {
    expect(isMidtransOrderId("AbC012defGHI345jkl678m-12")).toBe(true);
    expect(isMidtransOrderId("..")).toBe(false);
    expect(isMidtransOrderId("a/b")).toBe(false);
    expect(isMidtransOrderId("a".repeat(51))).toBe(false);
  });

  it("compares order amounts against the signed string only", () => {
    expect(expectedGrossAmount(50_000)).toBe("50000.00");
    expect(grossAmountMatches(50_000, "50000.00")).toBe(true);
    expect(grossAmountMatches(50_000, "50000")).toBe(false);
    expect(grossAmountMatches(50_000, "50000.001")).toBe(false);
    expect(() => expectedGrossAmount(0)).toThrow(RangeError);
    expect(() => expectedGrossAmount(-1)).toThrow(RangeError);
  });
});
