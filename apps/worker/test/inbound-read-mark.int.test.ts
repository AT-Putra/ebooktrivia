// Every personal message that reaches the worker is marked as read when it is processed, whether or not it gets a reply (src/delivery/inbound.ts markRead; Owner rule,
// 2026-11-24: a number that answers some chats and leaves the older messages of others unread looks like a bot; WAHA "How to avoid blocking": send seen before processing
// the message). The whole chat is marked (sendSeen with no message ids), on the number the message arrived on, after a random reading pause, before the decision, and only
// for a message the re-fetch confirmed: never a forged one, one of ours, a group, a status or a channel. A failing mark never fails the job or stops the reply.
// Real PostgreSQL, the in-process WAHA mock of infra/waha-mock (it records the calls).
import { randomInt } from "node:crypto";
import { WahaAccessError } from "../src/delivery/ports.ts";
import type { WahaClient } from "@ebooktrivia/adapters";
import { HUMAN_TIMING } from "@ebooktrivia/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDelivery, type Delivery } from "../src/delivery/deliver.ts";
import { createInboundConsumer } from "../src/delivery/inbound.ts";
import type { WahaAccess } from "../src/delivery/ports.ts";
import { inertFailpoint } from "../src/failpoint.ts";
import { createLogger } from "../src/log.ts";
import { createOutboxProcessor } from "../src/outbox-consumer.ts";
import {
  createDeliveryShop,
  createSession,
  createWahaFake,
  type DeliveryShop,
  deliveryConfig,
  fakeMagicLinks,
  inboundOf,
  type PaidOrder,
  paidOrder,
  retireDeliveries,
  retireSessions,
  storeInbound,
} from "./support/delivery.ts";
import { testFiles } from "./support/files.ts";
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

/** A chat of its own per use: a reply to the same chat within the hour is skipped, whichever file sent it. */
const strangerChat = (): string => `${uniquePhone().slice(1)}@c.us`;
const newLid = (): string => `${String(randomInt(10_000_000_000_000, 99_999_999_999_999))}@lid`;
const askingFor = (order: Pick<PaidOrder, "code">): string => `Halo, ini kode pesanan saya ${order.code} untuk Ebook.`;
const proactiveLater = (): Date => new Date(Date.now() + 180_000);

/** The consumer under test over a WAHA mock the test can read: the waits it asks for are recorded, not waited out. */
function rig(options: { consumerWaha?: (fake: ReturnType<typeof createWahaFake>) => WahaAccess; sleep?: () => Promise<void>; humanRandom?: () => number; log?: ReturnType<typeof createLogger> } = {}) {
  const waha = createWahaFake();
  const config = deliveryConfig(shop);
  const waits: number[] = [];
  const delivery: Delivery = createDelivery({
    sql: workerSql,
    log: silentLog,
    config,
    waha: waha.access,
    mail: { send: () => Promise.resolve() },
    files: testFiles(config),
    magicLinks: fakeMagicLinks(),
    enqueue: () => Promise.resolve(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
  const consumer = createInboundConsumer({
    sql: workerSql,
    log: options.log ?? silentLog,
    config,
    waha: options.consumerWaha?.(waha) ?? waha.access,
    delivery,
    files: testFiles(config),
    random: () => 0.5,
    ...(options.humanRandom === undefined ? {} : { humanRandom: options.humanRandom }),
    sleep: (ms) => {
      waits.push(ms);
      return options.sleep === undefined ? Promise.resolve() : options.sleep();
    },
  });
  const process = createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog });
  async function hear(input: { session: string; chatId: string; body: string }) {
    const messageId = await waha.inbound(input);
    const stored = await storeInbound({ sessionName: input.session, messageId, fromJid: input.chatId });
    return { ...stored, messageId, run: () => process({ id: stored.outboxId }) };
  }
  /** The WAHA calls served so far, as `path[:presence]` (presence calls share one path per session). */
  const calls = async (): Promise<string[]> =>
    (await waha.callLog()).map((c) => `${c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence")}${typeof c.body["presence"] === "string" ? `:${c.body["presence"]}` : ""}`);
  return { waha, process, hear, calls, waits, files: () => waha.sent.filter((s) => s.kind === "file"), texts: () => waha.sent.filter((s) => s.kind === "text") };
}

describe("a message that gets no reply is marked as read all the same", () => {
  it("a message with no order code, from a stranger: the whole chat is marked on the number it arrived on, after a reading pause, and nothing is sent", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = strangerChat();
    await r.waha.clearCallLog();
    const heard = await r.hear({ session: session.name, chatId, body: "halo, ebooknya mana?" });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: true, outcome: "no_code" });
    // One seen call, of the whole chat (no message ids), as the receiving session; and no other call: no typing, no send.
    expect(await r.waha.callLog()).toEqual([{ method: "POST", path: "/api/sendSeen", body: { session: session.name, chatId } }]);
    expect(r.waha.sent).toEqual([]);
    // One reading pause before it, inside the human-like reading bounds.
    expect(r.waits).toHaveLength(1);
    expect(r.waits[0]).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0]);
    expect(r.waits[0]).toBeLessThanOrEqual(HUMAN_TIMING.reading[1]);
  });

  it("the reading pause is drawn from the human-like random source: it varies, and a test can drive it", async () => {
    const draw = async (humanRandom: () => number): Promise<number> => {
      const r = rig({ humanRandom });
      const session = await createSession();
      await (await r.hear({ session: session.name, chatId: strangerChat(), body: "halo" })).run();
      return r.waits[0] ?? 0;
    };
    expect(await draw(() => 0.5)).toBe(await draw(() => 0.5));
    expect(await draw(() => 0.5)).not.toBe(await draw(() => 0.97));
    const unseeded = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const r = rig();
      const session = await createSession();
      await (await r.hear({ session: session.name, chatId: strangerChat(), body: "halo" })).run();
      unseeded.add(r.waits[0] ?? 0);
    }
    expect(unseeded.size).toBeGreaterThan(4);
  });

  it("a code that belongs to no order, an @lid sender nobody can place, and a rate-limited stranger are marked too", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    const chatId = strangerChat();
    const unknown = await r.hear({ session: session.name, chatId, body: "kode saya 7K3M9XQ2PA" });
    await unknown.run();
    expect(await inboundOf(unknown.inboundId)).toMatchObject({ outcome: "unknown_code" });
    const lid = newLid();
    await r.waha.clearCallLog();
    const fromLid = await r.hear({ session: session.name, chatId: lid, body: "halo kak" });
    await fromLid.run();
    expect(await inboundOf(fromLid.inboundId)).toMatchObject({ outcome: "no_code" });
    // The @lid chat is marked under its own id.
    expect((await r.waha.callLog()).filter((c) => c.path === "/api/sendSeen")).toEqual([{ method: "POST", path: "/api/sendSeen", body: { session: session.name, chatId: lid } }]);
    // A stranger who knows a real code gets ONE neutral text an hour; the second message gets nothing but is read.
    const knows = await r.hear({ session: session.name, chatId, body: askingFor(order) });
    await knows.run();
    expect(await inboundOf(knows.inboundId)).toMatchObject({ outcome: "text_mismatch" });
    await r.waha.clearCallLog();
    const again = await r.hear({ session: session.name, chatId, body: askingFor(order) });
    await again.run();
    expect(await inboundOf(again.inboundId)).toMatchObject({ outcome: "text_skipped" });
    expect(await r.waha.callLog()).toEqual([{ method: "POST", path: "/api/sendSeen", body: { session: session.name, chatId } }]);
    expect(r.texts()).toHaveLength(1);
  });
});

describe("a message that is answered is marked as read first", () => {
  it("a buyer who writes with the order code: read first (after a reading pause), then the reply goes out (typing, the file, offline)", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    await r.waha.clearCallLog();
    const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ outcome: "delivered" });
    expect(r.files()).toEqual([expect.objectContaining({ session: session.name, chatId: order.chatId })]);
    // The read mark of the inbound message comes first, then the reply's own sequence, which marks the chat once more (cheap and harmless: accepted rather than a flag).
    expect(await r.calls()).toEqual(["/api/sendSeen", "/api/sendSeen", "/presence:typing", "/presence:paused", "/api/sendFile", "/presence:offline"]);
    for (const call of (await r.waha.callLog()).slice(0, 2)) expect(call.body).toEqual({ session: session.name, chatId: order.chatId });
    // The reading pause before the decision, and the reply's own waits after it.
    expect(r.waits[0]).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0]);
    expect(r.waits[0]).toBeLessThanOrEqual(HUMAN_TIMING.reading[1]);
  });
});

describe("the read mark is best effort", () => {
  it("a seen call WAHA refuses neither fails the job nor stops the reply", async () => {
    const r = rig();
    const session = await createSession();
    const order = await paidOrder(shop, { waNotBefore: proactiveLater() });
    await r.waha.presenceFault("http500");
    try {
      const heard = await r.hear({ session: session.name, chatId: order.chatId, body: askingFor(order) });
      expect(await heard.run()).toBe("processed");
      expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: true, outcome: "delivered" });
      expect(r.files()).toHaveLength(1);
    } finally {
      await r.waha.presenceFault("ok");
    }
  });

  it("a session that cannot be opened for the mark is logged as a code only (no number, chat id or text) and the message is decided as if it had been marked", async () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", role: "worker" }, { write: (line: string) => void lines.push(line) });
    let opened = 0;
    const r = rig({
      log,
      // The first opening is the re-fetch; the second is the read mark: it fails; the rest work.
      consumerWaha: (fake) => ({
        withSession: (sessionId, use, options) => {
          opened++;
          if (opened === 2) return Promise.reject(new WahaAccessError("session_unusable"));
          return fake.access.withSession(sessionId, use, options);
        },
      }),
    });
    const session = await createSession();
    const chatId = strangerChat();
    const heard = await r.hear({ session: session.name, chatId, body: "halo, ada ebook tentang apa?" });
    expect(await heard.run()).toBe("processed");
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: true, outcome: "no_code" });
    expect(await r.waha.callLog()).toEqual([]);
    const logged = lines.join("\n");
    expect(logged).toContain('"step":"seen"');
    expect(logged).toContain('"code":"session_unusable"');
    expect(logged).not.toContain(chatId);
    expect(logged).not.toContain(chatId.split("@")[0] ?? "");
    expect(logged).not.toContain("ebook tentang apa");
  });

  it("any other failure of the mark is a code too, and an abort during the reading pause is NOT swallowed: the job fails (it is retried) before anything is decided or marked", async () => {
    const r = rig({ sleep: () => Promise.reject(new Error("the job was aborted")) });
    const session = await createSession();
    const heard = await r.hear({ session: session.name, chatId: strangerChat(), body: "halo" });
    await expect(heard.run()).rejects.toThrow(/aborted/);
    expect(await inboundOf(heard.inboundId)).toMatchObject({ processed: false, outcome: null });
    expect(await r.waha.callLog()).toEqual([]);
    const failing = rig({
      consumerWaha: () => ({
        withSession: (_sessionId, use) =>
          use({
            sessionName: "stub",
            client: {
              getMessage: () => Promise.resolve({ messageId: "unused", chat: { kind: "phone", chatId: "628100000001@c.us", phone: "+628100000001" }, fromMe: false, body: "halo", hasMedia: false, timestamp: 1 }),
              sendSeen: () => Promise.reject(new Error("the engine fell over")),
            } as unknown as WahaClient,
          }),
      }),
    });
    const heardAgain = await failing.hear({ session: session.name, chatId: strangerChat(), body: "halo" });
    expect(await heardAgain.run()).toBe("processed");
    expect(await inboundOf(heardAgain.inboundId)).toMatchObject({ processed: true, outcome: "no_code" });
  });
});

describe("what is not a confirmed personal message is never marked", () => {
  /** A WAHA that answers `message` for any id, and records every sendSeen. */
  function answering(message: { readonly fromMe: boolean; readonly chat: { readonly kind: "other"; readonly chatId: string } }, seen: unknown[][]): WahaAccess {
    return {
      withSession: (_sessionId, use) =>
        use({
          sessionName: "stub",
          client: {
            getMessage: (_session: string, messageId: string) => Promise.resolve({ messageId, chat: message.chat, fromMe: message.fromMe, body: "halo semua", hasMedia: false, timestamp: 1 }),
            sendSeen: (...args: unknown[]) => {
              seen.push(args);
              return Promise.resolve();
            },
          } as unknown as WahaClient,
        }),
    };
  }

  it("a group, a status and a channel (chat kind other) and a message of ours are ignored and not marked", async () => {
    for (const [chatId, fromMe] of [
      ["120363041234567890@g.us", false],
      ["status@broadcast", false],
      ["120363098765432101@newsletter", false],
      ["628100000002@c.us", true],
    ] as const) {
      const seen: unknown[][] = [];
      const r = rig({ consumerWaha: () => answering({ fromMe, chat: { kind: "other", chatId } }, seen) });
      const session = await createSession();
      const heard = await r.hear({ session: session.name, chatId: strangerChat(), body: "halo semua" });
      expect(await heard.run()).toBe("processed");
      expect(await inboundOf(heard.inboundId), chatId).toMatchObject({ processed: true, outcome: "ignored" });
      expect(seen, chatId).toEqual([]);
      expect(r.waits, chatId).toEqual([]);
    }
  });

  it("a forged message (WAHA does not know it) and one of our own (its id says so) are not marked, and nothing is waited for", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = strangerChat();
    const forged = await storeInbound({ sessionName: session.name, messageId: `false_${chatId}_FORGED00001`, fromJid: chatId });
    const ours = await storeInbound({ sessionName: session.name, messageId: `true_${chatId}_OWNMSG0001`, fromJid: chatId });
    await r.waha.clearCallLog();
    expect(await r.process({ id: forged.outboxId })).toBe("processed");
    expect(await r.process({ id: ours.outboxId })).toBe("processed");
    expect(await inboundOf(forged.inboundId)).toMatchObject({ outcome: "unverified" });
    expect(await inboundOf(ours.inboundId)).toMatchObject({ outcome: "unverified" });
    expect(await r.waha.callLog()).toEqual([]);
    expect(r.waits).toEqual([]);
  });
});
