// The human-like sequence of every WhatsApp send of the worker (US-025, Owner requirement; WAHA docs "How to avoid blocking", "Presence"). The pauses come
// from core human-send.ts (log-normal, clamped, drawn per message from a cryptographic source: never a fixed timing, never a seeded sequence); this runs them:
//
//   1. seen        a reply marks the buyer's message as read (an opener and an OTP have none), best effort;
//   2. reading     a random pause;
//   3. typing      the "typing..." presence starts, best effort;
//   4. typing wait a random wait scaled to the length of the message;
//   5. paused      the typing presence ends, best effort;
//   6. a short random pause;
//   7. SEND        the one call that counts: its outcome is the caller's, untouched by anything above;
//   8. offline     the session shows offline again, best effort (while it shows online the phone gets no notifications).
//
// Seen, typing, paused and offline are BEST EFFORT: each has a short budget, its failure is only logged (a code, never a number or a text), and it never
// fails, retries or counts against the send, and never makes it maybe_sent: the send is the first thing in the sequence that can. No database lock or
// transaction is held across any of it (the caller holds none). If the abort signal ends during a wait the send is NOT made: `aborted`, which the delivery
// turns into not_attempted. The caller also gets `beforeSend` (a last check that the claim's lease can still cover the send) and the waits are injectable.
import type { WahaClient } from "@ebooktrivia/adapters";
import { type HumanKind, humanPlan } from "@ebooktrivia/core";
import { randomInt } from "node:crypto";
import type { Logger } from "../log.ts";

/** Uniform in [0, 1) from the operating system's CSPRNG (47 bits: exact in a double). */
export const cryptoRandom = (): number => randomInt(2 ** 47) / 2 ** 47;

export interface HumanDeps {
  readonly log: Logger;
  /** The pauses' random source: default cryptoRandom. A test passes its own. */
  readonly random?: (() => number) | undefined;
  /** Waits `ms`, ended early by `signal` (which makes it reject). Default: node timers. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface HumanSend<T> {
  readonly client: WahaClient;
  readonly sessionName: string;
  readonly chatId: string;
  /** The length of what is typed (the message, or the caption of a file). */
  readonly textLength: number;
  readonly kind: HumanKind;
  /** The inbound message a reply answers: marked as seen first. Absent for an opener and an OTP. */
  readonly seenMessageId?: string | undefined;
  /** Mark the chat as seen even without a message id (a reply always does: there is an inbound message). */
  readonly withSeen: boolean;
  readonly signal: AbortSignal;
  /** Called after the last wait, just before the send: false = the claim can no longer cover the send (do not send). */
  readonly beforeSend?: () => boolean;
  readonly send: () => Promise<T>;
}

export type HumanResult<T> =
  | { readonly kind: "sent"; readonly value: T }
  /** Nothing was sent: the signal ended during a wait, or `beforeSend` said the lease can no longer cover the send. */
  | { readonly kind: "not_sent"; readonly reason: "aborted" | "too_late" };

export async function sendLikeAHuman<T>(deps: HumanDeps, input: HumanSend<T>): Promise<HumanResult<T>> {
  const random = deps.random ?? cryptoRandom;
  const { client, sessionName, chatId, signal } = input;
  const plan = humanPlan({ kind: input.kind, textLength: input.textLength, withReading: input.withSeen }, random);
  const bestEffort = async (step: string, call: () => Promise<void>): Promise<void> => {
    try {
      await call();
    } catch (error) {
      // A code only: never the chat, the text or the provider's message.
      deps.log.debug({ step, code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed" }, "a best-effort presence call failed; the send goes on");
    }
  };
  const wait = async (ms: number): Promise<boolean> => {
    try {
      await deps.sleep(ms, signal);
      return !signal.aborted;
    } catch {
      return false;
    }
  };

  const state = { typing: false };
  try {
    if (input.withSeen) {
      await bestEffort("seen", () => client.sendSeen(sessionName, chatId, input.seenMessageId === undefined ? undefined : [input.seenMessageId]));
      if (!(await wait(plan.readingMs))) return { kind: "not_sent", reason: "aborted" };
    }
    await bestEffort("typing", async () => {
      await client.startTyping(sessionName, chatId);
      state.typing = true;
    });
    if (!(await wait(plan.typingMs))) return { kind: "not_sent", reason: "aborted" };
    if (state.typing) await bestEffort("paused", () => client.stopTyping(sessionName, chatId));
    state.typing = false;
    if (!(await wait(plan.pausedMs))) return { kind: "not_sent", reason: "aborted" };
    if (input.beforeSend !== undefined && !input.beforeSend()) return { kind: "not_sent", reason: "too_late" };
    return { kind: "sent", value: await input.send() };
  } finally {
    // Never left typing or online, whatever happened (a send that failed, an abort in the middle of the typing wait).
    if (state.typing) await bestEffort("paused", () => client.stopTyping(sessionName, chatId));
    await bestEffort("offline", () => client.setOffline(sessionName));
  }
}
