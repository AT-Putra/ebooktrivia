// US-025: the failure paths of the delivery code that the main scenarios do not reach, each ending in a state the machines allow and nothing sent twice:
// an opener or a PDF reply that is aborted or too late (nothing sent, the claim given back), an opener nobody can send, a stale outcome, an order refunded while a
// retry was pending, a refusal of WhatsApp on a reply, and the ledger row of every reply that failed or may have gone out.
import { WahaError } from "@ebooktrivia/adapters";
import { EFFECT_CANCELLED } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createEbookFiles } from "../src/delivery/access.ts";
import { createDelivery, type DeliveryDeps } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { contactKey } from "../src/delivery/pool.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { MailAccessError } from "../src/delivery/ports.ts";
import { createDeliveryShop, createSession, createWahaFake, type DeliveryShop, deliveryConfig, deliveryOf, fakeMagicLinks, inboundOf, paidOrder, recordingMail, retireDeliveries, retireSessions, storeInbound } from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(8);
let shop: DeliveryShop;
const shops: DeliveryShop[] = [];

beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
  shop = await createDeliveryShop();
  shops.push(shop);
});
afterAll(async () => {
  await retireSessions();
  await retireDeliveries();
  await Promise.all(shops.map((s) => s.cleanup()));
});

const openerOf = async (deliveryId: string) =>
  first(await sql<{ status: string; attempts: number; last_error: string | null }[]>`SELECT status, attempts, last_error FROM delivery_openers WHERE delivery_id = ${deliveryId}`);
const ledger = (sessionId: string) => sql<{ kind: string; outcome: string }[]>`SELECT kind, outcome FROM waha_sends WHERE session_id = ${sessionId} ORDER BY created_at`;
/** A sleeper whose first `ok` waits pass and whose next ones are aborted (the job's signal ends). */
const sleepAbortedAfter = (ok: number) => {
  let calls = 0;
  return (): Promise<void> => (++calls > ok ? Promise.reject(new Error("aborted")) : Promise.resolve());
};
/** A clock that reads `values` in turn (the last one for ever): the claim, the lease check before the human-like steps, the one before the send. */
const clockOf = (...values: number[]) => {
  let i = 0;
  return (): number => values[Math.min(i++, values.length - 1)] ?? 0;
};

function build(over: Partial<DeliveryDeps> = {}) {
  const waha = createWahaFake();
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  const deps: DeliveryDeps = {
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: createEbookFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: () => 0,
    sleep: () => Promise.resolve(),
    ...over,
  };
  const delivery = createDelivery(deps);
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: over.waha ?? waha.access, delivery, files: createEbookFiles(config), random: () => 0, sleep: () => Promise.resolve() });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  const hear = async (session: string, chatId: string, body: string) => {
    const stored = await storeInbound({ sessionName: session, messageId: await waha.inbound({ session, chatId, body }), fromJid: chatId });
    return { ...stored, run: () => process({ id: stored.outboxId }) };
  };
  return { waha, mail, magic, config, delivery, hear };
}
const later = (): Date => new Date(Date.now() + 180_000);

describe("an opener that is aborted or too late sends nothing and gives its claim back", () => {
  it("aborted during the human-like steps: no message, no ledger row, the opener waits for its next try", async () => {
    const r = build({ sleep: sleepAbortedAfter(1) });
    const s = await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, last_error: "aborted_before_send" });
    expect(r.waha.sent).toEqual([]);
    expect(await ledger(s.id)).toEqual([]);
  });

  it("a claim that can no longer cover the send by the time the typing is done (the lease): not sent", async () => {
    const r = build({ clock: clockOf(0, 0, 10_000_000_000) });
    const s = await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, last_error: "claim_too_old" });
    expect(r.waha.sent).toEqual([]);
    expect(await ledger(s.id)).toEqual([]);
  });
});

describe("what an opener finds when it is claimed", () => {
  it("every number was tried: it is given up quietly (failed, no alert), never sent", async () => {
    const r = build();
    const sessions = await Promise.all([3, 2, 1].map((weight) => createSession({ weight })));
    const order = await paidOrder(shop);
    await sql`INSERT INTO delivery_openers (delivery_id, attempts, tried_session_ids) VALUES (${order.deliveries.whatsapp}, 2, ${sessions.map((x) => x.id)}::uuid[])`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "failed", last_error: "no_untried_number" });
    expect(r.waha.sent).toEqual([]);
  });

  it("an opener whose next try is not due is left alone", async () => {
    const r = build();
    await createSession();
    const order = await paidOrder(shop);
    await sql`INSERT INTO delivery_openers (delivery_id, next_attempt_at) VALUES (${order.deliveries.whatsapp}, now() + interval '10 minutes')`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(r.waha.sent).toEqual([]);
  });

  it("the share of the new-contact budget a warning leaves is the configured one", async () => {
    const config = deliveryConfig(shop);
    const r = build({ config: { ...config, warningCapFactors: [0.5, 0.25] } });
    const s = await createSession();
    await sql`UPDATE waha_sessions SET warning_level = 'first', new_contact_cap = 4 WHERE id = ${s.id}`;
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(await ledger(s.id)).toEqual([{ kind: "opener", outcome: "sent" }]);
  });
});

describe("an outcome that arrives after the claim is gone", () => {
  it("an opener taken over or deleted while it was being sent changes nothing more: stale", async () => {
    const fake = createWahaFake();
    const spying = (deliveryId: string, change: (deliveryId: string) => Promise<unknown>): WahaAccess => ({
      withSession: async (id, use, options) => {
        const [row] = await sql<{ delivery_id: string }[]>`SELECT delivery_id FROM delivery_openers WHERE status = 'sending' AND delivery_id = ${deliveryId}`;
        if (row !== undefined) await change(row.delivery_id);
        return fake.access.withSession(id, use, options);
      },
    });
    await createSession();
    const taken = await paidOrder(shop);
    const takenRig = build({ waha: spying(taken.deliveries.whatsapp, (id) => sql`UPDATE delivery_openers SET attempts = attempts + 1 WHERE delivery_id = ${id}`) });
    expect(await takenRig.delivery.process({ id: taken.deliveries.whatsapp })).toBe("stale");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const gone = await paidOrder(shop);
    const goneRig = build({ waha: spying(gone.deliveries.whatsapp, (id) => sql`DELETE FROM delivery_openers WHERE delivery_id = ${id}`) });
    expect(await goneRig.delivery.process({ id: gone.deliveries.whatsapp })).toBe("stale");
  });

  it("an e-mail that failed for a reason worth a retry, for an order refunded meanwhile, is taken out of the send path with payments' mark, never retried", async () => {
    const r = build();
    const order = await paidOrder(shop);
    r.mail.failures.push(new MailAccessError("smtp_not_configured"));
    const original = r.mail.send.bind(r.mail);
    r.mail.send = async (message) => {
      await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.orderId}`;
      return original(message);
    };
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("cancelled");
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED });
  });
});

describe("the PDF reply to a buyer who wrote first, when it cannot go out", () => {
  it("without a login link to put in it: nothing is sent, the delivery stays pending, and the number is not blamed", async () => {
    const r = build();
    const s = await createSession();
    r.magic.failing = true;
    const order = await paidOrder(shop, { waNotBefore: later() });
    const heard = await r.hear(s.name, order.chatId, `kode ${order.code}`);
    await heard.run();
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, attempts_base: 1, last_error: "magic_link_unavailable" });
    expect(r.waha.sent).toEqual([]);
    expect(await ledger(s.id)).toEqual([]);
    expect(first(await sql<{ fail_streak: number }[]>`SELECT fail_streak FROM waha_sessions WHERE id = ${s.id}`).fail_streak).toBe(0);
  });

  it("aborted at its slot, or during the human-like steps, or too late for the lease: nothing is sent and the claim is given back", async () => {
    for (const [label, over, error] of [
      ["slot", { sleep: sleepAbortedAfter(0) }, "aborted_before_send"],
      ["steps", { sleep: sleepAbortedAfter(1) }, "aborted_before_send"],
      ["lease", { clock: clockOf(0, 10_000_000_000) }, "claim_too_old"],
    ] as const) {
      const r = build(over);
      const s = await createSession();
      const order = await paidOrder(shop, { waNotBefore: later() });
      await (await r.hear(s.name, order.chatId, `kode ${order.code}`)).run();
      expect(await deliveryOf(order.deliveries.whatsapp), label).toMatchObject({ status: "pending", attempts: 1, attempts_base: 1, last_error: error });
      expect(r.waha.sent, label).toEqual([]);
      expect(await ledger(s.id), label).toEqual([]);
      await retireSessions();
    }
  });

  it("refused by WhatsApp (463): held back from new contacts, not blamed, the claim given back", async () => {
    const r = build();
    const s = await createSession();
    r.waha.fault(s.name, "ban463");
    const order = await paidOrder(shop, { waNotBefore: later() });
    await (await r.hear(s.name, order.chatId, `kode ${order.code}`)).run();
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, attempts_base: 1 });
    const state = first(await sql<{ reachout_until: Date | null; fail_streak: number; ban_463_count: number }[]>`SELECT reachout_until, fail_streak, ban_463_count FROM waha_sessions WHERE id = ${s.id}`);
    expect(state.reachout_until).not.toBeNull();
    expect(state).toMatchObject({ fail_streak: 0, ban_463_count: 1 });
    expect(await ledger(s.id)).toEqual([]);
  });
});

describe("the ledger row of an informational reply that failed, or may have gone out", () => {
  it("a stranger's text reply that may have gone out is an unknown send; one WAHA refused for sure is a failed send", async () => {
    const r = build();
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    r.waha.fault(s.name, "timeout_after_send");
    const unknown = await r.hear(s.name, "6281999900301@c.us", `kode ${order.code}`);
    await unknown.run();
    expect(await inboundOf(unknown.inboundId)).toMatchObject({ outcome: "text_failed" });
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    r.waha.fault(s.name, "unauthorized");
    const failed = await r.hear(s.name, "6281999900302@c.us", `kode ${order.code}`);
    await failed.run();
    expect((await ledger(s.id)).map((l) => l.outcome).sort()).toEqual(["failed", "unknown"]);
  });

  it("the PDF for an unresolved @lid that may have gone out is an unknown send, and a lid WAHA answers 4xx for is simply unresolved", async () => {
    const fake = createWahaFake();
    const rejecting: WahaAccess = {
      withSession: (id, use, options) =>
        fake.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, resolveLid: () => Promise.reject(new WahaError("rejected", "no number for it")) } }), options),
    };
    const r = build({ waha: rejecting });
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const heard = await (async () => {
      const messageId = await fake.inbound({ session: s.name, chatId: "55555555555801@lid", body: `kode ${order.code}` });
      return storeInbound({ sessionName: s.name, messageId, fromJid: "55555555555801@lid" });
    })();
    // The consumer of `build` reads through the default fake; the rejecting access is the one under test here.
    const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config: r.config, waha: rejecting, delivery: r.delivery, files: createEbookFiles(r.config), random: () => 0, sleep: () => Promise.resolve() });
    await createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: heard.outboxId });
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "pdf_only_sent" });
    expect(await ledger(s.id)).toEqual([{ kind: "reply", outcome: "sent" }]);
    fake.fault(s.name, "timeout_after_send");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await sql`DELETE FROM waha_sends WHERE session_id = ${s.id}`;
    await sql`UPDATE waha_inbound SET replied_at = NULL`;
    const again = await storeInbound({ sessionName: s.name, messageId: await fake.inbound({ session: s.name, chatId: "55555555555802@lid", body: `kode ${order.code}` }), fromJid: "55555555555802@lid" });
    await createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: again.outboxId });
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "pdf_only_failed" });
    expect(await ledger(s.id)).toEqual([{ kind: "reply", outcome: "unknown" }]);
  });

  it("a reply that the contact's hour, the number's cap or the number's queue refuses says so, and nothing is sent", async () => {
    const r = build();
    const s = await createSession({ dailyCap: 100 });
    const order = await paidOrder(shop, { waNotBefore: later() });
    // The stranger has had four messages in the hour already.
    const stranger = "6281999900401@c.us";
    await sql.unsafe(`INSERT INTO waha_sends (session_id, kind, contact_key, send_at) SELECT '${s.id}', 'text', '${contactKey(stranger)}', now() - (g * interval '5 minutes') FROM generate_series(1, 4) g`);
    const capped = await r.hear(s.name, stranger, `kode ${order.code}`);
    await capped.run();
    expect(await inboundOf(capped.inboundId)).toMatchObject({ outcome: "text_contact_capped", replied: false });
    // The number is at its (reply) cap: no number can answer.
    await sql`UPDATE waha_sessions SET daily_cap = 1 WHERE id = ${s.id}`;
    const noNumber = await r.hear(s.name, "6281999900402@c.us", `kode ${order.code}`);
    await noNumber.run();
    expect(await inboundOf(noNumber.inboundId)).toMatchObject({ outcome: "text_no_number" });
    // The number's queue is longer than the wait budget: busy.
    await sql`UPDATE waha_sessions SET daily_cap = 1000, next_send_at = now() + interval '1 hour' WHERE id = ${s.id}`;
    const busy = await r.hear(s.name, "6281999900403@c.us", `kode ${order.code}`);
    await busy.run();
    expect(await inboundOf(busy.inboundId)).toMatchObject({ outcome: "text_busy" });
    expect(r.waha.sent).toEqual([]);
  });
});
