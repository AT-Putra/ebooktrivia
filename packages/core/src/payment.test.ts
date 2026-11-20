import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES } from "./order-machine.ts";
import {
  attemptContext,
  decidePayment,
  deliverySchedule,
  isChargeback,
  isSettledStatus,
  mtSinks,
  paymentEvent,
  RECONCILE_FINDINGS,
  reconcileOrder,
  type ReconcileVerdict,
  reconciliationDay,
  REQUERY_ALERT_AFTER_MS,
  requeryOverdue,
  reversalSinks,
  WA_PROACTIVE_DELAY_MS,
  winnerFlagReason,
} from "./payment.ts";

describe("paymentEvent: the event of a re-queried verdict", () => {
  it("is settlement only for a confirmed settlement, challenge for a mismatch", () => {
    expect(paymentEvent({ kind: "paid" }, "accept")).toBe("settlement");
    expect(paymentEvent({ kind: "review", reason: "amount_mismatch" }, "accept")).toBe("challenge");
  });

  it("maps every other status through classifyMidtransStatus", () => {
    expect(paymentEvent({ kind: "not_settled", transactionStatus: "deny" }, null)).toBe("deny");
    expect(paymentEvent({ kind: "not_settled", transactionStatus: "partial_refund" }, undefined)).toBe("partial_refund");
    expect(paymentEvent({ kind: "not_settled", transactionStatus: "capture" }, "accept")).toBe("capture");
    expect(paymentEvent({ kind: "not_settled", transactionStatus: "authorize" }, null)).toBe("unknown");
  });

  it("never turns a not-settled verdict into a settlement", () => {
    expect(paymentEvent({ kind: "not_settled", transactionStatus: "settlement" }, "accept")).toBe("challenge");
  });
});

describe("attemptContext", () => {
  const a = (n: number, gatewayStatus: string | null, gatewayFraudStatus: string | null = null) => ({ n, gatewayStatus, gatewayFraudStatus });

  it("counts the OTHER attempts whose stored status holds money", () => {
    const attempts = [a(1, "settlement", "accept"), a(2, "settlement"), a(3, "deny"), a(4, null), a(5, "settlement", "challenge")];
    expect(attemptContext(2, 5, attempts)).toEqual({ eventAttemptIsLatest: false, otherSettledAttempts: 1 });
    expect(attemptContext(5, 5, attempts)).toEqual({ eventAttemptIsLatest: true, otherSettledAttempts: 2 });
    expect(attemptContext(1, 1, [])).toEqual({ eventAttemptIsLatest: true, otherSettledAttempts: 0 });
  });

  it("isSettledStatus: settlement with fraud accept or none, nothing else", () => {
    expect(isSettledStatus("settlement", null)).toBe(true);
    expect(isSettledStatus("settlement", "accept")).toBe(true);
    expect(isSettledStatus("settlement", "challenge")).toBe(false);
    expect(isSettledStatus("capture", "accept")).toBe(false);
    expect(isSettledStatus("refund", null)).toBe(false);
    expect(isSettledStatus(null, null)).toBe(false);
  });
});

describe("decidePayment", () => {
  it("pays a pending, expired, cancelled or reviewed order on a confirmed settlement, silently", () => {
    for (const state of ["pending", "expired", "gateway_failed", "snap_create_failed", "review"] as const) {
      expect(decidePayment(state, { kind: "paid" }, "accept", {})).toEqual({ event: "settlement", transition: { kind: "move", to: "paid" }, alert: null });
    }
  });

  it("never pays on a mismatched settlement and always alerts critical", () => {
    expect(decidePayment("pending", { kind: "review", reason: "amount_mismatch" }, "accept", {})).toEqual({
      event: "challenge",
      transition: { kind: "move", to: "review" },
      alert: { kind: "payment_settlement_review", severity: "critical" },
    });
    expect(decidePayment("refunded", { kind: "review", reason: "currency_mismatch" }, null, {}).alert).toEqual({ kind: "payment_settlement_review", severity: "critical" });
  });

  it("a second settlement on another attempt of a paid order is not a second PAID: a critical double-charge alert", () => {
    expect(decidePayment("paid", { kind: "paid" }, null, { otherSettledAttempts: 1 })).toEqual({
      event: "settlement",
      transition: { kind: "stay", alert: true },
      alert: { kind: "payment_double_settlement", severity: "critical" },
    });
    // The same attempt again (a replay): nothing to say.
    expect(decidePayment("paid", { kind: "paid" }, null, {})).toEqual({ event: "settlement", transition: { kind: "stay", alert: false }, alert: null });
  });

  it("m10: an accepted card capture of an unpaid order waits for settlement quietly; on a paid order it still alerts", () => {
    const capture = { kind: "not_settled", transactionStatus: "capture" } as const;
    for (const state of ["pending", "expired", "gateway_failed", "snap_create_failed"] as const) {
      expect(decidePayment(state, capture, "accept", {})).toEqual({ event: "capture", transition: { kind: "stay", alert: true }, alert: null });
    }
    expect(decidePayment("paid", capture, "accept", {}).alert).toEqual({ kind: "payment_anomaly", severity: "warning" });
    expect(decidePayment("refunded", capture, "accept", {}).alert).toEqual({ kind: "payment_anomaly", severity: "warning" });
  });

  it("isChargeback: full and partial chargebacks only", () => {
    expect(isChargeback("chargeback")).toBe(true);
    expect(isChargeback("partial_chargeback")).toBe(true);
    expect(isChargeback("refund")).toBe(false);
  });

  it("other anomalies warn; moves to review warn; deny stays pending quietly", () => {
    expect(decidePayment("refunded", { kind: "paid" }, null, {}).alert).toEqual({ kind: "payment_anomaly", severity: "warning" });
    expect(decidePayment("paid", { kind: "not_settled", transactionStatus: "partial_refund" }, null, {})).toEqual({
      event: "partial_refund",
      transition: { kind: "move", to: "review" },
      alert: { kind: "payment_review", severity: "warning" },
    });
    expect(decidePayment("pending", { kind: "not_settled", transactionStatus: "deny" }, null, {})).toEqual({ event: "deny", transition: { kind: "stay", alert: false }, alert: null });
  });
});

describe("the PAID effects", () => {
  it("S2S only for an attributed click; Meta / TikTok per landing-page pixel; never Google", () => {
    expect(mtSinks({ adnetId: "a", clickid: "c", pixels: { meta: "1", tiktok: "2", gtag: "AW-1" } })).toEqual(["s2s", "meta", "tiktok"]);
    expect(mtSinks({ adnetId: "a", clickid: "", pixels: {} })).toEqual([]);
    expect(mtSinks({ adnetId: null, clickid: "c", pixels: { meta: "" } })).toEqual([]);
    expect(mtSinks({ adnetId: "a", clickid: null, pixels: { tiktok: 5 } })).toEqual([]);
    expect(mtSinks({ adnetId: null, clickid: null, pixels: ["meta"] })).toEqual([]);
    expect(mtSinks({ adnetId: null, clickid: null, pixels: null })).toEqual([]);
    expect(mtSinks({ adnetId: null, clickid: null, pixels: { tiktok: "x" } })).toEqual(["tiktok"]);
  });

  it("reverses only an S2S MT of an adnet with a reversal template", () => {
    expect(reversalSinks(["s2s", "meta"], true)).toEqual(["s2s"]);
    expect(reversalSinks(["s2s"], false)).toEqual([]);
    expect(reversalSinks(["meta", "tiktok"], true)).toEqual([]);
  });

  it("sends e-mail at once and WhatsApp after the delay (default 3 minutes)", () => {
    const paidAt = new Date("2026-11-21T03:00:00.000Z");
    expect(WA_PROACTIVE_DELAY_MS).toBe(180_000);
    expect(deliverySchedule(paidAt, WA_PROACTIVE_DELAY_MS)).toEqual({ email: paidAt, whatsapp: new Date("2026-11-21T03:03:00.000Z") });
    expect(deliverySchedule(paidAt, 0).whatsapp).toEqual(paidAt);
    expect(() => deliverySchedule(paidAt, -1)).toThrow(RangeError);
    expect(() => deliverySchedule(paidAt, 1.5)).toThrow(RangeError);
  });
});

describe("refunds and chargebacks", () => {
  it("a chargeback always flags; anything else only when no paid order is left", () => {
    expect(winnerFlagReason("chargeback", true)).toBe("chargeback");
    expect(winnerFlagReason("partial_chargeback", false)).toBe("chargeback");
    expect(winnerFlagReason("refund", false)).toBe("no_paid_order");
    expect(winnerFlagReason("refund", true)).toBeNull();
    expect(winnerFlagReason("partial_refund", true)).toBeNull();
  });
});

describe("re-query and reconciliation", () => {
  it("alerts on a re-query that has failed for 24 hours", () => {
    const received = new Date("2026-11-20T00:00:00.000Z");
    expect(requeryOverdue(received, new Date(received.getTime() + REQUERY_ALERT_AFTER_MS - 1))).toBe(false);
    expect(requeryOverdue(received, new Date(received.getTime() + REQUERY_ALERT_AFTER_MS))).toBe(true);
  });

  it("is due once per WIB day from 02:00 WIB", () => {
    expect(reconciliationDay(new Date("2026-11-20T18:59:59.000Z"))).toBeNull(); // 01:59 WIB on the 21st
    expect(reconciliationDay(new Date("2026-11-20T19:00:00.000Z"))).toBe("2026-11-21"); // 02:00 WIB
    expect(reconciliationDay(new Date("2026-11-21T16:59:59.000Z"))).toBe("2026-11-21"); // 23:59 WIB
    expect(reconciliationDay(new Date("2026-11-21T17:00:00.000Z"))).toBeNull(); // 00:00 WIB on the 22nd
  });

  it("names each mismatch between the order and its attempts", () => {
    expect(reconcileOrder("pending", ["not_found", "paid"])).toEqual(["settled_not_paid"]);
    expect(reconcileOrder("expired", ["paid"])).toEqual(["settled_not_paid"]);
    expect(reconcileOrder("review", ["paid", "not_settled"])).toEqual(["settled_not_paid"]);
    expect(reconcileOrder("paid", ["not_settled", "not_found"])).toEqual(["paid_not_settled"]);
    expect(reconcileOrder("paid", ["paid", "paid"])).toEqual(["double_settlement"]);
    expect(reconcileOrder("pending", ["review"])).toEqual(["settlement_review"]);
    expect(reconcileOrder("refunded", ["paid"])).toEqual(["refunded_but_settled"]);
    expect(reconcileOrder("paid", ["paid", "not_found"])).toEqual([]);
    expect(reconcileOrder("pending", ["not_settled", "not_found"])).toEqual([]);
    expect(reconcileOrder("refunded", ["not_settled"])).toEqual([]);
  });

  it("property: a confirmed paid order with exactly one settled attempt is never a mismatch, and every finding is a known kind", () => {
    const verdict = fc.constantFrom<ReconcileVerdict>("paid", "review", "not_settled", "not_found");
    fc.assert(
      fc.property(fc.constantFrom(...ORDER_STATUSES), fc.array(verdict, { maxLength: 6 }), (status, verdicts) => {
        const findings = reconcileOrder(status, verdicts);
        for (const f of findings) expect(RECONCILE_FINDINGS).toContain(f);
        if (status === "paid" && verdicts.filter((v) => v === "paid").length === 1 && !verdicts.includes("review")) expect(findings).toEqual([]);
      }),
    );
  });
});
