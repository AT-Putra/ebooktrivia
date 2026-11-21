import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_GAP_MS,
  jitterMs,
  OTP_GAP_MS,
  type PoolSession,
  pickSession,
  POOL_MAX_WAIT_MS,
  POOL_STATUS_MAX_AGE_MS,
  DEFAULT_WARNING_CAP_FACTORS,
  effectiveNewContactCap,
  REACHOUT_COOLDOWN_MS,
  reserveSlot,
  SESSION_COOLDOWN_MS,
  SESSION_FAIL_THRESHOLD,
  sessionHealthAfter,
  warningSlowdown,
} from "./delivery-pool.ts";

const NOW = new Date("2027-06-01T03:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

const session = (id: string, over: Partial<PoolSession> = {}): PoolSession => ({
  id,
  weight: 1,
  dailyCap: 200,
  sentToday: 0,
  status: "WORKING",
  statusAt: NOW,
  nextSendAt: null,
  cooldownUntil: null,
  reachoutUntil: null,
  warning: "none",
  newContactCap: 30,
  newContactsToday: 0,
  ...over,
});
const ctx = (over: Partial<Parameters<typeof pickSession>[1]> = {}): Parameters<typeof pickSession>[1] => ({
  now: NOW,
  exclude: [],
  maxWaitMs: POOL_MAX_WAIT_MS,
  random: () => 0,
  ...over,
});
const idOf = (pick: ReturnType<typeof pickSession>): string => (pick.kind === "picked" ? pick.session.id : `none:${pick.reason}`);

describe("pickSession: who may send", () => {
  it("skips a session that is not WORKING, or whose status is stale or unknown", () => {
    const pool = [session("a", { status: "FAILED" }), session("b", { status: "SCAN_QR_CODE" }), session("c", { status: null, statusAt: null }), session("d", { statusAt: at(-POOL_STATUS_MAX_AGE_MS - 1) }), session("e")];
    expect(idOf(pickSession(pool, ctx()))).toBe("e");
    expect(idOf(pickSession(pool.slice(0, 4), ctx()))).toBe("none:no_working_session");
    // exactly at the limit is still fresh
    expect(idOf(pickSession([session("a", { statusAt: at(-POOL_STATUS_MAX_AGE_MS) })], ctx()))).toBe("a");
  });

  it("never picks a session the delivery already tried, and says so when none is left to fail over to", () => {
    expect(idOf(pickSession([session("a"), session("b")], ctx({ exclude: ["a"] })))).toBe("b");
    expect(idOf(pickSession([session("a"), session("b")], ctx({ exclude: ["a", "b"] })))).toBe("none:no_untried_session");
    expect(idOf(pickSession([], ctx()))).toBe("none:no_untried_session");
  });

  it("respects the per-number daily cap: at the cap the number is out for the day", () => {
    const pool = [session("a", { dailyCap: 5, sentToday: 5 }), session("b", { dailyCap: 5, sentToday: 4 }), session("c", { dailyCap: 0 })];
    expect(idOf(pickSession(pool, ctx()))).toBe("b");
    expect(idOf(pickSession(pool.filter((s) => s.id !== "b"), ctx()))).toBe("none:all_capped");
  });

  it("rests a number on its cooldown, until the cooldown is over", () => {
    const pool = [session("a", { cooldownUntil: at(1) })];
    expect(idOf(pickSession(pool, ctx()))).toBe("none:all_cooling_down");
    expect(idOf(pickSession([session("a", { cooldownUntil: NOW })], ctx()))).toBe("a");
  });

  it("calls a number whose queue is longer than the wait budget busy", () => {
    const pool = [session("a", { nextSendAt: at(POOL_MAX_WAIT_MS + 1) })];
    expect(idOf(pickSession(pool, ctx()))).toBe("none:all_busy");
    expect(idOf(pickSession([session("a", { nextSendAt: at(POOL_MAX_WAIT_MS) })], ctx()))).toBe("a");
    expect(idOf(pickSession([session("a", { nextSendAt: at(-5000) })], ctx()))).toBe("a");
  });
});

describe("pickSession: weighted round-robin", () => {
  it("rotates equal weights by sends so far, and prefers the earlier free slot, then a random one", () => {
    expect(idOf(pickSession([session("a", { sentToday: 3 }), session("b", { sentToday: 2 }), session("c", { sentToday: 4 })], ctx()))).toBe("b");
    expect(idOf(pickSession([session("a", { nextSendAt: at(4000) }), session("b", { nextSendAt: at(1000) })], ctx()))).toBe("b");
    const tie = [session("a"), session("b"), session("c")];
    expect(idOf(pickSession(tie, ctx({ random: () => 0 })))).toBe("a");
    expect(idOf(pickSession(tie, ctx({ random: () => 0.5 })))).toBe("b");
    expect(idOf(pickSession(tie, ctx({ random: () => 0.99 })))).toBe("c");
  });

  it("gives a number a share that follows its weight", () => {
    // Simulate 400 sends: weights 1, 2, 5. Each send goes to the pick and counts.
    const weights = { a: 1, b: 2, c: 5 };
    const sent = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 400; i++) {
      const pool = (Object.keys(weights) as (keyof typeof weights)[]).map((id) => session(id, { weight: weights[id], sentToday: sent[id], dailyCap: 10_000 }));
      const pick = pickSession(pool, ctx({ random: Math.random }));
      if (pick.kind !== "picked") throw new Error("a pool of three working numbers always picks");
      sent[pick.session.id as keyof typeof sent]++;
    }
    expect(sent.a).toBeGreaterThanOrEqual(48);
    expect(sent.a).toBeLessThanOrEqual(52);
    expect(sent.b).toBeGreaterThanOrEqual(98);
    expect(sent.b).toBeLessThanOrEqual(102);
    expect(sent.c).toBeGreaterThanOrEqual(248);
    expect(sent.c).toBeLessThanOrEqual(252);
  });

  it("never picks an ineligible session, whatever the pool looks like (property)", () => {
    const arbitrary = fc.record({
      weight: fc.integer({ min: 1, max: 10 }),
      dailyCap: fc.integer({ min: 0, max: 20 }),
      sentToday: fc.integer({ min: 0, max: 25 }),
      status: fc.constantFrom("WORKING", "FAILED", null),
      stale: fc.boolean(),
      wait: fc.integer({ min: -10_000, max: 60_000 }),
      cooling: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(arbitrary, { maxLength: 6 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (specs, random) => {
        const pool = specs.map((s, i) =>
          session(`s${String(i)}`, {
            weight: s.weight,
            dailyCap: s.dailyCap,
            sentToday: s.sentToday,
            status: s.status,
            statusAt: s.status === null ? null : s.stale ? at(-POOL_STATUS_MAX_AGE_MS - 1) : NOW,
            nextSendAt: at(s.wait),
            cooldownUntil: s.cooling ? at(1000) : null,
          }),
        );
        const pick = pickSession(pool, ctx({ random: () => random }));
        if (pick.kind !== "picked") return true;
        const s = pick.session;
        return s.status === "WORKING" && s.statusAt !== null && s.sentToday < s.dailyCap && s.cooldownUntil === null && (s.nextSendAt?.getTime() ?? 0) - NOW.getTime() <= POOL_MAX_WAIT_MS;
      }),
    );
  });
});

describe("jitter and send slots", () => {
  it("draws a whole number inside the range, ends included", () => {
    expect(jitterMs([3000, 9000], () => 0)).toBe(3000);
    expect(jitterMs([3000, 9000], () => 0.999999)).toBe(9000);
    expect(jitterMs([5, 5], () => 0.4)).toBe(5);
    expect(DELIVERY_GAP_MS[0]).toBeGreaterThan(OTP_GAP_MS[1] - 1);
    for (const range of [[-1, 5], [5, 4], [1.5, 3]] as const) expect(() => jitterMs(range, () => 0)).toThrow(RangeError);
  });

  it("reserves a slot after the number's previous one, or now when it is free", () => {
    expect(reserveSlot({ nextSendAt: null }, NOW, 4000)).toEqual({ startAt: NOW, nextSendAt: at(4000) });
    expect(reserveSlot({ nextSendAt: at(-1000) }, NOW, 4000)).toEqual({ startAt: NOW, nextSendAt: at(4000) });
    expect(reserveSlot({ nextSendAt: at(7000) }, NOW, 4000)).toEqual({ startAt: at(7000), nextSendAt: at(11_000) });
    expect(() => reserveSlot({ nextSendAt: null }, NOW, -1)).toThrow(RangeError);
    expect(() => reserveSlot({ nextSendAt: null }, NOW, 0.5)).toThrow(RangeError);
  });

  it("holds the slot back to the per-contact gap when the contact was written to a moment ago, and never moves it earlier", () => {
    expect(reserveSlot({ nextSendAt: null }, NOW, 4000, at(45_000))).toEqual({ startAt: at(45_000), nextSendAt: at(49_000) });
    expect(reserveSlot({ nextSendAt: at(7000) }, NOW, 4000, at(45_000))).toEqual({ startAt: at(45_000), nextSendAt: at(49_000) });
    expect(reserveSlot({ nextSendAt: at(60_000) }, NOW, 4000, at(45_000))).toEqual({ startAt: at(60_000), nextSendAt: at(64_000) });
    expect(reserveSlot({ nextSendAt: null }, NOW, 4000, at(-5000))).toEqual({ startAt: NOW, nextSendAt: at(4000) });
  });
});

describe("ban signals (WhatsApp's 463 reachout timelock and 475 message capping)", () => {
  const blocked = (id: string, until = at(60_000)) => session(id, { reachoutUntil: until });

  it("keeps a number under a ban signal from NEW contacts (an opener, an OTP) but not from answering a buyer who wrote first", () => {
    const pool = [blocked("a"), session("b")];
    expect(idOf(pickSession(pool, ctx({ newContact: true })))).toBe("b");
    expect(idOf(pickSession(pool.slice(0, 1), ctx({ newContact: true })))).toBe("none:all_reachout_blocked");
    // A reply is not a new contact: the blocked number still takes it.
    expect(idOf(pickSession(pool.slice(0, 1), ctx()))).toBe("a");
    expect(idOf(pickSession(pool.slice(0, 1), ctx({ newContact: false })))).toBe("a");
  });

  it("lets a number back in when its ban signal has ended (at the end instant, too)", () => {
    expect(idOf(pickSession([blocked("a", at(0))], ctx({ newContact: true })))).toBe("a");
    expect(idOf(pickSession([blocked("a", at(-1))], ctx({ newContact: true })))).toBe("a");
    expect(idOf(pickSession([blocked("a", at(1))], ctx({ newContact: true })))).toBe("none:all_reachout_blocked");
  });

  it("explains the shortage after the cooldown and the cap, so every other reason keeps its meaning", () => {
    expect(idOf(pickSession([session("a", { reachoutUntil: at(1), cooldownUntil: at(60_000) })], ctx({ newContact: true })))).toBe("none:all_cooling_down");
    expect(idOf(pickSession([blocked("a", at(1))].map((s) => ({ ...s, dailyCap: 0 })), ctx({ newContact: true })))).toBe("none:all_capped");
  });

  it("a warning slows a number's new-contact sends: a smaller share of its new-contact budget and a longer gap (the shares are configurable)", () => {
    expect(warningSlowdown("none")).toEqual({ capFactor: 1, gapFactor: 1 });
    expect(warningSlowdown("first")).toEqual({ capFactor: 0.5, gapFactor: 2 });
    expect(warningSlowdown("second")).toEqual({ capFactor: 0.25, gapFactor: 4 });
    expect(warningSlowdown("first", [0.8, 0.1])).toEqual({ capFactor: 0.8, gapFactor: 2 });
    expect(warningSlowdown("second", [0.8, 0.1])).toEqual({ capFactor: 0.1, gapFactor: 4 });
    expect(DEFAULT_WARNING_CAP_FACTORS).toEqual([0.5, 0.25]);
    expect(REACHOUT_COOLDOWN_MS).toBe(3_600_000);
    expect(effectiveNewContactCap({ newContactCap: 30, warning: "none" })).toBe(30);
    expect(effectiveNewContactCap({ newContactCap: 30, warning: "first" })).toBe(15);
    expect(effectiveNewContactCap({ newContactCap: 30, warning: "second" })).toBe(7);
    expect(effectiveNewContactCap({ newContactCap: 30, warning: "second" }, [0.5, 0.5])).toBe(15);
  });
});

describe("the daily budget of NEW contacts (separate from replies) and contacts a number already knows", () => {
  it("a new-contact send needs room in the number's new-contact budget, which a warning shrinks; replies and other sends never spend or need it", () => {
    const spent = session("a", { newContactCap: 10, newContactsToday: 10 });
    expect(idOf(pickSession([spent], ctx({ newContact: true })))).toBe("none:all_new_contact_capped");
    // A reply is not a new contact: the exhausted budget does not stop it.
    expect(idOf(pickSession([spent], ctx()))).toBe("a");
    expect(idOf(pickSession([session("a", { newContactCap: 10, newContactsToday: 9 })], ctx({ newContact: true })))).toBe("a");
    // The warning leaves half (first) or a quarter (second) of the budget.
    expect(idOf(pickSession([session("a", { newContactCap: 10, newContactsToday: 5, warning: "first" })], ctx({ newContact: true })))).toBe("none:all_new_contact_capped");
    expect(idOf(pickSession([session("a", { newContactCap: 10, newContactsToday: 4, warning: "first" })], ctx({ newContact: true })))).toBe("a");
    expect(idOf(pickSession([session("a", { newContactCap: 10, newContactsToday: 2, warning: "second" })], ctx({ newContact: true })))).toBe("none:all_new_contact_capped");
    expect(idOf(pickSession([session("a", { newContactCap: 10, newContactsToday: 4, warning: "first" })], ctx({ newContact: true, warningCapFactors: [0.9, 0.9] })))).toBe("a");
    // A budget of 0 takes the number out of the new-contact traffic only.
    expect(idOf(pickSession([session("a", { newContactCap: 0 })], ctx({ newContact: true })))).toBe("none:all_new_contact_capped");
    expect(idOf(pickSession([session("a", { newContactCap: 0 })], ctx()))).toBe("a");
  });

  it("picks the number that still has budget, and says nothing about the budget before the ban signals", () => {
    const pool = [session("a", { newContactCap: 5, newContactsToday: 5 }), session("b", { newContactCap: 5, newContactsToday: 1 })];
    expect(idOf(pickSession(pool, ctx({ newContact: true })))).toBe("b");
    const both = [session("a", { reachoutUntil: at(60_000), newContactCap: 5, newContactsToday: 5 })];
    expect(idOf(pickSession(both, ctx({ newContact: true })))).toBe("none:all_reachout_blocked");
  });

  it("a number that already has a chat with the contact is not held to the new-contact rules: it answers it though WhatsApp holds it back and its budget is spent", () => {
    const blocked = session("a", { reachoutUntil: at(60_000), newContactCap: 1, newContactsToday: 1, knowsContact: true });
    expect(idOf(pickSession([blocked], ctx({ newContact: true })))).toBe("a");
    expect(idOf(pickSession([{ ...blocked, knowsContact: false }], ctx({ newContact: true })))).toBe("none:all_reachout_blocked");
    // Of two numbers the one that knows the contact is the only one allowed when the other is held back.
    expect(idOf(pickSession([session("x", { reachoutUntil: at(60_000) }), session("y", { reachoutUntil: at(60_000), knowsContact: true })], ctx({ newContact: true })))).toBe("y");
  });
});

describe("sessionHealthAfter", () => {
  it("clears the streak when a send goes out and trips the breaker at the threshold", () => {
    expect(sessionHealthAfter(2, true, NOW)).toEqual({ failStreak: 0, cooldownUntil: null, tripped: false });
    expect(sessionHealthAfter(0, false, NOW)).toEqual({ failStreak: 1, cooldownUntil: null, tripped: false });
    expect(sessionHealthAfter(SESSION_FAIL_THRESHOLD - 2, false, NOW).tripped).toBe(false);
    expect(sessionHealthAfter(SESSION_FAIL_THRESHOLD - 1, false, NOW)).toEqual({ failStreak: SESSION_FAIL_THRESHOLD, cooldownUntil: at(SESSION_COOLDOWN_MS), tripped: true });
    // a probe after the cooldown that fails again rests the number again at once
    expect(sessionHealthAfter(SESSION_FAIL_THRESHOLD, false, NOW).tripped).toBe(true);
    expect(() => sessionHealthAfter(-1, true, NOW)).toThrow(RangeError);
    expect(() => sessionHealthAfter(1.5, true, NOW)).toThrow(RangeError);
  });
});
