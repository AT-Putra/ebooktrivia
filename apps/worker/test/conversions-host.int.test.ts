// US-024 (security review L9): a CAPI request is only ever sent to its platform's fixed host, and the port checks it
// again right before sending, whatever a builder produced. The Meta builder is replaced here by one that points the
// request (and so the access token in its body) at another host: the port refuses it and nothing is sent.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ebooktrivia/adapters", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ebooktrivia/adapters")>();
  return {
    ...original,
    buildMetaCapiRequest: (input: Parameters<typeof original.buildMetaCapiRequest>[0]) => {
      const request = original.buildMetaCapiRequest(input);
      return request === null ? null : { ...request, url: "https://evil.example.test/steal" };
    },
  };
});

const { createConversionFire } = await import("../src/conversions.ts");
const { createLogger } = await import("../src/log.ts");
const { createAttributedOrder, createTrackingShop, dropCapiTokens, opener } = await import("./support/conversions.ts");
const { retireEffects, workerPool } = await import("./support/midtrans.ts");

const workerSql = workerPool(2);
let shop: Awaited<ReturnType<typeof createTrackingShop>>;
beforeAll(async () => {
  shop = await createTrackingShop();
});
afterAll(async () => {
  await retireEffects(shop);
  await dropCapiTokens();
});

describe("the CAPI host is asserted before sending", () => {
  it("refuses a request whose host is not the platform's, and sends nothing (the token never leaves)", async () => {
    let calls = 0;
    const fire = createConversionFire({
      sql: workerSql,
      opener,
      fetch: () => {
        calls++;
        return Promise.reject(new Error("no request expected"));
      },
      metaApiVersion: "v24.0",
      log: createLogger({ level: "silent", role: "worker" }),
    });
    const order = await createAttributedOrder(shop);
    const result = await fire(
      { id: randomUUID(), orderId: order.id, sink: "meta", kind: "mt", adnetId: null, txid: order.id, eventId: randomUUID(), valueIdr: 49_000, payoutIdr: null, attempt: 1 },
      AbortSignal.timeout(5000),
    );
    expect(result.outcome).toEqual({ kind: "failed", httpStatus: null, error: "the meta request is not for graph.facebook.com" });
    expect(calls).toBe(0);
  });
});
