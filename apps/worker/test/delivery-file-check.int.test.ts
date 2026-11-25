// US-005 R11 (Owner ruling on finding 3): WAHA's WEBJS does NOT refuse a file URL it cannot fetch. It takes the answer page (a 404's HTML) as the document, sends it under the
// requested file name and answers 201, so a send that "worked" can put a garbage "ebook" in the buyer's chat. Two checks on our side (src/delivery/file-check.ts):
//   (a) before EVERY sendFile the worker fetches the first bytes of its own signed URL: 200, application/pdf, the stored Content-Length, the %PDF magic bytes. Anything else and
//       nothing is sent: not_attempted `file_unavailable`, a persisted alert, no penalty for the number, the e-mail untouched;
//   (b) after a sendFile the message is read back and the size WAHA delivered (WEBJS _data.size) is compared with the stored file's: a wrong size marks the delivery
//       `delivered_wrong_file` (it stays `sent`: it is never resent by itself) and alerts the Owner; a missing size is not an error.
// Against PostgreSQL as worker_rw and infra/waha-mock in its "webjs" mode (the 404-page behaviour recorded in docs/spikes/R11.md).
import { verifyFileUrl } from "@ebooktrivia/adapters";
import { HUMAN_MAX_MS } from "@ebooktrivia/core";
import { randomInt } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createDeliveryShop, createSession, createWahaFake, type DeliveryShop, deliveryConfig, deliveryOf, fakeMagicLinks, inboundOf, paidOrder, recordingMail, retireDeliveries, retireSessions, storeInbound } from "./support/delivery.ts";
import { type FileServer, fileServer, type FileServerMode, testFiles } from "./support/files.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PREFLIGHT_TIMEOUT_MS, READBACK_TIMEOUT_MS } from "../src/delivery/config.ts";

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

/** What WAHA itself gets when it downloads the URL: the stored PDF, or (to break it between the pre-flight and WAHA's fetch) an error page. */
type WahaDownload = "pdf" | "not_found_page";

function rig(options: { download?: WahaDownload; clock?: () => number; onDownload?: () => void } = {}) {
  const config = deliveryConfig(shop);
  const download = options.download ?? "pdf";
  const clock = options.clock === undefined ? {} : { clock: options.clock };
  const waha = createWahaFake({
    files: {
      fetch: async (input) => {
        const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        // (The mock also posts its webhooks through this fetch: only the download of the file is WAHA's slow send.)
        if (new URL(href).pathname.startsWith("/files/")) options.onDownload?.();
        if (download === "not_found_page") return new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });
        return new Response(await readFile(join(config.dataDir, new URL(href).pathname.replace(/^\/files\//, ""))), { status: 200, headers: { "content-type": "application/pdf" } });
      },
    },
  });
  const server: FileServer = fileServer(config.dataDir);
  const files = testFiles(config, server);
  const mail = recordingMail();
  const delivery: Delivery = createDelivery({ sql: workerSql, log: silentLog, config, waha: waha.access, mail, files, magicLinks: fakeMagicLinks(), enqueue: () => Promise.resolve(), random: () => 0.5, sleep: () => Promise.resolve(), ...clock });
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files, random: () => 0.5, sleep: () => Promise.resolve(), ...clock });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  async function hear(input: { session: string; chatId: string; body: string }) {
    const messageId = await waha.inbound({ session: input.session, chatId: input.chatId, body: input.body });
    const stored = await storeInbound({ sessionName: input.session, messageId, fromJid: input.chatId });
    return { ...stored, messageId, run: () => process({ id: stored.outboxId }) };
  }
  return { waha, server, config, mail, delivery, hear, files: () => waha.sent.filter((s) => s.kind === "file") };
}

const proactiveLater = (): Date => new Date(Date.now() + 180_000);
/** A sender that no earlier test of this database answered (a sender gets one extra reply an hour). */
const freshLid = (): string => `${randomInt(10_000_000_000_000, 99_999_999_999_999).toString()}@lid`;
const askingFor = (code: string): string => `Halo, ini kode pesanan saya ${code} untuk Ebook.`;
const alertsOf = (kind: string) => sql<{ severity: string; dedupe_key: string; payload: Record<string, unknown> }[]>`SELECT severity, dedupe_key, payload FROM alerts WHERE kind = ${kind} AND resolved_at IS NULL`;
const sessionHealth = async (id: string) => first(await sql<{ fail_streak: number; cooldown_until: Date | null }[]>`SELECT fail_streak, cooldown_until FROM waha_sessions WHERE id = ${id}`);

const BROKEN: readonly FileServerMode[] = ["not_found", "forbidden", "html_200", "wrong_type", "wrong_length", "no_length", "no_magic", "unreachable"];

describe("(a) the pre-flight: nothing is sent unless the signed URL answers the stored PDF", () => {
  it("a healthy route: the file is sent, and the pre-flight used a URL of its OWN (a 60 s expiry) so WAHA's URL (10 minutes) keeps its whole download allowance", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toHaveLength(1);
    expect(r.server.requested).toHaveLength(1);
    const preflight = r.server.requested[0];
    const wahaUrl = new URL(r.files()[0]?.url ?? "");
    expect(preflight?.path).toBe(wahaUrl.pathname);
    // Two different signed URLs of the same file: the route counts the downloads of ONE URL (cap 10), so the pre-flight cannot use up what WAHA's fetch needs.
    expect(preflight?.exp).not.toBe(wahaUrl.searchParams.get("exp"));
    // ... and even a URL that expires in the same second would be its own counter: every URL carries a random nonce the route keys the cap on (LOW-2).
    expect(preflight?.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(preflight?.nonce).not.toBe(wahaUrl.searchParams.get("n"));
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Number(preflight?.exp) - nowSeconds).toBeLessThanOrEqual(61);
    expect(Number(wahaUrl.searchParams.get("exp")) - nowSeconds).toBeGreaterThan(500);
    expect(verifyFileUrl({ path: wahaUrl.pathname, exp: wahaUrl.searchParams.get("exp"), sig: wahaUrl.searchParams.get("sig"), nonce: wahaUrl.searchParams.get("n"), key: r.config.fileUrlKey, now: new Date() }).ok).toBe(true);
    expect((await deliveryOf(order.deliveries.whatsapp)).last_error).toBeNull();
    expect((await alertsOf("delivery_wrong_file")).filter((a) => a.dedupe_key.includes(order.deliveries.whatsapp))).toEqual([]);
  });

  it.each(BROKEN)("route answer `%s`: the buyer-first PDF is NOT sent (not_attempted file_unavailable), the attempt is given back, the number is not penalised, a critical alert is persisted, the e-mail is untouched", async (mode) => {
    const r = rig();
    r.server.mode = mode;
    const session = await createSession();
    await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    // Held back on our side: the message is not done; it is tried again a minute later (inbound.ts PDF_RETRY_DELAYS_MS).
    expect(await heard.run()).toBe("deferred");
    expect(r.waha.sent).toEqual([]);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: null });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", last_error: "file_unavailable" });
    expect(await sessionHealth(session.id)).toMatchObject({ fail_streak: 0, cooldown_until: null });
    const alerts = (await alertsOf("delivery_not_attempted")).filter((a) => a.dedupe_key === "delivery_not_attempted:file_unavailable");
    expect(alerts).toEqual([expect.objectContaining({ severity: "critical", payload: { cause: "file_unavailable" } })]);
    // The e-mail path does not depend on the WhatsApp pre-flight: it still sends the PDF as an attachment.
    expect(await r.delivery.process({ id: order.deliveries.email })).toBe("sent");
    expect(r.mail.sent).toHaveLength(1);
  });

  it("the lease must cover the pre-flight, the human-like sequence, the send AND the read-back: a claim old enough for the old reserve only (1 s inside it) is not sent", async () => {
    const config = deliveryConfig(shop);
    // The first read is the claim, every later one is this late: inside the old limit (lease - request - HUMAN_MAX_MS - 1 s) by one second, outside the new one by the
    // pre-flight's and the read-back's budgets.
    const late = config.leaseMs - config.wahaTimeoutMs - HUMAN_MAX_MS - 2000;
    expect(late).toBeGreaterThan(config.leaseMs - config.wahaTimeoutMs - HUMAN_MAX_MS - PREFLIGHT_TIMEOUT_MS - READBACK_TIMEOUT_MS - 1000);
    let reads = 0;
    const r = rig({ clock: () => (reads++ === 0 ? 0 : late) });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(r.waha.sent).toEqual([]);
    expect(r.server.requested).toEqual([]);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", last_error: "claim_too_old" });
    expect(await sessionHealth(session.id)).toMatchObject({ fail_streak: 0, cooldown_until: null });
  });

  it("the route is fixed: the next attempt goes through (the broken answer was not remembered)", async () => {
    const r = rig();
    r.server.mode = "not_found";
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(r.waha.sent).toEqual([]);
    r.server.mode = "ok";
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second', lease_until = NULL WHERE id = ${order.deliveries.whatsapp}`;
    const again = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await again.run();
    expect(r.files().length).toBeGreaterThanOrEqual(1);
  });

  it("the D6 PDF-only reply to an unresolved @lid is not sent either, and the claim is given back", async () => {
    const r = rig();
    r.server.mode = "html_200";
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = freshLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order.code) });
    await heard.run();
    expect(r.waha.sent).toEqual([]);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "pdf_only_failed" });
    expect((await alertsOf("delivery_not_attempted")).map((a) => a.dedupe_key)).toContain("delivery_not_attempted:file_unavailable");
    expect(await sessionHealth(session.id)).toMatchObject({ fail_streak: 0 });
  });
});

describe("(b) the read-back: the delivered size against the stored file's", () => {
  it("the right file (WAHA downloaded the PDF): no mark and no alert", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", last_error: null });
    expect((await alertsOf("delivery_wrong_file")).filter((a) => a.dedupe_key.includes(order.deliveries.whatsapp))).toEqual([]);
  });

  it("a URL that stops answering between the pre-flight and WAHA's own fetch: WAHA delivers the 404 page, the delivery stays SENT but is marked delivered_wrong_file, a critical alert says the sizes, and nothing is resent", async () => {
    const r = rig({ download: "not_found_page" });
    const session = await createSession();
    await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    // It WAS sent (WAHA answered 201): the reply is recorded as delivered, never as a failure, and the number is healthy.
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toHaveLength(1);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", last_error: "delivered_wrong_file" });
    expect(await sessionHealth(session.id)).toMatchObject({ fail_streak: 0 });
    const stored = await readFile(join(r.config.dataDir, shop.storagePath));
    const alerts = (await alertsOf("delivery_wrong_file")).filter((a) => a.dedupe_key.includes(order.deliveries.whatsapp));
    expect(alerts).toEqual([expect.objectContaining({ severity: "critical", dedupe_key: `delivery_wrong_file:${order.deliveries.whatsapp}`, payload: expect.objectContaining({ expected_bytes: stored.byteLength, delivered_bytes: "<html>Not Found</html>".length }) as unknown })]);
    // Never resent by itself: the proactive job, a second reply and the sweeper find nothing to do, and no payload carries a phone, a name or a URL.
    await sql`UPDATE deliveries SET not_before = now() - interval '1 second' WHERE id = ${order.deliveries.whatsapp}`;
    expect(await r.delivery.process({ id: order.deliveries.whatsapp })).toBe("skipped");
    expect(r.files()).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toMatch(/https?:|\+62|@c\.us|@lid/);
    // The e-mail is a different channel and is untouched.
    expect((await deliveryOf(order.deliveries.email)).last_error).toBeNull();
  });

  it("the D6 PDF-only reply that arrives as a page is alerted too (it has no delivery row to mark)", async () => {
    const r = rig({ download: "not_found_page" });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const lid = freshLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order.code) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "pdf_only_sent" });
    expect((await alertsOf("delivery_wrong_file")).map((a) => a.dedupe_key)).toContain(`delivery_wrong_file:inbound:${heard.inboundId}`);
    // The buyer's own delivery row was never claimed by this extra send.
    expect((await deliveryOf(order.deliveries.whatsapp)).last_error).toBeNull();
  });

  it("the read-back is skipped when what is left of the lease cannot cover its budget (the sweeper may be about to take the row): a wrong file then goes unseen here, and the delivery is plainly sent", async () => {
    const config = deliveryConfig(shop);
    const time = { ms: 0 };
    // WAHA's own download is slow (the send used most of the lease): it ends with less than READBACK_TIMEOUT_MS (+ 1 s) of the lease left.
    const r = rig({ download: "not_found_page", clock: () => time.ms, onDownload: () => void (time.ms = config.leaseMs - READBACK_TIMEOUT_MS + 1500) });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(r.files()).toHaveLength(1);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", last_error: null });
    expect((await alertsOf("delivery_wrong_file")).filter((a) => a.dedupe_key.includes(order.deliveries.whatsapp))).toEqual([]);
  });

  it("... and it is made when the lease still covers it (the same slow send, with room for the read-back): the wrong file is marked", async () => {
    const config = deliveryConfig(shop);
    const time = { ms: 0 };
    const r = rig({ download: "not_found_page", clock: () => time.ms, onDownload: () => void (time.ms = config.leaseMs - READBACK_TIMEOUT_MS - 1500) });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    await heard.run();
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", last_error: "delivered_wrong_file" });
  });

  it("a stored PDF that is missing from the disk fails the PDF-only reply BEFORE anything is fetched or sent: not_sendable, the claim is given back (never a ledger `unknown`), the number is not penalised", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    await rm(join(r.config.dataDir, shop.storagePath));
    const lid = freshLid();
    await r.waha.lid(lid, null);
    const heard = await r.hear({ session: session.name, chatId: lid, body: askingFor(order.code) });
    await heard.run();
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "not_sendable" });
    expect(r.waha.sent).toEqual([]);
    expect(r.server.requested).toEqual([]);
    expect(await sql`SELECT outcome FROM waha_sends WHERE session_id = ${session.id}`).toEqual([]);
    expect(await sessionHealth(session.id)).toMatchObject({ fail_streak: 0, cooldown_until: null });
  });

  it("a size WAHA does not report is NOT an error: the delivery is simply sent (the plain mock answers no _data.size)", async () => {
    const config = deliveryConfig(shop);
    const waha = createWahaFake();
    const mail = recordingMail();
    const files = testFiles(config);
    const delivery = createDelivery({ sql: workerSql, log: silentLog, config, waha: waha.access, mail, files, magicLinks: fakeMagicLinks(), enqueue: () => Promise.resolve(), random: () => 0.5, sleep: () => Promise.resolve() });
    const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files, random: () => 0.5, sleep: () => Promise.resolve() });
    const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const messageId = await waha.inbound({ session: session.name, chatId: order.chatId, body: askingFor(order.code) });
    const stored = await storeInbound({ sessionName: session.name, messageId, fromJid: order.chatId });
    await process({ id: stored.outboxId });
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent", last_error: null });
    expect((await alertsOf("delivery_wrong_file")).filter((a) => a.dedupe_key.includes(order.deliveries.whatsapp))).toEqual([]);
  });
});
