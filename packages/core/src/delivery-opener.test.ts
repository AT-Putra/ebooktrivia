import { describe, expect, it } from "vitest";
import {
  claimOpener,
  CONTACT_CACHE_EXISTS_MS,
  CONTACT_CACHE_MISSING_MS,
  contactCacheFresh,
  expireOpener,
  expireOpenerLease,
  failOpener,
  NEW_OPENER,
  OPENER_MAX_AGE_MS,
  OPENER_RETRY_DELAY_MS,
  openerTooOld,
  type OpenerRow,
  recordOpenerOutcome,
  WA_MAX_SESSIONS,
} from "./index.ts";

const now = new Date("2026-11-21T10:00:00Z");
const notBefore = new Date(now.getTime() - 60_000);
const pending = (over: Partial<OpenerRow> = {}): OpenerRow => ({ ...NEW_OPENER, ...over });
const sending = (over: Partial<OpenerRow> = {}): OpenerRow => ({ ...NEW_OPENER, status: "sending", attempts: 1, sessionId: "s1", triedSessionIds: ["s1"], leaseUntil: new Date(now.getTime() + 60_000), ...over });
const ctx = { now, notBefore, leaseMs: 120_000, sessionId: "s1" };

describe("claimOpener", () => {
  it("claims a pending opener once the delivery's not_before has come: sending, a lease, the number recorded, attempts + 1", () => {
    const decision = claimOpener(pending(), ctx);
    expect(decision).toEqual({
      ok: true,
      expect: { status: "pending", attempts: 0 },
      set: { status: "sending", attempts: 1, sessionId: "s1", triedSessionIds: ["s1"], leaseUntil: new Date(now.getTime() + 120_000), nextAttemptAt: null },
    });
  });

  it("is not due before not_before, nor before its own retry time", () => {
    expect(claimOpener(pending(), { ...ctx, notBefore: new Date(now.getTime() + 1000) })).toEqual({ ok: false, reason: "not_due" });
    expect(claimOpener(pending({ nextAttemptAt: new Date(now.getTime() + 1000) }), ctx)).toEqual({ ok: false, reason: "not_due" });
    expect(claimOpener(pending({ nextAttemptAt: new Date(now.getTime() - 1000) }), ctx).ok).toBe(true);
    // A retry time before not_before changes nothing.
    expect(claimOpener(pending({ nextAttemptAt: new Date(notBefore.getTime() - 5000) }), { ...ctx, notBefore: new Date(now.getTime() + 1000) })).toEqual({ ok: false, reason: "not_due" });
  });

  it("only ever claims a pending opener: a sending, sent, unknown, failed or expired one is never claimed again", () => {
    for (const status of ["sending", "sent", "unknown", "failed", "expired"] as const) {
      expect(claimOpener(pending({ status }), ctx), status).toEqual({ ok: false, reason: "not_pending" });
    }
  });

  it("does not send an opener that is too old", () => {
    expect(claimOpener(pending(), { ...ctx, notBefore: new Date(now.getTime() - OPENER_MAX_AGE_MS - 1) })).toEqual({ ok: false, reason: "expired" });
    expect(claimOpener(pending(), { ...ctx, notBefore: new Date(now.getTime() - OPENER_MAX_AGE_MS) }).ok).toBe(true);
  });

  it("asks for a number, not one already tried (unless the pool has only that one, once), and at most WA_MAX_SESSIONS", () => {
    expect(claimOpener(pending(), { ...ctx, sessionId: "" })).toEqual({ ok: false, reason: "session_required" });
    expect(claimOpener(pending({ triedSessionIds: ["s1"] }), ctx)).toEqual({ ok: false, reason: "session_already_tried" });
    const again = claimOpener(pending({ triedSessionIds: ["s1"], attempts: 1 }), { ...ctx, retrySameSession: true });
    expect(again).toMatchObject({ ok: true, set: { triedSessionIds: ["s1", "s1"], attempts: 2 } });
    expect(WA_MAX_SESSIONS).toBe(3);
    expect(claimOpener(pending({ triedSessionIds: ["a", "b", "c"], attempts: 3 }), { ...ctx, sessionId: "d" })).toEqual({ ok: false, reason: "attempts_exhausted" });
  });

  it("refuses a lease that is not a positive number of milliseconds", () => {
    expect(() => claimOpener(pending(), { ...ctx, leaseMs: 0 })).toThrow(RangeError);
    expect(() => claimOpener(pending(), { ...ctx, leaseMs: 1.5 })).toThrow(RangeError);
  });
});

describe("recordOpenerOutcome", () => {
  const record = (row: OpenerRow, outcome: Parameters<typeof recordOpenerOutcome>[1], attempt = row.attempts) => recordOpenerOutcome(row, outcome, { now, attempt });

  it("sent: the opener is sent (awaiting the reply), with the message id; a late success also settles an unknown opener", () => {
    expect(record(sending(), { kind: "sent", waMessageId: "true_x" })).toEqual({
      ok: true,
      expect: { status: "sending", attempts: 1 },
      set: { status: "sent", sentAt: now, leaseUntil: null, lastError: null, waMessageId: "true_x" },
    });
    expect(record(sending(), { kind: "sent" })).toMatchObject({ ok: true, set: { status: "sent" } });
    expect(record(sending({ status: "unknown" }), { kind: "sent" })).toMatchObject({ ok: true, set: { status: "sent" } });
    expect(record(sending({ status: "pending" }), { kind: "sent" })).toEqual({ ok: false, reason: "not_sending" });
    expect(record(sending({ status: "sent" }), { kind: "sent" })).toEqual({ ok: false, reason: "not_sending" });
  });

  it("an outcome of another attempt, or of an opener that is not sending, changes nothing", () => {
    expect(record(sending(), { kind: "sent" }, 2)).toEqual({ ok: false, reason: "stale" });
    for (const kind of ["retryable_failure", "permanent_failure", "maybe_sent", "not_attempted"] as const) {
      expect(record(sending({ status: "sent" }), { kind, error: "x" }), kind).toEqual({ ok: false, reason: "not_sending" });
      expect(record(sending({ status: "unknown" }), { kind, error: "x" }), kind).toEqual({ ok: false, reason: "not_sending" });
    }
  });

  it("maybe sent: unknown, and never resent (the lease is kept)", () => {
    expect(record(sending(), { kind: "maybe_sent", error: "waha_maybe_sent" })).toEqual({ ok: true, expect: { status: "sending", attempts: 1 }, set: { status: "unknown", lastError: "waha_maybe_sent" } });
  });

  it("a permanent failure is failed; a definite failure goes on to another number at once, and is failed after WA_MAX_SESSIONS numbers", () => {
    expect(record(sending(), { kind: "permanent_failure", error: "no" })).toMatchObject({ ok: true, set: { status: "failed", leaseUntil: null, lastError: "no" } });
    expect(record(sending(), { kind: "retryable_failure", error: "waha_rejected" })).toMatchObject({
      ok: true,
      set: { status: "pending", sessionId: null, leaseUntil: null, nextAttemptAt: now, lastError: "waha_rejected" },
    });
    expect(record(sending({ attempts: 3, triedSessionIds: ["a", "b", "c"], sessionId: "c" }), { kind: "retryable_failure", error: "waha_rejected" })).toMatchObject({ ok: true, set: { status: "failed", leaseUntil: null } });
  });

  it("not attempted: back to pending after a delay, as if the claim never happened (the number given back; the attempt NUMBER is never reused, so a stale finisher cannot record onto a later claim)", () => {
    const decision = record(sending({ attempts: 2, triedSessionIds: ["s0", "s1"], sessionId: "s1" }), { kind: "not_attempted", error: "reachout_timelock" });
    expect(decision).toEqual({
      ok: true,
      expect: { status: "sending", attempts: 2 },
      set: {
        status: "pending",
        sessionId: null,
        triedSessionIds: ["s0"],
        leaseUntil: null,
        nextAttemptAt: new Date(now.getTime() + OPENER_RETRY_DELAY_MS),
        lastError: "reachout_timelock",
      },
    });
    // Without a recorded number nothing leaves the list.
    expect(record(sending({ sessionId: null, triedSessionIds: ["x"] }), { kind: "not_attempted", error: "e" })).toMatchObject({ set: { triedSessionIds: ["x"] } });
  });
});

describe("first contact: a phone that is not on WhatsApp, and the cache of what WAHA said", () => {
  it("no_whatsapp is final and quiet: failed with its own code, no failover, a lease that ends", () => {
    expect(recordOpenerOutcome(sending(), { kind: "no_whatsapp" }, { now, attempt: 1 })).toEqual({
      ok: true,
      expect: { status: "sending", attempts: 1 },
      set: { status: "failed", leaseUntil: null, nextAttemptAt: null, lastError: "no_whatsapp" },
    });
    expect(recordOpenerOutcome(sending({ status: "sent" }), { kind: "no_whatsapp" }, { now, attempt: 1 })).toEqual({ ok: false, reason: "not_sending" });
    expect(recordOpenerOutcome(sending(), { kind: "no_whatsapp" }, { now, attempt: 2 })).toEqual({ ok: false, reason: "stale" });
  });

  it("an opener that no number is left for fails quietly, only from pending; and one that is too old is told by the delivery's not_before", () => {
    expect(failOpener(pending(), "no_untried_number")).toEqual({ ok: true, expect: { status: "pending", attempts: 0 }, set: { status: "failed", nextAttemptAt: null, leaseUntil: null, lastError: "no_untried_number" } });
    for (const status of ["sending", "sent", "unknown", "failed", "expired"] as const) expect(failOpener(pending({ status }), "x"), status).toEqual({ ok: false, reason: "not_pending" });
    expect(openerTooOld(now, new Date(now.getTime() - OPENER_MAX_AGE_MS - 1))).toBe(true);
    expect(openerTooOld(now, new Date(now.getTime() - OPENER_MAX_AGE_MS))).toBe(false);
  });

  it("a check-exists answer is good for a month when the phone is on WhatsApp and for a day when it is not", () => {
    const at = (ms: number) => new Date(now.getTime() - ms);
    expect(contactCacheFresh({ numberExists: true, checkedAt: at(CONTACT_CACHE_EXISTS_MS - 1) }, now)).toBe(true);
    expect(contactCacheFresh({ numberExists: true, checkedAt: at(CONTACT_CACHE_EXISTS_MS) }, now)).toBe(false);
    expect(contactCacheFresh({ numberExists: false, checkedAt: at(CONTACT_CACHE_MISSING_MS - 1) }, now)).toBe(true);
    expect(contactCacheFresh({ numberExists: false, checkedAt: at(CONTACT_CACHE_MISSING_MS) }, now)).toBe(false);
    expect(CONTACT_CACHE_MISSING_MS).toBeLessThan(CONTACT_CACHE_EXISTS_MS);
  });
});

describe("the lease and the end of an opener", () => {
  it("a sending opener whose lease ran out becomes unknown (it may have been sent) and is never sent again", () => {
    expect(expireOpenerLease(sending({ leaseUntil: new Date(now.getTime() - 1) }), now)).toEqual({ ok: true, expect: { status: "sending", attempts: 1 }, set: { status: "unknown", lastError: "lease expired while sending" } });
    expect(expireOpenerLease(sending({ leaseUntil: null }), now).ok).toBe(true);
    expect(expireOpenerLease(sending(), now)).toEqual({ ok: false, reason: "lease_active" });
    expect(expireOpenerLease(pending(), now)).toEqual({ ok: false, reason: "not_sending" });
  });

  it("only a pending opener is expired (the buyer wrote first): an opener that went out stays as it is", () => {
    expect(expireOpener(pending(), "buyer_wrote")).toEqual({ ok: true, expect: { status: "pending", attempts: 0 }, set: { status: "expired", nextAttemptAt: null, lastError: "buyer_wrote" } });
    for (const status of ["sending", "sent", "unknown", "failed", "expired"] as const) {
      expect(expireOpener(pending({ status }), "buyer_wrote"), status).toEqual({ ok: false, reason: "not_pending" });
    }
  });
});
