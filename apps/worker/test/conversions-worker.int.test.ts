// US-024: the conversions in the worker composition (src/worker.ts): the conversion.mo consumer writes the MO rows,
// the order.paid consumer hurries the MT rows of a paid order onto the conversion queue (so they do not wait for
// the minute sweep), and the production entry wires all of it from SECRETS_CONVERSIONS_PRIVATE_KEY only.
import { randomUUID } from "node:crypto";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capiDedupesByEventId, conversionsFromEnv, createConversionFire } from "../src/conversions.ts";
import { createLogger } from "../src/log.ts";
import { startWorker } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import {
  createAttributedOrder,
  createTrackingShop,
  dropCapiTokens,
  eventOf,
  eventsOf,
  opener,
  startVendorStub,
  stubbedFetch,
  type TrackingShop,
  type VendorStub,
} from "./support/conversions.ts";
import { first, sql, waitFor } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";
import { midtransStub, notification, retireEffects, workerPool } from "./support/midtrans.ts";
import { kill, MAIN, spawnNode, waitForLine, workerEnv } from "./support/processes.ts";
import { uniquePrefix } from "./support/valkey.ts";

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

const beforeTwo = () => new Date("2030-01-01T18:00:00.000Z");

function ports(stubbed: ReturnType<typeof stubbedFetch>) {
  return {
    conversions: {
      fire: (workerSql: Parameters<typeof createConversionFire>[0]["sql"], log: Parameters<typeof createConversionFire>[0]["log"]) =>
        createConversionFire({ sql: workerSql, opener, fetch: stubbed.fetch, metaApiVersion: "v24.0", log }),
      sinkDedupesByTxid: capiDedupesByEventId,
    },
  };
}

describe("the conversions in the worker", () => {
  it("order.paid hurries the MT rows of a paid order: they go out at once, long before the next sweep", async () => {
    const midtrans = midtransStub();
    const order = await createAttributedOrder(shop);
    await midtrans.create(order.midtransId());
    await midtrans.setState(order.midtransId(), { transaction_status: "settlement" });
    const outboxId = await notification(order.midtransId());
    const stubbed = stubbedFetch(vendor);
    const { log, lines } = captureLogger("info");
    // The sweeper's first tick runs at start, before the order is paid; the next one is ten minutes away.
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_SWEEP_INTERVAL_MS: "600000", WORKER_RECONCILE_INTERVAL_MS: "1000" }));
    const running = await startWorker(config, { payments: { midtrans: midtrans.source, waDelayMs: 0, clock: beforeTwo }, ...ports(stubbed) }, log);
    try {
      await waitFor(
        "the three MTs sent",
        async () => (await eventsOf(order.id)).filter((e) => e.kind === "mt" && e.status === "sent").length === 3,
        25_000,
      );
      // The order.paid row was consumed too (the rows could not have been fired without its nudge).
      await waitFor(
        "order.paid processed",
        async () => first(await sql<{ processed: boolean }[]>`SELECT processed_at IS NOT NULL AS processed FROM outbox WHERE dedupe_key = ${`order.paid:${order.id}`}`).processed,
        10_000,
      );
    } finally {
      await running.stop();
      await stubbed.close();
    }
    expect(first(await sql<{ processed: boolean }[]>`SELECT processed_at IS NOT NULL AS processed FROM outbox WHERE id = ${outboxId}`).processed).toBe(true);
    expect(lines.find((l) => l["msg"] === "worker started")).toMatchObject({ conversions: true, conversionSinks: true });
    expect((lines.find((l) => l["msg"] === "worker started")?.["topics"] as string[]).sort()).toEqual(["conversion.mo", "order.paid", "payment.notification"]);
    await retireEffects(shop);
  });

  it("conversion.mo writes the MO rows of an order whose Snap payment exists, and the sweeper sends them", async () => {
    const order = await createAttributedOrder(shop, { clickid: "click-worker-mo" });
    await sql`UPDATE orders SET snap_redirect_url = 'https://app.sandbox.midtrans.com/snap/v4/redirection/abc-123' WHERE id = ${order.id}`;
    await sql`SELECT public.enqueue_mo(${order.id})`;
    const stubbed = stubbedFetch(vendor);
    const config = loadWorkerConfig(workerEnv(uniquePrefix()));
    const running = await startWorker(config, ports(stubbed), createLogger({ level: "silent", role: "worker" }));
    try {
      await waitFor("the three MOs sent", async () => (await eventsOf(order.id)).filter((e) => e.kind === "mo" && e.status === "sent").length === 3, 25_000);
    } finally {
      await running.stop();
      await stubbed.close();
    }
    expect((await eventsOf(order.id)).map((e) => `${e.kind}/${e.sink}`)).toEqual(["mo/meta", "mo/s2s", "mo/tiktok"]);
    expect(vendor.requests.some((r) => r.url.startsWith("/mo?c=click-worker-mo"))).toBe(true);
    await retireEffects(shop);
  });
});

describe("conversionsFromEnv (the production wiring)", () => {
  const env = (extra: Record<string, string> = {}) => workerEnv(uniquePrefix(), extra);

  it("is off without the conversions private key, and with a key of another scope only", () => {
    expect(conversionsFromEnv(env(), loadWorkerConfig(env()))).toBeUndefined();
    const other = env({ SECRETS_PAYMENT_PRIVATE_KEY: generateScopeKeyPair().privateKey.toString("base64url") });
    expect(conversionsFromEnv(other, loadWorkerConfig(other))).toBeUndefined();
  });

  it("with the key: the fire port over a strict safe-fetch that refuses a loopback sink, and Meta / TikTok dedupe by event id", async () => {
    const strict = env({ SECRETS_CONVERSIONS_PRIVATE_KEY: generateScopeKeyPair().privateKey.toString("base64url"), WORKER_DEV_ALLOW_HTTP: "false", WORKER_DEV_ALLOW_LOOPBACK: "false" });
    const port = conversionsFromEnv(strict, loadWorkerConfig(strict));
    try {
      expect(port).toBeDefined();
      // The fire port is built on the worker's pool once it is open.
      expect(typeof port?.fire(workerPool(1), createLogger({ level: "silent", role: "worker" }))).toBe("function");
      expect(port?.sinkDedupesByTxid({ sink: "meta", adnetId: null })).toBe(true);
      expect(port?.sinkDedupesByTxid({ sink: "tiktok", adnetId: null })).toBe(true);
      expect(port?.sinkDedupesByTxid({ sink: "s2s", adnetId: "a" })).toBe(false);
    } finally {
      await port?.close?.();
    }
  });

  it("the production entry warns at start when worker.env has no conversions key, and starts without it", async () => {
    const child = spawnNode([MAIN], env());
    try {
      const warned = await waitForLine(child, (l) => typeof l["msg"] === "string" && l["msg"].startsWith("SECRETS_CONVERSIONS_PRIVATE_KEY is not set"));
      expect(warned["level"]).toBe(40);
      const started = await waitForLine(child, (l) => l["msg"] === "worker started");
      expect(started).toMatchObject({ conversions: false, conversionSinks: false });
    } finally {
      await kill(child);
    }
  });
});

describe("the worker without the conversions key (security review US-024 L7, code review m6 / m7)", () => {
  it("the order.paid consumer exists for any port that has something to nudge, key or no key: a later story's delivery nudge works without the conversions key", async () => {
    const midtrans = midtransStub();
    const order = await createAttributedOrder(shop);
    await midtrans.create(order.midtransId());
    await midtrans.setState(order.midtransId(), { transaction_status: "settlement" });
    await notification(order.midtransId());
    const nudged: string[] = [];
    const { log, lines } = captureLogger("info");
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_SWEEP_INTERVAL_MS: "600000", WORKER_RECONCILE_INTERVAL_MS: "1000" }));
    const running = await startWorker(
      config,
      {
        payments: { midtrans: midtrans.source, waDelayMs: 0, clock: beforeTwo },
        orderPaidNudges: [
          (orderId) => {
            nudged.push(orderId);
            return Promise.resolve();
          },
        ],
      },
      log,
    );
    try {
      await waitFor("the nudge", () => Promise.resolve(nudged.includes(order.id)), 20_000);
      await waitFor("order.paid processed", async () => first(await sql<{ processed: boolean }[]>`SELECT processed_at IS NOT NULL AS processed FROM outbox WHERE dedupe_key = ${`order.paid:${order.id}`}`).processed, 10_000);
    } finally {
      await running.stop();
    }
    // No conversions port: no MO consumer and no conversion queue, but the order.paid consumer runs.
    expect(lines.find((l) => l["msg"] === "worker started")).toMatchObject({ conversions: false, conversionSinks: false });
    expect((lines.find((l) => l["msg"] === "worker started")?.["topics"] as string[]).sort()).toEqual(["order.paid", "payment.notification"]);
    await retireEffects(shop);
  });

  it("in production a missing conversions key raises a persisted critical alert at start, once, and the worker still starts; a worker with the key raises none", async () => {
    await sql`DELETE FROM alerts WHERE dedupe_key = 'conversions_disabled'`;
    const production = { NODE_ENV: "production", WORKER_DEV_ALLOW_HTTP: "", WORKER_DEV_ALLOW_LOOPBACK: "" };
    const stubbed = stubbedFetch(vendor);
    try {
      const withKey = await startWorker(loadWorkerConfig(workerEnv(uniquePrefix(), production)), ports(stubbed), createLogger({ level: "silent", role: "worker" }));
      await withKey.stop();
      expect(await sql`SELECT 1 FROM alerts WHERE dedupe_key = 'conversions_disabled'`).toEqual([]);
      // Not in production (tests, development): the start warning of runWorker only.
      const dev = await startWorker(loadWorkerConfig(workerEnv(uniquePrefix())), {}, createLogger({ level: "silent", role: "worker" }));
      await dev.stop();
      expect(await sql`SELECT 1 FROM alerts WHERE dedupe_key = 'conversions_disabled'`).toEqual([]);
      const without = await startWorker(loadWorkerConfig(workerEnv(uniquePrefix(), production)), {}, createLogger({ level: "silent", role: "worker" }));
      await without.stop();
      const again = await startWorker(loadWorkerConfig(workerEnv(uniquePrefix(), production)), {}, createLogger({ level: "silent", role: "worker" }));
      await again.stop();
      expect(await sql`SELECT kind, severity, source FROM alerts WHERE dedupe_key = 'conversions_disabled' AND resolved_at IS NULL`).toEqual([{ kind: "conversions_disabled", severity: "critical", source: "worker" }]);
    } finally {
      await stubbed.close();
      await sql`DELETE FROM alerts WHERE dedupe_key = 'conversions_disabled'`;
    }
  });

  it("the production fire port really refuses a loopback sink: a row fired at it through port.fire is a failed attempt and nothing reaches the stub (code review m4)", async () => {
    const loopbackShop = await createTrackingShop({
      endpointHost: new URL(vendor.origin).host,
      mtTemplate: `https://${new URL(vendor.origin).host}/mt?c={clickid}&t={txid}&p={payout}&s={status}`,
      apiKey: false,
      pixels: {},
    });
    const strict = workerEnv(uniquePrefix(), { SECRETS_CONVERSIONS_PRIVATE_KEY: generateScopeKeyPair().privateKey.toString("base64url"), WORKER_DEV_ALLOW_HTTP: "false", WORKER_DEV_ALLOW_LOOPBACK: "false" });
    const port = conversionsFromEnv(strict, loadWorkerConfig(strict));
    try {
      const order = await createAttributedOrder(loopbackShop);
      await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
      await sql`INSERT INTO conversion_events (order_id, sink, kind, adnet_id, txid, event_id, value_idr) VALUES (${order.id}, 's2s', 'mt', ${loopbackShop.adnetId}, ${order.id}, ${randomUUID()}, 49000)`;
      const row = await eventOf(order.id, "s2s", "mt");
      const fire = port?.fire(workerPool(1), createLogger({ level: "silent", role: "worker" }));
      const before = vendor.requests.length;
      const result = await fire?.({ id: row.id, orderId: order.id, sink: "s2s", kind: "mt", adnetId: loopbackShop.adnetId, txid: order.id, eventId: row.event_id, valueIdr: 49_000, payoutIdr: 15_000, attempt: 1 }, AbortSignal.timeout(5000));
      expect(result?.outcome).toMatchObject({ kind: "failed", httpStatus: null });
      expect(result?.outcome.kind === "failed" ? result.outcome.error : "").toMatch(/blocked address/);
      expect(vendor.requests.length).toBe(before);
    } finally {
      await port?.close?.();
      await retireEffects(loopbackShop);
    }
  });
});
