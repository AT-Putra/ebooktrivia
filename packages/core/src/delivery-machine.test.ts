import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cancelDelivery,
  claimBuyerFirst,
  claimDelivery,
  DELIVERY_STATUSES,
  EMAIL_MAX_ATTEMPTS,
  expireDeliveryLease,
  NOT_ATTEMPTED_DELAY_MS,
  recordDeliveryOutcome,
  resolveUnknownDelivery,
  WA_MAX_SESSIONS,
  type DeliveryDecision,
  type DeliveryOutcome,
  type DeliveryPatch,
  type BuyerFirstSender,
  type DeliveryRow,
  type DeliveryStatus,
  type OutgoingMessage,
} from "./delivery-machine.ts";

const T0 = new Date("2027-06-01T03:00:00.000Z");
const LEASE = 120_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const wa = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  channel: "whatsapp",
  status: "pending",
  notBefore: T0,
  leaseUntil: null,
  attempts: 0,
  sessionId: null,
  triedSessionIds: [],
  waChatId: "628123456789@c.us",
  filename: "ebook-K7M2Q9XR.pdf",
  ...over,
});
const email = (over: Partial<DeliveryRow> = {}): DeliveryRow =>
  wa({ channel: "email", waChatId: null, filename: null, ...over });

function ok(decision: DeliveryDecision): DeliveryPatch {
  if (!decision.ok) throw new Error(`expected ok, got ${decision.reason}`);
  return decision.set;
}
const reason = (decision: DeliveryDecision): string | undefined => (decision.ok ? undefined : decision.reason);
const apply = (row: DeliveryRow, set: DeliveryPatch): DeliveryRow => ({ ...row, ...set });

describe("claimDelivery", () => {
  it("claims a due WA row with a lease and records the session", () => {
    const decision = claimDelivery(wa(), { now: T0, leaseMs: LEASE, sessionId: "s1" });
    expect(decision).toEqual({
      ok: true,
      expect: { status: "pending", attempts: 0 },
      set: { status: "sending", leaseUntil: at(LEASE), attempts: 1, sessionId: "s1", triedSessionIds: ["s1"] },
    });
  });

  it("claims a due email row without a session", () => {
    expect(ok(claimDelivery(email(), { now: T0, leaseMs: LEASE }))).toEqual({
      status: "sending",
      leaseUntil: at(LEASE),
      attempts: 1,
    });
  });

  it.each(DELIVERY_STATUSES.filter((s) => s !== "pending"))("refuses to claim a %s row", (status) => {
    expect(reason(claimDelivery(wa({ status }), { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe("not_pending");
  });

  it("waits for not_before (proactive WA delay)", () => {
    const row = wa({ notBefore: at(180_000) });
    expect(reason(claimDelivery(row, { now: at(179_999), leaseMs: LEASE, sessionId: "s1" }))).toBe("not_due");
    expect(ok(claimDelivery(row, { now: at(180_000), leaseMs: LEASE, sessionId: "s1" })).status).toBe("sending");
  });

  it("enforces WA session rules: required, never the same number twice, at most 3 numbers", () => {
    expect(reason(claimDelivery(wa(), { now: T0, leaseMs: LEASE }))).toBe("session_required");
    expect(reason(claimDelivery(wa(), { now: T0, leaseMs: LEASE, sessionId: "" }))).toBe("session_required");
    const tried = wa({ attempts: 1, triedSessionIds: ["s1"] });
    expect(reason(claimDelivery(tried, { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe("session_already_tried");
    expect(ok(claimDelivery(tried, { now: T0, leaseMs: LEASE, sessionId: "s2" })).triedSessionIds).toEqual(["s1", "s2"]);
    const full = wa({ attempts: 3, triedSessionIds: ["s1", "s2", "s3"] });
    expect(reason(claimDelivery(full, { now: T0, leaseMs: LEASE, sessionId: "s4" }))).toBe("attempts_exhausted");
    expect(reason(claimDelivery(wa({ waChatId: null }), { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe(
      "missing_target",
    );
    expect(reason(claimDelivery(wa({ filename: null }), { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe(
      "missing_target",
    );
  });

  it("lets a pool with nothing untried retry the SAME number, appended once more, while the budget of 3 holds", () => {
    const tried = wa({ attempts: 1, triedSessionIds: ["s1"] });
    expect(ok(claimDelivery(tried, { now: T0, leaseMs: LEASE, sessionId: "s1", retrySameSession: true })).triedSessionIds).toEqual(["s1", "s1"]);
    const third = wa({ attempts: 2, triedSessionIds: ["s1", "s1"] });
    expect(ok(claimDelivery(third, { now: T0, leaseMs: LEASE, sessionId: "s1", retrySameSession: true })).triedSessionIds).toEqual(["s1", "s1", "s1"]);
    const full = wa({ attempts: 3, triedSessionIds: ["s1", "s1", "s1"] });
    expect(reason(claimDelivery(full, { now: T0, leaseMs: LEASE, sessionId: "s1", retrySameSession: true }))).toBe("attempts_exhausted");
    // Without the flag the same number is refused, as before.
    expect(reason(claimDelivery(tried, { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe("session_already_tried");
  });

  it("enforces email rules: no session, at most 4 attempts", () => {
    expect(reason(claimDelivery(email(), { now: T0, leaseMs: LEASE, sessionId: "s1" }))).toBe("session_not_allowed");
    expect(reason(claimDelivery(email({ attempts: EMAIL_MAX_ATTEMPTS }), { now: T0, leaseMs: LEASE }))).toBe(
      "attempts_exhausted",
    );
  });

  it("rejects an invalid lease", () => {
    for (const leaseMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => claimDelivery(wa(), { now: T0, leaseMs, sessionId: "s1" })).toThrow(RangeError);
    }
  });
});

describe("recordDeliveryOutcome", () => {
  const sendingWa = wa({ status: "sending", attempts: 1, sessionId: "s1", triedSessionIds: ["s1"], leaseUntil: at(LEASE) });
  const sendingEmail = (attempts: number) => email({ status: "sending", attempts, leaseUntil: at(LEASE) });
  const now = at(5_000);

  it("sent -> sent, with the WA message id when known", () => {
    expect(recordDeliveryOutcome(sendingWa, { kind: "sent", waMessageId: "true_628@c.us_ABC" }, { now, attempt: 1 })).toEqual({
      ok: true,
      expect: { status: "sending", attempts: 1 },
      set: { status: "sent", sentAt: now, leaseUntil: null, lastError: null, waMessageId: "true_628@c.us_ABC" },
    });
    expect(ok(recordDeliveryOutcome(sendingEmail(1), { kind: "sent" }, { now, attempt: 1 }))).toEqual({
      status: "sent",
      sentAt: now,
      leaseUntil: null,
      lastError: null,
    });
  });

  it("a late success settles an unknown row", () => {
    const unknown = { ...sendingWa, status: "unknown" as const };
    expect(ok(recordDeliveryOutcome(unknown, { kind: "sent" }, { now, attempt: 1 })).status).toBe("sent");
  });

  it("maybe sent -> unknown and keeps the lease for the lookup window", () => {
    const set = ok(recordDeliveryOutcome(sendingWa, { kind: "maybe_sent", error: "timeout" }, { now, attempt: 1 }));
    expect(set).toEqual({ status: "unknown", lastError: "timeout" });
    expect("leaseUntil" in set).toBe(false);
  });

  it("permanent failure -> failed", () => {
    expect(ok(recordDeliveryOutcome(sendingWa, { kind: "permanent_failure", error: "not on WA" }, { now, attempt: 1 }))).toEqual({
      status: "failed",
      leaseUntil: null,
      lastError: "not on WA",
    });
  });

  it("WA retryable failure fails over to another number at once, then fails after 3 numbers", () => {
    expect(ok(recordDeliveryOutcome(sendingWa, { kind: "retryable_failure", error: "session STOPPED" }, { now, attempt: 1 }))).toEqual({
      status: "pending",
      notBefore: now,
      leaseUntil: null,
      sessionId: null,
      lastError: "session STOPPED",
    });
    const third = { ...sendingWa, attempts: 3, triedSessionIds: ["s1", "s2", "s3"] };
    expect(ok(recordDeliveryOutcome(third, { kind: "retryable_failure", error: "x" }, { now, attempt: 3 })).status).toBe("failed");
  });

  it("email retryable failure retries after 1m / 5m / 30m, then fails on the 4th attempt", () => {
    const delays = [60_000, 300_000, 1_800_000];
    delays.forEach((delay, i) => {
      const set = ok(recordDeliveryOutcome(sendingEmail(i + 1), { kind: "retryable_failure", error: "421" }, { now, attempt: i + 1 }));
      expect(set).toEqual({ status: "pending", notBefore: at(5_000 + delay), leaseUntil: null, lastError: "421" });
    });
    expect(ok(recordDeliveryOutcome(sendingEmail(4), { kind: "retryable_failure", error: "421" }, { now, attempt: 4 })).status).toBe(
      "failed",
    );
    // Defensive: an inconsistent row (sending with 0 attempts) fails instead of retrying blindly.
    expect(ok(recordDeliveryOutcome(sendingEmail(0), { kind: "retryable_failure", error: "?" }, { now, attempt: 0 })).status).toBe(
      "failed",
    );
  });

  it("not attempted (a failure of ours before anything was sent): pending after a backoff, the retry budget given back (the attempt NUMBER is never reused), the number out of tried_session_ids, no failover slot used", () => {
    const set = ok(recordDeliveryOutcome(sendingWa, { kind: "not_attempted", error: "magic_link_unavailable" }, { now, attempt: 1 }));
    expect(set).toEqual({
      status: "pending",
      notBefore: at(5_000 + NOT_ATTEMPTED_DELAY_MS),
      leaseUntil: null,
      attemptsBase: 1,
      sessionId: null,
      triedSessionIds: [],
      lastError: "magic_link_unavailable",
    });
    // Only THIS claim's number leaves the list (the last occurrence), earlier failovers stay.
    const second = { ...sendingWa, attempts: 2, sessionId: "s2", triedSessionIds: ["s1", "s2"] };
    expect(ok(recordDeliveryOutcome(second, { kind: "not_attempted", error: "x" }, { now, attempt: 2 })).triedSessionIds).toEqual(["s1"]);
    // The proactive delay is never moved earlier (a buyer-first reply that was not attempted keeps it).
    const delayed = { ...sendingWa, notBefore: at(30 * 60_000) };
    expect(ok(recordDeliveryOutcome(delayed, { kind: "not_attempted", error: "x" }, { now, attempt: 1 })).notBefore).toEqual(at(30 * 60_000));
    // E-mail: the budget is given back too (an outage of the login link must not use up the 4 attempts), the backoff is the same; `attempts` stays 3.
    expect(ok(recordDeliveryOutcome(sendingEmail(3), { kind: "not_attempted", error: "template_invalid" }, { now, attempt: 3 }))).toEqual({
      status: "pending",
      notBefore: at(5_000 + NOT_ATTEMPTED_DELAY_MS),
      leaseUntil: null,
      attemptsBase: 1,
      sessionId: null,
      triedSessionIds: [],
      lastError: "template_invalid",
    });
    // A row that never had a session (an e-mail) loses nothing from the list, and a stale worker changes nothing.
    expect(reason(recordDeliveryOutcome(sendingWa, { kind: "not_attempted", error: "x" }, { now, attempt: 2 }))).toBe("stale");
  });

  it("the retry budget of an e-mail is attempts minus attempts_base: a row given its budget back (a resend, a not-attempted claim) is claimed again and retried from the first delay, while `attempts` only grows", () => {
    // Four attempts spent, then the budget is given back (as public.resend_delivery does): claimable again, and the attempt number goes on from 5.
    const resent = email({ status: "pending", attempts: 4, attemptsBase: 4, notBefore: at(0) });
    expect(ok(claimDelivery(resent, { now, leaseMs: LEASE })).attempts).toBe(5);
    expect(reason(claimDelivery(email({ status: "pending", attempts: 4, notBefore: at(0) }), { now, leaseMs: LEASE }))).toBe("attempts_exhausted");
    // The first retry after that claim waits the FIRST delay (1 min), not the one for attempt 5.
    const sending = email({ status: "sending", attempts: 5, attemptsBase: 4, leaseUntil: at(LEASE) });
    expect(ok(recordDeliveryOutcome(sending, { kind: "retryable_failure", error: "421" }, { now, attempt: 5 })).notBefore).toEqual(at(5_000 + 60_000));
    // The fourth attempt of the new budget is the last.
    const last = email({ status: "sending", attempts: 8, attemptsBase: 4, leaseUntil: at(LEASE) });
    expect(ok(recordDeliveryOutcome(last, { kind: "retryable_failure", error: "421" }, { now, attempt: 8 })).status).toBe("failed");
    // A not-attempted claim gives its attempt back to the budget by moving the base, never by reusing the number.
    const gone = ok(recordDeliveryOutcome(email({ status: "sending", attempts: 3, attemptsBase: 1, leaseUntil: at(LEASE) }), { kind: "not_attempted", error: "x" }, { now, attempt: 3 }));
    expect(gone).toMatchObject({ status: "pending", attemptsBase: 2 });
    expect(gone).not.toHaveProperty("attempts");
  });

  it("rejects stale workers and rows that are not sending", () => {
    expect(reason(recordDeliveryOutcome(sendingWa, { kind: "sent" }, { now, attempt: 2 }))).toBe("stale");
    const outcomes: DeliveryOutcome[] = [
      { kind: "sent" },
      { kind: "maybe_sent", error: "t" },
      { kind: "permanent_failure", error: "p" },
      { kind: "retryable_failure", error: "r" },
      { kind: "not_attempted", error: "n" },
    ];
    for (const status of DELIVERY_STATUSES) {
      for (const outcome of outcomes) {
        if (status === "sending" || (status === "unknown" && outcome.kind === "sent")) continue;
        expect(reason(recordDeliveryOutcome({ ...sendingWa, status }, outcome, { now, attempt: 1 }))).toBe("not_sending");
      }
    }
  });
});

describe("expireDeliveryLease", () => {
  const sending = wa({ status: "sending", attempts: 1, sessionId: "s1", triedSessionIds: ["s1"], leaseUntil: at(LEASE) });

  it("turns an expired sending lease into unknown (never back to pending)", () => {
    expect(ok(expireDeliveryLease(sending, at(LEASE))).status).toBe("unknown");
    expect(ok(expireDeliveryLease({ ...sending, leaseUntil: null }, at(0))).status).toBe("unknown");
    expect(reason(expireDeliveryLease(sending, at(LEASE - 1)))).toBe("lease_active");
  });

  it.each(DELIVERY_STATUSES.filter((s) => s !== "sending"))("ignores a %s row", (status) => {
    expect(reason(expireDeliveryLease({ ...sending, status }, at(LEASE * 10)))).toBe("not_sending");
  });
});

describe("resolveUnknownDelivery (recent outgoing lookup)", () => {
  const leaseUntil = at(LEASE);
  const unknown = wa({ status: "unknown", attempts: 1, sessionId: "s1", triedSessionIds: ["s1"], leaseUntil });
  const msg = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
    id: "true_628123456789@c.us_3EB0",
    chatId: "628123456789@c.us",
    fromMe: true,
    filename: "ebook-K7M2Q9XR.pdf",
    timestamp: at(30_000),
    ...over,
  });
  const ctx = (outgoing: OutgoingMessage[], now = at(LEASE + 1)) => ({ now, leaseMs: LEASE, skewMs: 5_000, outgoing });

  it("marks sent when the session sent that file to that chat inside the lease window", () => {
    expect(ok(resolveUnknownDelivery(unknown, ctx([msg({ filename: "other.pdf" }), msg()])))).toEqual({
      status: "sent",
      sentAt: at(30_000),
      leaseUntil: null,
      waMessageId: "true_628123456789@c.us_3EB0",
      lastError: null,
    });
  });

  it("includes the window edges (lease start - skew, lease end + skew)", () => {
    expect(ok(resolveUnknownDelivery(unknown, ctx([msg({ timestamp: at(-5_000) })]))).status).toBe("sent");
    expect(ok(resolveUnknownDelivery(unknown, ctx([msg({ timestamp: at(LEASE + 5_000) })]))).status).toBe("sent");
  });

  it("otherwise leaves the row for Owner review (never resends)", () => {
    for (const m of [
      msg({ chatId: "628999999999@c.us" }),
      msg({ filename: "ebook-OTHER.pdf" }),
      msg({ filename: null }),
      msg({ fromMe: false }),
      msg({ timestamp: at(-5_001) }),
      msg({ timestamp: at(LEASE + 5_001) }),
    ]) {
      expect(reason(resolveUnknownDelivery(unknown, ctx([m])))).toBe("needs_review");
    }
    expect(reason(resolveUnknownDelivery(unknown, ctx([])))).toBe("needs_review");
  });

  it("waits until the lease has expired", () => {
    expect(reason(resolveUnknownDelivery(unknown, ctx([msg()], at(LEASE - 1))))).toBe("lease_active");
  });

  it("sends email and incomplete rows to Owner review", () => {
    const unknownEmail = email({ status: "unknown", attempts: 1, leaseUntil });
    expect(reason(resolveUnknownDelivery(unknownEmail, ctx([msg()])))).toBe("needs_review");
    expect(reason(resolveUnknownDelivery({ ...unknown, leaseUntil: null }, ctx([msg()])))).toBe("needs_review");
    expect(reason(resolveUnknownDelivery({ ...unknown, waChatId: null }, ctx([msg()])))).toBe("needs_review");
    expect(reason(resolveUnknownDelivery({ ...unknown, filename: null }, ctx([msg()])))).toBe("needs_review");
  });

  it.each(DELIVERY_STATUSES.filter((s) => s !== "unknown"))("ignores a %s row", (status) => {
    expect(reason(resolveUnknownDelivery({ ...unknown, status }, ctx([msg()])))).toBe("not_unknown");
  });

  it("rejects an invalid window", () => {
    expect(() => resolveUnknownDelivery(unknown, { ...ctx([]), leaseMs: 0 })).toThrow(RangeError);
    expect(() => resolveUnknownDelivery(unknown, { ...ctx([]), skewMs: -1 })).toThrow(RangeError);
  });
});

describe("cancelDelivery", () => {
  it("cancels only a pending row", () => {
    expect(cancelDelivery(wa())).toEqual({
      ok: true,
      expect: { status: "pending", attempts: 0 },
      set: { status: "cancelled", leaseUntil: null },
    });
    for (const status of DELIVERY_STATUSES.filter((s) => s !== "pending")) {
      expect(reason(cancelDelivery(wa({ status })))).toBe("not_pending");
    }
  });
});

describe("delivery machine: random operation sequences", () => {
  type Op =
    | { readonly op: "claim"; readonly session: number }
    | { readonly op: "buyerFirst"; readonly session: number; readonly sender: BuyerFirstSender }
    | { readonly op: "outcome"; readonly outcome: DeliveryOutcome; readonly stale: boolean }
    | { readonly op: "expire" }
    | { readonly op: "resolve"; readonly found: boolean }
    | { readonly op: "cancel" }
    | { readonly op: "wait"; readonly ms: number };
  const arbOutcome = fc.constantFrom<DeliveryOutcome>(
    { kind: "sent" },
    { kind: "maybe_sent", error: "timeout" },
    { kind: "permanent_failure", error: "p" },
    { kind: "retryable_failure", error: "r" },
  );
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("claim" as const), session: fc.integer({ min: 1, max: 5 }) }),
    fc.record({
      op: fc.constant("buyerFirst" as const),
      session: fc.integer({ min: 1, max: 5 }),
      sender: fc.constantFrom<BuyerFirstSender>("verified", "unresolved", "mismatch"),
    }),
    fc.record({ op: fc.constant("outcome" as const), outcome: arbOutcome, stale: fc.boolean() }),
    fc.constant({ op: "expire" as const }),
    fc.record({ op: fc.constant("resolve" as const), found: fc.boolean() }),
    fc.constant({ op: "cancel" as const }),
    fc.record({ op: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 40 * 60_000 }) }),
  );

  const TERMINAL: readonly DeliveryStatus[] = ["sent", "failed", "cancelled"];

  it("never resends after unknown, respects the attempt limits and keeps terminal states", () => {
    // The third start row has a proactive delay (AC-D8): no proactive claim may beat it (L2).
    const delayed = wa({ notBefore: at(15 * 60_000) });
    fc.assert(
      fc.property(fc.constantFrom(wa(), email(), delayed), fc.array(arbOp, { maxLength: 40 }), (start, ops) => {
        let row = start;
        let now = T0;
        let sends = 0;
        let buyerFirstSends = 0;
        let sawUnknown = false;
        for (const step of ops) {
          let decision: DeliveryDecision;
          switch (step.op) {
            case "claim":
              decision = claimDelivery(row, {
                now,
                leaseMs: LEASE,
                ...(row.channel === "whatsapp" ? { sessionId: `s${String(step.session)}` } : {}),
              });
              if (decision.ok) {
                sends++;
                if (start.channel === "whatsapp") expect(now.getTime()).toBeGreaterThanOrEqual(start.notBefore.getTime());
              }
              break;
            case "buyerFirst":
              decision = claimBuyerFirst(row, {
                now,
                leaseMs: LEASE,
                sessionId: `s${String(step.session)}`,
                chatId: "998877665544332@lid",
                sender: step.sender,
              });
              if (step.sender === "mismatch") expect(decision).toEqual({ ok: false, reason: "sender_mismatch" });
              if (decision.ok) {
                expect(decision.reply).toEqual({ chatId: "998877665544332@lid", withoutLink: step.sender === "unresolved" });
                sends++;
                buyerFirstSends++;
              }
              break;
            case "outcome":
              decision = recordDeliveryOutcome(row, step.outcome, { now, attempt: row.attempts + (step.stale ? 1 : 0) });
              break;
            case "expire":
              decision = expireDeliveryLease(row, now);
              break;
            case "resolve":
              decision = resolveUnknownDelivery(row, {
                now,
                leaseMs: LEASE,
                skewMs: 0,
                outgoing:
                  step.found && row.leaseUntil !== null && row.waChatId !== null
                    ? [{ id: "m", chatId: row.waChatId, fromMe: true, filename: row.filename, timestamp: row.leaseUntil }]
                    : [],
              });
              break;
            case "cancel":
              decision = cancelDelivery(row);
              break;
            case "wait":
              now = new Date(now.getTime() + step.ms);
              continue;
          }
          if (TERMINAL.includes(row.status)) expect(decision.ok).toBe(false);
          if (decision.ok) {
            expect(decision.expect).toEqual({ status: row.status, attempts: row.attempts });
            if (row.status === "unknown") expect(decision.set.status).toBe("sent");
            row = apply(row, decision.set);
          }
          if (row.status === "unknown") sawUnknown = true;
          if (sawUnknown) expect(["unknown", "sent"]).toContain(row.status);
          // NEW-2: no operation ever re-targets the order's chat.
          expect(row.waChatId).toBe(start.waChatId);
        }
        // Proactive claims respect the budget; buyer-first claims each answer a new inbound message.
        expect(sends - buyerFirstSends).toBeLessThanOrEqual(row.channel === "whatsapp" ? WA_MAX_SESSIONS : EMAIL_MAX_ATTEMPTS);
        expect(row.attempts).toBe(sends);
      }),
    );
  });
});

describe("review item 5: claimBuyerFirst (AC-D8 buyer messages first)", () => {
  const ctx = { now: T0, leaseMs: LEASE, sessionId: "s2", chatId: "123456789012345@lid", sender: "unresolved" } as const;

  it("claims the pending WA row before not_before; the reply target travels with the claim, not the row", () => {
    const row = wa({ notBefore: at(180_000) });
    expect(claimBuyerFirst(row, ctx)).toEqual({
      ok: true,
      expect: { status: "pending", attempts: 0 },
      set: { status: "sending", leaseUntil: at(LEASE), attempts: 1, sessionId: "s2", triedSessionIds: ["s2"] },
      reply: { chatId: "123456789012345@lid", withoutLink: true },
    });
    const verified = claimBuyerFirst(row, { ...ctx, chatId: "628123456789@c.us", sender: "verified" });
    expect(verified.ok && verified.reply).toEqual({ chatId: "628123456789@c.us", withoutLink: false });
  });

  it("L3: a sender that resolves to another phone is rejected and the row is neither consumed nor changed", () => {
    const row = wa({ notBefore: at(180_000) });
    const before = structuredClone(row);
    expect(claimBuyerFirst(row, { ...ctx, chatId: "628999999999@c.us", sender: "mismatch" })).toEqual({
      ok: false,
      reason: "sender_mismatch",
    });
    expect(row).toEqual(before);
    // The proactive send still owns the row, with its full budget.
    expect(ok(claimDelivery(row, { now: at(180_000), leaseMs: LEASE, sessionId: "s1" }))).toMatchObject({ attempts: 1 });
  });

  it("L3: verified and unresolved claims never write wa_chat_id", () => {
    for (const sender of ["verified", "unresolved"] as const) {
      const decision = claimBuyerFirst(wa(), { ...ctx, sender });
      expect(decision.ok && decision.reply?.withoutLink).toBe(sender === "unresolved");
      expect(Object.keys(ok(decision))).not.toContain("waChatId");
    }
  });

  it("L2: a failed buyer-first reply keeps the proactive delay (not_before never moves earlier)", () => {
    let row = wa({ notBefore: at(3_600_000) }); // proactive send due at 01:00
    row = apply(row, ok(claimBuyerFirst(row, ctx))); // 00:00 buyer-first reply
    const failed = ok(recordDeliveryOutcome(row, { kind: "retryable_failure", error: "session STOPPED" }, { now: at(1_000), attempt: 1 }));
    expect(failed).toMatchObject({ status: "pending", notBefore: at(3_600_000) });
    row = apply(row, failed);
    expect(reason(claimDelivery(row, { now: at(2_000), leaseMs: LEASE, sessionId: "s3" }))).toBe("not_due");
    expect(ok(claimDelivery(row, { now: at(3_600_000), leaseMs: LEASE, sessionId: "s3" })).status).toBe("sending");
  });

  it("NEW-2: a failed buyer-first reply never re-targets the proactive send to the unverified chat", () => {
    let row = wa({ notBefore: at(180_000) });
    const steps: DeliveryDecision[] = [];
    const step = (decision: DeliveryDecision) => {
      steps.push(decision);
      row = apply(row, ok(decision));
      expect(row.waChatId).toBe("628123456789@c.us");
    };
    step(claimBuyerFirst(row, ctx));
    step(recordDeliveryOutcome(row, { kind: "retryable_failure", error: "session STOPPED" }, { now: at(1_000), attempt: 1 }));
    expect(row.status).toBe("pending");
    step(claimDelivery(row, { now: at(180_000), leaseMs: LEASE, sessionId: "s3" }));
    expect(row).toMatchObject({ status: "sending", sessionId: "s3", waChatId: "628123456789@c.us" });
    for (const decision of steps) expect(JSON.stringify(decision.ok ? decision.set : {})).not.toContain("@lid");
  });

  it("ignores the tried-session check but does not duplicate the session", () => {
    const row = wa({ attempts: 1, triedSessionIds: ["s2"] });
    const set = ok(claimBuyerFirst(row, ctx));
    expect(set.attempts).toBe(2);
    expect(set.triedSessionIds).toEqual(["s2"]);
    expect(ok(claimBuyerFirst(wa({ attempts: 1, triedSessionIds: ["s1"] }), ctx)).triedSessionIds).toEqual(["s1", "s2"]);
  });

  it.each(DELIVERY_STATUSES.filter((s) => s !== "pending"))("refuses a %s row", (status) => {
    expect(reason(claimBuyerFirst(wa({ status }), ctx))).toBe("not_pending");
  });

  it("requires a WA row with a filename, a session and a chat id", () => {
    expect(reason(claimBuyerFirst(email(), ctx))).toBe("wrong_channel");
    expect(reason(claimBuyerFirst(wa(), { ...ctx, sessionId: "" }))).toBe("session_required");
    expect(reason(claimBuyerFirst(wa(), { ...ctx, chatId: "" }))).toBe("missing_target");
    expect(reason(claimBuyerFirst(wa({ filename: null }), ctx))).toBe("missing_target");
    expect(() => claimBuyerFirst(wa(), { ...ctx, leaseMs: 0 })).toThrow(RangeError);
  });
});
