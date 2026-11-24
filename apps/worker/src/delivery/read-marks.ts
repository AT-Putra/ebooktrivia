// Read marks (Owner rule, 2026-11-24: "always give read mark to all of msg sent to our wa number ... it will be suspected if you sent msg but the older msg not in seen
// state"; WAHA "How to avoid blocking": send seen before processing the message). EVERY incoming personal WhatsApp message gets its whole chat marked as read, whether the
// webhook stored it for the inbound consumer or dropped it (chatter with no order code, a rate-limited sender, a foreign number): a cheap path of its own, with no
// database write and no worker slot held asleep:
//
//   1. public    the webhook calls the worker-loaded Valkey function ebt_wa_read_v1 for each message (apps/public/src/lib/webhooks/waha.ts, enqueueWaRead): one pending read per
//                chat, a CAPPED ring of {session, SEALED message id, chat digest} under cache:public:wa-read:* (2000 items, 10 minutes). Best effort there. The message id
//                embeds the sender's phone and Valkey keeps an AOF on disk, so it is sealed to the messaging public key (@ebooktrivia/crypto wa-read.ts): the ring and the
//                jobs hold only the sealed blob, and only this process, which has the private key, opens it.
//   2. poll      the worker (under a lock, so a second process never double-spends or moves the cursor back) takes the ring's new items in order (a cursor in Valkey; a lap
//                that overwrote an item loses it, a stale one is let go). Per item it first applies the CHAT's cap (READ_MARK_CAP_PER_CHAT marks a minute: a chatty chat cannot
//                spend the number's budget, and everything past it is covered by ONE trailing job at the start of the next minute that marks the whole chat, so its last message
//                is still marked), then reserves a mark of the NUMBER's budget (READ_MARK_CAP_PER_MINUTE a minute; when this minute's is spent it takes the next minute's that
//                has one, up to the item's ten minutes: deferred, not dropped), and schedules a DELAYED BullMQ job (the reading pause of core HUMAN_TIMING.reading, drawn from
//                the cryptographic source, after the reserved minute starts): nobody sleeps, and a restart keeps the job in Valkey. The job id comes from the plaintext id.
//   3. job       the delayed job re-fetches the message by id on that session (the webhook is untrusted: a forged one drives nothing), skips our own messages and anything
//                that is not a person's chat, and marks the WHOLE chat as read (sendSeen without message ids), then puts the session offline again like every send of the
//                worker (human.ts), unless a human-like send of the same number is in flight: its "typing..." must not be cut by an offline, and it ends offline itself.
//                The chat's pending mark is released FIRST, so a message that arrives from then on starts a read of its own (the mark covers everything up to the call).
// Best effort throughout: a failure is a code (never a phone, a chat id or a text) logged per event at debug and, rate-limited, as ONE warning a minute with the counts
// (flushed from the poll's own tick, so the last minute is reported too), so a sendSeen that is broken everywhere, or a poll that fails every second, is seen as one line a
// minute. Nothing here ever sends a message or touches a delivery.
import { isPersonalChatId, WahaError } from "@ebooktrivia/adapters";
import { parseWaReadItem, WA_READ_ITEM_TTL_S, WA_READ_NAMESPACE, WA_READ_RING_SIZE, type WaReadItem, waReadKeys, waReadPayload } from "@ebooktrivia/adapters/valkey-functions";
import { HUMAN_PRESENCE_TIMEOUT_MS, HUMAN_TIMING, sampleLogNormal } from "@ebooktrivia/core";
import type { WaReadOpener } from "@ebooktrivia/crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { cryptoRandom, isSending } from "./human.ts";
import { type WahaAccess, WahaAccessError } from "./ports.ts";
import { type Fetched, refetchMessage } from "./refetch.ts";

export const READ_QUEUE = "wa.read";
/** At most this many read marks per number (session) per minute: a flood of chats costs the budget and never WAHA; what is over it waits for a later minute. */
export const READ_MARK_CAP_PER_MINUTE = 60;
/** At most this many read marks per chat per number per minute; the rest of that minute's messages of the chat share ONE trailing job. */
export const READ_MARK_CAP_PER_CHAT = 3;
/** How often the ring is looked at; a batch that finds more waiting is followed at once. */
export const READ_POLL_INTERVAL_MS = 1000;
/** The items taken from the ring per tick. */
export const READ_BATCH = 100;
/** How many minutes ahead a mark may wait for a minute with budget left: an item lives ten (WA_READ_ITEM_TTL_S), so it is marked within that. */
export const READ_DEFER_MINUTES = WA_READ_ITEM_TTL_S / 60 - 1;
/** The poll's lock: a tick that dies leaves it for this long. */
export const READ_POLL_LOCK_MS = 15_000;
/** The re-fetch is a quick read. */
const LOOKUP_TIMEOUT_MS = 10_000;
const CURSOR_TTL_SECONDS = 86_400;
/** A counter of a window lives until the window is over and a minute after it (a reserved future minute: longer, see reserve). */
const COUNTER_TTL_SECONDS = 120;
const CHAT_COUNTER_TTL_SECONDS = 180;
const WINDOW_MS = 60_000;
/** A failed read job is kept this long for diagnostics (its data is a sealed id, but a chat's digest is still a handle), a finished one not at all. */
const FAILED_KEEP_SECONDS = 3600;
const WARN_EVERY_MS = 60_000;

/** The Valkey calls the read path makes on the worker's connection. */
export type ReadMarkValkey = Pick<Redis, "get" | "mget" | "set" | "incr" | "decr" | "del">;

export interface ReadMarkDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  readonly valkey: ReadMarkValkey;
  /** Opens the sealed message ids (the messaging private key). */
  readonly opener: WaReadOpener;
  /** The worker's key prefix (its own keys: the cursor, the lock and the budgets). */
  readonly prefix: string;
  /** Where public's ring lives (default WA_READ_NAMESPACE); a test uses one of its own. */
  readonly namespace?: string;
  /** The reading pauses' random source (default: the operating system's CSPRNG). */
  readonly random?: () => number;
  /** Wall clock in ms (default Date.now). */
  readonly now?: () => number;
}

export interface ReadMarks {
  readonly queue: string;
  readonly intervalMs: number;
  /** Takes the ring's new items and schedules their reads on `queue`; true when more are waiting (run again at once). Never throws: a failure is counted and reported once a minute. */
  readonly poll: (queue: Pick<Queue, "add">) => Promise<boolean>;
  /** The delayed job: re-fetch, mark the chat as read, offline again. Answers a code; never throws for WAHA's or Valkey's failures. */
  readonly process: (data: unknown) => Promise<string>;
}

/** The id of a message's read job: a digest of the plaintext id, so BullMQ's own key never holds the chat id, and a message is scheduled once while its job lives. */
export const readJobId = (messageId: string): string => `read-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;
/** The id of the ONE trailing job of a chat in a window (a minute): it marks the whole chat, so the last message of a chatty chat is marked too. */
export const trailingJobId = (digest: string, window: number): string => `read-t-${digest}-${String(window)}`;

const codeOf = (error: unknown): string => (error instanceof WahaError || error instanceof WahaAccessError ? error.code : "failed");

export function createReadMarks(deps: ReadMarkDeps): ReadMarks {
  const { sql, log, valkey, prefix, opener } = deps;
  const random = deps.random ?? cryptoRandom;
  const now = deps.now ?? Date.now;
  const keys = waReadKeys(deps.namespace ?? WA_READ_NAMESPACE);
  const cursorKey = `${prefix}:wa-read:cursor`;
  const lockKey = `${prefix}:wa-read:lock`;
  const capKey = (session: string, minute: number): string => `${prefix}:wa-read:cap:${session}:${String(minute)}`;
  const chatKey = (digest: string, minute: number): string => `${prefix}:wa-read:chat:${digest}:${String(minute)}`;
  const minuteOf = (ms: number): number => Math.floor(ms / WINDOW_MS);

  // One warning a minute, with how many failed and how (a code each), whatever the number of messages: a sendSeen that fails for everyone, or a poll that fails every
  // tick, must be visible; a single failure is only a debug line. Flushed from every failure and from the poll's tick, so the last minute's counts are reported too.
  const tally = new Map<string, number>();
  let warnedAt = Number.NEGATIVE_INFINITY;
  const flush = (): void => {
    if (tally.size === 0 || now() - warnedAt < WARN_EVERY_MS) return;
    warnedAt = now();
    log.warn({ failures: Object.fromEntries(tally) }, "read marks are failing or skipped");
    tally.clear();
  };
  const failed = (step: string, code: string, fields: Record<string, unknown> = {}): string => {
    log.debug({ step, code, ...fields }, "a read mark did not go through");
    const key = `${step}:${code}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    flush();
    return `${step}_${code}`;
  };

  /** A counter of a window, ATOMIC with its life: the key is created at 0 with its TTL (SET NX EX) and then incremented, so it never exists without one. */
  async function bump(key: string, ttlSeconds: number): Promise<number> {
    await valkey.set(key, "0", "EX", ttlSeconds, "NX");
    return valkey.incr(key);
  }

  /**
   * Reserves one mark of the number's budget: this minute's while it has any (unless `minutesAhead` says not before a later one), else the next minute's that has one, up to
   * READ_DEFER_MINUTES ahead (the item's life). The answer is how long to wait until that minute starts (0: now) and the counter it spent, or undefined when every one of
   * them is spent.
   */
  async function reserve(session: string, minutesAhead: number): Promise<{ readonly wait: number; readonly key: string } | undefined> {
    const t = now();
    const here = minuteOf(t);
    for (let k = minutesAhead; k <= READ_DEFER_MINUTES; k++) {
      // A counter for a minute k ahead lives until that minute is over and a minute more.
      const key = capKey(session, here + k);
      if ((await bump(key, COUNTER_TTL_SECONDS + 60 * k)) <= READ_MARK_CAP_PER_MINUTE) return { wait: k === 0 ? 0 : (here + k) * WINDOW_MS - t, key };
    }
    return undefined;
  }

  async function take(item: WaReadItem, messageId: string, queue: Pick<Queue, "add">): Promise<"scheduled" | "deferred" | "trailing" | "covered" | "over_budget"> {
    const window = minuteOf(now());
    // The chat's own cap first: a chatty chat must not spend the number's budget. The message past it is covered by the window's ONE trailing job (the first past the cap
    // schedules it, the rest find it there): it runs when the window is over and marks the whole chat, so the chat's last message is marked too.
    const chat = chatKey(item.digest, window);
    const inWindow = await bump(chat, CHAT_COUNTER_TTL_SECONDS);
    if (inWindow > READ_MARK_CAP_PER_CHAT + 1) return "covered";
    const trailing = inWindow === READ_MARK_CAP_PER_CHAT + 1;
    const reserved = await reserve(item.session, trailing ? 1 : 0);
    if (reserved === undefined) {
      // No minute within the item's life has a mark left: let the chat's pending mark go so its next message can try again (and its window start over).
      await valkey.del(keys.pending(item.digest));
      if (trailing) await valkey.del(chat);
      return "over_budget";
    }
    try {
      await queue.add(READ_QUEUE, { session: item.session, sealed: item.sealed, digest: item.digest }, {
        jobId: trailing ? trailingJobId(item.digest, window) : readJobId(messageId),
        delay: reserved.wait + sampleLogNormal(random, HUMAN_TIMING.reading),
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: FAILED_KEEP_SECONDS, count: 100 },
      });
    } catch (error) {
      // Nothing was scheduled and the tick will take this item again: what it spent is given back, or every retry would spend it again (and a chat would turn "covered" by
      // a trailing job that does not exist). Best effort: a Valkey that cannot do this either has failed everything else too.
      await Promise.all([valkey.decr(chat), valkey.decr(reserved.key)]).catch(() => undefined);
      throw error;
    }
    return trailing ? "trailing" : reserved.wait > 0 ? "deferred" : "scheduled";
  }

  /** One tick of the ring, the lock held (`token`): the new items, in order, then the cursor. */
  async function takeRing(queue: Pick<Queue, "add">, token: string): Promise<boolean> {
    const seq = Number(await valkey.get(keys.seq));
    if (!Number.isSafeInteger(seq) || seq < 1) return false;
    const stored = await valkey.get(cursorKey);
    const known = stored === null ? Number.NaN : Number(stored);
    // No cursor yet: whatever the ring still holds. A cursor ahead of the counter: the counter restarted (it had expired), start over. Items a lap overwrote are gone.
    let cursor = Number.isSafeInteger(known) && known >= 0 ? known : 0;
    if (cursor > seq) cursor = 0;
    cursor = Math.max(cursor, seq - WA_READ_RING_SIZE);
    if (cursor >= seq) return false;
    const last = Math.min(seq, cursor + READ_BATCH);
    const slots = Array.from({ length: last - cursor }, (_, i) => keys.item(cursor + 1 + i));
    const values = await valkey.mget(...slots);
    // The cursor moves only while the lock is still ours (a tick that outlived it must not move the cursor, nor move it back), and after EACH item that was taken: a later item
    // that fails (the queue is down) leaves the earlier ones done, and this tick's retry finds the cursor right behind the one that failed.
    const commit = async (n: number): Promise<boolean> => {
      if ((await valkey.get(lockKey)) !== token) return false;
      await valkey.set(cursorKey, String(n), "EX", CURSOR_TTL_SECONDS);
      return true;
    };
    for (const [i, value] of values.entries()) {
      const n = cursor + 1 + i;
      const item = parseWaReadItem(value);
      // A missing, expired or overwritten slot (the item of another lap) or a value that is not an item at all drives nothing.
      if (item === undefined || item.n !== n) continue;
      let messageId: string | undefined;
      try {
        messageId = opener.open({ session: item.session, digest: item.digest, sealed: Buffer.from(item.sealed, "base64url") });
      } catch {
        // Sealed to another key, or not by us at all: nothing to read.
        failed("open", "decrypt_failed");
      }
      if (messageId !== undefined && (await take(item, messageId, queue)) === "over_budget") failed("budget", "over_budget");
      if (!(await commit(n))) return false;
    }
    if (!(await commit(last))) return false;
    return last < seq;
  }

  return {
    queue: READ_QUEUE,
    intervalMs: READ_POLL_INTERVAL_MS,

    async poll(queue) {
      const token = randomBytes(8).toString("hex");
      try {
        // One poller at a time, whatever the number of worker processes: a second one finds the lock and leaves the tick to the first.
        if ((await valkey.set(lockKey, token, "PX", READ_POLL_LOCK_MS, "NX")) !== "OK") return false;
        try {
          return await takeRing(queue, token);
        } finally {
          // Released only while it is still ours; a failure to release is not worth a failed tick (the lock expires).
          await valkey
            .get(lockKey)
            .then((held) => (held === token ? valkey.del(lockKey) : undefined))
            .catch(() => undefined);
        }
      } catch (error) {
        // The same failure every second would be a line a second: it is counted and told once a minute, and the next tick tries again from the same cursor.
        failed("poll", codeOf(error));
        return false;
      } finally {
        flush();
      }
    },

    async process(data) {
      const record = typeof data === "object" && data !== null ? (data as { session?: unknown; sealed?: unknown; digest?: unknown }) : {};
      const { session, sealed, digest } = record;
      if (typeof session !== "string" || typeof sealed !== "string" || typeof digest !== "string") return "invalid";
      const item: WaReadItem = { session, sealed, digest };
      if (waReadPayload(item) === null) return "invalid";
      let messageId: string;
      try {
        messageId = opener.open({ session, digest, sealed: Buffer.from(sealed, "base64url") });
      } catch {
        return failed("open", "decrypt_failed");
      }
      // The chat's pending mark goes first: a message that arrives from now on starts a read of its own, and this call marks everything before it.
      await valkey.del(keys.pending(digest)).catch(() => undefined);
      let fetched: Fetched | "unverified";
      try {
        fetched = await refetchMessage({ sql, waha: deps.waha }, session, messageId, LOOKUP_TIMEOUT_MS);
      } catch (error) {
        return failed("refetch", codeOf(error));
      }
      // A message WAHA does not know (a forged hint), one of ours, or a chat that is not a person's marks nothing. (A message id that is not a person's chat is refused by the
      // re-fetch itself, which only knows ids of that shape: the chat check below cannot fire today. It stays so that a change of either shape can never give a group, a
      // status or a channel a read mark.)
      if (fetched === "unverified") return "unverified";
      if (fetched.fromMe || !isPersonalChatId(fetched.chat.chatId)) return "ignored";
      const { chatId } = fetched.chat;
      try {
        await deps.waha.withSession(
          fetched.sessionId,
          async ({ sessionName, client }) => {
            try {
              await client.sendSeen(sessionName, chatId);
            } finally {
              // Like every send of the worker: the session shows offline again (while it shows online the phone gets no notifications), best effort. NOT while a human-like
              // send of this number is in flight: its "typing..." (2 to 14 s) would be cut, and that send puts the number offline itself when it is done.
              if (!isSending(sessionName)) await client.setOffline(sessionName).catch(() => undefined);
            }
          },
          { timeoutMs: HUMAN_PRESENCE_TIMEOUT_MS },
        );
      } catch (error) {
        return failed("seen", codeOf(error), { sessionId: fetched.sessionId });
      }
      return "marked";
    },
  };
}
