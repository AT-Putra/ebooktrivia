// The read marks (src/delivery/read-marks.ts; Owner rule, 2026-11-24: every incoming personal message is marked as read, the ones the webhook drops included). The ring
// public fills through the worker-loaded function ebt_wa_read_v1 is filled here the way public fills it (the real function, on the real Valkey), the worker takes it (poll),
// schedules a delayed job per message (a real BullMQ queue in one test, a recording one in the others) and the job re-fetches the message from the in-process WAHA mock
// (infra/waha-mock, which records every call) and marks the WHOLE chat as read. What public does with the webhook (which messages are handed over at all) is
// apps/public/test/waha-webhook.int.test.ts. Every rig has a ring and a cursor of its own, so no test sees another's items.
import { createHash, randomBytes } from "node:crypto";
import { WahaError } from "@ebooktrivia/adapters";
import { loadPublicValkeyFunctions, WA_READ_FUNCTION, WA_READ_RING_SIZE, waReadCall, waReadKeys } from "@ebooktrivia/adapters/valkey-functions";
import { HUMAN_TIMING } from "@ebooktrivia/core";
import { type Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cryptoRandom } from "../src/delivery/human.ts";
import { type WahaAccess, WahaAccessError } from "../src/delivery/ports.ts";
import { createReadMarks, READ_BATCH, READ_MARK_CAP_PER_MINUTE, READ_QUEUE, readJobId } from "../src/delivery/read-marks.ts";
import { createLogger } from "../src/log.ts";
import { createQueue, redisOptions } from "../src/queues.ts";
import { createSession, createWahaFake, retireSessions } from "./support/delivery.ts";
import { silentLog, uniquePhone, workerPool } from "./support/midtrans.ts";
import { obliterate, testValkey, uniquePrefix } from "./support/valkey.ts";

const workerSql = workerPool(4);
const redis = new Redis({ ...redisOptions(testValkey()), maxRetriesPerRequest: 1 });
const namespaces = new Set<string>();

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

interface Added {
  readonly name: string;
  readonly data: { readonly session: string; readonly messageId: string; readonly digest: string };
  readonly opts: { readonly jobId: string; readonly delay: number; readonly attempts: number; readonly removeOnComplete: boolean };
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
    prefix,
    namespace,
    ...(over.now === undefined ? {} : { now: over.now }),
    ...(over.random === undefined ? {} : { random: over.random }),
  });
  /** A message arrives at a number (registered in WAHA, as the webhook would announce it) and public hands it over: the real function, as the public user calls it. */
  async function arrive(session: string, chatId: string, body = "halo, ebooknya mana?"): Promise<{ messageId: string; digest: string; n: number }> {
    const messageId = await waha.inbound({ session, chatId, body });
    const digest = digestOf(session, chatId);
    const call = waReadCall(namespace, { session, messageId, digest });
    if (call === null) throw new Error("the item is well formed");
    const n = Number(await redis.fcall(WA_READ_FUNCTION, call.keys.length, ...call.keys, ...call.args));
    return { messageId, digest, n };
  }
  /** What WAHA was asked besides the lookups: the path (presence calls as one) and the body. */
  const calls = async () => (await waha.callLog()).map((c) => ({ path: c.path.replace(/^\/api\/[^/]+\/presence$/, "/presence"), body: c.body }));
  return { waha, added, queue, marks, arrive, calls, ring, prefix, namespace };
}

describe("the job marks the whole chat as read, and puts the number offline again", () => {
  it("a stranger's chatter in a phone chat: sendSeen of the whole chat (no message ids) on the receiving number, then offline; nothing is typed or sent", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const { messageId, digest } = await r.arrive(session.name, chatId);
    expect(await redis.exists(r.ring.pending(digest))).toBe(1);
    await r.waha.clearCallLog();
    expect(await r.marks.process({ session: session.name, messageId, digest })).toBe("marked");
    expect(await r.calls()).toEqual([
      { path: "/api/sendSeen", body: { session: session.name, chatId } },
      { path: "/presence", body: { presence: "offline" } },
    ]);
    expect(r.waha.sent).toEqual([]);
    // The chat's pending mark was released first: its next message starts a read of its own.
    expect(await redis.exists(r.ring.pending(digest))).toBe(0);
  });

  it("an @lid chat and a personal number of another country are marked under their own chat id", async () => {
    const r = rig();
    const session = await createSession();
    for (const chatId of [`${String(Math.floor(10_000_000_000 + Math.random() * 8_999_999_999))}@lid`, `1415555${String(Math.floor(1000 + Math.random() * 8999))}@c.us`]) {
      const { messageId, digest } = await r.arrive(session.name, chatId);
      await r.waha.clearCallLog();
      expect(await r.marks.process({ session: session.name, messageId, digest }), chatId).toBe("marked");
      expect((await r.calls())[0], chatId).toEqual({ path: "/api/sendSeen", body: { session: session.name, chatId } });
    }
  });

  it("marks nothing for a message of ours, one WAHA does not know, or an id that is no person's chat (a group, a status, a channel): a forged hint drives nothing", async () => {
    const r = rig();
    const session = await createSession();
    const chatId = personalChat();
    const digest = digestOf(session.name, chatId);
    // The id of a message the mock REALLY sent in a phone chat (fromMe after the re-fetch).
    const ours = await r.waha.access.withSession(session.id, ({ sessionName, client }) => client.sendText(sessionName, chatId, "halo kak"));
    await r.waha.clearCallLog();
    expect(await r.marks.process({ session: session.name, messageId: ours.id, digest })).toBe("ignored");
    // Never seen by WAHA: forged.
    expect(await r.marks.process({ session: session.name, messageId: `false_${chatId}_FORGED00001`, digest })).toBe("unverified");
    // Not a person's chat, or not an id at all: refused before anything is asked of WAHA.
    for (const messageId of ["false_120363025246125486@g.us_AAAA1111", "false_status@broadcast_AAAA1111", "false_120363098765432101@newsletter_AAAA1111", "nonsense"]) {
      expect(await r.marks.process({ session: session.name, messageId, digest }), messageId).toBe("invalid");
    }
    for (const bad of [null, "x", {}, { session: session.name }, { session: 7, messageId: "x", digest: "y" }, { session: session.name, messageId: ours.id, digest: "short" }]) expect(await r.marks.process(bad)).toBe("invalid");
    expect(await r.calls()).toEqual([]);
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
    expect(await failingSeen.marks.process({ session: session.name, messageId: a.messageId, digest: a.digest })).toBe("seen_failed");
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
    expect(await unopenable.marks.process({ session: session.name, messageId: b.messageId, digest: b.digest })).toBe("seen_session_unusable");
    // A WAHA that cannot be asked about the message at all.
    const down = rig();
    const c = await down.arrive(session.name, chatId);
    down.waha.outage(session.name, true);
    expect(await down.marks.process({ session: session.name, messageId: c.messageId, digest: c.digest })).toBe("refetch_failed");
    // A WAHA whose presence calls answer 500.
    const faulty = rig();
    const d = await faulty.arrive(session.name, chatId);
    await faulty.waha.presenceFault("http500");
    try {
      expect(await faulty.marks.process({ session: session.name, messageId: d.messageId, digest: d.digest })).toBe("seen_failed");
    } finally {
      await faulty.waha.presenceFault("ok");
    }
  });

  it("logs a failure as a code per event (debug) and as ONE warning a minute with the counts, never a number, a chat id or a text", async () => {
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
    const { messageId, digest } = await r.arrive(session.name, chatId, "halo, ini rahasia 081234567890");
    const job = { session: session.name, messageId, digest };
    for (let i = 0; i < 5; i++) expect(await r.marks.process(job)).toBe("seen_key_missing");
    expect(lines.filter((l) => l.msg === "a read mark did not go through")).toHaveLength(5);
    // The first failure warns at once, the next four within the minute do not.
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "seen:key_missing": 1 }]);
    clock += 61_000;
    await r.marks.process(job);
    expect(lines.filter((l) => l.msg === "read marks are failing or skipped").map((l) => l.failures)).toEqual([{ "seen:key_missing": 1 }, { "seen:key_missing": 5 }]);
    const text = JSON.stringify(lines);
    expect(text).toContain('"code":"key_missing"');
    expect(text).toContain('"step":"seen"');
    expect(text).not.toContain(chatId);
    expect(text).not.toContain(chatId.split("@")[0] ?? "x");
    expect(text).not.toContain("rahasia");
  });
});

describe("the poll takes the ring and schedules one delayed job per message", () => {
  it("schedules each new item once, after a random reading pause, with a deterministic job id and nothing kept after it is done; a second poll finds nothing", async () => {
    const r = rig();
    const session = await createSession();
    const first = await r.arrive(session.name, personalChat());
    const second = await r.arrive(session.name, personalChat());
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added.map((a) => a.data.messageId)).toEqual([first.messageId, second.messageId]);
    for (const job of r.added) {
      expect(job.name).toBe(READ_QUEUE);
      expect(job.opts.jobId).toBe(readJobId(job.data.messageId));
      expect(job.opts.jobId).toMatch(/^read-[0-9a-f]{32}$/);
      expect(job.opts.delay).toBeGreaterThanOrEqual(HUMAN_TIMING.reading[0]);
      expect(job.opts.delay).toBeLessThanOrEqual(HUMAN_TIMING.reading[1]);
      expect(job.opts).toMatchObject({ attempts: 1, removeOnComplete: true });
    }
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toHaveLength(2);
    // A third message is the only new one.
    const third = await r.arrive(session.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.map((a) => a.data.messageId)).toEqual([first.messageId, second.messageId, third.messageId]);
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
    await r.marks.process({ session: session.name, messageId: a.messageId, digest: a.digest });
    const c = await r.arrive(session.name, chatId, "halo?");
    expect(c.n).toBeGreaterThan(0);
  });

  it(`a number's budget is ${String(READ_MARK_CAP_PER_MINUTE)} marks a minute: the rest is let go (and their chats may try again), another number and the next minute are not affected`, async () => {
    let clock = Date.UTC(2026, 10, 24, 1, 0, 10);
    const r = rig({ now: () => clock });
    const busy = await createSession();
    const quiet = await createSession();
    const arrived: { messageId: string; digest: string }[] = [];
    for (let i = 0; i < READ_MARK_CAP_PER_MINUTE + 4; i++) arrived.push(await r.arrive(busy.name, personalChat()));
    while (await r.marks.poll(r.queue)) continue;
    expect(r.added.filter((a) => a.data.session === busy.name)).toHaveLength(READ_MARK_CAP_PER_MINUTE);
    // Those over the budget were not scheduled and their chats' pending marks are gone, so their next message can try again.
    const scheduled = new Set(r.added.map((a) => a.data.messageId));
    const skipped = arrived.filter((m) => !scheduled.has(m.messageId));
    expect(skipped).toHaveLength(4);
    for (const m of skipped) expect(await redis.exists(r.ring.pending(m.digest))).toBe(0);
    for (const m of arrived.filter((x) => scheduled.has(x.messageId))) expect(await redis.exists(r.ring.pending(m.digest))).toBe(1);
    // Another number has a budget of its own.
    await r.arrive(quiet.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.filter((a) => a.data.session === quiet.name)).toHaveLength(1);
    // The next minute starts again.
    clock += 60_000;
    await r.arrive(busy.name, personalChat());
    await r.marks.poll(r.queue);
    expect(r.added.filter((a) => a.data.session === busy.name)).toHaveLength(READ_MARK_CAP_PER_MINUTE + 1);
    // The budget's keys are under the worker's own prefix and expire.
    const keys = await scanned(`${r.prefix}:wa-read:cap:${busy.name}:*`);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await redis.ttl(key)).toBeGreaterThan(0);
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
    const digest = "0123456789abcdef0123456789abcdef";
    const messageId = `false_${personalChat()}_LAP000001`;
    const head = WA_READ_RING_SIZE * 2 + 3;
    // The counter is far ahead (a long-running ring): the cursor starts at the oldest slot that can still hold an item.
    await redis.set(r.ring.seq, String(head));
    await redis.set(r.ring.item(head), `${String(head)}|${session.name}|${messageId}|${digest}`);
    // The slot of an item of ANOTHER lap, and junk, in two others of the window.
    await redis.set(r.ring.item(head - 2), `${String(WA_READ_RING_SIZE + 1)}|${session.name}|${messageId}|${digest}`);
    await redis.set(r.ring.item(head - 1), "not an item");
    for (let i = 0; i < 40 && (await r.marks.poll(r.queue)); i++) continue;
    expect(r.added.map((a) => a.data.messageId)).toEqual([messageId]);
    // The counter restarted (it had expired): a cursor ahead of it starts over.
    await redis.set(r.ring.seq, "1");
    const restarted = `false_${personalChat()}_RESTART001`;
    await redis.set(r.ring.item(1), `1|${session.name}|${restarted}|${digest}`);
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added.map((a) => a.data.messageId)).toEqual([messageId, restarted]);
    // Nothing at all while the counter does not exist.
    await redis.del(r.ring.seq);
    expect(await r.marks.poll(r.queue)).toBe(false);
  });

  it("a failure to schedule leaves the cursor where it was: the same items are taken again at the next tick", async () => {
    const r = rig();
    const session = await createSession();
    await r.arrive(session.name, personalChat());
    const broken = { add: () => Promise.reject(new Error("valkey down")) } as unknown as Pick<Queue, "add">;
    await expect(r.marks.poll(broken)).rejects.toThrow("valkey down");
    expect(await r.marks.poll(r.queue)).toBe(false);
    expect(r.added).toHaveLength(1);
  });

  it("end to end on a real BullMQ queue: the delayed job runs after its pause, marks the chat, and leaves no job behind", async () => {
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
