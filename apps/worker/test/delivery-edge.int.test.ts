// US-025: the edges of the delivery code that the main scenarios do not reach: preparation failures, unexpected errors (never a blind resend), a lease
// lost or a row deleted while the send is in flight, a failing failover enqueue, the buyer-first refusals, the unknown-send lookup when WAHA is down or the
// row moved on, and the optional ports of the delivery port. Every one of them ends in a state the machine allows, and nothing is sent twice.
import { SmtpError, WahaError } from "@ebooktrivia/adapters";
import { EMAIL_MAX_ATTEMPTS } from "@ebooktrivia/core";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type DeliveryDeps, raisePoolAlert } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { createDeliveryPort } from "../src/delivery/index.ts";
import { loadTemplate, TemplateMissing } from "../src/delivery/messages.ts";
import { createPoolSender } from "../src/delivery/pool-sender.ts";
import { MailAccessError, type EbookFiles, type WahaAccess, WahaAccessError } from "../src/delivery/ports.ts";
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
} from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(8);
/** The state of a delivery's opener (the short proactive WhatsApp message, Owner decision D7): the WhatsApp job works on this row, not on the delivery. */
const openerOf = async (deliveryId: string) =>
  first(await sql<{ status: string; attempts: number; last_error: string | null }[]>`SELECT status, attempts, last_error FROM delivery_openers WHERE delivery_id = ${deliveryId}`);
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
  const enqueued: unknown[] = [];
  const deps: DeliveryDeps = {
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: testFiles(config),
    magicLinks: magic,
    enqueue: (jobs) => {
      enqueued.push(...jobs);
      return Promise.resolve();
    },
    random: () => 0,
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { waha, mail, magic, config, enqueued, deps, delivery: createDelivery(deps) };
}

describe("claims that cannot happen", () => {
  it("an opener whose attempts are used up is skipped and leaves nothing behind (the ledger row of its claim is rolled back)", async () => {
    const r = build();
    const tried = await Promise.all([4, 3, 2].map((weight) => createSession({ weight })));
    const fresh = await createSession({ weight: 1 });
    const order = await paidOrder(shop);
    await sql`INSERT INTO delivery_openers (delivery_id, attempts, tried_session_ids) VALUES (${order.deliveries.whatsapp}, 3, ${tried.map((s) => s.id)}::uuid[])`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 3 });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await sql`SELECT 1 FROM waha_sends WHERE session_id = ${fresh.id}`).toEqual([]);
    const next = (await sql<{ next_send_at: Date | null }[]>`SELECT next_send_at FROM waha_sessions WHERE id = ${fresh.id}`)[0];
    expect(next?.next_send_at).toBeNull();
    // An e-mail with its four attempts spent is not claimed either.
    await sql`UPDATE deliveries SET attempts = ${EMAIL_MAX_ATTEMPTS} WHERE id = ${order.deliveries.email}`;
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("skipped");
    expect(r.mail.sent).toEqual([]);
  });
});

describe("what goes wrong before anything is sent", () => {
  it("a PDF that is not on disk fails the e-mail for good (with an alert); an unreadable one is retried; a buyer without a player has no login link to send (the opener needs none)", async () => {
    const missing = await paidOrder(shop);
    const r = build({ files: { size: () => Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })), read: () => Promise.reject(new Error("x")), signedUrl: () => "https://x", preflight: () => Promise.reject(new Error("x")) } });
    expect(await r.delivery.process({ id: missing.deliveries.email })).toBe("failed");
    expect(await deliveryOf(missing.deliveries.email)).toMatchObject({ status: "failed", last_error: "ebook_file_missing" });

    const unreadable = await paidOrder(shop);
    const broken: EbookFiles = { size: () => Promise.reject(new Error("disk error")), read: () => Promise.reject(new Error("x")), signedUrl: () => "https://x", preflight: () => Promise.reject(new Error("disk error")) };
    expect(await build({ files: broken }).delivery.process({ id: unreadable.deliveries.email })).toBe("pending");
    expect(await deliveryOf(unreadable.deliveries.email)).toMatchObject({ status: "pending", last_error: "preparation_failed" });

    const anonymous = await paidOrder(shop);
    await sql`UPDATE orders SET player_id = NULL WHERE id = ${anonymous.orderId}`;
    await createSession();
    const clean = build();
    expect(await clean.delivery.process({ id: anonymous.deliveries.email })).toBe("pending");
    expect(await deliveryOf(anonymous.deliveries.email)).toMatchObject({ last_error: "magic_link_unavailable" });
    // The opener carries no login link: it goes out; the link is made when the buyer replies and the PDF is sent (the reply path fails the same way).
    expect(await clean.delivery.process({ id: anonymous.deliveries.whatsapp })).toBe("opened");
    expect(clean.mail.sent).toEqual([]);
    expect(clean.waha.sent).toEqual([expect.objectContaining({ kind: "text" })]);
    expect(clean.waha.sent.filter((s) => s.kind === "file")).toEqual([]);
    expect(await deliveryOf(anonymous.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a template that is missing is a clean, retried failure; a send aborted while it waits for its slot is not sent", async () => {
    await expect(loadTemplate(workerSql, "delivery", "email_nope" as never)).rejects.toBeInstanceOf(TemplateMissing);
    await createSession();
    const order = await paidOrder(shop);
    const r = build({ sleep: () => Promise.reject(new Error("aborted")) });
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1, last_error: "aborted_before_send" });
    expect(r.waha.sent).toEqual([]);
  });
});

describe("what goes wrong while sending", () => {
  it("classifies every failure by whether the message may have gone out: only a certain one is retried", async () => {
    const mailError = async (error: Error): Promise<{ status: string; last_error: string | null }> => {
      const r = build();
      r.mail.failures.push(error);
      const order = await paidOrder(shop);
      await r.delivery.process({ id: order.deliveries.email });
      const row = await deliveryOf(order.deliveries.email);
      return { status: row.status, last_error: row.last_error };
    };
    expect(await mailError(new MailAccessError("smtp_not_configured"))).toEqual({ status: "pending", last_error: "mail_smtp_not_configured" });
    expect(await mailError(new RangeError("to must be exactly one plain address"))).toEqual({ status: "failed", last_error: "invalid_recipient" });
    expect(await mailError(new Error("socket hang up"))).toEqual({ status: "unknown", last_error: "smtp_send_failed" });

    // A size refusal whose fallback is refused too, with a 4xx: the retry is the machine's, from the start.
    const r = build();
    const order = await paidOrder(shop);
    r.mail.failures.push(new SmtpError("rejected", "x", { cause: { responseCode: 552 } }), new SmtpError("failed", "x"));
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("pending");
    expect(await deliveryOf(order.deliveries.email)).toMatchObject({ last_error: "smtp_failed" });
    expect(r.mail.sent).toEqual([]);
  });

  it("an unexpected error, or a session that cannot be opened, in the middle of a WhatsApp send", async () => {
    await createSession({ weight: 5 });
    await createSession({ weight: 1 });
    const unexpected = build({ waha: { withSession: () => Promise.reject(new Error("boom")) } });
    const a = await paidOrder(shop);
    // Unknown: never retried on another number.
    expect(await unexpected.delivery.process({ id: a.deliveries.whatsapp })).toBe("unknown");
    expect(await openerOf(a.deliveries.whatsapp)).toMatchObject({ status: "unknown", last_error: "waha_send_failed" });
    expect(await deliveryOf(a.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await unexpected.delivery.process({ id: a.deliveries.whatsapp })).toBe("skipped");

    const refused = build({ waha: { withSession: () => Promise.reject(new WahaAccessError("key_missing")) } });
    const b = await paidOrder(shop);
    expect(await refused.delivery.process({ id: b.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(b.deliveries.whatsapp)).toMatchObject({ status: "pending", last_error: "waha_key_missing" });
  });

  it("a lease lost or a row deleted while the message is in flight changes nothing more: the outcome is dropped", async () => {
    await createSession();
    const lost = await paidOrder(shop);
    const r = build();
    const original = r.mail.send.bind(r.mail);
    r.mail.send = async (message) => {
      // Another attempt took the row over while this one was sending.
      await sql`UPDATE deliveries SET attempts = attempts + 1 WHERE id = ${lost.deliveries.email}`;
      return original(message);
    };
    expect(await r.delivery.process({ id: lost.deliveries.email })).toBe("stale");
    expect(await deliveryOf(lost.deliveries.email)).toMatchObject({ status: "sending", attempts: 2 });

    const deleted = await paidOrder(shop);
    const d = build();
    const send = d.mail.send.bind(d.mail);
    d.mail.send = async (message) => {
      await sql`DELETE FROM deliveries WHERE id = ${deleted.deliveries.email}`;
      return send(message);
    };
    expect(await d.delivery.process({ id: deleted.deliveries.email })).toBe("stale");
  });

  it("a failover job that cannot be queued is left to the sweeper, and the pool alert that cannot be raised does not stop the job", async () => {
    const dead = await createSession({ weight: 5 });
    await createSession({ weight: 1 });
    const r = build({ enqueue: () => Promise.reject(new Error("valkey is down")) });
    await r.waha.status(dead.name, "STOPPED");
    const order = await paidOrder(shop);
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("pending");
    expect(await openerOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1 });
    // The alert path with no database: logged, never thrown.
    const down = postgres("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1, connect_timeout: 1, onnotice: () => undefined });
    await expect(raisePoolAlert(down, "no_working_session", silentLog)).resolves.toBeUndefined();
    await expect(raisePoolAlert(down, "all_busy", silentLog)).resolves.toBeUndefined();
    await down.end({ timeout: 1 });
  });
});

describe("buyer-first refusals and failures", () => {
  function inbound(r: ReturnType<typeof build>, waha: WahaAccess = r.waha.access) {
    const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config: r.config, waha, delivery: r.delivery, files: testFiles(r.config), random: () => 0 });
    const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
    return { process, hear: async (session: string, chatId: string, body: string) => storeInbound({ sessionName: session, messageId: await r.waha.inbound({ session, chatId, body }), fromJid: chatId }) };
  }
  const later = (): Date => new Date(Date.now() + 180_000);

  it("a paid order without a WhatsApp delivery row, or without its PDF, is not answered with a file; a text reply that cannot be sent is recorded, not retried", async () => {
    const r = build();
    const session = await createSession();
    const c = inbound(r);
    const noRow = await paidOrder(shop, { waNotBefore: later() });
    await sql`DELETE FROM deliveries WHERE id = ${noRow.deliveries.whatsapp}`;
    const heard = await c.hear(session.name, noRow.chatId, `kode ${noRow.code}`);
    await c.process({ id: heard.outboxId });
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "no_delivery" });

    const bare = await createDeliveryShop({ pdf: null });
    shops.push(bare);
    const noPdf = await paidOrder(bare, { waNotBefore: later() });
    const heardBare = await c.hear(session.name, noPdf.chatId, `kode ${noPdf.code}`);
    await c.process({ id: heardBare.outboxId });
    expect(await inboundOf(heardBare.inboundId)).toMatchObject({ outcome: "not_sendable" });
    expect(r.waha.sent).toEqual([]);

    // A stranger's text cannot be sent (the number refuses): recorded as such, the right to reply spent, nothing retried.
    const target = await paidOrder(shop, { waNotBefore: later() });
    r.waha.fault(session.name, "unauthorized");
    const refused = await c.hear(session.name, "6281999900099@c.us", `kode ${target.code}`);
    await c.process({ id: refused.outboxId });
    expect(await inboundOf(refused.inboundId)).toMatchObject({ outcome: "text_failed", replied: true });
  });

  it("answers nothing to our own messages or to a foreign number, and retries when the number's queue is full", async () => {
    const r = build();
    const session = await createSession();
    const c = inbound(r);
    // Our own outgoing message, delivered back to the webhook: ignored.
    const order = await paidOrder(shop, { waNotBefore: later() });
    const sender =createPoolSender({ sql: workerSql, log: silentLog, waha: r.waha.access, random: () => 0, sleep: () => Promise.resolve() });
    await sender.sendText({ to: uniquePhone() as never, text: "halo" });
    const ownId = first(r.waha.sent.filter((s) => s.kind === "text")).id;
    const own = await storeInbound({ sessionName: session.name, messageId: ownId, fromJid: order.chatId });
    await c.process({ id: own.outboxId });
    expect(await inboundOf(own.inboundId)).toMatchObject({ outcome: "ignored" });
    // A number that is not an Indonesian mobile: not a person's chat we serve.
    const foreign = await c.hear(session.name, "14155550100@c.us", `kode ${order.code}`);
    await c.process({ id: foreign.outboxId });
    expect(await inboundOf(foreign.inboundId)).toMatchObject({ outcome: "ignored" });

    // The number's queue is longer than the wait budget: the reply is retried, the row is untouched.
    await sql`UPDATE waha_sessions SET next_send_at = now() + interval '5 minutes' WHERE id = ${session.id}`;
    const busy = await c.hear(session.name, order.chatId, `kode ${order.code}`);
    await expect(c.process({ id: busy.outboxId })).rejects.toThrow(/queue is full/);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("an error that is not WAHA's is not swallowed: the message is asked about again later", async () => {
    const r = build();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const broken = inbound(r, { withSession: () => Promise.reject(new Error("boom")) });
    const heard = await inbound(r).hear(session.name, order.chatId, `kode ${order.code}`);
    await expect(broken.process({ id: heard.outboxId })).rejects.toThrow(/boom/);
    // An @lid lookup that fails for any reason but "WAHA has no number for it" is an outage too.
    const lid = "77777777777777@lid";
    await r.waha.lid(lid, null);
    const lidHeard = await inbound(r).hear(session.name, lid, `kode ${order.code}`);
    const flaky: WahaAccess = {
      withSession: (sessionId, use, options) =>
        r.waha.access.withSession(sessionId, ({ sessionName, client }) => use({ sessionName, client: { ...client, resolveLid: () => Promise.reject(new WahaError("failed", "down")) } }), options),
    };
    await expect(inbound(r, flaky).process({ id: lidHeard.outboxId })).rejects.toThrow(WahaError);
    expect(r.waha.sent).toEqual([]);
  });

  it("uses the real timer for a text reply and for a pool text when nothing injects one", async () => {
    const r = build();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config: r.config, waha: r.waha.access, delivery: r.delivery, files: testFiles(r.config) });
    const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
    const heard = await storeInbound({ sessionName: session.name, messageId: await r.waha.inbound({ session: session.name, chatId: "6281999900123@c.us", body: `kode ${order.code}` }), fromJid: "6281999900123@c.us" });
    await process({ id: heard.outboxId });
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch" });
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    await createPoolSender({ sql: workerSql, log: silentLog, waha: r.waha.access, random: () => 0 }).sendText({ to: uniquePhone() as never, text: "halo" });
    expect(r.waha.sent.filter((s) => s.kind === "text")).toHaveLength(2);
  });
});

describe("the unknown-send lookup", () => {
  it("asks again at the next sweep when WAHA cannot be asked, and leaves a row that moved on meanwhile alone", async () => {
    const r = build();
    // The count below is of THIS row: unknown rows left by other tests (the database lives across runs) are moved out of the lookup window.
    await sql`UPDATE deliveries SET lease_until = now() - interval '2 days' WHERE status = 'unknown'`;
    const flaky = await createSession();
    r.waha.fault(flaky.name, "timeout_after_send");
    // A PDF reply to a buyer who wrote first, whose answer is lost: the delivery row is unknown (an opener never is a delivery's unknown state).
    const order = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 180_000) });
    const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config: r.config, waha: r.waha.access, delivery: r.delivery, files: testFiles(r.config), random: () => 0, sleep: () => Promise.resolve() });
    const heard = await storeInbound({ sessionName: flaky.name, messageId: await r.waha.inbound({ session: flaky.name, chatId: order.chatId, body: `kode ${order.code}` }), fromJid: order.chatId });
    await createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: heard.outboxId });
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("unknown");
    await sql`UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    const deps = { sql: workerSql, log: silentLog, config: r.config };
    r.waha.outage(flaky.name, true);
    expect(await resolveUnknownDeliveries({ ...deps, waha: r.waha.access })).toMatchObject({ resolved: 0, left: 1 });
    r.waha.outage(flaky.name, false);
    // The late outcome of the original job settles the row while the lookup holds its answer.
    const racing: WahaAccess = {
      withSession: async (sessionId, use, options) => {
        const found = await r.waha.access.withSession(sessionId, use, options);
        await sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE id = ${order.deliveries.whatsapp}`;
        return found;
      },
    };
    expect(await resolveUnknownDeliveries({ ...deps, waha: racing })).toMatchObject({ resolved: 0 });
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("sent");
    expect(r.waha.sent.filter((s) => s.kind === "file")).toHaveLength(1);
  });
});

describe("the delivery port's optional parts", () => {
  it("takes the random source, the sleeper and the clock of a test, and builds the same runtime", () => {
    const r = build();
    const port = createDeliveryPort({
      config: r.config,
      waha: r.waha.access,
      mail: r.mail,
      files: testFiles(r.config),
      magicLinks: r.magic,
      random: () => 0.25,
      sleep: () => Promise.resolve(),
      clock: () => 1,
    });
    const runtime = port.create({ sql: workerSql, log: silentLog, enqueue: () => Promise.resolve() });
    expect(runtime.outboxConsumers.map((c) => c.topic)).toEqual(["waha.inbound"]);
  });
});
