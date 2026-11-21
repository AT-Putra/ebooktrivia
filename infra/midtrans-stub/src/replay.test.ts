import { describe, expect, it } from "vitest";
import notificationFixture from "../fixtures/notification.json" with { type: "json" };
import snapFixture from "../fixtures/snap-create.json" with { type: "json" };
import statusFixture from "../fixtures/status.json" with { type: "json" };
import { createMidtransStubApp } from "./app.ts";
import { midtransSignature } from "./signature.ts";

// The stub replays what the Midtrans sandbox RECORDED (fixtures/*.json, US-005, 2026-11-21).
const SERVER_KEY = "SB-Mid-server-TEST";
const DEV_KEY = "SB-Mid-server-DEVONLY";
const headers = { Authorization: `Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}`, "content-type": "application/json" };
const json = (body: unknown) => ({ method: "POST", headers, body: JSON.stringify(body) });
const make = () => createMidtransStubApp({ serverKey: SERVER_KEY });
type App = ReturnType<typeof make>;
const create = (app: App, orderId: string) => app.request("/snap/v1/transactions", json({ transaction_details: { order_id: orderId, gross_amount: 50000 } }));
const state = (app: App, orderId: string, body: unknown) => app.request(`/__stub/transactions/${orderId}/state`, json(body));
const statusOf = async (app: App, orderId: string) => {
  const res = await app.request(`/v2/${orderId}/status`, { headers });
  return { http: res.status, body: (await res.json()) as Record<string, unknown> };
};
const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
const scenarios = statusFixture.scenarios as unknown as Record<string, Record<string, unknown>>;

describe("midtrans-stub replays the recorded sandbox", () => {
  it("every recorded fixture carries a signature recomputed with the dev key, by the documented formula", () => {
    const bodies = [...Object.values(scenarios), ...Object.values(notificationFixture).filter((v) => typeof v === "object")] as Record<string, unknown>[];
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) {
      if (typeof body["signature_key"] !== "string") continue;
      expect(body["signature_key"]).toBe(midtransSignature(String(body["order_id"]), String(body["status_code"]), String(body["gross_amount"]), DEV_KEY));
    }
  });

  it("answers an unknown order, and a Snap order whose buyer has not picked a method, with HTTP 200 and status_code 404 in the body", async () => {
    const app = make();
    const recorded = scenarios["no_method_chosen"] ?? {};
    const unknown = await statusOf(app, "NOPE-1");
    expect(unknown.http).toBe(200);
    expect(keys(unknown.body)).toEqual(keys(recorded));
    expect(unknown.body).toMatchObject({ status_code: "404", status_message: recorded["status_message"] });
    await create(app, "ORDER-A");
    await state(app, "ORDER-A", { method_chosen: false });
    expect(await statusOf(app, "ORDER-A")).toMatchObject({ http: 200, body: { status_code: "404" } });
    await state(app, "ORDER-A", { method_chosen: true });
    expect((await statusOf(app, "ORDER-A")).body).toMatchObject({ status_code: "201", transaction_status: "pending" });
  });

  it("the same order_id: a NEW token while no method was chosen, then 400 (settled: English text, otherwise Indonesian), as recorded", async () => {
    const app = make();
    const first = (await (await create(app, "ORDER-B")).json()) as { token: string };
    await state(app, "ORDER-B", { method_chosen: false });
    const again = await create(app, "ORDER-B");
    expect(again.status).toBe(snapFixture.response_201_same_order_id_no_method_chosen.http_status);
    expect(((await again.json()) as { token: string }).token).not.toBe(first.token);
    await state(app, "ORDER-B", { method_chosen: true });
    const pending = await create(app, "ORDER-B");
    expect([pending.status, await pending.json()]).toEqual([snapFixture.response_400_duplicate_order_id.http_status, snapFixture.response_400_duplicate_order_id.body]);
    await state(app, "ORDER-B", { transaction_status: "expire" });
    expect(await (await create(app, "ORDER-B")).json()).toEqual(snapFixture.response_400_reuse_after_expire.body);
    await state(app, "ORDER-B", { transaction_status: "settlement" });
    const settled = await create(app, "ORDER-B");
    expect([settled.status, await settled.json()]).toEqual([snapFixture.response_400_duplicate_order_id_settled.http_status, snapFixture.response_400_duplicate_order_id_settled.body]);
  });

  it("deny, then a retry with another method on the SAME order_id: a new transaction_id, status 202 then 201, then 200 on the retry's settlement, as recorded", async () => {
    const denied = scenarios["deny_by_bank_card"] ?? {};
    const retried = scenarios["bca_va_pending_after_deny"] ?? {};
    const settled = scenarios["bca_va_settlement"] ?? {};
    // The recording itself: one order id throughout, the denied transaction replaced by a new one that then settled.
    expect([denied["order_id"], retried["order_id"], settled["order_id"]]).toEqual(["ORDER-1", "ORDER-1", "ORDER-1"]);
    expect([denied["status_code"], retried["status_code"], settled["status_code"]]).toEqual(["202", "201", "200"]);
    expect(denied["transaction_id"]).not.toBe(retried["transaction_id"]);
    expect(retried["transaction_id"]).toBe(settled["transaction_id"]);

    const app = make();
    await create(app, "ORDER-1");
    await state(app, "ORDER-1", { transaction_status: "deny", payment_type: "credit_card" });
    const first = await statusOf(app, "ORDER-1");
    await state(app, "ORDER-1", { transaction_status: "pending", payment_type: "bank_transfer", bank: "bca", new_transaction: true });
    const second = await statusOf(app, "ORDER-1");
    await state(app, "ORDER-1", { transaction_status: "settlement", payment_type: "bank_transfer", bank: "bca" });
    const third = await statusOf(app, "ORDER-1");

    expect(first.body).toMatchObject({ order_id: "ORDER-1", status_code: "202", transaction_status: "deny", payment_type: "credit_card" });
    expect(second.body).toMatchObject({ order_id: "ORDER-1", status_code: "201", transaction_status: "pending", payment_type: "bank_transfer" });
    expect(third.body).toMatchObject({ order_id: "ORDER-1", status_code: "200", transaction_status: "settlement" });
    expect(second.body["transaction_id"]).not.toBe(first.body["transaction_id"]); // a new transaction, the same order
    expect(third.body["transaction_id"]).toBe(second.body["transaction_id"]); // the retry's transaction is the one that settled
    expect(keys(first.body)).toEqual(keys(denied));
    expect(keys(second.body)).toEqual(keys(retried));
    expect(keys(third.body)).toEqual(keys(settled));
    expect((second.body["va_numbers"] as { bank: string }[])[0]?.bank).toBe("bca");
    // And once the retry's method is chosen the order id is taken (the recorded duplicate refusal, English text after the settlement).
    expect((await create(app, "ORDER-1")).status).toBe(400);
  });

  it("answers a missing order_id and a wrong key with the recorded bodies", async () => {
    const app = make();
    const missing = await app.request("/snap/v1/transactions", json({ transaction_details: { gross_amount: 1000 } }));
    expect([missing.status, await missing.json()]).toEqual([snapFixture.response_400_missing_order_id.http_status, snapFixture.response_400_missing_order_id.body]);
    const refused = await app.request("/v2/X/status", { headers: { Authorization: "Basic x" } });
    expect([refused.status, await refused.json()]).toEqual([snapFixture.response_401.http_status, snapFixture.response_401.body]);
  });

  it("a Snap redirect_url is the recorded /snap/v4/redirection/<uuid>", async () => {
    const app = make();
    const body = (await (await create(app, "ORDER-C")).json()) as { token: string; redirect_url: string };
    expect(body.redirect_url).toBe(`https://app.sandbox.midtrans.com/snap/v4/redirection/${body.token}`);
    expect(Object.keys(body).sort()).toEqual(Object.keys(snapFixture.response_201).sort());
  });

  it("expiry_time is the request's start_time (or the creation) plus its duration, not the buyer's method choice", async () => {
    const app = make();
    await app.request("/snap/v1/transactions", json({ transaction_details: { order_id: "ORDER-D", gross_amount: 1000 }, expiry: { start_time: "2026-11-21 17:30:00 +0700", unit: "minutes", duration: 60 } }));
    expect((await statusOf(app, "ORDER-D")).body["expiry_time"]).toBe("2026-11-21 18:30:00");
  });

  // Each recorded method-specific status: the stub, driven to that state, has the recorded keys.
  const REPLAYS: readonly (readonly [string, Record<string, unknown>])[] = [
    ["bca_va_pending_after_deny", { transaction_status: "pending", payment_type: "bank_transfer", bank: "bca" }],
    ["bca_va_settlement", { transaction_status: "settlement", payment_type: "bank_transfer", bank: "bca" }],
    ["bni_va_pending", { transaction_status: "pending", payment_type: "bank_transfer", bank: "bni" }],
    ["bni_va_expired", { transaction_status: "expire", payment_type: "bank_transfer", bank: "bni" }],
    ["permata_va_pending", { transaction_status: "pending", payment_type: "bank_transfer", bank: "permata" }],
    ["echannel_pending", { transaction_status: "pending", payment_type: "echannel" }],
    ["qris_settlement", { transaction_status: "settlement", payment_type: "qris" }],
    ["indomaret_pending", { transaction_status: "pending", payment_type: "cstore" }],
    ["indomaret_cancelled", { transaction_status: "cancel", payment_type: "cstore" }],
    ["card_capture", { transaction_status: "capture", payment_type: "credit_card" }],
    ["deny_by_bank_card", { transaction_status: "deny", payment_type: "credit_card" }],
  ];
  it.each(REPLAYS)("%s: same keys, status_code and statuses as the recording", async (name, control) => {
    const app = make();
    await create(app, "ORDER-E");
    await state(app, "ORDER-E", control);
    const recorded = scenarios[name] ?? {};
    const { http, body } = await statusOf(app, "ORDER-E");
    expect(http).toBe(200);
    expect(keys(body)).toEqual(keys(recorded));
    expect(body).toMatchObject({ status_code: recorded["status_code"], transaction_status: recorded["transaction_status"], payment_type: recorded["payment_type"], fraud_status: "accept", currency: "IDR" });
  });
});
