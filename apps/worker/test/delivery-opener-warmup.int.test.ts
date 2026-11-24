// Owner decision 2026-11-24: opener variety and the warm-up of new WhatsApp numbers, through the real delivery code against PostgreSQL (worker_rw) and the in-process
// WAHA mock.
//   - the wording of an opener: picked at claim time, recorded on the opener row (variant_key), never one the number used for its last 3 openers; {sapaan} and [[a|b]]
//     are drawn when it is sent; a wording the Owner removed never breaks anything;
//   - the warm-up: a new number's budget of NEW contacts grows with its WIB days (5, 10, 20, then its own cap); replies to a buyer who wrote first are never limited by it;
//     an established number keeps its own cap.
import { sapaanForTime } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type DeliveryDeps } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createDeliveryShop, createSession, createWahaFake, type DeliveryShop, deliveryConfig, deliveryOf, fakeMagicLinks, paidOrder, recordingMail, retireDeliveries, retireSessions, storeInbound } from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
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

function build(over: Partial<DeliveryDeps> = {}) {
  const waha = createWahaFake();
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  const delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: testFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: () => 0,
    sleep: () => Promise.resolve(),
    ...over,
  });
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files: testFiles(config), random: () => 0, sleep: () => Promise.resolve() });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  const hear = async (session: string, chatId: string, body: string) => {
    const stored = await storeInbound({ sessionName: session, messageId: await waha.inbound({ session, chatId, body }), fromJid: chatId });
    return { ...stored, run: () => process({ id: stored.outboxId }) };
  };
  return { waha, mail, delivery, hear };
}

const openerRowOf = async (deliveryId: string) =>
  first(await sql<{ status: string; variant_key: string | null; session_id: string | null }[]>`SELECT status, variant_key, session_id FROM delivery_openers WHERE delivery_id = ${deliveryId}`);
const wordingKeys = async (): Promise<string[]> =>
  (await sql<{ key: string }[]>`SELECT key FROM message_templates WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp' AND locale = 'id' ORDER BY substring(key from '[0-9]+$')::int`).map((r) => r.key);
const newContactsOf = async (sessionId: string): Promise<number> =>
  first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM waha_sends WHERE session_id = ${sessionId} AND new_contact AND outcome <> 'failed'`).n;

/** One opener to a fresh buyer, the number's next slot freed first (the gap between sends is not under test). */
async function openOne(r: ReturnType<typeof build>, name = "Budi Santoso") {
  await sql`UPDATE waha_sessions SET next_send_at = NULL`;
  const order = await paidOrder(shop, { name, phone: uniquePhone() });
  const result = await r.delivery.process({ id: order.deliveries.whatsapp });
  return { order, result };
}

/** Puts every wording of the database to `body` for the duration of `run` (the Owner's wordings are restored after). */
async function withEveryWording<T>(body: string, run: () => Promise<T>): Promise<T> {
  const saved = await sql<{ id: string; body: string }[]>`SELECT id, body FROM message_templates WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp'`;
  await sql`UPDATE message_templates SET body = ${body} WHERE key ~ '^delivery_opener_[0-9]+$' AND channel = 'whatsapp'`;
  try {
    return await run();
  } finally {
    for (const row of saved) await sql`UPDATE message_templates SET body = ${row.body} WHERE id = ${row.id}`;
  }
}

describe("the wording of an opener (variety)", () => {
  it("the database holds the ten approved wordings", async () => {
    expect(await wordingKeys()).toEqual(Array.from({ length: 10 }, (_, i) => `delivery_opener_${String(i + 1)}`));
  });

  it("records the wording it was claimed with, never repeats one of the number's last 3, and uses a wording that exists", async () => {
    const r = build({ humanRandom: Math.random });
    const session = await createSession({ dailyCap: 1000 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000 WHERE id = ${session.id}`;
    const keys = await wordingKeys();
    const used: string[] = [];
    for (let i = 0; i < 24; i++) {
      const { order, result } = await openOne(r);
      expect(result).toBe("opened");
      const row = await openerRowOf(order.deliveries.whatsapp);
      expect(row).toMatchObject({ status: "sent", session_id: session.id });
      expect(keys).toContain(row.variant_key);
      expect(used.slice(-3), `opener ${String(i + 1)}`).not.toContain(row.variant_key);
      used.push(row.variant_key ?? "");
    }
    // 24 openers over 10 wordings: more than the three of a window, and the last text was rendered (no token or choice marker left in it).
    expect(new Set(used).size).toBeGreaterThan(3);
    expect(r.waha.sent).toHaveLength(24);
    for (const message of r.waha.sent) expect(message.text).not.toMatch(/[{}]|\[\[|\]\]/);
  });

  it("each number has its own history: another number may use the wording this one used a moment ago", async () => {
    const r = build({ humanRandom: () => 0 });
    const a = await createSession({ dailyCap: 1000, weight: 1 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
    // humanRandom 0 draws the first allowed wording: delivery_opener_1 for a number with no history.
    const first_ = await openOne(r);
    expect(await openerRowOf(first_.order.deliveries.whatsapp)).toMatchObject({ variant_key: "delivery_opener_1", session_id: a.id });
    // The same number cannot use 1 again at once: it draws the first allowed one, 2.
    const second = await openOne(r);
    expect((await openerRowOf(second.order.deliveries.whatsapp)).variant_key).toBe("delivery_opener_2");
    // A second number has no history: with only it WORKING it starts again at 1.
    await sql`UPDATE waha_sessions SET active = false WHERE id = ${a.id}`;
    const b = await createSession({ dailyCap: 1000 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000 WHERE id = ${b.id}`;
    const third = await openOne(r);
    expect(await openerRowOf(third.order.deliveries.whatsapp)).toMatchObject({ variant_key: "delivery_opener_1", session_id: b.id });
  });

  it("renders {sapaan} (the time of day in Jakarta, or a casual Halo / Hai) and each [[a|b]] choice when the opener is sent", async () => {
    await withEveryWording("{sapaan} {nama}, [[satu|dua]] untuk {judul_ebook}.", async () => {
      await createSession({ dailyCap: 1000 });
      await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
      // A draw of 0: the casual branch (below 1/3), the first casual greeting, the first option.
      const low = build({ humanRandom: () => 0 });
      await openOne(low);
      expect(low.waha.sent.at(-1)?.text).toMatch(/^Halo Budi, satu untuk Ebook .+\.$/);
      // A draw of 0.9: the greeting of the time of day, the last option.
      const high = build({ humanRandom: () => 0.9 });
      await openOne(high);
      const text = high.waha.sent.at(-1)?.text ?? "";
      const greeting = sapaanForTime(new Date());
      expect(text.startsWith(`${greeting} Budi, dua untuk Ebook`) || text.startsWith(`${sapaanForTime(new Date(Date.now() - 5000))} Budi, dua untuk Ebook`), text).toBe(true);
    });
  });

  it("an opener never carries a login link or a code: a wording that asks for one is refused, nothing is sent and the attempt is given back", async () => {
    await withEveryWording("Halo {nama}, masuk: {link_trivia}", async () => {
      const r = build();
      const session = await createSession();
      const { order, result } = await openOne(r);
      expect(result).toBe("pending");
      expect(r.waha.sent).toEqual([]);
      expect(first(await sql<{ last_error: string | null }[]>`SELECT last_error FROM delivery_openers WHERE delivery_id = ${order.deliveries.whatsapp}`).last_error).toBe("template_invalid");
      expect(await newContactsOf(session.id)).toBe(0);
    });
  });

  it("a wording the Owner removed breaks nothing: the next opener of the number goes out with another one, and the removed key still takes its place in the history", async () => {
    const r = build({ humanRandom: () => 0 });
    await createSession({ dailyCap: 1000 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
    const one = await openOne(r);
    const used = (await openerRowOf(one.order.deliveries.whatsapp)).variant_key;
    expect(used).toBe("delivery_opener_1");
    const [saved] = await sql<{ subject: string | null; body: string }[]>`SELECT subject, body FROM message_templates WHERE key = 'delivery_opener_1' AND channel = 'whatsapp'`;
    await sql`DELETE FROM message_templates WHERE key = 'delivery_opener_1' AND channel = 'whatsapp'`;
    try {
      // The row that mentions the removed wording is still there, as it was.
      expect(await openerRowOf(one.order.deliveries.whatsapp)).toMatchObject({ status: "sent", variant_key: "delivery_opener_1" });
      const two = await openOne(r);
      expect(two.result).toBe("opened");
      // 1 is gone and was the number's last: the first wording left that is not among its last 3 is 2.
      expect((await openerRowOf(two.order.deliveries.whatsapp)).variant_key).toBe("delivery_opener_2");
    } finally {
      await sql`INSERT INTO message_templates (key, channel, locale, subject, body) VALUES ('delivery_opener_1', 'whatsapp', 'id', ${saved?.subject ?? null}, ${saved?.body ?? ""})`;
    }
  });
});

describe("the wording is picked under the pool's lock, and {sapaan} is the greeting of the moment of the send", () => {
  it("openers claimed at the same moment for one number get different wordings: each pick sees the wordings the others took", async () => {
    const r = build({ humanRandom: () => 0 });
    await createSession({ dailyCap: 1000 });
    await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
    const orders = await Promise.all([paidOrder(shop), paidOrder(shop), paidOrder(shop)]);
    const results = await Promise.all(orders.map((o) => r.delivery.process({ id: o.deliveries.whatsapp })));
    expect(results).toEqual(["opened", "opened", "opened"]);
    const keys = await Promise.all(orders.map(async (o) => (await openerRowOf(o.deliveries.whatsapp)).variant_key));
    // humanRandom 0 takes the first allowed wording: the first claim gets 1, the next one (1 excluded) 2, the third (1 and 2 excluded) 3, in whatever order they won the lock.
    expect([...keys].sort()).toEqual(["delivery_opener_1", "delivery_opener_2", "delivery_opener_3"]);
  });

  it("renders {sapaan} when the message is sent, not when it was prepared: a send carried across an hour of change greets with the new one", async () => {
    await withEveryWording("{sapaan} {nama}.", async () => {
      await createSession({ dailyCap: 1000 });
      await sql`UPDATE waha_sessions SET new_contact_cap = 1000`;
      // Far in the future, so the slot's start (now) never decides: 10:59:59 WIB when the text is prepared, 11:00:01 WIB when it is sent.
      const wall = [new Date("2099-06-01T10:59:59+07:00"), new Date("2099-06-01T11:00:01+07:00")];
      let calls = 0;
      const r = build({ humanRandom: () => 0.9, now: () => wall[Math.min(calls++, 1)] ?? new Date() });
      await openOne(r);
      expect(r.waha.sent.at(-1)?.text).toBe("Selamat siang Budi.");
      expect(calls).toBe(2);
      // And the other way round: the greeting of the send, whatever the first text said (the casual greeting is drawn per render, and 0.9 is never casual).
      const earlier = [new Date("2099-06-01T14:59:59+07:00"), new Date("2099-06-01T15:00:01+07:00")];
      let n = 0;
      const r2 = build({ humanRandom: () => 0.9, now: () => earlier[Math.min(n++, 1)] ?? new Date() });
      await openOne(r2);
      expect(r2.waha.sent.at(-1)?.text).toBe("Selamat sore Budi.");
    });
  });
});

describe("a session inserted without a warm-up setting warms up (the column's default is now())", () => {
  it("a row that nobody marked established is a new number: five new contacts on its first day", async () => {
    const r = build();
    const session = await createSession();
    await sql`UPDATE waha_sessions SET warmup_started_at = DEFAULT WHERE id = ${session.id}`;
    const [row] = await sql<{ recent: boolean }[]>`SELECT warmup_started_at > now() - interval '1 minute' AS recent FROM waha_sessions WHERE id = ${session.id}`;
    expect(row?.recent).toBe(true);
    expect(await openUntilDeferred(r, 8)).toBe(5);
  });
});

/** Opens buyers one after the other until the pool defers; returns how many went out. */
async function openUntilDeferred(r: ReturnType<typeof build>, limit: number): Promise<number> {
  let opened = 0;
  for (let i = 0; i < limit; i++) {
    const { result } = await openOne(r);
    if (result === "deferred") break;
    expect(result).toBe("opened");
    opened++;
  }
  return opened;
}

describe("the warm-up of a new number", () => {
  /** A number whose warm-up started `days` WIB days ago (null: an established number). */
  async function warmingSession(days: number | null, newContactCap: number) {
    const session = await createSession({ dailyCap: 1000 });
    if (days === null) await sql`UPDATE waha_sessions SET new_contact_cap = ${newContactCap}, warmup_started_at = NULL WHERE id = ${session.id}`;
    else
      await sql`
        UPDATE waha_sessions SET new_contact_cap = ${newContactCap},
               warmup_started_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') - make_interval(days => ${days}) + interval '1 hour') AT TIME ZONE 'Asia/Jakarta'
         WHERE id = ${session.id}`;
    return session;
  }

  it("day 0 to 6: five new contacts a day, then the pool defers the rest with the budget alert", async () => {
    await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'wa_new_contact_budget_spent' AND resolved_at IS NULL`;
    const r = build();
    const session = await warmingSession(0, 30);
    expect(await openUntilDeferred(r, 12)).toBe(5);
    expect(await newContactsOf(session.id)).toBe(5);
    // The alert says why the budget is so small: which number is warming up, on which day, with which limit (a session name and numbers, no contact).
    const alerts = await sql<{ message: string; payload: { reason: string; warming: { session_name: string; day: number; limit: number }[] } }[]>`
      SELECT message, payload FROM alerts WHERE dedupe_key = 'wa_new_contact_budget_spent' AND resolved_at IS NULL`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toContain(`warm-up: ${session.name} is on day 1 of 21, limit 5`);
    expect(alerts[0]?.payload).toEqual({ reason: "all_new_contact_capped", warming: [{ session_name: session.name, day: 1, limit: 5 }] });
    // The last day of the first step is still five.
    await sql`UPDATE waha_sessions SET warmup_started_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') - interval '6 days' + interval '1 hour') AT TIME ZONE 'Asia/Jakarta' WHERE id = ${session.id}`;
    expect((await openOne(r)).result).toBe("deferred");
  });

  it("day 7 to 13: ten; day 14 to 20: twenty; day 21 on: the number's own cap", async () => {
    const r = build();
    const session = await warmingSession(7, 100);
    expect(await openUntilDeferred(r, 14)).toBe(10);
    // Seven days later (14): twenty a day, ten already spent today.
    await sql`UPDATE waha_sessions SET warmup_started_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') - interval '14 days' + interval '1 hour') AT TIME ZONE 'Asia/Jakarta' WHERE id = ${session.id}`;
    expect(await openUntilDeferred(r, 14)).toBe(10);
    expect(await newContactsOf(session.id)).toBe(20);
    // Day 21: the warm-up is over, the own cap (here 25) is the limit.
    await sql`UPDATE waha_sessions SET new_contact_cap = 25, warmup_started_at = (date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Jakarta') - interval '21 days' + interval '1 hour') AT TIME ZONE 'Asia/Jakarta' WHERE id = ${session.id}`;
    expect(await openUntilDeferred(r, 12)).toBe(5);
    expect(await newContactsOf(session.id)).toBe(25);
  });

  it("the own cap still wins when it is lower than the warm-up's, and a warning takes its share of whichever is lower", async () => {
    const r = build();
    const low = await warmingSession(0, 3);
    expect(await openUntilDeferred(r, 8)).toBe(3);
    expect(await newContactsOf(low.id)).toBe(3);
    await retireSessions();
    const warned = await warmingSession(7, 100);
    await sql`UPDATE waha_sessions SET warning_level = 'first' WHERE id = ${warned.id}`;
    // Warm-up ten x the first warning's half = 5.
    expect(await openUntilDeferred(r, 12)).toBe(5);
  });

  it("an established number keeps its own cap: no warm-up", async () => {
    const r = build();
    await sql`UPDATE alerts SET resolved_at = now() WHERE dedupe_key = 'wa_new_contact_budget_spent' AND resolved_at IS NULL`;
    const session = await warmingSession(null, 8);
    expect(await openUntilDeferred(r, 12)).toBe(8);
    expect(await newContactsOf(session.id)).toBe(8);
    // Nothing to say about a warm-up for an established number.
    const [alert] = await sql<{ message: string; payload: { warming: unknown[] } }[]>`SELECT message, payload FROM alerts WHERE dedupe_key = 'wa_new_contact_budget_spent' AND resolved_at IS NULL`;
    expect(alert?.message).not.toContain("warm-up");
    expect(alert?.payload.warming).toEqual([]);
  });

  it("replies to a buyer who wrote first, and to a contact the number already knows, are never limited by the warm-up", async () => {
    const r = build();
    const session = await warmingSession(0, 30);
    expect(await openUntilDeferred(r, 12)).toBe(5);
    // The budget of new contacts is spent. A buyer who writes first (a reply, not a new contact) still gets the ebook.
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const writer = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 180_000) });
    await (await r.hear(session.name, writer.chatId, `kode ${writer.code}`)).run();
    expect(await deliveryOf(writer.deliveries.whatsapp)).toMatchObject({ status: "sent", session_id: session.id });
    expect(r.waha.sent.some((m) => m.kind === "file" && m.chatId === writer.chatId)).toBe(true);
    expect(await newContactsOf(session.id)).toBe(5);
    // A contact this number already wrote to (an opener a moment ago) is not new again: the same phone's next opener is not turned away by the budget,
    // and nothing here spends it.
    const known = await paidOrder(shop, { phone: writer.phone });
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    expect(await r.delivery.process({ id: known.deliveries.whatsapp })).not.toBe("deferred");
    expect(await newContactsOf(session.id)).toBe(5);
  });
});
