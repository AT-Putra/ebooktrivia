// The customer-service (CS) contact in what the worker says (Owner decision 2026-11-24), against PostgreSQL as the worker_rw login and the in-process
// WAHA mock, through the real inbound path and the real delivery:
//   - four fixed replies (mismatch, generic, not_available, needs_help) carry the CS line when a contact is set and are EXACTLY the old texts when none is;
//   - the contact is read when the reply is built: a change in the console is used by the next reply, with no restart;
//   - a failing read never blocks the reply: it goes out as it was;
//   - the line holds no order or buyer data, and no link;
//   - {cs_whatsapp} and {cs_email} reach the delivery WhatsApp caption and the delivery e-mail, empty when nothing is set.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { replyText } from "../src/delivery/messages.ts";
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
  unpaidOrder,
} from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
import { sql } from "./support/db.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(8);
let shop: DeliveryShop;
const shops: DeliveryShop[] = [];

const CS = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };
/** The {cs} of the replies: the dots of the hours are U+2024 (look-alike dots), so no part of it can become a link. */
const LINE = "WhatsApp 0812-3456-7890 atau email cs@contoh.id (Senin–Jumat 09\u202400–17\u202400 WIB)";

const setCs = async (contact: { whatsapp: string | null; email: string | null; hours: string | null }): Promise<void> => {
  await sql`DELETE FROM cs_contact`;
  await sql`INSERT INTO cs_contact (id, whatsapp, email, hours) VALUES (1, ${contact.whatsapp}, ${contact.email}, ${contact.hours})`;
};
const noCs = async (): Promise<void> => {
  await sql`DELETE FROM cs_contact`;
};

beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
  await noCs();
  shop = await createDeliveryShop();
  shops.push(shop);
});
afterAll(async () => {
  await noCs();
  await retireSessions();
  await retireDeliveries();
  await Promise.all(shops.map((s) => s.cleanup()));
});

function rig() {
  const waha = createWahaFake();
  const mail = recordingMail();
  const magic = fakeMagicLinks();
  const config = deliveryConfig(shop);
  const delivery: Delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail,
    files: testFiles(config),
    magicLinks: magic,
    enqueue: () => Promise.resolve(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files: testFiles(config), random: () => 0.5, sleep: () => Promise.resolve() });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  async function hear(input: { session: string; chatId: string; body: string }) {
    const messageId = await waha.inbound({ session: input.session, chatId: input.chatId, body: input.body });
    const stored = await storeInbound({ sessionName: input.session, messageId, fromJid: input.chatId });
    return { ...stored, run: () => process({ id: stored.outboxId }) };
  }
  const texts = () => waha.sent.filter((s) => s.kind === "text");
  return { waha, mail, magic, delivery, hear, texts };
}

const asking = (code: string): string => `Halo, ini kode pesanan saya ${code} untuk Ebook.`;
const later = (): Date => new Date(Date.now() + 180_000);
/** A sender of its own per use: a reply to the same chat within the hour is skipped, whichever file sent it. */
const stranger = (): string => `${uniquePhone().slice(1)}@c.us`;

describe("the four fixed replies", () => {
  it("mismatch: another number than the buyer's gets the old text plus the CS line, with the line made of the CS contact only", async () => {
    await setCs(CS);
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const heard = await r.hear({ session: session.name, chatId: stranger(), body: asking(order.code) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch", replied: true });
    const text = r.texts()[0]?.text ?? "";
    expect(text).toBe(replyText("mismatch", CS));
    expect(text).toBe(`${replyText("mismatch")} Jika Anda pembeli pesanan ini, hubungi CS kami di ${LINE} dengan menyebut kode pesanan.`);
    // No order or buyer data, no link: a stranger learns nothing from it.
    for (const secret of [order.code, order.phone, order.phone.slice(-4), order.name, order.email]) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(/https?:|wa\.me|mailto:/i);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("generic: a sender nobody could confirm gets the old text plus the CS line", async () => {
    await setCs(CS);
    const r = rig();
    const session = await createSession();
    const unpaid = await unpaidOrder(shop);
    const lid = `${String(70_000_000_000_000 + Math.floor(Math.random() * 9_000_000_000_000))}@lid`;
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: asking(unpaid.code) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_generic", replied: true });
    expect(r.texts()).toEqual([expect.objectContaining({ chatId: lid, text: `${replyText("generic")} Butuh bantuan? Hubungi CS kami di ${LINE}.` })]);
  });

  it("not_available and needs_help: a verified buyer is told to contact CS instead of 'the organiser'", async () => {
    await setCs(CS);
    const r = rig();
    const session = await createSession();
    const refunded = await paidOrder(shop);
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE order_id = ${refunded.orderId}`;
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refunded.orderId}`;
    const refundedHeard = await r.hear({ session: session.name, chatId: refunded.chatId, body: asking(refunded.code) });
    await refundedHeard.run();
    expect(await inboundOf(refundedHeard.inboundId)).toMatchObject({ outcome: "text_not_available", replied: true });
    expect(r.texts().at(-1)?.text).toBe(`Pesanan ini tidak dapat kami proses lewat chat. Silakan hubungi CS kami di ${LINE}.`);

    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const failed = await paidOrder(shop, { waNotBefore: later() });
    await sql`UPDATE deliveries SET status = 'failed', attempts = 1 WHERE id = ${failed.deliveries.whatsapp}`;
    const failedHeard = await r.hear({ session: session.name, chatId: failed.chatId, body: asking(failed.code) });
    await failedHeard.run();
    expect(await inboundOf(failedHeard.inboundId)).toMatchObject({ outcome: "text_needs_help", replied: true });
    expect(r.texts().at(-1)?.text).toBe(`Ebook belum bisa kami kirim lewat WhatsApp. Silakan cek email Anda atau hubungi CS kami di ${LINE}.`);
  });

  it("with no CS contact set, every one of them is exactly the text it was before", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const mismatch = await r.hear({ session: session.name, chatId: stranger(), body: asking(order.code) });
    await mismatch.run();
    expect(r.texts().at(-1)?.text).toBe("Nomor ini tidak sama dengan nomor pembeli pesanan tersebut, jadi ebook tidak kami kirim ke sini. Ebook dikirim otomatis ke nomor pembeli.");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const lid = `${String(80_000_000_000_000 + Math.floor(Math.random() * 9_000_000_000_000))}@lid`;
    await r.waha.lid(lid, null);
    const unpaid = await unpaidOrder(shop);
    const generic = await r.hear({ session: session.name, chatId: lid, body: asking(unpaid.code) });
    await generic.run();
    expect(r.texts().at(-1)?.text).toBe("Pesan Anda sudah kami terima. Jika Anda pembeli, ebook dikirim otomatis ke nomor WhatsApp dan email yang Anda isi saat membeli.");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const refunded = await paidOrder(shop);
    await sql`UPDATE deliveries SET status = 'cancelled' WHERE order_id = ${refunded.orderId}`;
    await sql`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refunded.orderId}`;
    const notAvailable = await r.hear({ session: session.name, chatId: refunded.chatId, body: asking(refunded.code) });
    await notAvailable.run();
    expect(r.texts().at(-1)?.text).toBe("Pesanan ini tidak dapat kami proses lewat chat. Silakan hubungi penyelenggara.");
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const failed = await paidOrder(shop, { waNotBefore: later() });
    await sql`UPDATE deliveries SET status = 'failed', attempts = 1 WHERE id = ${failed.deliveries.whatsapp}`;
    const needsHelp = await r.hear({ session: session.name, chatId: failed.chatId, body: asking(failed.code) });
    await needsHelp.run();
    expect(r.texts().at(-1)?.text).toBe("Ebook belum bisa kami kirim lewat WhatsApp. Silakan cek email Anda atau hubungi penyelenggara.");
    // Hours alone are no contact either.
    await setCs({ whatsapp: null, email: null, hours: "Setiap hari" });
    await sql`UPDATE waha_sessions SET next_send_at = NULL`;
    const again = await r.hear({ session: session.name, chatId: stranger(), body: asking(order.code) });
    await again.run();
    expect(r.texts().at(-1)?.text).toBe(replyText("mismatch"));
  });

  it("reads the contact when the reply is built: a change in the console is used by the next reply, no restart, and the parts that are set are the ones named", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    const hearOnce = async () => {
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const heard = await r.hear({ session: session.name, chatId: stranger(), body: asking(order.code) });
      await heard.run();
      return r.texts().at(-1)?.text ?? "";
    };
    await setCs({ whatsapp: "+6281234567890", email: null, hours: null });
    expect(await hearOnce()).toContain("hubungi CS kami di WhatsApp 0812-3456-7890 dengan menyebut kode pesanan.");
    await setCs({ whatsapp: null, email: "cs@contoh.id", hours: "Setiap hari" });
    expect(await hearOnce()).toContain("hubungi CS kami di email cs@contoh.id (Setiap hari) dengan menyebut kode pesanan.");
    await noCs();
    expect(await hearOnce()).toBe(replyText("mismatch"));
  });

  it("a CS read that fails never blocks the reply: it goes out as it was", async () => {
    await setCs(CS);
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: later() });
    // The worker may not read the table now (what a broken grant or a database fault looks like to the read).
    await sql`REVOKE SELECT (whatsapp, email, hours) ON public.cs_contact FROM worker_rw`;
    try {
      const heard = await r.hear({ session: session.name, chatId: stranger(), body: asking(order.code) });
      await heard.run();
      expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "text_mismatch", replied: true });
      expect(r.texts().at(-1)?.text).toBe(replyText("mismatch"));
    } finally {
      await sql`GRANT SELECT (whatsapp, email, hours) ON public.cs_contact TO worker_rw`;
    }
  });
});

describe("{cs_whatsapp} and {cs_email} in the delivery texts", () => {
  const original = new Map<string, string>();
  async function useCsInTemplates(): Promise<void> {
    for (const channel of ["whatsapp", "email"] as const) {
      const [row] = await sql<{ body: string }[]>`SELECT body FROM message_templates WHERE key = 'delivery' AND channel = ${channel} AND locale = 'id'`;
      original.set(channel, row?.body ?? "");
      const extra = channel === "whatsapp" ? "\nCS: {cs_whatsapp} / {cs_email}." : "<p>CS: {cs_whatsapp} / {cs_email}.</p>";
      await sql`UPDATE message_templates SET body = ${(row?.body ?? "") + extra} WHERE key = 'delivery' AND channel = ${channel} AND locale = 'id'`;
    }
  }
  async function restoreTemplates(): Promise<void> {
    for (const [channel, body] of original) await sql`UPDATE message_templates SET body = ${body} WHERE key = 'delivery' AND channel = ${channel} AND locale = 'id'`;
    original.clear();
  }

  it("put the Owner's number (with dashes) and address in the PDF's caption and in the e-mail, and nothing when none is set", async () => {
    await useCsInTemplates();
    try {
      const r = rig();
      const session = await createSession();
      await setCs(CS);
      const order = await paidOrder(shop, { waNotBefore: later() });
      const heard = await r.hear({ session: session.name, chatId: order.chatId, body: asking(order.code) });
      await heard.run();
      expect(r.waha.sent.filter((s) => s.kind === "file")[0]?.text).toContain("CS: 0812-3456-7890 / cs@contoh.id.");
      expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
      expect(r.mail.sent[0]?.html).toContain("CS: 0812-3456-7890 / cs@contoh.id.");
      expect(r.mail.sent[0]?.text).toContain("CS: 0812-3456-7890 / cs@contoh.id.");

      await noCs();
      await sql`UPDATE waha_sessions SET next_send_at = NULL`;
      const second = await paidOrder(shop, { waNotBefore: later() });
      const heardAgain = await r.hear({ session: session.name, chatId: second.chatId, body: asking(second.code) });
      await heardAgain.run();
      expect(r.waha.sent.filter((s) => s.kind === "file")[1]?.text).toContain("CS:  / .");
      expect(await r.delivery.process({ id: second.deliveries.email })).toBe("sent");
      expect(r.mail.sent[1]?.html).toContain("CS:  / .");
    } finally {
      await restoreTemplates();
    }
  });
});
