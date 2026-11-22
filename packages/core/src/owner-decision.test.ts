import { describe, expect, it } from "vitest";
import {
  DECISION_STATUS,
  decisionCoversReconciliation,
  decisionCoversRequery,
  decisionHeldMoney,
  decisionLeftByRequery,
  type GatewayState,
  OWNER_DECISIONS,
  OWNER_REQUERY_MAX_ATTEMPTS,
  OWNER_REQUERY_MIN_INTERVAL_MS,
  parseFingerprint,
  type RecordedDecision,
  REVIEW_ALERT_KINDS,
  REVIEW_STUCK_AFTER_MS,
} from "./owner-decision.ts";
import { transitionOrder } from "./order-machine.ts";

const deny: GatewayState = { status: "deny", fraud: null };
const settlement: GatewayState = { status: "settlement", fraud: "accept" };
const none: GatewayState = { status: null, fraud: null };
const markedPaid: RecordedDecision = { toStatus: "paid", attempts: [{ n: 1, ...deny }, { n: 2, ...none }] };

describe("the decisions and the statuses they leave", () => {
  it("mark paid -> paid, not paid -> gateway_failed (terminal, unpaid, and a later settlement still pays it)", () => {
    expect(OWNER_DECISIONS).toEqual(["paid", "not_paid"]);
    expect(DECISION_STATUS).toEqual({ paid: "paid", not_paid: "gateway_failed" });
    expect(transitionOrder(DECISION_STATUS.not_paid, "settlement")).toEqual({ kind: "move", to: "paid" });
    expect(transitionOrder(DECISION_STATUS.not_paid, "deny")).toEqual({ kind: "stay", alert: false });
  });

  it("names the review alerts a decision resolves and the 24 h stuck threshold", () => {
    expect(REVIEW_ALERT_KINDS).toContain("payment_paid_reversed");
    expect(REVIEW_ALERT_KINDS).not.toContain("payment_chargeback");
    expect(REVIEW_STUCK_AFTER_MS).toBe(86_400_000);
    expect([OWNER_REQUERY_MAX_ATTEMPTS, OWNER_REQUERY_MIN_INTERVAL_MS]).toEqual([5, 60_000]);
  });
});

describe("parseFingerprint", () => {
  it("reads the ledger's attempts", () => {
    expect(parseFingerprint([{ n: 1, status: "deny", fraud: null }, { n: 2, status: null, fraud: null }])).toEqual(markedPaid.attempts);
    expect(parseFingerprint([])).toEqual([]);
  });

  it.each([
    ["not an array", { n: 1 }],
    ["a non-object item", [1]],
    ["a null item", [null]],
    ["a bad n", [{ n: 0, status: null, fraud: null }]],
    ["a fractional n", [{ n: 1.5, status: null, fraud: null }]],
    ["a numeric status", [{ n: 1, status: 3, fraud: null }]],
    ["a missing fraud", [{ n: 1, status: "deny" }]],
    ["a repeated n", [{ n: 1, status: null, fraud: null }, { n: 1, status: "deny", fraud: null }]],
  ])("refuses %s (then nothing is honoured)", (_what, value) => {
    expect(parseFingerprint(value)).toBeNull();
  });
});

describe("decisionCoversRequery", () => {
  it("covers a re-query that shows the decided state again, before and after", () => {
    expect(decisionCoversRequery(markedPaid, "paid", 1, deny, deny)).toBe(true);
    expect(decisionCoversRequery(markedPaid, "paid", 2, none, none)).toBe(true);
  });

  it("does not cover a new Midtrans event (another status or fraud status)", () => {
    expect(decisionCoversRequery(markedPaid, "paid", 1, deny, { status: "refund", fraud: null })).toBe(false);
    expect(decisionCoversRequery(markedPaid, "paid", 1, deny, { status: "deny", fraud: "challenge" })).toBe(false);
    expect(decisionCoversRequery(markedPaid, "paid", 1, deny, settlement)).toBe(false);
  });

  it("is spent for an attempt once another state was recorded, even if Midtrans returns to the decided one", () => {
    expect(decisionCoversRequery(markedPaid, "paid", 1, settlement, deny)).toBe(false);
  });

  it("covers nothing once the order left the decided status, for an attempt it does not name, or without a decision", () => {
    expect(decisionCoversRequery(markedPaid, "refunded", 1, deny, deny)).toBe(false);
    expect(decisionCoversRequery(markedPaid, "paid", 3, none, none)).toBe(false);
    expect(decisionCoversRequery(null, "paid", 1, deny, deny)).toBe(false);
  });
});

describe("decisionLeftByRequery (security review M1: the Owner is told even when nothing moves)", () => {
  it("is true when the attempt was in the decided state and is not any more", () => {
    expect(decisionLeftByRequery(markedPaid, "paid", 1, deny, settlement)).toBe(true);
    expect(decisionLeftByRequery(markedPaid, "paid", 2, none, { status: "expire", fraud: null })).toBe(true);
  });

  it("is false while the state is the decided one, once already left, for an unknown attempt, another status or no decision", () => {
    expect(decisionLeftByRequery(markedPaid, "paid", 1, deny, deny)).toBe(false);
    expect(decisionLeftByRequery(markedPaid, "paid", 1, settlement, deny)).toBe(false);
    expect(decisionLeftByRequery(markedPaid, "paid", 3, none, deny)).toBe(false);
    expect(decisionLeftByRequery(markedPaid, "review", 1, deny, settlement)).toBe(false);
    expect(decisionLeftByRequery(null, "paid", 1, deny, settlement)).toBe(false);
  });
});

describe("decisionHeldMoney (security review M1)", () => {
  const challenged: RecordedDecision = {
    toStatus: "paid",
    attempts: [
      { n: 1, status: "capture", fraud: "challenge" },
      { n: 2, status: "pending", fraud: null },
      { n: 3, status: null, fraud: null },
      { n: 4, status: "partial_refund", fraud: null },
    ],
  };

  it("counts an attempt that showed money when the Owner marked the order paid", () => {
    expect(decisionHeldMoney(challenged, "paid", 1)).toBe(true);
    expect(decisionHeldMoney(challenged, "paid", 4)).toBe(true);
  });

  it("not one that showed none, one it does not name, a not-paid decision, an order no longer paid, or no decision", () => {
    expect(decisionHeldMoney(challenged, "paid", 2)).toBe(false);
    expect(decisionHeldMoney(challenged, "paid", 3)).toBe(false);
    expect(decisionHeldMoney(challenged, "paid", 5)).toBe(false);
    expect(decisionHeldMoney({ ...challenged, toStatus: "gateway_failed" }, "gateway_failed", 1)).toBe(false);
    expect(decisionHeldMoney(challenged, "review", 1)).toBe(false);
    expect(decisionHeldMoney(null, "paid", 1)).toBe(false);
  });
});

describe("decisionCoversReconciliation", () => {
  const checked = (one: GatewayState, two: GatewayState) => [
    { n: 1, prior: deny, next: one },
    { n: 2, prior: none, next: two },
  ];

  it("covers a run that finds every attempt in the decided state", () => {
    expect(decisionCoversReconciliation(markedPaid, "paid", checked(deny, none))).toBe(true);
  });

  it("does not cover a run with any new state, a missing or extra attempt, another status, or no decision", () => {
    expect(decisionCoversReconciliation(markedPaid, "paid", checked({ status: "chargeback", fraud: null }, none))).toBe(false);
    expect(decisionCoversReconciliation(markedPaid, "paid", checked(deny, { status: "expire", fraud: null }))).toBe(false);
    expect(decisionCoversReconciliation(markedPaid, "paid", [{ n: 1, prior: deny, next: deny }])).toBe(false);
    expect(decisionCoversReconciliation(markedPaid, "paid", [...checked(deny, none), { n: 3, prior: none, next: none }])).toBe(false);
    expect(decisionCoversReconciliation(markedPaid, "paid", [])).toBe(false);
    expect(decisionCoversReconciliation(markedPaid, "gateway_failed", checked(deny, none))).toBe(false);
    expect(decisionCoversReconciliation(null, "paid", checked(deny, none))).toBe(false);
  });
});
