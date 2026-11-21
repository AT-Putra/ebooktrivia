// US-025 round 2 (code and security review): a ledger row is never left `reserved`, an attempt number is never reused (a stale finisher can never record onto a
// newer claim, even after a resend), a lid belongs to one phone and an old link is checked again before a login link, the worker's poll lifts a block WAHA no longer
// reports, the lease covers the offline call, the pacing is drawn from the operating system's random source, a failing lookup is a warning per number, and an
// unknown PDF reply to a @lid chat resolves on its own.
import type { WahaClient } from "@ebooktrivia/adapters";
import { EFFECT_CANCELLED } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEbookFiles } from "../src/delivery/access.ts";
import { ContactCacheError, knownLid, rememberLid, resolveContact } from "../src/delivery/contacts.ts";
import { createDelivery, type DeliveryDeps } from "../src/delivery/deliver.ts";
import { refreshSessionLimits } from "../src/delivery/health.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { createPoolSender } from "../src/delivery/pool-sender.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { resolveUnknownDeliveries } from "../src/delivery/resolve-unknown.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  deliveryOf,
  fakeMagicLinks,
  inboundOf,
  paidOrder,
  recordingMail,
  retireDeliveries,
  retireSessions,
  storeInbound,
  type WahaFake,
} from "./support/delivery.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";

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

const ledger = (sessionId: string) => sql<{ kind: string; outcome: string }[]>`SELECT kind, outcome FROM waha_sends WHERE session_id = ${sessionId} ORDER BY created_at`;
const openerOf = async (deliveryId: string) =>
  first(await sql<{ status: string; attempts: number; session_id: string | null }[]>`SELECT status, attempts, session_id FROM delivery_openers WHERE delivery_id = ${deliveryId}`);
const deliveryRow = async (id: string) => first(await sql<{ status: string; attempts: number; attempts_base: number; reply_chat_id: string | null }[]>`SELECT status::text AS status, attempts, attempts_base, reply_chat_id FROM deliveries WHERE id = ${id}`);
const later = (): Date => new Date(Date.now() + 180_000);
const sleepAbortedAfter = (ok: number) => {
  let calls = 0;
  return (): Promise<void> => (++calls > ok ? Promise.reject(new Error("aborted")) : Promise.resolve());
};
const clockOf = (...values: number[]) => {
  let i = 0;
  return (): number => values[Math.min(i++, values.length - 1)] ?? 0;
};
/** An access that lets the first `pass` calls through (the re-fetch of the inbound message) and runs `hook` before every later one (the send). */
function hooked(fake: WahaFake, pass: number, hook: () => Promise<void>): WahaAccess {
  let calls = 0;
  return {
    withSession: async (id, use, options) => {
      if (calls++ >= pass) await hook();
      return fake.access.withSession(id, use, options);
    },
  };
}

function build(over: Partial<DeliveryDeps> = {}, fake: WahaFake = createWahaFake()) {
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  const deps: DeliveryDeps = {
    sql: workerSql,
    log: silentLog,
    config,
    waha: fake.access,
    mail,
    files: createEbookFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: () => 0,
    sleep: () => Promise.resolve(),
    ...over,
  };
  const delivery = createDelivery(deps);
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: deps.waha, delivery, files: createEbookFiles(config), random: () => 0, sleep: () => Promise.resolve() });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  const hear = async (session: string, chatId: string, body: string) => {
    const stored = await storeInbound({ sessionName: session, messageId: await fake.inbound({ session, chatId, body }), fromJid: chatId });
    return { ...stored, run: () => process({ id: stored.outboxId }) };
  };
  return { waha: fake, mail, magic, config, delivery, hear, files: () => fake.sent.filter((s) => s.kind === "file") };
}

describe("a ledger row is never left `reserved` (it would count against the number's day for ever)", () => {
  it("an order refunded while the reply was in flight: the delivery is cancelled with payments' mark and the row says how the send ended (WAHA refused it: failed)", async () => {
    const fake = createWahaFake();
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    fake.fault(s.name, "unauthorized");
    const r = build(
      {
        waha: hooked(fake, 1, async () => {
          await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.orderId}`;
        }),
      },
      fake,
    );
    await (await r.hear(s.name, order.chatId, `kode ${order.code}`)).run();
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "cancelled", last_error: EFFECT_CANCELLED });
    expect(await ledger(s.id)).toEqual([{ kind: "reply", outcome: "failed" }]);
  });

  it("a reply whose claim was taken over while it was in flight is stale for the delivery, and its row still says it went out", async () => {
    const fake = createWahaFake();
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const r = build(
      {
        waha: hooked(fake, 1, async () => {
          await sql`UPDATE deliveries SET attempts = attempts + 1 WHERE id = ${order.deliveries.whatsapp}`;
        }),
      },
      fake,
    );
    await (await r.hear(s.name, order.chatId, `kode ${order.code}`)).run();
    expect(await deliveryRow(order.deliveries.whatsapp)).toMatchObject({ status: "sending", attempts: 2 });
    expect(await ledger(s.id)).toEqual([{ kind: "reply", outcome: "sent" }]);
  });

  it("an opener taken over or deleted while it was in flight leaves its ledger row as sent, not reserved", async () => {
    const fake = createWahaFake();
    const s = await createSession({ dailyCap: 100 });
    for (const change of [
      (id: string) => sql`UPDATE delivery_openers SET attempts = attempts + 1 WHERE delivery_id = ${id}`,
      (id: string) => sql`DELETE FROM delivery_openers WHERE delivery_id = ${id}`,
    ]) {
      const order = await paidOrder(shop);
      const access: WahaAccess = {
        withSession: async (id, use, options) => {
          await change(order.deliveries.whatsapp);
          return fake.access.withSession(id, use, options);
        },
      };
      expect(await build({ waha: access }, fake).delivery.process({ id: order.deliveries.whatsapp })).toBe("stale");
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    }
    expect((await ledger(s.id)).map((l) => l.outcome)).toEqual(["sent", "sent"]);
  });

  it("a pool text that failed in a way that is not WAHA's answer (something of ours after the request may have left) is an unknown send", async () => {
    const s = await createSession();
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: { withSession: () => Promise.reject(new Error("boom")) }, random: () => 0, sleep: () => Promise.resolve() });
    await expect(sender.sendText({ to: uniquePhone() as never, text: "Kode" })).rejects.toMatchObject({ code: "maybe_sent" });
    expect(await ledger(s.id)).toEqual([{ kind: "otp", outcome: "unknown" }]);
  });

  it("a stranger's text reply that failed in a way that is not WAHA's answer is an unknown send too", async () => {
    const fake = createWahaFake();
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const r = build({ waha: hooked(fake, 1, () => Promise.reject(new Error("boom"))) }, fake);
    const heard = await r.hear(s.name, "6281999900501@c.us", `kode ${order.code}`);
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_failed" });
    expect((await ledger(s.id)).map((l) => l.outcome)).toEqual(["unknown"]);
  });
});

describe("an attempt number is never reused", () => {
  it("an opener that sent nothing for a reason of ours keeps its attempt number: the next claim is attempt 2, never 1 again", async () => {
    const fake = createWahaFake();
    await createSession();
    const order = await paidOrder(shop);
    expect(await build({ sleep: sleepAbortedAfter(1) }, fake).delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1 });
    await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${order.deliveries.whatsapp}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await build({}, fake).delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("an e-mail that sent nothing for a reason of ours gives its retry budget back (attempts_base) without reusing the attempt number", async () => {
    const r = build();
    const order = await paidOrder(shop);
    r.magic.failing = true;
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("pending");
    expect(await deliveryRow(order.deliveries.email)).toMatchObject({ status: "pending", attempts: 1, attempts_base: 1 });
    r.magic.failing = false;
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.email}`;
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    expect(await deliveryRow(order.deliveries.email)).toMatchObject({ status: "sent", attempts: 2, attempts_base: 1 });
  });

  it("a finisher of an old claim can never record onto a newer one, not even after the Owner's resend: the second claim is attempt 2, so the first finisher is stale", async () => {
    const r = build();
    const order = await paidOrder(shop);
    const id = order.deliveries.email;
    const original = r.mail.send.bind(r.mail);
    let second = "";
    r.mail.send = async (message) => {
      // While the first attempt is in flight its lease runs out and the Owner confirms a resend; a second attempt then claims the row and sends.
      await sql`UPDATE deliveries SET status = 'unknown', lease_until = now() - interval '1 second' WHERE id = ${id}`;
      await sql`SELECT public.resend_delivery(${id}::uuid, true)`;
      r.mail.send = original;
      second = await r.delivery.process({ id });
      return original(message);
    };
    expect(await r.delivery.process({ id })).toBe("stale");
    expect(second).toBe("sent");
    expect(await deliveryRow(id)).toMatchObject({ status: "sent", attempts: 2 });
    expect(r.mail.sent).toHaveLength(2);
  });
});

describe("a lid belongs to one phone, and an old link is checked again before a login link", () => {
  const LID = "98765432101877@lid";

  it("a link older than a day is not trusted: WAHA is asked, and when it now says another phone the sender is a stranger (no PDF, no login link, nothing stored)", async () => {
    const fake = createWahaFake();
    const r = build({}, fake);
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, lid_checked_at) VALUES (${order.phone}, true, ${LID}, ${LID}, now() - interval '3 days')`;
    await fake.lid(LID, "6281999900777@c.us");
    const heard = await r.hear(s.name, LID, `kode ${order.code}`);
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch" });
    expect(r.files()).toEqual([]);
    expect(r.magic.issued).toEqual([]);
    expect(fake.calls.filter((c) => c.path.includes("/lids/"))).toHaveLength(1);
    // The stranger's phone, which only WAHA's answer named, is not stored.
    expect(await sql`SELECT 1 FROM wa_contacts WHERE phone = '+6281999900777'`).toEqual([]);
  });

  it("an old link WAHA still confirms is the buyer: the full reply, and the link is confirmed again for the next day", async () => {
    const fake = createWahaFake();
    const r = build({}, fake);
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, lid_checked_at) VALUES (${order.phone}, true, ${LID}, ${LID}, now() - interval '3 days')`;
    await fake.lid(LID, order.chatId);
    const heard = await r.hear(s.name, LID, `kode ${order.code}`);
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.magic.issued).toHaveLength(1);
    expect(first(await sql<{ fresh: boolean }[]>`SELECT lid_checked_at > now() - interval '1 minute' AS fresh FROM wa_contacts WHERE phone = ${order.phone}`).fresh).toBe(true);
  });

  it("a phone WAHA names for a lid is stored only when the message matched an order: a stranger asking for a code that is not an order's leaves nothing", async () => {
    const fake = createWahaFake();
    const r = build({}, fake);
    const s = await createSession();
    await fake.lid("55555555555811@lid", "6281999900778@c.us");
    const heard = await r.hear(s.name, "55555555555811@lid", "kode AAAAAAAAAA");
    await heard.run();
    expect(await sql`SELECT 1 FROM wa_contacts WHERE phone = '+6281999900778' OR lid = '55555555555811@lid'`).toEqual([]);
  });

  it("pointing a lid at a phone takes it from the phone that held it, and the choice of owner is deterministic", async () => {
    const a = uniquePhone();
    const b = uniquePhone();
    await rememberLid(workerSql, a, LID);
    expect(await knownLid(workerSql, LID)).toMatchObject({ phone: a });
    await rememberLid(workerSql, b, LID);
    expect(await knownLid(workerSql, LID)).toMatchObject({ phone: b });
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${LID}`).toEqual([{ phone: b }]);
    expect(first(await sql<{ lid: string | null }[]>`SELECT lid FROM wa_contacts WHERE phone = ${a}`).lid).toBeNull();
    // A check-exists answer that carries the lid does the same.
    const c = uniquePhone();
    const client = { checkExists: () => Promise.resolve({ numberExists: true, chatId: LID, lid: LID, phone: null }) } as unknown as WahaClient;
    expect(await resolveContact(workerSql, client, "default", c)).toMatchObject({ kind: "ok", chatId: LID });
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${LID}`).toEqual([{ phone: c }]);
    expect(await knownLid(workerSql, "11111111111@lid")).toBeNull();
  });
});

describe("the contact cache: one transaction, a failure of ours is never an uncertain send, and a lid is only as young as its last confirmation", () => {
  const LID2 = "98765432101878@lid";
  const answering = (answer: { numberExists: boolean; chatId: string | null; lid: string | null; phone: string | null }): WahaClient =>
    ({ checkExists: () => Promise.resolve(answer) }) as unknown as WahaClient;

  it("taking a lid from one phone and writing it to another is ONE step: when the write fails, the first phone keeps its lid", async () => {
    const a = uniquePhone();
    await rememberLid(workerSql, a, LID2);
    const b = uniquePhone();
    // An answer whose chat id the table refuses: the clearing of the lid (done first) must roll back with it.
    await expect(resolveContact(workerSql, answering({ numberExists: true, chatId: "not-a-chat-id", lid: LID2, phone: null }), "default", b)).rejects.toBeInstanceOf(ContactCacheError);
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${LID2}`).toEqual([{ phone: a }]);
    expect(await sql`SELECT 1 FROM wa_contacts WHERE phone = ${b}`).toEqual([]);
    // Inside a transaction the caller already holds, the same call joins it (no second transaction).
    const c = uniquePhone();
    await workerSql.begin(async (tx) => {
      expect(await resolveContact(tx, answering({ numberExists: true, chatId: LID2, lid: LID2, phone: null }), "default", c)).toMatchObject({ kind: "ok", chatId: LID2 });
    });
    expect(await sql`SELECT phone FROM wa_contacts WHERE lid = ${LID2}`).toEqual([{ phone: c }]);
  });

  it("a failure of our own database while the contact is looked up is nothing sent, not an uncertain send: the opener goes back to pending (contact_cache_failed), never unknown", async () => {
    const fake = createWahaFake();
    const s = await createSession();
    const order = await paidOrder(shop);
    const broken: WahaAccess = {
      withSession: (id, use, options) =>
        fake.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, checkExists: () => Promise.resolve({ numberExists: true, chatId: "not-a-chat-id", lid: null, phone: null }) } }), options),
    };
    const r = build({ waha: broken }, fake);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1 });
    expect(first(await sql<{ last_error: string | null }[]>`SELECT last_error FROM delivery_openers WHERE delivery_id = ${order.deliveries.whatsapp}`).last_error).toBe("contact_cache_failed");
    expect(fake.sent).toEqual([]);
    expect(await ledger(s.id)).toEqual([]);
    // The same for a login code: nothing sent, so not maybe_sent (the next number is tried, and with none left the send fails plainly).
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: broken, random: () => 0, sleep: () => Promise.resolve() });
    await expect(sender.sendText({ to: uniquePhone() as never, text: "Kode" })).rejects.toMatchObject({ code: "failed" });
    expect(await ledger(s.id)).toEqual([]);
  });

  it("a check-exists answer refreshes the cache, but the lid link only when the answer carried that lid", async () => {
    const phone = uniquePhone();
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid, checked_at, lid_checked_at) VALUES (${phone}, true, ${LID2}, ${LID2}, now() - interval '40 days', now() - interval '3 days')`;
    const stamps = async () => first(await sql<{ cache_age: number; link_age: number; lid: string | null }[]>`
      SELECT extract(epoch FROM now() - checked_at)::float8 AS cache_age, extract(epoch FROM now() - lid_checked_at)::float8 AS link_age, lid FROM wa_contacts WHERE phone = ${phone}`);
    // The cache is stale (40 days): WAHA is asked. It answers with the phone's own chat and NO lid: the cache is fresh, the old link is exactly as old as it was.
    await resolveContact(workerSql, answering({ numberExists: true, chatId: "628123456789@c.us", lid: null, phone: null }), "default", phone);
    const afterPlain = await stamps();
    expect(afterPlain.cache_age).toBeLessThan(60);
    expect(afterPlain.link_age).toBeGreaterThan(2.9 * 86_400);
    expect(afterPlain.lid).toBe(LID2);
    // An answer that carries the lid confirms it.
    await sql`UPDATE wa_contacts SET checked_at = now() - interval '40 days' WHERE phone = ${phone}`;
    await resolveContact(workerSql, answering({ numberExists: true, chatId: LID2, lid: LID2, phone: null }), "default", phone);
    expect((await stamps()).link_age).toBeLessThan(60);
    // A link nothing ever confirmed (no timestamp) is as old as can be.
    const lone = uniquePhone();
    await sql`INSERT INTO wa_contacts (phone, number_exists, chat_id, lid) VALUES (${lone}, true, '98765432101879@lid', '98765432101879@lid')`;
    expect((await knownLid(workerSql, "98765432101879@lid"))?.checkedAt.getTime()).toBe(0);
  });
});

describe("the poll is the authority on a number's block", () => {
  const stateOf = async (id: string) => first(await sql<{ reachout_until: Date | null }[]>`SELECT reachout_until FROM waha_sessions WHERE id = ${id}`);

  it("lifts a block when WAHA answers both calls and says the number is not limited; not right after a refusal, and not when only one call answered", async () => {
    const fake = createWahaFake();
    const s = await createSession();
    const deps = (access: WahaAccess) => ({ sql: workerSql, log: silentLog, waha: access });
    await sql`UPDATE waha_sessions SET reachout_until = now() + interval '5 hours' WHERE id = ${s.id}`;
    // Right after WhatsApp's own refusal the hold stands whatever WAHA's state says.
    expect(await refreshSessionLimits(deps(fake.access), s.id, { keepHold: true })).toBe(true);
    expect((await stateOf(s.id)).reachout_until).not.toBeNull();
    // Only the timelock answered: nothing says the capping is clear either.
    const half: WahaAccess = {
      withSession: (id, use, options) => fake.access.withSession(id, ({ sessionName, client }) => use({ sessionName, client: { ...client, messageCapping: () => Promise.reject(new Error("x")) } }), options),
    };
    await refreshSessionLimits(deps(half), s.id);
    expect((await stateOf(s.id)).reachout_until).not.toBeNull();
    // Both answered, nothing limited: the block is lifted.
    await refreshSessionLimits(deps(fake.access), s.id);
    expect((await stateOf(s.id)).reachout_until).toBeNull();
  });
});

describe("the lease covers the offline call, and the pacing is not Math.random", () => {
  it("a send is not made when the lease could not cover the offline call that follows it", async () => {
    const config = deliveryConfig(shop);
    const base = config.leaseMs - config.wahaTimeoutMs - 1000;
    // Reading the clock at the claim, before the human-like steps, and before the send: the send would still fit the lease itself, but not the offline call after it.
    const r = build({ clock: clockOf(0, 0, base - 2000) });
    const s = await createSession();
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1 });
    expect(r.waha.sent).toEqual([]);
    expect(await ledger(s.id)).toEqual([]);
    // With room for it the same send goes out.
    await sql`UPDATE delivery_openers SET next_attempt_at = now() - interval '1 second' WHERE delivery_id = ${order.deliveries.whatsapp}`;
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await build({ clock: clockOf(0, 0, base - 4000) }, r.waha).delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
  });

  it("the slot and contact gaps come from the operating system's random source: no Math.random in an opener or an OTP", async () => {
    const fake = createWahaFake();
    await createSession({ dailyCap: 100 });
    const order = await paidOrder(shop);
    const delivery = createDelivery({ sql: workerSql, log: silentLog, config: deliveryConfig(shop), waha: fake.access, mail: recordingMail(), files: createEbookFiles(deliveryConfig(shop)), magicLinks: fakeMagicLinks(), enqueue: () => Promise.resolve(), sleep: () => Promise.resolve() });
    const sender = createPoolSender({ sql: workerSql, log: silentLog, waha: fake.access, sleep: () => Promise.resolve() });
    const spy = vi.spyOn(Math, "random");
    try {
      expect(await delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      await sender.sendText({ to: uniquePhone() as never, text: "Kode" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a WAHA lookup that keeps failing is a warning per number, not a critical alert per cause", () => {
  it("raises waha_lookup_failing (warning, once per number) and no delivery_not_attempted for it", async () => {
    const fake = createWahaFake();
    const r = build({}, fake);
    const s = await createSession();
    await fake.presenceFault("http500");
    for (let i = 0; i < 2; i++) {
      const order = await paidOrder(shop);
      expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    }
    await fake.presenceFault("ok");
    const alerts = await sql<{ kind: string; severity: string; dedupe_key: string }[]>`
      SELECT kind, severity, dedupe_key FROM alerts WHERE resolved_at IS NULL AND (dedupe_key = ${`waha_lookup_failing:${s.id}`} OR dedupe_key LIKE 'delivery_not_attempted:check_exists%')`;
    expect(alerts).toEqual([{ kind: "waha_lookup_failing", severity: "warning", dedupe_key: `waha_lookup_failing:${s.id}` }]);
  });
});

describe("an unknown PDF reply to a @lid chat resolves on its own", () => {
  it("the chat the reply went to is stored on the delivery, and the lookup asks there as well as in the order's own chat", async () => {
    const fake = createWahaFake();
    const r = build({}, fake);
    const s = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const lid = "98765432101899@lid";
    await fake.lid(lid, order.chatId);
    fake.fault(s.name, "timeout_after_send");
    await (await r.hear(s.name, lid, `kode ${order.code}`)).run();
    expect(await deliveryRow(order.deliveries.whatsapp)).toMatchObject({ status: "unknown", reply_chat_id: lid });
    await sql`UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    fake.fault(s.name, undefined);
    const swept = await resolveUnknownDeliveries({ sql: workerSql, log: silentLog, waha: fake.access, config: r.config });
    expect(swept.resolved).toBeGreaterThanOrEqual(1);
    expect((await deliveryRow(order.deliveries.whatsapp)).status).toBe("sent");
    expect(r.files()).toHaveLength(1);
  });
});
