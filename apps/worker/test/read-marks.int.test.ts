// The read marks (src/delivery/read-marks.ts; Owner rule, 2026-11-24: every incoming personal message is marked as read, the ones the webhook drops included). The ring
// public fills through the worker-loaded function ebt_wa_read_v1 is filled here the way public fills it (the real function, on the real Valkey, with the message id SEALED to
// the messaging key as public seals it), the worker takes it (poll), schedules a delayed job per message (a real BullMQ queue in one test, a recording one in the others) and
// the job re-fetches the message from the in-process WAHA mock (infra/waha-mock, which records every call) and marks the WHOLE chat as read. What public does with the
// webhook (which messages are handed over at all) is apps/public/test/waha-webhook.int.test.ts. Every rig has a ring, a cursor and a lock of its own, so no test sees another's.
import { createHash, randomBytes } from "node:crypto";
import { WahaError } from "@ebooktrivia/adapters";
import { loadPublicValkeyFunctions, WA_READ_FUNCTION, WA_READ_ITEM_TTL_S, WA_READ_RING_SIZE, waReadCall, waReadKeys } from "@ebooktrivia/adapters/valkey-functions";
import { HUMAN_TIMING } from "@ebooktrivia/core";
import { createWaReadOpener, createWaReadSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { type Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cryptoRandom, isSending, sendLikeAHuman } from "../src/delivery/human.ts";
import { type WahaAccess, WahaAccessError } from "../src/delivery/ports.ts";
import {
  createReadMarks,
  READ_BATCH,
  READ_DEFER_MINUTES,
  READ_MARK_CAP_PER_CHAT,
  READ_MARK_CAP_PER_MINUTE,
  READ_QUEUE,
  readJobId,
  trailingJobId,
} from "../src/delivery/read-marks.ts";
import { createLogger } from "../src/log.ts";
import { createQueue, redisOptions } from "../src/queues.ts";
import { createSession, createWahaFake, retireSessions } from "./support/delivery.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = workerPool(4);
const redis = new Redis({ ...redisOptions(testValkey()), maxRetriesPerRequest: 1 });
const namespaces = new Set<string>();
/** The messaging key pair of this "deployment": public seals the ids to the public half, the worker opens them with the private one. */
const messaging = generateScopeKeyPair();
const sealer = createWaReadSealer(messaging.publicKey);
const opener = createWaReadOpener(messaging.privateKey);

async function scanned(match: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", match, "COUNT", 1000);
    found.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

beforeAll(async () => {
  await loadPublicValkeyFunctions(redis);
});
beforeEach(retireSessions);
afterAll(async () => {
  await retireSessions();
  for (const namespace of namespaces) {
    const keys = await scanned(`${namespace}:*`);
    if (keys.length > 0) await redis.unlink(...keys);
  }
  redis.disconnect();
});

const personalChat = (): string => `${uniquePhone().slice(1)}@c.us`;
/** A chat's digest: stable for the session and chat (the dedupe key of the chat), as public's keyed digest is. */
const digestOf = (session: string, chatId: string): string => createHash("sha256").update(`${session}|${chatId}`).digest("hex").slice(0, 32);
const sealedOf = (session: string, chatId: string, messageId: string): string => sealer.seal({ session, digest: digestOf(session, chatId), messageId }).toString("base64url");

interface Added {
  readonly name: string;
  readonly data: { readonly session: string; readonly sealed: string; readonly digest: string };
  readonly opts: { readonly jobId: string; readonly delay: number; readonly attempts: number; readonly removeOnComplete: boolean };
}

interface Arrived {
  readonly messageId: string;
  readonly digest: string;
  readonly sealed: string;
  readonly n: number;
  /** The data of the job that marks it (what the poll puts on the queue). */
  readonly job: { readonly session: string; readonly sealed: string; readonly digest: string };
}

function rig(over: { now?: () => number; random?: () => number; log?: ReturnType<typeof createLogger>; waha?: (fake: ReturnType<typeof createWahaFake>) => WahaAccess } = {}) {
  const namespace = `cache:public:wa-read-w${randomBytes(4).toString("hex")}`;
  namespaces.add(namespace);
  const ring = waReadKeys(namespace);
  const prefix = uniquePrefix();
  const waha = createWahaFake();
  const added: Added[] = [];
  const queue = {
    add: (name: string, data: Added["data"], opts: Added["opts"]) => {
      added.push({ name, data, opts });
      return Promise.resolve({});
    },
  } as unknown as Pick<Queue, "add">;
  const marks = createReadMarks({
    sql: workerSql,
    log: over.log ?? silentLog,
    waha: over.waha?.(waha) ?? waha.access,
    valkey: redis,
    opener,
    prefix,
    namespace,
    ...(over.now === undefined ? {} : { now: over.now }),
    ...(over.random === undefined ? {} : { random: over.random }),
  });
  /** A message arrives at a number (registered in WAHA, as the webhook would announce it) and public hands it over: the real function, as the public user calls it. */
  async function arrive(session: string, chatId: string, body = "halo, ebooknya mana?"): Promise<Arrived> {
    const messageId = await waha.inbound({ session, chatId, body });
    const digest = digestOf(session, chatId);
    const sealed = sealedOf(session, chatId, messageId);
    const call = waReadCall(namespace, { session, sealed, digest });
    if (call === null) throw new Error("the item is well formed");
    const n = Number(await redis.fcall(WA_READ_FUNCTION, call.keys.length, ...call.keys, ...call.args));
    return { messageId, digest, sealed, n, job: { session, sealed, digest } };
  }
  /** What the job does first when it takes a chat's read: lets the chat's pending mark go (so the chat's next message is handed over again). */
  const release = async (digest: string): Promise<void> => {
    await redis.del(ring.pending(digest));
  };
  /** What WAHA was asked besides the lookups: the path (presence calls as one) and the body. */
  const calls = async () => (await waha.callLog()).map((c) => ({ path: c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence"), body: c.body }));
  return { waha, added, queue, marks, arrive, release, calls, ring, prefix, namespace };
}

describe("the job marks the whole chat as read, and puts the number offline again", () => {
  it("a stranger's chatter in a phone chat: sendSeen of the whole chat (no message ids) on the receiving number, then offline; nothing is typed or sent", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const arrived = await r.arrive(session.name, chatId);
    expect(await redis.exists(r.ring.pending(arrived.digest))).toBe(1);
    await r.waha.clearCallLog();
    expect(await r.marks.process(arrived.job)).toBe("marked");
    expect(await r.calls()).toEqual([
      { path: "/api/sendSeen", body: { session: session.name, chatId } },
      { path: "/presence", body: { presence: "offline" } },
    ]);
    expect(r.waha.sent).toEqual([]);
    // The chat's pending mark was released first: its next message starts a read of its own.
    expect(await redis.exists(r.ring.pending(arrived.digest))).toBe(0);
  });

  it("an @lid chat and a personal number of another country are marked under their own chat id", async () => {
    const r = rig();
    const session = await createSession();
    for (const chatId of [`${String(Math.floor(10_000_000_000 + Math.random() * 8_999_999_999))}@lid`, `1415555${String(Math.floor(1000 + Math.random() * 8999))}@c.us`]) {
      const arrived = await r.arrive(session.name, chatId);
      await r.waha.clearCallLog();
      expect(await r.marks.process(arrived.job), chatId).toBe("marked");
      expect((await r.calls())[0], chatId).toEqual({ path: "/api/sendSeen", body: { session: session.name, chatId } });
    }
  });

  it("marks nothing for a message of ours, one WAHA does not know, or data that is no sealed id of this session and chat: a forged hint drives nothing", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const digest = digestOf(session.name, chatId);
    // The id of a message the mock REALLY sent in a phone chat (fromMe after the re-fetch).
    const ours = await r.waha.access.withSession(session.id, ({ sessionName, client }) => client.sendText(sessionName, chatId, "halo kak"));
    await r.waha.clearCallLog();
    expect(await r.marks.process({ session: session.name, sealed: sealedOf(session.name, chatId, ours.id), digest })).toBe("ignored");
    // Never seen by WAHA: forged.
    expect(await r.marks.process({ session: session.name, sealed: sealedOf(session.name, chatId, `false_${chatId}_FORGED00001`), digest })).toBe("unverified");
    // A group's, a status', a channel's id: the re-fetch only knows ids of a person's chat, so it is refused there (and nothing is marked).
    for (const messageId of ["false_120363025246125486@g.us_AAAA1111", "false_status@broadcast_AAAA1111", "false_120363098765432101@newsletter_AAAA1111"]) {
      expect(await r.marks.process({ session: session.name, sealed: sealedOf(session.name, chatId, messageId), digest }), messageId).toBe("unverified");
    }
    // A sealed id of another session or another chat does not open (the AAD binds it), and neither does anything that is not a sealed id.
    const real = await r.arrive(session.name, chatId);
    expect(await r.marks.process({ session: "another", sealed: real.sealed, digest })).toBe("open_decrypt_failed");
    expect(await r.marks.process({ session: session.name, sealed: real.sealed, digest: "f".repeat(32) })).toBe("open_decrypt_failed");
    const flipped = Buffer.from(real.sealed, "base64url");
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    expect(await r.marks.process({ session: session.name, sealed: flipped.toString("base64url"), digest })).toBe("open_decrypt_failed");
    for (const bad of [null, "x", {}, { session: session.name }, { session: 7, sealed: "x", digest: "y" }, { session: session.name, sealed: "short", digest }, { session: session.name, sealed: real.sealed, digest: "short" }]) {
      expect(await r.marks.process(bad)).toBe("invalid");
    }
    // A raw message id (an older shape of the job, with the phone in it) is no sealed blob.
    expect(await r.marks.process({ session: session.name, sealed: `false_${chatId}_AAAA1111`, digest })).toBe("invalid");
    expect((await r.calls()).filter((c) => c.path === "/api/sendSeen" || c.path === "/presence")).toEqual([]);
  });

  it("is best effort: a seen WAHA refuses, a number that cannot be opened and a WAHA that cannot be asked are codes, never an error; the number still goes offline after a failed seen", async () => {
    const session = await createSession();
    const chatId = personalChat();
    // sendSeen fails: a code, and offline was still attempted (on the same mock).
    let opened = 0;
    const failingSeen = rig({
      waha: (fake) => ({
        withSession: (id, use, options) =>
          fake.access.withSession(
            id,
            ({ sessionName, client }) => {
              opened++;
              return use({ sessionName, client: { ...client, sendSeen: () => Promise.reject(new WahaError("failed", "down")) } });
            },
            options,
          ),
      }),
    });
    const a = await failingSeen.arrive(session.name, chatId);
    await failingSeen.waha.clearCallLog();
    expect(await failingSeen.marks.process(a.job)).toBe("seen_failed");
    expect(opened).toBe(2); // the re-fetch, then the mark
    expect(await failingSeen.calls()).toEqual([{ path: "/presence", body: { presence: "offline" } }]);
    // A number that cannot be opened for the mark.
    let calls = 0;
    const unopenable = rig({
      waha: (fake) => ({
        withSession: (id, use, options) => (++calls === 2 ? Promise.reject(new WahaAccessError("session_unusable")) : fake.access.withSession(id, use, options)),
      }),
    });
    const b = await unopenable.arrive(session.name, chatId);
    expect(await unopenable.marks.process(b.job)).toBe("seen_session_unusable");
    // A WAHA that cannot be asked about the message at all.
    const down = rig();
    const c = await down.arrive(session.name, chatId);
    down.waha.outage(session.name, true);
    expect(await down.marks.process(c.job)).toBe("refetch_failed");
    // A WAHA whose presence calls answer 500.
    const faulty = rig();
    const d = await faulty.arrive(session.name, chatId);
    await faulty.waha.presenceFault("http500");
    try {
      expect(await faulty.marks.process(d.job)).toBe("seen_failed");
    } finally {
      await faulty.waha.presenceFault("ok");
    }
  });

  it("does not put the number offline while a human-like send of the same number is in flight (its typing would be cut), and the send ends offline itself", async () => {
    const r = rig();
    const session = await createSession();
    const readChat = personalChat();
    const sendChat = personalChat();
    const arrived = await r.arrive(session.name, readChat);
    await r.waha.clearCallLog();
    // A send of the same number, held in its typing wait until the test lets it go.
    let release: () => void = () => undefined;
    const holdTyping = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedTyping: () => void = () => undefined;
    const typingStarted = new Promise<void>((resolve) => {
      reachedTyping = resolve;
    });
    let wait = 0;
    const send = r.waha.access.withSession(session.id, ({ sessionName, client }) =>
      sendLikeAHuman(
        {
          log: silentLog,
          random: () => 0.5,
          sleep: async () => {
            // The first wait (reading) passes; the second (typing: "typing..." is showing) is held.
            if (++wait === 2) {
              reachedTyping();
              await holdTyping;
            }
          },
        },
        { client, sessionName, chatId: sendChat, textLength: 40, kind: "message", signal: new AbortController().signal, send: () => client.sendText(sessionName, sendChat, "halo kak") },
      ),
    );
    await typingStarted;
    expect(isSending(session.name)).toBe(true);
    // A read mark of ANOTHER chat of this number while it types: the chat is marked, but the number is not put offline.
    expect(await r.marks.process(arrived.job)).toBe("marked");
    const during = await r.calls();
    expect(during.filter((c) => c.path === "/api/sendSeen").map((c) => c.body["chatId"])).toEqual([sendChat, readChat]);
    expect(during.filter((c) => c.path === "/presence").map((c) => c.body["presence"])).toEqual(["typing"]);
    // The send goes on and ends offline itself, once.
    release();
    expect(await send).toMatchObject({ kind: "sent" });
    expect(isSending(session.name)).toBe(false);
    expect((await r.calls()).filter((c) => c.path === "/presence").map((c) => c.body["presence"])).toEqual(["typing", "paused", "offline"]);
    // With nothing in flight the read job puts the number offline as before.
    await r.waha.clearCallLog();
    const again = await r.arrive(session.name, personalChat());
    expect(await r.marks.process(again.job)).toBe("marked");
    expect((await r.calls()).filter((c) => c.path === "/presence").map((c) => c.body["presence"])).toEqual(["offline"]);
  });

  it("a send that never settles cannot keep a number 'sending' for ever (a safety expiry), and a send that fails or is aborted ends its mark", async () => {
    const r = rig();
    const session = await createSession();
    const failing = await r.waha.access.withSession(session.id, ({ sessionName, client }) =>
      sendLikeAHuman(
        { log: silentLog, sleep: () => Promise.resolve() },
        { client, sessionName, chatId: personalChat(), textLength: 10, kind: "message", signal: new AbortController().signal, send: () => Promise.reject(new WahaError("failed", "refused")) },
      ).catch((error: unknown) => error),
    );
    expect(failing).toBeInstanceOf(WahaError);
    expect(isSending(session.name)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await r.waha.access.withSession(session.id, ({ sessionName, client }) =>
      sendLikeAHuman({ log: silentLog, sleep: () => Promise.resolve() }, { client, sessionName, chatId: personalChat(), textLength: 10, kind: "message", signal: controller.signal, send: () => client.sendText(sessionName, "1@c.us", "x") }),
    );
    expect(isSending(session.name)).toBe(false);
    // A send whose promise never settles: its mark expires on its own (HUMAN_MAX_MS and a minute after it began).
    let settle: () => void = () => undefined;
    let waits = 0;
    const hung = r.waha.access.withSession(session.id, ({ sessionName, client }) =>
      sendLikeAHuman(
        { log: silentLog, sleep: () => (++waits === 1 ? new Promise<void>((resolve) => (settle = resolve)) : Promise.resolve()) },
        { client, sessionName, chatId: personalChat(), textLength: 10, kind: "message", signal: new AbortController().signal, send: () => Promise.resolve("x") },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isSending(session.name)).toBe(true);
    expect(isSending(session.name, Date.now() + 3_600_000)).toBe(false);
    settle();
    await hung;
    expect(isSending(session.name)).toBe(false);
  });

  it("logs a failure as a code per event (debug) and as ONE warning a minute with the counts, the last minute's too, never a number, a chat id or a text", async () => {
    const lines: { msg: string; step?: string; code?: string; failures?: Record<string, number>; sessionId?: string }[] = [];
    const log = createLogger({ level: "debug", role: "worker" }, { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) });
    let clock = 1_000_000;
    let opened = 0;
    // Every second opening (the mark, after the re-fetch) fails with a code.
    const r = rig({
      log,
      now: () => clock,
      waha: (fake) => ({ withSession: (id, use, options) => (opened++ % 2 === 1 ? Promise.reject(new WahaAccessError("key_missing")) : fake.access.withSession(id, use, options)) }),
    });
    const session = await createSession();
    const chatId = personalChat();
    const arrived = await r.arrive(session.name, chatId, "halo, ini rahasia 081234567890");
    for (let i = 0; i < 5; i++) expect(await r.marks.process(arrived.job)).toBe("seen_key_missing");
    expect(lines.filter((l) => l.msg === "a read mark did not go through")).toHaveLength(5);
    // The first failure warns at once, the next four within the minute do not.
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "seen:key_missing": 1 }]);
    // The minute passes with no further failure: the poll's own tick reports what was counted meanwhile (4), nothing waits for the next failure.
    clock += 61_000;
    await r.marks.poll(r.queue);
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "seen:key_missing": 1 }, { "seen:key_missing": 4 }]);
    // Counted and told, nothing more: a quiet tick says nothing.
    clock += 61_000;
    await r.marks.poll(r.queue);
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped")).toHaveLength(2);
    const text = JSON.stringify(lines);
    expect(text).toContain('"code":"key_missing"');
    expect(text).toContain('"step":"seen"');
    expect(text).not.toContain(chatId);
    expect(text).not.toContain(chatId.split("@")[0] ?? "x");
    expect(text).not.toContain("rahasia");
    expect(text).not.toContain(arrived.messageId);
  });
});

describe("the sealed id: no phone number is in Valkey or in a job", () => {
  it("neither the ring's item, nor the pending mark, nor the job's data, nor the job's id holds a digit of the sender's number or the message id", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const digits = chatId.split("@")[0] ?? "x";
    const arrived = await r.arrive(session.name, chatId, "halo, ebooknya mana?");
    expect(arrived.messageId).toContain(digits);
    const ringText = (await scanned(`${r.namespace}:*`)).flatMap((key) => [key]).join("\n");
    const values = await Promise.all((await scanned(`${r.namespace}:*`)).map(async (key) => `${key}=${String(await redis.get(key))}`));
    for (const text of [ringText, values.join("\n")]) {
      expect(text).not.toContain(digits);
      expect(text).not.toContain(arrived.messageId);
      expect(text).not.toContain(arrived.messageId.split("_").at(-1) ?? "x");
      expect(text).not.toMatch(/@c\.us|@lid|false_|true_/);
    }
    await r.marks.poll(r.queue);
    const [job] = r.added;
    expect(job?.data).toEqual(arrived.job);
    const jobText = JSON.stringify(job);
    expect(jobText).not.toContain(digits);
    expect(jobText).not.toContain(arrived.messageId);
    expect(jobText).not.toMatch(/@c\.us|@lid|false_|true_/);
    // The job id is derived from the PLAINTEXT id (a message is scheduled once while its job lives), as a digest.
    expect(job?.opts.jobId).toBe(readJobId(arrived.messageId));
    expect(job?.opts.jobId).toMatch(/^read-[0-9a-f]{32}$/);
    // Only the worker, with the private key, reads it back: the id is the one that arrived.
    expect(opener.open({ session: session.name, digest: arrived.digest, sealed: Buffer.from(arrived.sealed, "base64url") })).toBe(arrived.messageId);
  });
});

describe("the poll takes the ring and schedules one delayed job per message", () => {
  it("schedules each new item once, after a random reading pause, with a deterministic job id and nothing kept after it is done; a second poll finds nothing", async () => {
    const r = rig();
    const session = await createSession();
    const first = await r.arrive(session.name, personalChat());
    const second = await r.arrive(session.name, personalChat());
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(first.messageId), readJobId(second.messageId)]);
    for (const job of r.added) {
      expect(job.name).toBe(READ_QUEUE);
      expect(job.opts.delay).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0]);
      expect(job.opts.delay).toBeLessThanOrEqual(HUMAN_TIMING.reading[1]);
      expect(job.opts).toMatchObject({ attempts: 1, removeOnComplete: true });
    }
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toHaveLength(2);
    // A third message is the only new one.
    const third = await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(first.messageId), readJobId(second.messageId), readJobId(third.messageId)]);
  });

  it("the reading pause is drawn from the human-like random source: it varies, and a test can drive it", async () => {
    const delays = async (random?: () => number): Promise<number[]> => {
      const r = rig(random === undefined ? {} : { random });
      const session = await createSession();
      for (let i = 0; i < 12; i++) await r.arrive(session.name, personalChat());
      await r.marks.poll(r.queue);
      return r.added.map((a) => a.opts.delay);
    };
    expect(new Set(await delays(cryptoRandom)).size).toBeGreaterThan(6);
    expect(new Set(await delays(() => 0)).size).toBe(1);
  });

  it("one pending read per chat: a second message waits for the job to take the read; once taken, the next message starts another", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const a = await r.arrive(session.name, chatId, "halo");
    expect(a.n).toBeGreaterThan(0);
    const b = await r.arrive(session.name, chatId, "ada kak?");
    expect(b.n).toBe(0);
    await r.marks.poll(r.queue);
    expect(r.added).toHaveLength(1);
    // The job takes the read (the pending mark goes first), so a message from then on is a new read.
    await r.marks.process(a.job);
    const c = await r.arrive(session.name, chatId, "halo?");
    expect(c.n).toBeGreaterThan(0);
  });

  it(`a chat's cap is ${String(READ_MARK_CAP_PER_CHAT)} marks a minute: the chatty chat's other messages share ONE trailing job at the start of the next minute, which marks the whole chat, and its budget is the number's four, not all of it`, async () => {
    const minuteStart = Math.floor(Date.UTC(2026, 10, 24, 3, 0, 0) / 60_000) * 60_000;
    const r = rig({ now: () => minuteStart + 10_000, random: () => 0 });
    const session = await createSession();
    const chatty = personalChat();
    const window = minuteStart / 60_000;
    const arrived: Arrived[] = [];
    for (let i = 0; i < 12; i++) {
      arrived.push(await r.arrive(session.name, chatty, `pesan ${String(i)}`));
      expect(arrived[i]?.n, `message ${String(i)}`).toBeGreaterThan(0);
      await r.marks.poll(r.queue);
      await r.release(arrived[i]?.digest ?? "");
    }
    // The first three are scheduled one by one; the fourth schedules the window's trailing job; the other eight find it there.
    expect(r.added).toHaveLength(READ_MARK_CAP_PER_CHAT + 1);
    expect(r.added.slice(0, READ_MARK_CAP_PER_CHAT).map((a) => a.opts.jobId)).toEqual(arrived.slice(0, READ_MARK_CAP_PER_CHAT).map((a) => readJobId(a.messageId)));
    const trailing = r.added[READ_MARK_CAP_PER_CHAT];
    expect(trailing?.opts.jobId).toBe(trailingJobId(arrived[0]?.digest ?? "", window));
    expect(trailing?.opts.jobId).toMatch(/^read-t-[0-9a-f]{32}-\d+$/);
    // It runs when the window is over (50 s from "now": the clock is 10 s into its minute) plus a reading pause, and its data is a sealed id of that chat: it marks the whole chat.
    expect(trailing?.opts.delay).toBe(50_000 + HUMAN_TIMING.reading[0]);
    expect(trailing?.data.digest).toBe(arrived[0]?.digest);
    // The whole chat is marked by it (one sendSeen of the chat, whatever message it names).
    await r.waha.clearCallLog();
    expect(await r.marks.process(trailing?.data)).toBe("marked");
    expect((await r.calls())[0]).toEqual({ path: "/api/sendSeen", body: { session: session.name, chatId: chatty } });
    // The number's budget paid for four marks, not twelve; another chat of the number is not held back by the chatty one.
    expect(Number(await redis.get(`${r.prefix}:wa-read:cap:${session.name}:${String(window)}`))).toBe(READ_MARK_CAP_PER_CHAT);
    expect(Number(await redis.get(`${r.prefix}:wa-read:cap:${session.name}:${String(window + 1)}`))).toBe(1);
    const other = await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.at(-1)?.opts.jobId).toBe(readJobId(other.messageId));
    expect(r.added.at(-1)?.opts.delay).toBe(HUMAN_TIMING.reading[0]);
    // The next window starts the chat's count over.
    const later = rig({ now: () => minuteStart + 70_000, random: () => 0 });
    const next = await later.arrive(session.name, chatty);
    await later.marks.poll(later.queue);
    expect(later.added.map((a) => a.opts.jobId)).toEqual([readJobId(next.messageId)]);
  });

  it(`a number's budget is ${String(READ_MARK_CAP_PER_MINUTE)} marks a minute: what is over it is DEFERRED to the next minutes that have room (within the item's ten), not dropped; another number and the next minute are not affected`, async () => {
    const minuteStart = Math.floor(Date.UTC(2026, 10, 24, 4, 0, 0) / 60_000) * 60_000;
    let clock = minuteStart + 5_000;
    const r = rig({ now: () => clock, random: () => 0 });
    const busy = await createSession();
    const quiet = await createSession();
    const arrived: Arrived[] = [];
    const total = READ_MARK_CAP_PER_MINUTE * 2 + 10;
    for (let i = 0; i < total; i++) arrived.push(await r.arrive(busy.name, personalChat()));
    while (await r.marks.poll(r.queue)) continue;
    expect(r.added).toHaveLength(total);
    const pause = HUMAN_TIMING.reading[0];
    // This minute's 60 go at once; the next 60 wait for the next minute (55 s away), the last 10 for the minute after.
    const delays = r.added.map((a) => a.opts.delay);
    expect(delays.filter((d) => d === pause)).toHaveLength(READ_MARK_CAP_PER_MINUTE);
    expect(delays.filter((d) => d === 55_000 + pause)).toHaveLength(READ_MARK_CAP_PER_MINUTE);
    expect(delays.filter((d) => d === 115_000 + pause)).toHaveLength(10);
    // Still pending (their jobs are scheduled): a second message of such a chat waits for its job like any other.
    for (const m of arrived) expect(await redis.exists(r.ring.pending(m.digest))).toBe(1);
    // Another number has a budget of its own.
    await r.arrive(quiet.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.at(-1)?.opts.delay).toBe(pause);
    // The budget's keys are under the worker's own prefix and expire: the ones of the minutes ahead outlive them.
    const keys = await scanned(`${r.prefix}:wa-read:cap:${busy.name}:*`);
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(await redis.ttl(key)).toBeGreaterThan(0);
    // The next minute: this minute's counter already holds the 60 reserved for it, so a new message goes after them (the minute after), not on top.
    clock += 60_000;
    await r.arrive(busy.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.at(-1)?.opts.delay).toBe(55_000 + pause);
  });

  it("when every minute within the item's life is spent, the mark is let go: no job, and the chat's pending mark is released so its next message can try again", async () => {
    const minuteStart = Math.floor(Date.UTC(2026, 10, 24, 5, 0, 0) / 60_000) * 60_000;
    const r = rig({ now: () => minuteStart + 1_000, random: () => 0 });
    const session = await createSession();
    expect(READ_DEFER_MINUTES).toBe(WA_READ_ITEM_TTL_S / 60 - 1);
    for (let k = 0; k <= READ_DEFER_MINUTES; k++) await redis.set(`${r.prefix}:wa-read:cap:${session.name}:${String(minuteStart / 60_000 + k)}`, String(READ_MARK_CAP_PER_MINUTE), "EX", 600);
    const arrived = await r.arrive(session.name, personalChat());
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toEqual([]);
    expect(await redis.exists(r.ring.pending(arrived.digest))).toBe(0);
    // One minute has room again: the next message of that chat is marked, in that minute (9 minutes ahead is the farthest: an item lives ten).
    await redis.set(`${r.prefix}:wa-read:cap:${session.name}:${String(minuteStart / 60_000 + READ_DEFER_MINUTES)}`, "0", "EX", 600);
    const again = await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added).toHaveLength(1);
    expect(r.added[0]?.opts.delay).toBe(READ_DEFER_MINUTES * 60_000 - 1_000 + HUMAN_TIMING.reading[0]);
    expect(r.added[0]?.opts.jobId).toBe(readJobId(again.messageId));
    expect(r.added[0]?.opts.delay).toBeLessThan(WA_READ_ITEM_TTL_S * 1000);
  });

  it("counters are made with their life in one step (SET NX EX, then INCR): none of the budget's or the chat's keys ever exists without a TTL", async () => {
    const r = rig();
    const session = await createSession();
    for (let i = 0; i < 3; i++) await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    const counters = [...(await scanned(`${r.prefix}:wa-read:cap:*`)), ...(await scanned(`${r.prefix}:wa-read:chat:*`))];
    expect(counters.length).toBeGreaterThanOrEqual(4);
    for (const key of counters) expect(await redis.ttl(key), key).toBeGreaterThan(0);
  });

  it(`takes at most ${String(READ_BATCH)} items a tick and says so when more wait`, async () => {
    const r = rig();
    const sessions = await Promise.all(Array.from({ length: 3 }, () => createSession()));
    for (let i = 0; i < READ_BATCH + 5; i++) await r.arrive(sessions[i % 3]?.name ?? "", personalChat());
    expect(await r.marks.poll(r.queue)).toBe(true);
    expect(r.added).toHaveLength(READ_BATCH);
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toHaveLength(READ_BATCH + 5);
  });

  it("an item that is not what the function wrote (an overwritten slot, junk) drives nothing; a counter far ahead only looks at the ring's window; a restarted counter starts over", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const messageId = await r.waha.inbound({ session: session.name, chatId, body: "halo" });
    const digest = digestOf(session.name, chatId);
    const sealed = sealedOf(session.name, chatId, messageId);
    const head = WA_READ_RING_SIZE * 2 + 3;
    // The counter is far ahead (a long-running ring): the cursor starts at the oldest slot that can still hold an item.
    await redis.set(r.ring.seq, String(head));
    await redis.set(r.ring.item(head), `${String(head)}|${session.name}|${sealed}|${digest}`);
    // The slot of an item of ANOTHER lap, and junk, in two others of the window.
    await redis.set(r.ring.item(head - 2), `${String(WA_READ_RING_SIZE + 1)}|${session.name}|${sealed}|${digest}`);
    await redis.set(r.ring.item(head - 1), "not an item");
    for (let i = 0; i < 40 && (await r.marks.poll(r.queue)); i++) continue;
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(messageId)]);
    // The counter restarted (it had expired): a cursor ahead of it starts over.
    await redis.set(r.ring.seq, "1");
    const restartedChat = personalChat();
    const restarted = await r.waha.inbound({ session: session.name, chatId: restartedChat, body: "halo" });
    await redis.set(r.ring.item(1), `1|${session.name}|${sealedOf(session.name, restartedChat, restarted)}|${digestOf(session.name, restartedChat)}`);
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(messageId), readJobId(restarted)]);
    // Nothing at all while the counter does not exist.
    await redis.del(r.ring.seq);
    expect(await r.marks.poll(r.queue)).toBe(false);
  });

  it("an item sealed to another key is let go with a code (nothing is scheduled), the others of the batch still are", async () => {
    const r = rig();
    const session = await createSession();
    const good = await r.arrive(session.name, personalChat());
    const chatId = personalChat();
    const digest = digestOf(session.name, chatId);
    const foreign = createWaReadSealer(generateScopeKeyPair().publicKey).seal({ session: session.name, digest, messageId: `false_${chatId}_ABC` }).toString("base64url");
    const call = waReadCall(r.namespace, { session: session.name, sealed: foreign, digest });
    if (call === null) throw new Error("well formed");
    await redis.fcall(WA_READ_FUNCTION, call.keys.length, ...call.keys, ...call.args);
    const last = await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(good.messageId), readJobId(last.messageId)]);
  });
});

describe("one poller at a time, and a poll that fails says so once a minute", () => {
  it("two polls at once take each item once: the second finds the lock and leaves the tick to the first", async () => {
    const r = rig();
    const session = await createSession();
    for (let i = 0; i < 5; i++) await r.arrive(session.name, personalChat());
    const secondAdded: Added[] = [];
    const second = {
      add: (name: string, data: Added["data"], opts: Added["opts"]) => {
        secondAdded.push({ name, data, opts });
        return Promise.resolve({});
      },
    } as unknown as Pick<Queue, "add">;
    const results = await Promise.all([r.marks.poll(r.queue), r.marks.poll(second)]);
    expect(results).toEqual([false, false]);
    expect(r.added.length + secondAdded.length).toBe(5);
    expect(r.added.length === 0 || secondAdded.length === 0).toBe(true);
    // The lock is released: the next tick is free to take new items.
    await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.length + secondAdded.length).toBe(6);
    expect(await redis.exists(`${r.prefix}:wa-read:lock`)).toBe(0);
  });

  it("a lock held by someone else leaves the tick alone; a tick that lost its lock never moves the cursor, so the same items are taken again", async () => {
    const r = rig();
    const session = await createSession();
    await r.arrive(session.name, personalChat());
    const lockKey = `${r.prefix}:wa-read:lock`;
    await redis.set(lockKey, "another-process", "PX", 30_000);
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toEqual([]);
    expect(await redis.get(lockKey)).toBe("another-process");
    // The lock expires mid-tick and another process takes it: this tick's work is done, but the cursor is not its to move (and the lock is not its to release).
    await redis.del(lockKey);
    const taken = { add: async () => { await redis.set(lockKey, "a-newer-poller", "PX", 30_000); return {}; } } as unknown as Pick<Queue, "add">;
    expect(await r.marks.poll(taken)).toBe(false);
    expect(await redis.exists(`${r.prefix}:wa-read:cursor`)).toBe(0);
    expect(await redis.get(lockKey)).toBe("a-newer-poller");
    await redis.del(lockKey);
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toHaveLength(1);
    expect(await redis.exists(`${r.prefix}:wa-read:cursor`)).toBe(1);
  });

  it("a poll that fails every second never throws and is one line a minute: counted, told with its counts, and the same items are taken again once it works", async () => {
    const lines: { level: number; msg: string; failures?: Record<string, number> }[] = [];
    const log = createLogger({ level: "warn", role: "worker" }, { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) });
    let clock = 5_000_000;
    const r = rig({ log, now: () => clock });
    const session = await createSession();
    const arrived = await r.arrive(session.name, personalChat());
    const broken = { add: () => Promise.reject(new Error("valkey down")) } as unknown as Pick<Queue, "add">;
    for (let i = 0; i < 30; i++) {
      expect(await r.marks.poll(broken)).toBe(false);
      clock += 1000;
    }
    // Thirty ticks across thirty seconds: the first failure warned, the other 29 wait for the minute to be over.
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "poll:failed": 1 }]);
    expect(lines.filter((l) => l.level >= 50)).toEqual([]);
    clock += 60_000;
    expect(await r.marks.poll(broken)).toBe(false);
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "poll:failed": 1 }, { "poll:failed": 30 }]);
    // Valkey back: the item is still there, from the same cursor, and what the failed ticks spent was given back: it is a plain mark, not a chat that turned "covered" by a
    // trailing job that was never made, and the number's budget paid for it once.
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added.map((a) => a.opts.jobId)).toEqual([readJobId(arrived.messageId)]);
    expect(await redis.get(`${r.prefix}:wa-read:chat:${arrived.digest}:${String(Math.floor(clock / 60_000))}`)).toBe("1");
    expect(await redis.get(`${r.prefix}:wa-read:cap:${session.name}:${String(Math.floor(clock / 60_000))}`)).toBe("1");
  });
});

describe("end to end on a real BullMQ queue", () => {
  it("the delayed job runs after its pause, marks the chat, and leaves no job behind", async () => {
    const r = rig({ random: () => 0 });
    const session = await createSession();
    const chatId = personalChat();
    const queue = createQueue(READ_QUEUE, { valkey: testValkey(), prefix: r.prefix });
    const worker = new Worker(READ_QUEUE, (job) => r.marks.process(job.data), { connection: redisOptions(testValkey()), prefix: r.prefix });
    try {
      const { messageId } = await r.arrive(session.name, chatId, "halo kak");
      await r.waha.clearCallLog();
      const startedAt = Date.now();
      await r.marks.poll(queue);
      expect(await queue.getDelayedCount()).toBe(1);
      const [job] = await queue.getDelayed();
      expect(job?.id).toBe(readJobId(messageId));
      expect(job?.opts.delay).toBe(HUMAN_TIMING.reading[0]);
      // The job's data in Valkey is the sealed id, never the id.
      expect(JSON.stringify(job?.data)).not.toContain(messageId);
      for (let i = 0; i < 80 && !(await r.calls()).some((c) => c.path === "/api/sendSeen"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0] - 50);
      expect(await r.calls()).toEqual([
        { path: "/api/sendSeen", body: { session: session.name, chatId } },
        { path: "/presence", body: { presence: "offline" } },
      ]);
      const counts = () => queue.getJobCounts("completed", "delayed", "waiting", "active", "failed");
      for (let i = 0; i < 40 && (await counts()).active !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await counts()).toEqual({ completed: 0, delayed: 0, waiting: 0, active: 0, failed: 0 });
    } finally {
      await worker.close();
      await obliterate([queue]);
    }
  });
});
