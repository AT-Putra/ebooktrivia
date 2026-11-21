// US-024 criterion 4: exactly-once conversions under notification reorderings, replays, concurrent workers,
// the lease sweeper and retries; and the MT lease sweeper race of the US-021 follow-up (BINDING).
//   - AC-T4 property test: random notification orderings and replays, processed concurrently, with the sinks
//     firing in between: exactly ONE MT per paid order per sink (per adnet), none for an order never paid, no
//     reversal without a counted MT. The oracle is the sinks' own request log, not the code under test.
//   - a sweeper that expires a lease and a retry that races the original fire: one request.
import { mtSinks } from "@ebooktrivia/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FireConversion, NO_SINK_DEDUPES } from "../src/conversion-fire.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { capiDedupesByEventId, createConversionFire } from "../src/conversions.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createPaymentNotificationConsumer, EFFECT_CANCELLED } from "../src/payments.ts";
import { expireLeases } from "../src/sweepers.ts";
import { first, sleep, sql } from "./support/db.ts";
import {
  createAttributedOrder,
  createTrackingShop,
  dropCapiTokens,
  eventOf,
  eventsOf,
  fireDue,
  firing,
  opener,
  payOrder,
  queryOf,
  startVendorStub,
  stubbedFetch,
  type TrackingShop,
  type VendorStub,
} from "./support/conversions.ts";
import { midtransStub, type MidtransStub, notification, type Order, retireEffects, silentLog, WA_DELAY_MS, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(10);
let vendor: VendorStub;
beforeAll(async () => {
  vendor = await startVendorStub();
});
afterAll(async () => {
  await vendor.close();
  await dropCapiTokens();
});

/** mulberry32: a seeded PRNG, so a failing seed replays exactly. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("AC-T4 property: random notification orderings and replays give exactly one MT per adnet, none for an unpaid order", () => {
  /** What Midtrans can say about one transaction (the re-query reads this). */
  const STATES: readonly { readonly state: Record<string, unknown>; readonly money: boolean }[] = [
    { state: { transaction_status: "pending" }, money: false },
    { state: { transaction_status: "settlement", payment_type: "qris" }, money: true },
    { state: { transaction_status: "settlement", payment_type: "qris" }, money: true },
    { state: { transaction_status: "capture", fraud_status: "accept", payment_type: "credit_card" }, money: true },
    { state: { transaction_status: "deny" }, money: false },
    { state: { transaction_status: "cancel" }, money: false },
    { state: { transaction_status: "expire" }, money: false },
    { state: { transaction_status: "refund", payment_type: "qris" }, money: false },
    { state: { transaction_status: "partial_refund", payment_type: "qris" }, money: false },
  ];

  const SEEDS = [1, 2, 3, 4, 5, 6];

  it.each(SEEDS)("seed %i", async (seed) => {
    const random = rng(seed * 7919);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const shops: TrackingShop[] = [await createTrackingShop(), await createTrackingShop()];
    const midtrans: MidtransStub = midtransStub();
    const consumer = createPaymentNotificationConsumer({ sql: workerSql, midtrans: midtrans.source, log: silentLog, waDelayMs: WA_DELAY_MS });
    const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
    const f = firing(vendor, { leaseMs: 20_000 });

    interface Subject {
      readonly order: Order;
      readonly shop: TrackingShop;
      readonly attributed: boolean;
      readonly attempts: number;
      /** A state that holds the buyer's money was applied to some attempt. */
      money: boolean;
    }
    const subjects: Subject[] = [];
    for (let i = 0; i < 10; i++) {
      // The first two orders have a fixed fate below: attributed, one attempt.
      const attributed = i < 2 || random() < 0.7;
      const attempts = i < 2 || random() >= 0.4 ? 1 : 2;
      const shop = pick(shops);
      const order = await createAttributedOrder(shop, { attributed, attempts: Array.from({ length: attempts }, () => "created" as const) });
      for (let n = 1; n <= attempts; n++) await midtrans.create(order.midtransId(n));
      subjects.push({ order, shop, attributed, attempts, money: false });
    }

    // The oracle is the sinks' own log. Every request is counted at the stub, by `<order id>/<sink>/<kind>`: a CAPI
    // request by its EVENT NAME (Purchase / CompletePayment are the MT; anything else is not counted as one), the
    // order by the event_id the browser pixel shares. `asked` counts requests, `acked` those answered 2xx.
    const eventIds = new Map((await sql<{ id: string; event_id: string }[]>`SELECT id, event_id FROM orders WHERE id = ANY (${subjects.map((x) => x.order.id)}::uuid[])`).map((o) => [o.event_id, o.id]));
    const asked = new Map<string, number>();
    const acked = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string): void => void map.set(key, (map.get(key) ?? 0) + 1);
    const keyOf = (request: VendorStub["requests"][number]): string | undefined => {
      if (request.url.startsWith("/mt")) return `${queryOf(request)["t"] ?? ""}/s2s/mt`;
      if (request.url.startsWith("/rev")) return `${queryOf(request)["t"] ?? ""}/s2s/reversal`;
      const data = (JSON.parse(request.body) as { data: { event_id: string; event_name?: string; event?: string }[] }).data[0];
      const meta = request.url.includes("/events");
      if (data === undefined || (meta ? data.event_name !== "Purchase" : data.event !== "CompletePayment")) return undefined;
      return `${eventIds.get(data.event_id) ?? "?"}/${meta ? "meta" : "tiktok"}/mt`;
    };
    // The sinks misbehave while the notifications are applied: some answers are 5xx, some are slow (a request is then
    // in flight when a refund lands), until the drain.
    let chaos = false;
    const before = vendor.reply;
    vendor.reply = (request) => {
      const r = random();
      const reply = !chaos ? { status: 200, body: "ok" } : r < 0.15 ? { status: 503, body: "busy", delayMs: r < 0.05 ? 150 : 0 } : { status: 200, body: "ok", delayMs: r < 0.4 ? 120 : 0 };
      const key = keyOf(request);
      if (key !== undefined) {
        bump(asked, key);
        if (reply.status === 200) bump(acked, key);
      }
      return reply;
    };

    /** One event: a state of one attempt of the order, announced `replays` times and processed at once. */
    const event = async (subject: Subject, forced?: (typeof STATES)[number]): Promise<void> => {
      const n = forced === undefined ? 1 + Math.floor(random() * subject.attempts) : 1;
      const chosen = forced ?? pick(STATES);
      if (chosen.money) subject.money = true;
      await midtrans.setState(subject.order.midtransId(n), chosen.state);
      const replays = 1 + Math.floor(random() * 3);
      const ids = await Promise.all(Array.from({ length: replays }, () => notification(subject.order.midtransId(n), String(chosen.state["transaction_status"]))));
      await Promise.all(ids.map((id) => process({ id })));
    };
    // Two orders have a fixed fate, so every seed exercises the reversal and the cancellation: the first is paid,
    // fired and then refunded; the second is paid and refunded before its MTs go out.
    const [fired, unfired] = subjects as [Subject, Subject];
    const SETTLE = STATES[1] as (typeof STATES)[number];
    const REFUND = STATES[7] as (typeof STATES)[number];
    await event(fired, SETTLE);
    await fireDue(f, fired.order.id);
    await event(fired, REFUND);
    await event(unfired, SETTLE);
    await event(unfired, REFUND);

    chaos = true;
    for (let wave = 0; wave < 5; wave++) {
      const turn = subjects.filter(() => random() < 0.6);
      const firingToo = subjects.filter(() => random() < 0.5);
      await Promise.all([
        ...turn.map((subject) => event(subject)),
        // The sinks fire while notifications are still being applied, and a refund can land mid-request.
        (async () => {
          for (const subject of firingToo) await fireDue(f, subject.order.id);
        })(),
      ]);
    }
    // Drain: the sinks recover, every retry slot is due, and whatever is due goes out, however many times the sweep comes round.
    chaos = false;
    await sql`UPDATE conversion_events SET next_attempt_at = now() WHERE status = 'pending' AND order_id = ANY (${subjects.map((x) => x.order.id)}::uuid[])`;
    for (let round = 0; round < 3; round++) await Promise.all(subjects.map((subject) => fireDue(f, subject.order.id)));
    vendor.reply = before;

    expect([...asked.keys()].filter((key) => key.startsWith("?"))).toEqual([]);

    let paidOrders = 0;
    for (const subject of subjects) {
      const id = subject.order.id;
      const rows = await eventsOf(id);
      const row = first(await sql<{ status: string; paid_at: Date | null }[]>`SELECT status::text AS status, paid_at FROM orders WHERE id = ${id}`);
      const mts = rows.filter((r) => r.kind === "mt");
      const label = `seed ${String(seed)} order ${id}`;
      if (row.paid_at === null) {
        // An order that was never paid: no MT row, no request of any kind.
        expect(rows, label).toEqual([]);
        for (const key of asked.keys()) expect(key.startsWith(id), label).toBe(false);
        continue;
      }
      paidOrders++;
      // Only a money state can have paid it.
      expect(subject.money, label).toBe(true);
      // One MT row per sink, exactly the sinks of an order (s2s only when attributed), and Google none.
      const expected = mtSinks({ adnetId: subject.attributed ? subject.shop.adnetId : null, clickid: subject.attributed ? "c" : null, pixels: { meta: "1", tiktok: "1" } });
      expect(mts.map((r) => r.sink).sort(), label).toEqual([...expected].sort());
      for (const mt of mts) {
        const key = `${id}/${mt.sink}/mt`;
        const acks = acked.get(key) ?? 0;
        // Acknowledged exactly once or never, whatever 5xx answers, retries and refunds came between; and what the
        // sink acknowledged is what the row says it received.
        expect(acks, `${label} ${mt.sink}`).toBe(mt.status === "sent" ? 1 : 0);
        expect(asked.get(key) ?? 0, `${label} ${mt.sink}`).toBeLessThanOrEqual(mt.attempts);
        expect(["sent", "failed"], `${label} ${mt.sink}`).toContain(mt.status);
        if (mt.status === "failed") expect(mt.last_error, `${label} ${mt.sink}`).toBe(EFFECT_CANCELLED);
        // An order that is still paid has all of its MTs sent.
        if (row.status === "paid") expect(mt.status, `${label} ${mt.sink}`).toBe("sent");
      }
      // A reversal is acknowledged at most once, and only for an S2S MT the adnet acknowledged.
      const reversals = acked.get(`${id}/s2s/reversal`) ?? 0;
      expect(reversals, label).toBeLessThanOrEqual(1);
      if (reversals === 1) expect(acked.get(`${id}/s2s/mt`), label).toBe(1);
      for (const platform of ["meta", "tiktok"]) expect(asked.get(`${id}/${platform}/reversal`) ?? 0, label).toBe(0);
    }
    expect(paidOrders).toBeGreaterThan(1);
    // The fixed fates: fired then refunded -> its reversal went out, once; refunded before it fired -> nothing was sent.
    expect(acked.get(`${fired.order.id}/s2s/mt`)).toBe(1);
    expect(acked.get(`${fired.order.id}/s2s/reversal`)).toBe(1);
    for (const sink of ["s2s", "meta", "tiktok"]) expect(asked.get(`${unfired.order.id}/${sink}/mt`) ?? 0).toBe(0);
    expect(asked.get(`${unfired.order.id}/s2s/reversal`) ?? 0).toBe(0);
    for (const shop of shops) await retireEffects(shop);
    await f.close();
  });
});

describe("a sweeper and a retry racing the original fire give one fire (criterion 4)", () => {
  const slowStub = async (delayMs: number): Promise<VendorStub> => {
    const stub = await startVendorStub();
    stub.reply = () => ({ status: 200, body: "ok", delayMs });
    return stub;
  };
  /**
   * The fire port of a process that STALLS after its claim (a GC pause, a suspended VM) and sends after its lease is gone:
   * the fire's own time budget (an AbortSignal of requestTimeoutMs, shorter than the lease) can no longer let a request
   * outlive the lease, so a stalled process is how a lease is lost mid-flight.
   */
  function stalled(stub: VendorStub, ms: number): { fire: FireConversion; close: () => Promise<void> } {
    const stubbed = stubbedFetch(stub);
    const real = createConversionFire({ sql: workerSql, opener, fetch: stubbed.fetch, metaApiVersion: "v24.0", log: silentLog });
    return {
      fire: async (event) => {
        await sleep(ms);
        return real(event, AbortSignal.timeout(5000));
      },
      close: stubbed.close,
    };
  }

  it("a request sent after its process lost its lease: the sweeper fails the row for a manual re-fire, the retry job finds nothing to claim, the late 2xx is still accepted: one request", async () => {
    const stub = await slowStub(0);
    const shop = await createTrackingShop({ pixels: {}, apiKey: false, mtTemplate: "https://pb.example.test/mt?c={clickid}&t={txid}&p={payout}&s={status}" });
    const late = stalled(stub, 3600);
    const f = firing(stub, { leaseMs: 3000, requestTimeoutMs: 1000, fire: late.fire });
    try {
      const order = await createAttributedOrder(shop);
      await payOrder(order);
      const row = await eventOf(order.id, "s2s", "mt");
      const original = f.process({ id: row.id });
      await sleep(3300);
      // The lease (3 s) ran out while the request (3.6 s) is still in flight: sweeper and retry arrive together.
      const [swept, retried] = await Promise.all([expireLeases(workerSql, NO_SINK_DEDUPES), f.process({ id: row.id })]);
      expect(retried).toBe("skipped");
      // The sweeper never waits for a row the retry holds (SKIP LOCKED): if it met the claim it comes round again.
      const again = await expireLeases(workerSql, NO_SINK_DEDUPES);
      expect(swept.conversions + again.conversions).toBeGreaterThanOrEqual(1);
      expect(await original).toBe("sent");
      expect(await eventOf(order.id, "s2s", "mt")).toMatchObject({ status: "sent", attempts: 1, last_error: null });
      expect(stub.requests.filter((r) => r.url.startsWith("/mt"))).toHaveLength(1);
    } finally {
      await f.close();
      await late.close();
      await stub.close();
      await retireEffects(shop);
    }
  }, 30_000);

  it("a CAPI request sent after its process lost its lease: the row waits for its retry slot (1 minute), so no second request can follow", async () => {
    const stub = await slowStub(0);
    const shop = await createTrackingShop({ pixels: { meta: "7777777777777" }, apiKey: false, mtTemplate: null });
    const late = stalled(stub, 3600);
    const f = firing(stub, { leaseMs: 3000, requestTimeoutMs: 1000, fire: late.fire });
    try {
      const order = await createAttributedOrder(shop, { attributed: false });
      await payOrder(order);
      const row = await eventOf(order.id, "meta", "mt");
      const original = f.process({ id: row.id });
      await sleep(3300);
      const [swept, retried] = await Promise.all([expireLeases(workerSql, capiDedupesByEventId), f.process({ id: row.id })]);
      expect(retried).toBe("skipped");
      const again = await expireLeases(workerSql, capiDedupesByEventId);
      expect(swept.conversions + again.conversions).toBeGreaterThanOrEqual(1);
      expect((await eventOf(order.id, "meta", "mt")).status).toBe("pending");
      expect(await original).toBe("sent");
      expect(await eventOf(order.id, "meta", "mt")).toMatchObject({ status: "sent", attempts: 1 });
      expect(stub.requests).toHaveLength(1);
    } finally {
      await f.close();
      await late.close();
      await stub.close();
      await retireEffects(shop);
    }
  }, 30_000);

  it("many jobs and sweeps racing for many due rows still fire each row once", async () => {
    const stub = await slowStub(150);
    const shop = await createTrackingShop({ pixels: {}, apiKey: false, mtTemplate: "https://pb.example.test/mt?c={clickid}&t={txid}&p={payout}&s={status}" });
    const f = firing(stub);
    try {
      const orders: Order[] = [];
      for (let i = 0; i < 5; i++) {
        const order = await createAttributedOrder(shop);
        await payOrder(order);
        orders.push(order);
      }
      const rows = await Promise.all(orders.map((o) => eventOf(o.id, "s2s", "mt")));
      await Promise.all([
        ...rows.flatMap((row) => [f.process({ id: row.id }), f.process({ id: row.id }), f.process({ id: row.id }), f.process({ id: row.id })]),
        expireLeases(workerSql, NO_SINK_DEDUPES),
        expireLeases(workerSql, NO_SINK_DEDUPES),
      ]);
      for (const order of orders) {
        expect(stub.requests.filter((r) => queryOf(r)["t"] === order.id)).toHaveLength(1);
        expect(await eventOf(order.id, "s2s", "mt")).toMatchObject({ status: "sent", attempts: 1 });
      }
    } finally {
      await f.close();
      await stub.close();
      await retireEffects(shop);
    }
  });
});

describe("the MT lease sweeper race (US-021 follow-up, BINDING; closed by the order lock, security review US-024 L4)", () => {
  async function sendingMtOfReviewedOrder() {
    const shop = await createTrackingShop({ pixels: { meta: "7777777777777" }, apiKey: false, mtTemplate: null });
    const order = await createAttributedOrder(shop, { attributed: false });
    await payOrder(order);
    const row = await eventOf(order.id, "meta", "mt");
    // The MT is in flight with an expired lease (its sender died); then the order goes to review.
    await sql`UPDATE conversion_events SET status = 'sending', attempts = 1, lease_until = now() - interval '1 second' WHERE id = ${row.id}`;
    await sql`UPDATE orders SET status = 'review' WHERE id = ${order.id}`;
    return { shop, order, row };
  }
  const rowState = async (id: string) =>
    first(await sql<{ status: string; last_error: string | null; attempts: number; delay: number }[]>`
      SELECT status::text AS status, last_error, attempts, round(extract(epoch FROM next_attempt_at - now()))::int AS delay FROM conversion_events WHERE id = ${id}`);

  it("a review -> paid still in flight (its revive already run, not yet committed) while the sweeper runs: the sweeper never reads it half-done and the row never ends as order_not_paid", async () => {
    const { shop, order, row } = await sendingMtOfReviewedOrder();
    let commit: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let ranRevive: () => void = () => undefined;
    const revived = new Promise<void>((resolve) => {
      ranRevive = resolve;
    });
    // Payments' transaction, as applyRequery does it: the order row lock, review -> paid, then the revive of the rows it
    // cancelled earlier (this one is still `sending`, so the revive finds nothing). It commits only after the sweep.
    const payments = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM orders WHERE id = ${order.id} FOR UPDATE`;
      await tx`UPDATE orders SET status = 'paid' WHERE id = ${order.id}`;
      const revive = await tx`UPDATE conversion_events SET status = 'pending', failed_at = NULL, last_error = NULL WHERE order_id = ${order.id} AND kind = 'mt' AND status = 'failed' AND last_error = ${EFFECT_CANCELLED}`;
      expect(revive.count).toBe(0);
      ranRevive();
      await gate;
    });
    try {
      await revived;
      // The sweep runs while payments holds the order: it skips the row (SKIP LOCKED, never waits) and writes nothing.
      const started = Date.now();
      await expireLeases(workerSql, capiDedupesByEventId);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await rowState(row.id)).toMatchObject({ status: "sending", last_error: null, attempts: 1 });
      commit();
      await payments;
      // After the commit the next sweep sees a paid order: the normal retry path.
      await expireLeases(workerSql, capiDedupesByEventId);
      const after = await rowState(row.id);
      expect(after).toMatchObject({ status: "pending", last_error: "lease expired while sending", attempts: 1 });
      expect(after.delay).toBeGreaterThan(50);
      expect(after.delay).toBeLessThanOrEqual(60);
    } finally {
      commit();
      await payments;
      await retireEffects(shop);
    }
  });

  it("control: when the order stays out of PAID the same row fails with payments' mark, for the Owner, and the send may have counted", async () => {
    const { shop, row } = await sendingMtOfReviewedOrder();
    try {
      expect((await expireLeases(workerSql, capiDedupesByEventId)).conversions).toBeGreaterThanOrEqual(1);
      expect(await rowState(row.id)).toMatchObject({ status: "failed", last_error: EFFECT_CANCELLED });
      expect(first(await sql<{ maybe_counted: boolean }[]>`SELECT maybe_counted FROM conversion_events WHERE id = ${row.id}`).maybe_counted).toBe(true);
    } finally {
      await retireEffects(shop);
    }
  });
});
