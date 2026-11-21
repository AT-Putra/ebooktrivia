// US-025 on US-026, end to end: a PAID order is delivered by e-mail, and by WhatsApp once the buyer replies to the short opener (Owner decision D7: the
// opener carries no link), through the REAL login-link issuer (delivery/magic-links.ts:
// core issueMagicLink, issue_magic_link as worker_rw, core magicLinkUrl), and the links that went out are used the way a buyer uses them: US-026's confirm
// route (POST /api/v1/play/auth/magic-link, imported from apps/public, over a public_rw login, the real Valkey and the real Better Auth instance)
// accepts each exactly once, and refuses it on the other channel and on replay. The only fakes are the WhatsApp and SMTP transports.
import { randomBytes, randomInt } from "node:crypto";
import { hashMagicLinkToken, parseMagicLinkFragment } from "@ebooktrivia/core";
import { createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import { createDatabaseMagicLinks } from "../src/delivery/magic-links.ts";
import { MagicLinkUnavailable } from "../src/delivery/ports.ts";
import { capProviders } from "../../public/src/lib/cap-routes.ts";
import { createPlayAuth } from "../../public/src/lib/play/auth.ts";
import { createPlayDb } from "../../public/src/lib/play/db.ts";
import { handleMagicLink, loadOtpSettings, type PlayDeps } from "../../public/src/lib/play/handlers.ts";
import { createValkey, type Valkey } from "../../public/src/lib/valkey.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import { createDeliveryShop, createSession, createWahaFake, type DeliveryShop, deliveryConfig, deliveryOf, paidOrder, recordingMail, retireDeliveries, retireSessions, storeInbound, type WahaFake } from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
import { first, sql } from "./support/db.ts";
import { silentLog, workerPool } from "./support/midtrans.ts";

const workerSql = workerPool(8);
const publicSql = postgres(inject("publicDbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
const playDb = createPlayDb(inject("publicDbUrl"));
const PLAY_ORIGIN = "https://play.example.test";
const messaging = generateScopeKeyPair();
let valkey: Valkey;
let play: PlayDeps;
let shop: DeliveryShop;

beforeAll(async () => {
  const url = new URL(inject("valkeyUrl"));
  valkey = createValkey({ host: url.hostname, port: Number(url.port === "" ? "6379" : url.port), db: 0, username: inject("valkeyPublicUsername"), password: inject("valkeyPublicPassword"), tls: false });
  await valkey.connect();
  const pepper = randomBytes(32);
  play = {
    sql: publicSql,
    valkey,
    auth: createPlayAuth({
      config: { playOrigin: PLAY_ORIGIN, playerAuthSecrets: [{ version: 1, value: randomBytes(32).toString("hex") }], otpPepper: pepper },
      sql: publicSql,
      db: playDb.db,
      log: () => undefined,
      maxAttempts: async () => (await loadOtpSettings(publicSql))["otp.max_attempts"],
    }),
    capFor: capProviders(valkey, randomBytes(32)),
    sealer: createSecretSealer({ messaging: messaging.publicKey }),
    otpPepper: pepper,
    playOrigin: PLAY_ORIGIN,
    log: () => undefined,
    defer: () => undefined,
  };
});
beforeEach(async () => {
  await retireSessions();
  await retireDeliveries();
  shop = await createDeliveryShop();
});
afterAll(async () => {
  valkey.disconnect();
  await Promise.all([workerSql.end({ timeout: 5 }), publicSql.end({ timeout: 5 }), playDb.close(), shop.cleanup()]);
});

const freshIp = (): string => `2001:db8:${randomInt(1, 0xffff).toString(16)}:${randomInt(1, 0xffff).toString(16)}::1`;
/** What the confirm page POSTs when the buyer clicks the button. */
const confirm = (channel: string, token: string): Promise<Response> =>
  handleMagicLink(
    play,
    new Request(`${PLAY_ORIGIN}/api/v1/play/auth/magic-link`, {
      method: "POST",
      headers: { origin: PLAY_ORIGIN, "content-type": "application/json", "x-forwarded-for": freshIp(), "user-agent": "delivery-login-int/1.0" },
      body: JSON.stringify({ channel, token }),
    }),
  );
/** The login link inside a message, found the way a buyer finds it: by its address. */
function linkIn(text: string): { readonly channel: string; readonly token: string; readonly url: string } {
  const found = /https:\/\/play\.example\.test\/masuk#[^\s"'<>)]+/.exec(text.replaceAll("&amp;", "&"));
  if (found === null) throw new Error("no login link in the message");
  const parsed = parseMagicLinkFragment(new URL(found[0]).hash);
  if (parsed === null) throw new Error("the login link is malformed");
  return { ...parsed, url: found[0] };
}

/** The buyer writes to a number (with the order code): the buyer-first path claims the delivery and answers with the PDF and the link. */
async function buyerReplies(delivery: Delivery, waha: WahaFake, order: { readonly chatId: string; readonly code: string }, sessionName: string): Promise<void> {
  const config = deliveryConfig(shop);
  const consumer = createInboundConsumer({ sql: workerSql, log: silentLog, config, waha: waha.access, delivery, files: testFiles(config), random: () => 0 });
  const heard = await storeInbound({ sessionName, messageId: await waha.inbound({ session: sessionName, chatId: order.chatId, body: `Halo, kode pesanan saya ${order.code}` }), fromJid: order.chatId });
  await createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: heard.outboxId });
}

describe("the links the deliveries send are the links US-026 accepts", () => {
  it("PAID: the e-mail carries a login link, the WhatsApp PDF reply another; each logs the buyer in once, and only on its own channel", async () => {
    const waha = createWahaFake();
    const mail = recordingMail();
    const session = await createSession();
    const config = deliveryConfig(shop);
    const delivery = createDelivery({
      sql: workerSql,
      log: silentLog,
      config,
      waha: waha.access,
      mail,
      files: testFiles(config),
      magicLinks: createDatabaseMagicLinks({ sql: workerSql, playOrigin: PLAY_ORIGIN }),
      enqueue: () => Promise.resolve(),
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    const order = await paidOrder(shop);
    expect(await delivery.process({ id: order.deliveries.email })).toBe("sent");
    // WhatsApp: the opener has no link; the buyer's reply to it is answered with the PDF and the link.
    expect(await delivery.process({ id: order.deliveries.whatsapp })).toBe("opened");
    expect(waha.sent[0]?.text).not.toContain("masuk");
    expect(await sql`SELECT 1 FROM magic_links WHERE player_id = ${order.playerId} AND channel = 'whatsapp'`).toHaveLength(0);
    await buyerReplies(delivery, waha, order, session.name);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "sent" });
    expect(waha.sent).toHaveLength(2);

    // Both messages carry a link on the play origin, with the channel they went out on, and the two tokens differ.
    const emailLink = linkIn(mail.sent[0]?.html ?? "");
    const emailTextLink = linkIn(mail.sent[0]?.text ?? "");
    const whatsappLink = linkIn(waha.sent[1]?.text ?? "");
    expect(emailLink.channel).toBe("email");
    expect(emailTextLink).toEqual(emailLink);
    expect(whatsappLink.channel).toBe("whatsapp");
    expect(whatsappLink.token).not.toBe(emailLink.token);
    // The database holds the hash only, with the 72 hours it set itself, one live link per player and channel.
    const stored = await sql<{ channel: string; hours: number; hash: string }[]>`
      SELECT channel, round(extract(epoch FROM expires_at - created_at) / 3600)::int AS hours, encode(token_hash, 'hex') AS hash
        FROM magic_links WHERE player_id = ${order.playerId} AND consumed_at IS NULL ORDER BY channel`;
    expect(stored.map((r) => [r.channel, r.hours, r.hash])).toEqual([
      ["email", 72, hashMagicLinkToken(emailLink.token)?.toString("hex")],
      ["whatsapp", 72, hashMagicLinkToken(whatsappLink.token)?.toString("hex")],
    ]);

    // The WhatsApp link, on the WRONG channel: refused, and it is not burnt by the attempt.
    const wrongChannel = await confirm("email", whatsappLink.token);
    expect(wrongChannel.status).toBeGreaterThanOrEqual(400);
    expect(wrongChannel.headers.getSetCookie()).toEqual([]);
    // On its own channel: the buyer is logged in (a session cookie), once.
    const accepted = await confirm("whatsapp", whatsappLink.token);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.getSetCookie().some((c) => c.startsWith("__Host-play_session="))).toBe(true);
    expect(await accepted.json()).toMatchObject({ ok: true });
    // The replay: refused, no cookie.
    const replay = await confirm("whatsapp", whatsappLink.token);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.headers.getSetCookie()).toEqual([]);
    // The e-mail link is a separate token: it works once too, and not on WhatsApp's channel.
    expect((await confirm("whatsapp", emailLink.token)).status).toBeGreaterThanOrEqual(400);
    expect((await confirm("email", emailLink.token)).status).toBe(200);
    expect((await confirm("email", emailLink.token)).status).toBeGreaterThanOrEqual(400);
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM magic_links WHERE player_id = ${order.playerId} AND consumed_at IS NOT NULL`).n).toBe(2);
  });

  it("a retried reply supersedes the link of the attempt that failed: only the link in the message that went out works", async () => {
    const waha = createWahaFake();
    const first_ = await createSession({ weight: 5 });
    const second = await createSession();
    waha.fault(first_.name, "unauthorized");
    const config = deliveryConfig(shop);
    const delivery = createDelivery({
      sql: workerSql,
      log: silentLog,
      config,
      waha: waha.access,
      mail: recordingMail(),
      files: testFiles(config),
      magicLinks: createDatabaseMagicLinks({ sql: workerSql, playOrigin: PLAY_ORIGIN }),
      enqueue: () => Promise.resolve(),
      random: () => 0,
      sleep: () => Promise.resolve(),
    });
    const order = await paidOrder(shop);
    // The buyer writes to the first number, which refuses (its link never reached the buyer); they write to the second, which sends: the delivery went
    // out with the SECOND link.
    await buyerReplies(delivery, waha, order, first_.name);
    expect(await deliveryOf(order.deliveries.whatsapp)).toMatchObject({ status: "pending", attempts: 1 });
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM magic_links WHERE player_id = ${order.playerId} AND channel = 'whatsapp' AND consumed_at IS NULL`).n).toBe(1);
    await buyerReplies(delivery, waha, order, second.name);
    expect((await deliveryOf(order.deliveries.whatsapp)).status).toBe("sent");
    expect(waha.sent).toHaveLength(1);
    const live = linkIn(waha.sent[0]?.text ?? "");
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM magic_links WHERE player_id = ${order.playerId} AND channel = 'whatsapp' AND consumed_at IS NULL`).n).toBe(1);
    expect((await confirm("whatsapp", live.token)).status).toBe(200);
  });
});

describe("the issuer", () => {
  it("refuses a player who may not log in (anonymized, or no eligible program) without keeping anything of the database's message", async () => {
    const issuer = createDatabaseMagicLinks({ sql: workerSql, playOrigin: PLAY_ORIGIN });
    const order = await paidOrder(shop);
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${order.playerId}`;
    const refused = await issuer.issue({ playerId: order.playerId, channel: "whatsapp" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MagicLinkUnavailable);
    expect((refused as Error).message).not.toContain(order.playerId);
    expect(await sql`SELECT 1 FROM magic_links WHERE player_id = ${order.playerId}`).toHaveLength(0);
    await sql`UPDATE player_programs SET eligible = true WHERE player_id = ${order.playerId}`;
    const url = await issuer.issue({ playerId: order.playerId, channel: "email" });
    expect(url).toMatch(/^https:\/\/play\.example\.test\/masuk#c=email&t=[A-Za-z0-9_-]{43}$/);
  });
});
