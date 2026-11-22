// US-025: deliveries in the worker composition (src/worker.ts + delivery/index.ts) with real PostgreSQL, real Valkey / BullMQ, the real Midtrans
// pipeline (infra/midtrans-stub), real SMTP to Mailpit and the in-process WAHA mock.
//   - AC-D1: PAID -> e-mail sent within 10 s. The delivery nudge of the single order.paid consumer hurries the e-mail onto the queue, so it does
//     not wait for the minute sweep; this test is the repeatable measurement (one order at a time, then a burst) and prints the numbers. The
//     relay runs at its production interval (500 ms), the sweeper at ten minutes: only the nudge can explain the time.
//   - Mailpit shows the attachment and the rendered template; the proactive WhatsApp delay is the admin setting (default 3 minutes, 0 = at once).
//   - The proactive WhatsApp message is the short opener (Owner decision D7); a definite failure of it fails over to another number through the
//     queue at once; a buyer-first message is answered through the relay and the consumer; the sweeper picks up what the pool deferred and
//     settles an unknown PDF reply from the number's outgoing messages.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMailSender } from "../src/delivery/access.ts";
import { testFiles } from "./support/files.ts";
import { createDeliveryPort } from "../src/delivery/index.ts";
import { createLogger } from "../src/log.ts";
import { startWorker } from "../src/worker.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import { createSecretOpener, generateScopeKeyPair } from "@ebooktrivia/crypto";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  deliveryOf,
  fakeMagicLinks,
  PDF_BYTES,
  paidOrder,
  retireDeliveries,
  retireSessions,
  storeInbound,
} from "./support/delivery.ts";
import { first, sql, waitFor } from "./support/db.ts";
import { captureLogger } from "./support/log.ts";
import { createOrder, midtransStub, notification, workerPool } from "./support/midtrans.ts";
import { workerEnv } from "./support/processes.ts";
import { uniquePrefix } from "./support/valkey.ts";

const SMTP_PORT = Number(process.env["MAILPIT_SMTP_PORT"] ?? "51025");
const MAILPIT_API = process.env["MAILPIT_API"] ?? "http://127.0.0.1:58025";
const messaging = generateScopeKeyPair();
const opener = createSecretOpener({ messaging: messaging.privateKey });

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}
interface MailpitDetail {
  readonly HTML: string;
  readonly Text: string;
  readonly Attachments: readonly { readonly FileName: string; readonly ContentType: string; readonly Size: number }[];
}

async function mailTo(address: string): Promise<MailpitMessage[]> {
  const search = (await (await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json()) as { messages: MailpitMessage[] };
  return search.messages.filter((m) => m.To.some((t) => t.Address === address));
}
const detail = async (id: string): Promise<MailpitDetail> => (await (await fetch(`${MAILPIT_API}/api/v1/message/${id}`)).json()) as MailpitDetail;

let shop: DeliveryShop;
const waha = createWahaFake();
const magic = fakeMagicLinks();
const stubPool = workerPool(4);
const midtrans = midtransStub();

beforeAll(async () => {
  await sql`DELETE FROM smtp_settings`;
  await sql`INSERT INTO smtp_settings (host, port, security, from_address, from_name) VALUES ('127.0.0.1', ${SMTP_PORT}, 'starttls', 'noreply@example.test', 'Toko Uji')`;
  shop = await createDeliveryShop();
});
afterAll(async () => {
  await sql`DELETE FROM smtp_settings`;
  await sql`UPDATE app_settings SET value = '180'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
  await retireSessions();
  await retireDeliveries();
  await shop.cleanup();
});
beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
});

function deliveryPorts() {
  const config = deliveryConfig(shop);
  return createDeliveryPort({
    config,
    waha: waha.access,
    mail: createMailSender({ sql: stubPool, opener, config: { dev: config.dev, smtpTimeoutMs: config.smtpTimeoutMs } }),
    files: testFiles(config),
    magicLinks: magic,
  });
}

/** A pending Midtrans order of the shop, settled in the stub, with its notification in the outbox (as the webhook route stores it). */
async function settle(): Promise<{ id: string; email: string }> {
  const order = await createOrder(shop, { attributed: false });
  const email = `budi-${randomBytes(6).toString("hex")}@example.test`;
  await sql`UPDATE orders SET buyer_email = ${email} WHERE id = ${order.id}`;
  await midtrans.create(order.midtransId());
  await midtrans.setState(order.midtransId(), { transaction_status: "settlement", payment_type: "qris" });
  await notification(order.midtransId());
  return { id: order.id, email };
}

const emailLatencyMs = async (orderId: string): Promise<number> =>
  first(
    await sql<{ ms: number }[]>`
      SELECT (extract(epoch FROM (d.sent_at - o.paid_at)) * 1000)::float8 AS ms
        FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.order_id = ${orderId} AND d.channel = 'email' AND d.status = 'sent'`,
  ).ms;
const openerStatus = async (deliveryId: string): Promise<string | undefined> =>
  (await sql<{ status: string }[]>`SELECT status FROM delivery_openers WHERE delivery_id = ${deliveryId}`)[0]?.status;
const emailSent = async (orderId: string): Promise<boolean> => (await sql`SELECT 1 FROM deliveries WHERE order_id = ${orderId} AND channel = 'email' AND status = 'sent'`).length === 1;

describe("PAID -> e-mail within 10 seconds (AC-D1), measured on the dev stack", () => {
  it("delivers every e-mail inside the budget with only the order.paid nudge (the sweeper is ten minutes away), PDF attached, template rendered", async () => {
    await sql`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
    const { log, lines } = captureLogger("info");
    // Production timing: the relay polls every 500 ms; the sweepers would only come after ten minutes.
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_RELAY_INTERVAL_MS: "500", WORKER_SWEEP_INTERVAL_MS: "600000", WORKER_RECONCILE_INTERVAL_MS: "600000" }));
    await createSession();
    const running = await startWorker(config, { payments: { midtrans: midtrans.source, waDelayMs: 180_000 }, deliveries: deliveryPorts() }, log);
    const latencies: number[] = [];
    try {
      expect(lines.find((l) => l["msg"] === "worker started")).toMatchObject({ deliveries: true, payments: true });
      expect((lines.find((l) => l["msg"] === "worker started")?.["topics"] as string[]).sort()).toEqual(["order.paid", "payment.notification", "payment.requery", "waha.inbound"]);
      // One order at a time: the latency in isolation.
      const orders: { id: string; email: string }[] = [];
      for (let i = 0; i < 6; i++) {
        const order = await settle();
        orders.push(order);
        await waitFor(`the e-mail of order ${String(i)}`, () => emailSent(order.id), 20_000, 25);
        latencies.push(await emailLatencyMs(order.id));
      }
      // A burst: twenty orders paid at once.
      const burst = await Promise.all(Array.from({ length: 20 }, () => settle()));
      orders.push(...burst);
      await waitFor("the burst's e-mails", async () => (await Promise.all(burst.map((o) => emailSent(o.id)))).every(Boolean), 40_000, 50);
      for (const o of burst) latencies.push(await emailLatencyMs(o.id));

      const sorted = [...latencies].sort((a, b) => a - b);
      const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      process.stdout.write(`\n[US-025 AC-D1] PAID -> e-mail sent, ${String(sorted.length)} orders (6 alone, 20 in a burst): p50 ${p(0.5).toFixed(0)} ms, p95 ${p(0.95).toFixed(0)} ms, max ${(sorted.at(-1) ?? 0).toFixed(0)} ms (budget 10000 ms)\n`);
      expect(sorted.at(-1) ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(10_000);

      // Mailpit: one e-mail per order, the PDF attached under its name, the template rendered with the order and the e-mail login link.
      const sample = orders[0];
      const messages = await mailTo(sample?.email ?? "");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.Subject).toMatch(/^Ebook Ebook [0-9a-f]{8} untuk Budi Santoso$/);
      const body = await detail(messages[0]?.ID ?? "");
      expect(body.Attachments).toEqual([expect.objectContaining({ ContentType: "application/pdf", Size: PDF_BYTES.length })]);
      expect(body.Attachments[0]?.FileName).toMatch(/^Ebook-[0-9a-f]{8}\.pdf$/);
      const [orderRow] = await sql<{ order_code: string }[]>`SELECT order_code FROM orders WHERE id = ${sample?.id ?? ""}`;
      expect(body.HTML).toContain(orderRow?.order_code ?? "?");
      expect(body.HTML).toContain("https://play.example.test/masuk#c=email&amp;t=");
      expect(body.Text).toContain("https://play.example.test/masuk#c=email&t=");
      for (const order of burst.slice(0, 5)) expect(await mailTo(order.email)).toHaveLength(1);
      // The WhatsApp side (the delay was 0) goes out on its own queue, one number's gap (3-9 s) and its human-like pauses at a time: it never held
      // the e-mails back above, it is the short opener (no file), and no order is written to twice.
      const firstWa = first(await sql<{ id: string }[]>`SELECT id FROM deliveries WHERE order_id = ${orders[0]?.id ?? ""} AND channel = 'whatsapp'`).id;
      await waitFor("the first WhatsApp opener", async () => (await openerStatus(firstWa)) === "sent", 40_000, 100);
      expect(waha.sent.filter((s) => s.kind === "file")).toEqual([]);
      const texts = waha.sent.filter((s) => s.kind === "text");
      expect(new Set(texts.map((t) => t.chatId)).size).toBe(texts.length);
      expect((await deliveryOf(firstWa)).status).toBe("pending");
    } finally {
      await running.stop();
    }
    await sql`UPDATE app_settings SET value = '180'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
  }, 180_000);
});

describe("the proactive WhatsApp delay is an admin setting (AC-D8)", () => {
  /** The delay the PAID effects schedule the WhatsApp delivery with (US-033: public.proactive_delay_ms), as the worker's login. */
  const proactiveDelayMs = async (db: typeof stubPool, fallbackMs: number): Promise<number> =>
    Number(first(await db<{ ms: string }[]>`SELECT public.proactive_delay_ms(${fallbackMs})::text AS ms`).ms);

  it("reads delivery.wa_delay_seconds when an order is paid (default 3 minutes, 0 = at once), the env value only as the fallback", async () => {
    await sql`UPDATE app_settings SET value = '180'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
    try {
      expect(await proactiveDelayMs(stubPool, 999)).toBe(180_000);
      await sql`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
      expect(await proactiveDelayMs(stubPool, 999)).toBe(0);
      await sql`UPDATE app_settings SET value = '86400'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
      expect(await proactiveDelayMs(stubPool, 999)).toBe(86_400_000);
      await sql`DELETE FROM app_settings WHERE key = 'delivery.wa_delay_seconds'`;
      expect(await proactiveDelayMs(stubPool, 777)).toBe(777);
    } finally {
      await sql`INSERT INTO app_settings (key, value) VALUES ('delivery.wa_delay_seconds', '180') ON CONFLICT (key) DO UPDATE SET value = '180'::jsonb`;
    }
    expect(await proactiveDelayMs(stubPool, 999)).toBe(180_000);
  });
});

describe("through the queue and the relay", () => {
  async function run<T>(body: () => Promise<T>, env: Record<string, string> = {}): Promise<T> {
    const config = loadWorkerConfig(workerEnv(uniquePrefix(), { WORKER_SWEEP_INTERVAL_MS: "600000", WORKER_RECONCILE_INTERVAL_MS: "600000", ...env }));
    const running = await startWorker(config, { payments: { midtrans: midtrans.source, waDelayMs: 180_000 }, deliveries: deliveryPorts() }, createLogger({ level: "silent", role: "worker" }));
    try {
      return await body();
    } finally {
      await running.stop();
    }
  }

  it("a killed session fails over to another number at once, through the queue, without waiting for a sweep", async () => {
    await sql`UPDATE app_settings SET value = '0'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
    const dead = await createSession({ weight: 9 });
    const alive = await createSession({ weight: 1 });
    const before = waha.sent.length;
    await sql`UPDATE waha_sessions SET status_at = now() - interval '2 minutes' WHERE id = ANY(${[dead.id, alive.id]}::uuid[])`;
    try {
      await run(async () => {
        // WAHA stops the session after the worker's first status poll: the pool still believes it is WORKING (the next poll is far off).
        await waitFor("the first status poll", async () => (await sql`SELECT 1 FROM waha_sessions WHERE id = ANY(${[dead.id, alive.id]}::uuid[]) AND status_at > now() - interval '1 minute'`).length === 2, 20_000, 50);
        await waha.status(dead.name, "STOPPED");
        const order = await settle();
        await waitFor("the failover opener", async () => (await sql`SELECT 1 FROM delivery_openers o JOIN deliveries d ON d.id = o.delivery_id WHERE d.order_id = ${order.id} AND d.channel = 'whatsapp' AND o.status = 'sent'`).length === 1, 30_000, 50);
        const row = first(await sql<{ id: string }[]>`SELECT id FROM deliveries WHERE order_id = ${order.id} AND channel = 'whatsapp'`);
        const opener = first(await sql<{ status: string; attempts: number; session_id: string; tried_session_ids: string[] }[]>`SELECT status, attempts, session_id, tried_session_ids FROM delivery_openers WHERE delivery_id = ${row.id}`);
        expect(opener).toMatchObject({ status: "sent", attempts: 2, session_id: alive.id, tried_session_ids: [dead.id, alive.id] });
        // One opener in all, from the number that works; the delivery itself waits for the buyer's reply.
        expect(waha.sent.slice(before).filter((s) => s.kind === "text")).toEqual([expect.objectContaining({ session: alive.name })]);
        expect((await deliveryOf(row.id)).status).toBe("pending");
      });
    } finally {
      await waha.status(dead.name, "WORKING");
      await sql`UPDATE app_settings SET value = '180'::jsonb WHERE key = 'delivery.wa_delay_seconds'`;
    }
  }, 90_000);

  it("a buyer-first message is answered through the outbox relay: the PDF goes back to the buyer, and the proactive send finds the row claimed", async () => {
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 3_600_000) });
    const messageId = await waha.inbound({ session: session.name, chatId: order.chatId, body: `Halo, ini kode pesanan saya ${order.code}` });
    const before = waha.sent.length;
    await run(async () => {
      const stored = await storeInbound({ sessionName: session.name, messageId, fromJid: order.chatId });
      await waitFor("the reply", async () => (await sql`SELECT 1 FROM waha_inbound WHERE id = ${stored.inboundId} AND processed_at IS NOT NULL`).length === 1, 30_000, 50);
      expect((await sql<{ outcome: string }[]>`SELECT outcome FROM waha_inbound WHERE id = ${stored.inboundId}`)[0]?.outcome).toBe("delivered");
    });
    expect(waha.sent.slice(before).filter((s) => s.kind === "file")).toEqual([expect.objectContaining({ chatId: order.chatId, session: session.name })]);
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("sent");
  }, 60_000);

  it("the minute sweeper picks up what the pool deferred (a number that comes back) and settles an unknown PDF reply from the number's messages", async () => {
    const order = await paidOrder(shop);
    // No number yet: the first job defers; the sweeper (300 ms here) comes back for the row once a number exists.
    await run(
      async () => {
        await waitFor("a deferral", async () => (await sql`SELECT 1 FROM alerts WHERE kind = 'wa_pool_empty' AND resolved_at IS NULL`).length >= 1, 20_000, 50);
        expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("pending");
        const session = await createSession();
        await waitFor("the sweep", async () => (await openerStatus(order.deliveries.whatsapp)) === "sent", 30_000, 100);
        expect((await sql<{ session_id: string }[]>`SELECT session_id FROM delivery_openers WHERE delivery_id = ${order.deliveries.whatsapp}`)[0]?.session_id).toBe(session.id);

        // An unknown PDF reply whose message the number DID send: the sweep's lookup settles it, with no second message.
        await retireSessions();
        const flaky = await createSession();
        waha.fault(flaky.name, "timeout_after_send");
        const other = await paidOrder(shop, { waNotBefore: new Date(Date.now() + 3_600_000) });
        const messageId = await waha.inbound({ session: flaky.name, chatId: other.chatId, body: `Halo, ini kode pesanan saya ${other.code}` });
        await storeInbound({ sessionName: flaky.name, messageId, fromJid: other.chatId });
        await waitFor("the unknown", async () => (await deliveryOf(other.deliveries.whatsapp)).status === "unknown", 30_000, 100);
        waha.fault(flaky.name, undefined);
        const sentBefore = waha.sent.filter((s) => s.kind === "file" && s.chatId === other.chatId).length;
        await sql`UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = ${other.deliveries.whatsapp}`;
        await waitFor("the lookup", async () => (await deliveryOf(other.deliveries.whatsapp)).status === "sent", 30_000, 100);
        expect(waha.sent.filter((s) => s.kind === "file" && s.chatId === other.chatId)).toHaveLength(sentBefore);
      },
      { WORKER_SWEEP_INTERVAL_MS: "300", WORKER_SESSION_POLL_INTERVAL_MS: "600000" },
    );
  }, 120_000);
});
