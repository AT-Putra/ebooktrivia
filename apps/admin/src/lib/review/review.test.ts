// US-033: the review queue's pure helpers, and the SQLSTATE read the decision's messages rest on.
import { describe, expect, it } from "vitest";
import { sqlState } from "../settings/fields.ts";
import { type DecisionResult, decisionMessage, reasonLabel } from "./review.ts";

const base: DecisionResult = {
  decision: "paid",
  replayed: false,
  eligible: true,
  deliveriesCreated: 0,
  deliveriesRevived: 1,
  mtCreated: 0,
  mtRevived: 2,
  reversalsCreated: 0,
  magicLinksRevoked: 0,
  winnersFlagged: 0,
  alertsResolved: 1,
  fulfilmentSkipped: false,
};

describe("sqlState", () => {
  it("reads a PostgreSQL error by shape too (a second copy of postgres.js in the production build fails instanceof)", () => {
    // What postgres.js builds from the server's ErrorResponse: an Error with the server's fields assigned onto it.
    const fromOtherCopy = Object.assign(new Error("order_review_decide: the confirmation does not match the order"), { severity: "ERROR", code: "ET185", routine: "exec_stmt_raise" });
    expect(sqlState(fromOtherCopy)).toBe("ET185");
  });

  it("is undefined for anything else: a Node system error, a plain object, a bad code", () => {
    expect(sqlState(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBeUndefined();
    expect(sqlState({ code: "ET185", severity: "ERROR" })).toBeUndefined();
    expect(sqlState(Object.assign(new Error("x"), { code: "et185x", severity: "ERROR" }))).toBeUndefined();
    expect(sqlState(new Error("x"))).toBeUndefined();
  });
});

describe("the queue's labels", () => {
  it("names why an order is in review", () => {
    expect(reasonLabel("deny", "paid")).toBe("Midtrans reversed a payment we counted (D9: deny)");
    expect(reasonLabel("cancel", "paid")).toContain("D9");
    expect(reasonLabel("partial_refund", "paid")).toBe("Partial refund (D5)");
    expect(reasonLabel("partial_chargeback", "paid")).toBe("Partial chargeback (D5)");
    expect(reasonLabel("challenge", "pending")).toContain("Fraud challenge");
    expect(reasonLabel("refund", "pending")).toBe("Full refund of an order that was never confirmed paid");
    expect(reasonLabel("unknown", "pending")).toBe("Midtrans status unknown");
  });
});

describe("decisionMessage", () => {
  it("says what mark paid did", () => {
    expect(decisionMessage(base)).toBe("Marked paid. 1 delivery and 2 conversions back on the send path. The buyer can play and log in again (WhatsApp code or the login page's resend).");
    expect(decisionMessage({ ...base, deliveriesRevived: 0, mtRevived: 0, deliveriesCreated: 2, mtCreated: 1, eligible: false, winnersFlagged: 1 })).toBe(
      "Marked paid. 2 deliveries and 1 conversion created. 1 flagged winner of this buyer stays flagged: reinstate on the contest results page.",
    );
  });

  it("says that mark paid of an erased buyer's order kept the money and fulfilled nothing", () => {
    expect(decisionMessage({ ...base, deliveriesRevived: 0, mtRevived: 0, eligible: false, fulfilmentSkipped: true })).toBe(
      "Marked paid without fulfilment: the buyer was erased (UU PDP), so nothing is delivered, no conversion is reported and nobody becomes eligible.",
    );
  });

  it("says what not paid did", () => {
    expect(decisionMessage({ ...base, decision: "not_paid", eligible: false, reversalsCreated: 1, magicLinksRevoked: 2 })).toBe(
      "Marked not paid: the order is closed as failed. 1 reversal postback queued. The buyer is not eligible. 2 login links revoked.",
    );
    expect(decisionMessage({ ...base, decision: "not_paid", eligible: true })).toBe("Marked not paid: the order is closed as failed. The buyer stays eligible through another paid order.");
  });
});
