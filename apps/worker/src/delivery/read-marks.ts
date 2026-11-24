// Read marks (Owner rule, 2026-11-24: "always give read mark to all of msg sent to our wa number ... it will be suspected if you sent msg but the older msg not in seen
// state"; WAHA "How to avoid blocking": send seen before processing the message). EVERY incoming personal WhatsApp message gets its whole chat marked as read, whether the
// webhook stored it for the inbound consumer or dropped it (chatter with no order code, a rate-limited sender, a foreign number): a cheap path of its own, with no
// database write and no worker slot held asleep:
//
//   1. public    the webhook calls the worker-loaded Valkey function ebt_wa_read_v1 for each message (apps/public/src/lib/webhooks/waha.ts, enqueueWaRead): one pending read per
//                chat, a CAPPED ring of {session, message id, chat digest} under cache:public:wa-read:* (2000 items, 10 minutes). Best effort there.
//   2. poll      the worker takes the ring's new items in order (a cursor in Valkey; a lap that overwrote an item loses it, a stale one is let go), and for each one
//                spends the NUMBER's budget (READ_MARK_CAP_PER_MINUTE marks per session per minute: a flood costs the budget, never WAHA) and schedules a DELAYED BullMQ job
//                (the reading pause of core HUMAN_TIMING.reading, drawn from the cryptographic source): nobody sleeps, and a restart keeps the job in Valkey.
//   3. job       the delayed job re-fetches the message by id on that session (the webhook is untrusted: a forged one drives nothing), skips our own messages and anything
//                that is not a person's chat, and marks the WHOLE chat as read (sendSeen without message ids), then puts the session offline again like every send of the
//                worker (human.ts). The chat's pending mark is released FIRST, so a message that arrives from then on starts a read of its own (the mark covers everything
//                up to the call).
// Best effort throughout: a failure is a code (never a phone, a chat id or a text) logged per event at debug and, rate-limited, as ONE warning a minute with the counts, so a
// sendSeen that is broken everywhere is seen. Nothing here ever sends a message or touches a delivery.
import { isPersonalChatId, WahaError } from "@ebooktrivia/adapters";
import { parseWaReadItem, WA_READ_NAMESPACE, WA_READ_RING_SIZE, type WaReadItem, waReadKeys, waReadPayload } from "@ebooktrivia/adapters/valkey-functions";
import { HUMAN_PRESENCE_TIMEOUT_MS, HUMAN_TIMING, sampleLogNormal } from "@ebooktrivia/core";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { cryptoRandom } from "./human.ts";
import { type WahaAccess, WahaAccessError } from "./ports.ts";
import { type Fetched, refetchMessage } from "./refetch.ts";

export const READ_QUEUE = "wa.read";
/** At most this many read marks per number (session) per minute: over it the mark is skipped, so a flood of chats costs the budget and never WAHA. */
export const READ_MARK_CAP_PER_MINUTE = 60;
/** How often the ring is looked at; a batch that finds more waiting is followed at once. */
export const READ_POLL_INTERVAL_MS = 1000;
/** The items taken from the ring per tick. */
export const READ_BATCH = 100;
/** The re-fetch is a quick read. */
const LOOKUP_TIMEOUT_MS = 10_000;
const CURSOR_TTL_SECONDS = 86_400;
const CAP_TTL_SECONDS = 120;
/** A failed read job is kept this long for diagnostics (its data names a chat through the message id), a finished one not at all. */
const FAILED_KEEP_SECONDS = 3600;
const WARN_EVERY_MS = 60_000;

/** The Valkey calls the read path makes on the worker's connection. */
export type ReadMarkValkey = Pick<Redis, "get" | "mget" | "set" | "incr" | "expire" | "del">;

export interface ReadMarkDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  readonly valkey: ReadMarkValkey;
  /** The worker's key prefix (its own keys: the cursor and the per-number budget). */
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
  /** Takes the ring's new items and schedules their reads on `queue`; true when more are waiting (run again at once). */
  readonly poll: (queue: Pick<Queue, "add">) => Promise<boolean>;
  /** The delayed job: re-fetch, mark the chat as read, offline again. Answers a code; never throws for WAHA's or Valkey's failures. */
  readonly process: (data: unknown) => Promise<string>;
}

/** The id of a message's read job: a digest, so BullMQ's own key never holds the chat id, and a message is scheduled once while its job lives. */
export const readJobId = (messageId: string): string => `read-${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}`;

const codeOf = (error: unknown): string => (error instanceof WahaError || error instanceof WahaAccessError ? error.code : "failed");

export function createReadMarks(deps: ReadMarkDeps): ReadMarks {
  const { sql, log, valkey, prefix } = deps;
  const random = deps.random ?? cryptoRandom;
  const now = deps.now ?? Date.now;
  const keys = waReadKeys(deps.namespace ?? WA_READ_NAMESPACE);
  const cursorKey = `${prefix}:wa-read:cursor`;
  const capKey = (session: string): string => `${prefix}:wa-read:cap:${session}:${String(Math.floor(now() / 60_000))}`;

  // One warning a minute, with how many failed and how (a code each), whatever the number of messages: a sendSeen that fails for everyone must be visible, a single
  // failure is only a debug line.
  const tally = new Map<string, number>();
  let warnedAt = Number.NEGATIVE_INFINITY;
  const failed = (step: string, code: string, fields: Record<string, unknown> = {}): string => {
    log.debug({ step, code, ...fields }, "a read mark did not go through");
    const key = `${step}:${code}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (now() - warnedAt >= WARN_EVERY_MS) {
      warnedAt = now();
      log.warn({ failures: Object.fromEntries(tally) }, "read marks are failing or skipped");
      tally.clear();
    }
    return `${step}_${code}`;
  };

  /** Spends one of the number's marks for this minute; false when it is spent. */
  async function underBudget(session: string): Promise<boolean> {
    const key = capKey(session);
    const count = await valkey.incr(key);
    await valkey.expire(key, CAP_TTL_SECONDS);
    return count <= READ_MARK_CAP_PER_MINUTE;
  }

  async function take(item: WaReadItem, queue: Pick<Queue, "add">): Promise<"scheduled" | "over_budget"> {
    if (!(await underBudget(item.session))) {
      // Not scheduled: the chat's pending mark is let go, so its next message can try again within the budget.
      await valkey.del(keys.pending(item.digest));
      return "over_budget";
    }
    await queue.add(READ_QUEUE, { session: item.session, messageId: item.messageId, digest: item.digest }, {
      jobId: readJobId(item.messageId),
      delay: sampleLogNormal(random, HUMAN_TIMING.reading),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: FAILED_KEEP_SECONDS, count: 100 },
    });
    return "scheduled";
  }

  return {
    queue: READ_QUEUE,
    intervalMs: READ_POLL_INTERVAL_MS,

    async poll(queue) {
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
      for (const [i, value] of values.entries()) {
        const item = parseWaReadItem(value);
        // A missing, expired or overwritten slot (the item of another lap) or a value that is not an item at all drives nothing.
        if (item === undefined || item.n !== cursor + 1 + i) continue;
        const outcome = await take(item, queue);
        if (outcome === "over_budget") failed("budget", "over_budget");
      }
      await valkey.set(cursorKey, String(last), "EX", CURSOR_TTL_SECONDS);
      return last < seq;
    },

    async process(data) {
      const record = typeof data === "object" && data !== null ? (data as { session?: unknown; messageId?: unknown; digest?: unknown }) : {};
      const { session, messageId, digest } = record;
      if (typeof session !== "string" || typeof messageId !== "string" || typeof digest !== "string") return "invalid";
      const item: WaReadItem = { session, messageId, digest };
      if (waReadPayload(item) === null) return "invalid";
      // The chat's pending mark goes first: a message that arrives from now on starts a read of its own, and this call marks everything before it.
      await valkey.del(keys.pending(item.digest)).catch(() => undefined);
      let fetched: Fetched | "unverified";
      try {
        fetched = await refetchMessage({ sql, waha: deps.waha }, item.session, item.messageId, LOOKUP_TIMEOUT_MS);
      } catch (error) {
        return failed("refetch", codeOf(error));
      }
      // A message WAHA does not know (a forged hint), one of ours, or a chat that is not a person's marks nothing.
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
              // Like every send of the worker: the session shows offline again (while it shows online the phone gets no notifications). Best effort.
              await client.setOffline(sessionName).catch(() => undefined);
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
