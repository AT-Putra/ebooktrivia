import { describe, expect, it } from "vitest";
import { isEligible } from "./eligibility.ts";
import { ORDER_STATUSES, transitionOrder } from "./order-machine.ts";

describe("isEligible: a paid, non-refunded order for that program", () => {
  it.each(ORDER_STATUSES)("a single %s order", (status) => {
    expect(isEligible([{ programId: "p1", status }], "p1")).toBe(status === "paid");
  });

  it("is per program, never global", () => {
    expect(isEligible([{ programId: "p2", status: "paid" }], "p1")).toBe(false);
  });

  it("stays eligible while another paid order for the program remains after a refund", () => {
    const orders = [
      { programId: "p1", status: "refunded" as const },
      { programId: "p1", status: "paid" as const },
    ];
    expect(isEligible(orders, "p1")).toBe(true);
    expect(isEligible(orders.slice(0, 1), "p1")).toBe(false);
  });

  it("is false without orders", () => {
    expect(isEligible([], "p1")).toBe(false);
  });
});

describe("NEW-3: double payment keeps the buyer eligible", () => {
  it.each(["refund", "partial_refund", "chargeback", "partial_chargeback", "challenge", "cancel"] as const)(
    "double payment, duplicate %s -> still eligible",
    (event) => {
      const t = transitionOrder("paid", event, { otherSettledAttempts: 1 });
      const status = t.kind === "move" ? t.to : "paid";
      expect(isEligible([{ programId: "p1", status }], "p1")).toBe(true);
    },
  );

  it("without another settled attempt a full refund still revokes eligibility", () => {
    const t = transitionOrder("paid", "refund", { otherSettledAttempts: 0 });
    expect(t).toEqual({ kind: "move", to: "refunded" });
    expect(isEligible([{ programId: "p1", status: "refunded" }], "p1")).toBe(false);
  });
});
