// US-024: what the conversion fire port refuses to send, and what it leaves out of a request it does send. Every
// refusal is a plain failed attempt with a reason that carries no secret, no value and no PII, and makes no
// request: nothing left the process, so the attempt is retried on the schedule and never "maybe sent".
import { randomUUID } from "node:crypto";
import type { HttpFetch } from "@ebooktrivia/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversionToFire, FireConversion } from "../src/conversion-fire.ts";
import { createConversionFire } from "../src/conversions.ts";
import { createLogger } from "../src/log.ts";
import { sql } from "./support/db.ts";
import { createAttributedOrder, createTrackingShop, dropCapiTokens, opener, startVendorStub, stubbedFetch, type TrackingShop, type VendorStub } from "./support/conversions.ts";
import { retireEffects, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(4);
const log = createLogger({ level: "silent", role: "worker" });
let vendor: VendorStub;
let shop: TrackingShop;
beforeAll(async () => {
  vendor = await startVendorStub();
  shop = await createTrackingShop();
});
afterAll(async () => {
  await vendor.close();
  await retireEffects(shop);
  await dropCapiTokens();
});

const signal = new AbortController().signal;
const event = (over: Partial<ConversionToFire> & { orderId: string }): ConversionToFire => ({
  id: randomUUID(),
  sink: "meta",
  kind: "mt",
  adnetId: null,
  txid: over.orderId,
  eventId: randomUUID(),
  valueIdr: 49_000,
  payoutIdr: null,
  attempt: 1,
  ...over,
});

/** A port over a fetch that fails the test if it is called: a refusal sends nothing. */
function refusing(): { fire: FireConversion; calls: () => number } {
  let calls = 0;
  const fetch: HttpFetch = () => {
    calls++;
    return Promise.reject(new Error("no request expected"));
  };
  return { fire: createConversionFire({ sql: workerSql, opener, fetch, metaApiVersion: "v24.0", log }), calls: () => calls };
}

async function refused(over: Partial<ConversionToFire> & { orderId: string }, fire = refusing()): Promise<string> {
  const result = await fire.fire(event(over), signal);
  expect(fire.calls()).toBe(0);
  expect(result).toMatchObject({ outcome: { kind: "failed", httpStatus: null }, latencyMs: 0, responseSnippet: "", requestUrlRedacted: null });
  return result.outcome.kind === "failed" ? result.outcome.error : "";
}

describe("a conversion the port refuses to even try", () => {
  it("an unknown kind or sink, and an order or adnet that no longer exists", async () => {
    const order = await createAttributedOrder(shop);
    expect(await refused({ orderId: order.id, kind: "refund" })).toBe("unknown conversion kind");
    expect(await refused({ orderId: order.id, sink: "google" })).toBe("no sender for the google sink");
    expect(await refused({ orderId: randomUUID() })).toBe("the order of this conversion no longer exists");
    expect(await refused({ orderId: order.id, sink: "s2s", adnetId: null })).toBe("an S2S conversion has no adnet");
    expect(await refused({ orderId: order.id, sink: "s2s", adnetId: randomUUID() })).toBe("the adnet of this conversion no longer exists");
  });

  it("an S2S conversion of an adnet without a postback host, or of an order without a click id", async () => {
    const noHost = await createTrackingShop({ apiKey: false, pixels: {} });
    await sql`UPDATE adnets SET endpoint_host = NULL WHERE id = ${noHost.adnetId}`;
    const attributed = await createAttributedOrder(noHost);
    expect(await refused({ orderId: attributed.id, sink: "s2s", adnetId: noHost.adnetId })).toBe("the adnet has no postback host");
    const organic = await createAttributedOrder(shop, { attributed: false });
    expect(await refused({ orderId: organic.id, sink: "s2s", adnetId: shop.adnetId })).toBe("the order carries no click id");
    await retireEffects(noHost);
  });

  it("a CAPI event of a page without that pixel, without a value, with a malformed pixel id, an event id that is not one, or a reversal", async () => {
    const bare = await createTrackingShop({ pixels: {}, apiKey: false });
    const order = await createAttributedOrder(bare);
    expect(await refused({ orderId: order.id, sink: "meta" })).toBe("the landing page has no meta pixel");
    const withPixel = await createAttributedOrder(shop);
    expect(await refused({ orderId: withPixel.id, valueIdr: null })).toBe("the conversion has no value");
    expect(await refused({ orderId: withPixel.id, sink: "tiktok", kind: "reversal" })).toBe("tiktok has no reversal event");
    expect(await refused({ orderId: withPixel.id, eventId: "x" })).toMatch(/^the conversion cannot be built: eventId must be/);
    const odd = await createTrackingShop({ pixels: { meta: "123" }, metaToken: false, apiKey: false });
    const oddOrder = await createAttributedOrder(odd);
    expect(await refused({ orderId: oddOrder.id })).toBe("the conversion cannot be built: not a meta pixel id");
    await retireEffects(bare);
    await retireEffects(odd);
  });

  it("a database failure before the request is a failed attempt with a generic reason, not a crash and not an uncertain send", async () => {
    const broken = new Proxy(workerSql, {
      get: (_target, prop) => (prop === "then" ? undefined : () => Promise.reject(new Error("connection terminated"))),
      apply: () => Promise.reject(new Error("connection terminated")),
    });
    let calls = 0;
    const fire = createConversionFire({
      sql: broken,
      opener,
      fetch: () => {
        calls++;
        return Promise.reject(new Error("no request"));
      },
      metaApiVersion: "v24.0",
      log,
    });
    const result = await fire(event({ orderId: randomUUID() }), signal);
    expect(result.outcome).toEqual({ kind: "failed", httpStatus: null, error: "the conversion could not be prepared" });
    expect(calls).toBe(0);
  });
});

describe("what a request leaves out when the order does not have it", () => {
  it("no phone it can hash, no IP, no landing page address, no ad-platform ids: those fields are simply absent", async () => {
    const lean = await createTrackingShop();
    await sql`DELETE FROM lp_domains WHERE landing_page_id = ${lean.landingPageId}`;
    const order = await createAttributedOrder(lean);
    await sql`UPDATE orders SET buyer_phone = '+14155550123', ip = NULL, fbp = NULL, fbc = NULL, ttclid = NULL, sub_id = NULL, pub = NULL WHERE id = ${order.id}`;
    const stubbed = stubbedFetch(vendor);
    const fire = createConversionFire({ sql: workerSql, opener, fetch: stubbed.fetch, metaApiVersion: "v24.0", log, now: () => new Date("2030-01-01T00:00:00.000Z") });
    const from = vendor.requests.length;
    try {
      // An MT of an order that has no paid_at yet takes the sender's clock for its event time.
      const meta = await fire(event({ orderId: order.id }), signal);
      expect(meta.outcome.kind).toBe("sent");
      const tiktok = await fire(event({ orderId: order.id, sink: "tiktok" }), signal);
      expect(tiktok.outcome.kind).toBe("sent");
      const s2s = await fire(event({ orderId: order.id, sink: "s2s", adnetId: lean.adnetId }), signal);
      expect(s2s.outcome.kind).toBe("sent");
      const [metaRequest, tiktokRequest, s2sRequest] = vendor.requests.slice(from);
      const metaEvent = (JSON.parse(metaRequest?.body ?? "{}") as { data: Record<string, unknown>[] }).data[0] ?? {};
      expect(metaEvent["event_time"]).toBe(Date.parse("2030-01-01T00:00:00.000Z") / 1000);
      expect(metaEvent).not.toHaveProperty("event_source_url");
      expect(Object.keys(metaEvent["user_data"] as object).sort()).toEqual(["em"]);
      const tiktokUser = ((JSON.parse(tiktokRequest?.body ?? "{}") as { data: { user: Record<string, unknown> }[] }).data[0] ?? { user: {} }).user;
      expect(Object.keys(tiktokUser)).toEqual(["email"]);
      // {sub_id} and {pub} render empty when the order has none.
      expect(new URL(s2sRequest?.url ?? "", "http://x").searchParams.get("sub")).toBe("");
    } finally {
      await stubbed.close();
      await retireEffects(lean);
    }
  });
});
