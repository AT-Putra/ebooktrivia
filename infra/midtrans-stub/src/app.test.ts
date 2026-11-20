import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMidtransStubApp } from "./app.ts";

const SERVER_KEY = "SB-Mid-server-TEST";
const authHeader = `Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}`;
const headers = { Authorization: authHeader, "content-type": "application/json" };
const json = (body: unknown) => ({ method: "POST", headers, body: JSON.stringify(body) });
const expectedSig = (o: string, s: string, g: string) =>
  createHash("sha512").update(`${o}${s}${g}${SERVER_KEY}`).digest("hex");

function make(fetchImpl?: typeof fetch) {
  return createMidtransStubApp({ serverKey: SERVER_KEY, ...(fetchImpl && { fetchImpl }) });
}
const create = (app: ReturnType<typeof make>, orderId: string) =>
  app.request("/snap/v1/transactions", json({ transaction_details: { order_id: orderId, gross_amount: 50000 } }));

describe("midtrans-stub", () => {
  it("requires Basic auth", async () => {
    const app = make();
    const res = await app.request("/snap/v1/transactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect((await app.request("/v2/X/status")).status).toBe(401);
  });

  it("creates a Snap transaction and rejects a duplicate order_id with 400", async () => {
    const app = make();
    const ok = await create(app, "ORDER-1");
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { token: string; redirect_url: string };
    expect(body.token).toBeTruthy();
    expect(body.redirect_url).toContain(body.token);
    const dup = await create(app, "ORDER-1");
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ error_messages: ["transaction_details.order_id sudah digunakan"] });
  });

  it("returns Midtrans-shaped status JSON and honours state control", async () => {
    const app = make();
    await create(app, "ORDER-2");
    const pending = (await (await app.request("/v2/ORDER-2/status", { headers })).json()) as Record<string, string>;
    expect(pending).toMatchObject({
      status_code: "201",
      gross_amount: "50000.00",
      currency: "IDR",
      order_id: "ORDER-2",
      transaction_status: "pending",
    });
    for (const k of ["transaction_id", "payment_type", "fraud_status", "transaction_time", "signature_key"]) {
      expect(pending).toHaveProperty(k);
    }
    await app.request("/__stub/transactions/ORDER-2/state", json({ transaction_status: "settlement", payment_type: "qris" }));
    const settled = (await (await app.request("/v2/ORDER-2/status", { headers })).json()) as Record<string, string>;
    expect(settled).toMatchObject({ status_code: "200", transaction_status: "settlement", payment_type: "qris" });
    expect(settled["signature_key"]).toBe(expectedSig("ORDER-2", "200", "50000.00"));
  });

  it("notify signs with sha512(order_id+status_code+gross_amount+serverKey); forge variant fails", async () => {
    const calls: { url: string; body: string }[] = [];
    const fake: typeof fetch = (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), body: init?.body as string });
      return Promise.resolve(new Response("ok"));
    };
    const app = make(fake);
    await create(app, "ORDER-3");
    await app.request("/__stub/transactions/ORDER-3/state", json({ transaction_status: "settlement" }));
    await app.request("/__stub/notify", json({ order_id: "ORDER-3", targetUrl: "http://hook.test/midtrans" }));
    await app.request("/__stub/notify", json({ order_id: "ORDER-3", targetUrl: "http://hook.test/midtrans", forge: true }));
    expect(calls).toHaveLength(2);
    const good = JSON.parse(calls[0]?.body ?? "{}") as Record<string, string>;
    const forged = JSON.parse(calls[1]?.body ?? "{}") as Record<string, string>;
    const expected = expectedSig("ORDER-3", "200", "50000.00");
    expect(good["signature_key"]).toBe(expected);
    expect(forged["signature_key"]).not.toBe(expected);
    expect(forged["order_id"]).toBe("ORDER-3");
  });

  it("state control can settle another amount or currency, signed, and mint a new transaction id (a Snap retry)", async () => {
    const app = make();
    await create(app, "ORDER-4");
    const before = (await (await app.request("/v2/ORDER-4/status", { headers })).json()) as Record<string, string>;
    await app.request("/__stub/transactions/ORDER-4/state", json({ transaction_status: "settlement", gross_amount: "50001.00", currency: "USD", new_transaction: true }));
    const after = (await (await app.request("/v2/ORDER-4/status", { headers })).json()) as Record<string, string>;
    expect(after).toMatchObject({ transaction_status: "settlement", gross_amount: "50001.00", currency: "USD" });
    expect(after["transaction_id"]).not.toBe(before["transaction_id"]);
    expect(after["signature_key"]).toBe(expectedSig("ORDER-4", "200", "50001.00"));
  });
});
