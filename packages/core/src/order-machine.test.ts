import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyMidtransStatus,
  ORDER_EVENTS,
  ORDER_STATUSES,
  transitionOrder,
  type OrderEvent,
  type OrderStatus,
} from "./order-machine.ts";

// Hand-written expected table. Cell notation: a state name = move there, "=" = stay (logged),
// "!" = stay and alert (anomaly).
const COLUMNS = [
  "settlement",
  "challenge",
  "capture",
  "pending",
  "deny",
  "cancel",
  "expire",
  "failure",
  "refund",
  "partial_refund",
  "chargeback",
  "partial_chargeback",
  "unknown",
] as const;

type Cell = OrderStatus | "=" | "!";
// `capture` (card capture+accept, not yet settled) never pays: stay + alert in every state (review item 3).
const UNPAID: Cell[] = ["paid", "review", "!", "=", "=", "=", "=", "=", "review", "review", "review", "review", "!"];
const EXPECTED: Record<OrderStatus, Cell[]> = {
  //       settlement challenge capture pending deny cancel            expire     failure           refund      partial_r  chargeback  partial_c  unknown
  pending: ["paid", "review", "!", "=", "=", "gateway_failed", "expired", "gateway_failed", "review", "review", "review", "review", "!"],
  paid: ["=", "review", "!", "=", "=", "review", "=", "=", "refunded", "review", "refunded", "review", "!"],
  review: ["paid", "=", "!", "=", "=", "=", "=", "=", "refunded", "=", "refunded", "=", "!"],
  expired: UNPAID,
  gateway_failed: UNPAID,
  snap_create_failed: UNPAID,
  refunded: ["!", "!", "!", "=", "=", "=", "=", "=", "=", "=", "=", "=", "!"],
};

const cellOf = (state: OrderStatus, event: OrderEvent): Cell => EXPECTED[state][COLUMNS.indexOf(event)] ?? "!";

const expectCell = (t: ReturnType<typeof transitionOrder>, cell: Cell): void => {
  if (cell === "=") expect(t).toEqual({ kind: "stay", alert: false });
  else if (cell === "!") expect(t).toEqual({ kind: "stay", alert: true });
  else expect(t).toEqual({ kind: "move", to: cell });
};

const after = (state: OrderStatus, event: OrderEvent): OrderStatus => {
  const t = transitionOrder(state, event);
  return t.kind === "move" ? t.to : state;
};

describe("order machine: exhaustive state x event table", () => {
  it("covers exactly the module's states and events", () => {
    expect([...ORDER_EVENTS]).toEqual([...COLUMNS]);
    expect(Object.keys(EXPECTED).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  const cells = ORDER_STATUSES.flatMap((state) => COLUMNS.map((event, i) => [state, event, EXPECTED[state][i]] as const));

  it(`has ${String(ORDER_STATUSES.length * COLUMNS.length)} cells`, () => {
    expect(cells).toHaveLength(91);
  });

  it.each(cells)("%s + %s -> %s", (state, event, cell) => {
    const t = transitionOrder(state, event);
    if (cell === "=") expect(t).toEqual({ kind: "stay", alert: false });
    else if (cell === "!") expect(t).toEqual({ kind: "stay", alert: true });
    else expect(t).toEqual({ kind: "move", to: cell });
    // A move never targets the current state (that would be a stay).
    if (t.kind === "move") expect(t.to).not.toBe(state);
  });
});

describe("order machine: plan M6 verify sequences", () => {
  const run = (events: OrderEvent[], from: OrderStatus = "pending"): OrderStatus => events.reduce(after, from);

  it("deny -> retry with another method -> paid", () => {
    expect(run(["deny"])).toBe("pending");
    expect(run(["deny", "pending", "settlement"])).toBe("paid");
  });

  it("cancel -> paid, expired -> paid, failure -> paid (late settlement)", () => {
    expect(run(["cancel", "settlement"])).toBe("paid");
    expect(run(["expire", "settlement"])).toBe("paid");
    expect(run(["failure", "settlement"])).toBe("paid");
    expect(run(["settlement"], "snap_create_failed")).toBe("paid");
  });

  it("partial refund / chargeback / capture+challenge -> review", () => {
    expect(run(["settlement", "partial_refund"])).toBe("review");
    expect(run(["settlement", "partial_chargeback"])).toBe("review");
    expect(run(["challenge"])).toBe("review");
    expect(run(["challenge", "settlement"])).toBe("paid");
  });

  it("refund / chargeback after paid -> refunded, and stays refunded", () => {
    expect(run(["settlement", "refund"])).toBe("refunded");
    expect(run(["settlement", "chargeback", "settlement"])).toBe("refunded");
  });

  it("5 replays of a settlement give exactly one transition", () => {
    const transitions = Array.from({ length: 5 }).reduce<{ state: OrderStatus; moves: number }>(
      (acc) => {
        const t = transitionOrder(acc.state, "settlement");
        return t.kind === "move" ? { state: t.to, moves: acc.moves + 1 } : acc;
      },
      { state: "pending", moves: 0 },
    );
    expect(transitions).toEqual({ state: "paid", moves: 1 });
  });
});

describe("order machine: properties over random event sequences", () => {
  const arbState = fc.constantFrom(...ORDER_STATUSES);
  const arbEvents = fc.array(fc.constantFrom(...ORDER_EVENTS), { maxLength: 30 });

  it("enters paid only on a settlement event", () => {
    fc.assert(
      fc.property(arbState, arbEvents, (start, events) => {
        let state = start;
        for (const event of events) {
          const next = after(state, event);
          if (next === "paid" && state !== "paid") expect(event).toBe("settlement");
          state = next;
        }
      }),
    );
  });

  it("refunded is absorbing", () => {
    fc.assert(
      fc.property(arbEvents, (events) => {
        expect(events.reduce<OrderStatus>(after, "refunded")).toBe("refunded");
      }),
    );
  });

  it("only paid or review can become refunded", () => {
    fc.assert(
      fc.property(arbState, fc.constantFrom(...ORDER_EVENTS), (state, event) => {
        if (state !== "refunded" && after(state, event) === "refunded") {
          expect(["paid", "review"]).toContain(state);
          expect(["refund", "chargeback"]).toContain(event);
        }
      }),
    );
  });
});

describe("classifyMidtransStatus", () => {
  it.each<[string, string | null | undefined, OrderEvent]>([
    ["settlement", undefined, "settlement"],
    ["settlement", null, "settlement"],
    ["settlement", "", "settlement"],
    ["settlement", "accept", "settlement"],
    ["settlement", "challenge", "challenge"],
    ["settlement", "deny", "challenge"],
    ["capture", "accept", "capture"], // review item 3: not paid until settlement (AC-S6)
    ["capture", "challenge", "challenge"],
    ["capture", "deny", "deny"],
    ["capture", undefined, "challenge"],
    ["capture", "weird", "challenge"],
    ["pending", undefined, "pending"],
    ["deny", "deny", "deny"],
    ["cancel", undefined, "cancel"],
    ["expire", undefined, "expire"],
    ["failure", undefined, "failure"],
    ["refund", "accept", "refund"],
    ["partial_refund", "accept", "partial_refund"],
    ["chargeback", undefined, "chargeback"],
    ["partial_chargeback", undefined, "partial_chargeback"],
    ["authorize", "accept", "unknown"],
    ["SETTLEMENT", "accept", "unknown"],
    ["", undefined, "unknown"],
  ])("%s / %s -> %s", (status, fraud, expected) => {
    expect(classifyMidtransStatus(status, fraud)).toBe(expected);
  });
});

describe("review item 3: card capture+accept is not paid by default (AC-S6)", () => {
  it("classifies capture+accept as capture, or as settlement only when the Owner opts in", () => {
    expect(classifyMidtransStatus("capture", "accept")).toBe("capture");
    expect(classifyMidtransStatus("capture", "accept", { treatCardCaptureAsPaid: false })).toBe("capture");
    expect(classifyMidtransStatus("capture", "accept", { treatCardCaptureAsPaid: true })).toBe("settlement");
    // The option only affects capture+accept.
    expect(classifyMidtransStatus("capture", "challenge", { treatCardCaptureAsPaid: true })).toBe("challenge");
    expect(classifyMidtransStatus("settlement", undefined, { treatCardCaptureAsPaid: true })).toBe("settlement");
  });

  it.each(ORDER_STATUSES)("%s + capture/accept follows the capture column (default) or the settlement column (opt-in)", (state) => {
    expectCell(transitionOrder(state, classifyMidtransStatus("capture", "accept")), cellOf(state, "capture"));
    expectCell(
      transitionOrder(state, classifyMidtransStatus("capture", "accept", { treatCardCaptureAsPaid: true })),
      cellOf(state, "settlement"),
    );
  });

  it("pending -> capture -> settlement pays exactly on the settlement", () => {
    expect(after("pending", "capture")).toBe("pending");
    expect(after(after("pending", "capture"), "settlement")).toBe("paid");
  });
});

describe("review item 4: Midtrans attempt context", () => {
  const NEGATIVE: readonly OrderEvent[] = ["deny", "cancel", "expire", "failure"];
  type Overrides = Readonly<Partial<Record<OrderStatus, Readonly<Partial<Record<OrderEvent, Cell>>>>>>;
  // Hand-written from the round-2 policy, cell by cell. Double payment (otherSettledAttempts > 0):
  // the kept attempt's money still stands, so every reversal or doubt event leaves the order as it
  // is and alerts the Owner; a second settlement on a paid order alerts too.
  const DOUBLE_PAYMENT: Overrides = {
    paid: {
      settlement: "!",
      challenge: "!",
      cancel: "!",
      refund: "!",
      partial_refund: "!",
      chargeback: "!",
      partial_chargeback: "!",
    },
    review: { challenge: "!", cancel: "!", refund: "!", partial_refund: "!", chargeback: "!", partial_chargeback: "!" },
  };
  // Event from an older attempt (eventAttemptIsLatest false): deny / cancel / expire / failure are
  // ignored, except paid + cancel, which may be the attempt that paid (base table: review).
  const OLDER_ATTEMPT: Overrides = {
    pending: { deny: "=", cancel: "=", expire: "=", failure: "=" },
    paid: { deny: "=", expire: "=", failure: "=" },
    review: { deny: "=", cancel: "=", expire: "=", failure: "=" },
    expired: { deny: "=", cancel: "=", expire: "=", failure: "=" },
    gateway_failed: { deny: "=", cancel: "=", expire: "=", failure: "=" },
    snap_create_failed: { deny: "=", cancel: "=", expire: "=", failure: "=" },
    refunded: { deny: "=", cancel: "=", expire: "=", failure: "=" },
  };
  function expectedWithContext(state: OrderStatus, event: OrderEvent, latest: boolean, others: number): Cell {
    const doublePayment = others > 0 ? DOUBLE_PAYMENT[state]?.[event] : undefined;
    if (doublePayment !== undefined) return doublePayment;
    const older = latest ? undefined : OLDER_ATTEMPT[state]?.[event];
    return older ?? cellOf(state, event);
  }

  const cases = ORDER_STATUSES.flatMap((state) =>
    COLUMNS.flatMap((event) =>
      [true, false].flatMap((latest) => [0, 1].map((others) => [state, event, latest, others] as const)),
    ),
  );

  it(`checks all ${String(ORDER_STATUSES.length * COLUMNS.length * 4)} state x event x context cells`, () => {
    expect(cases).toHaveLength(364);
    for (const [state, event, latest, others] of cases) {
      const t = transitionOrder(state, event, { eventAttemptIsLatest: latest, otherSettledAttempts: others });
      try {
        expectCell(t, expectedWithContext(state, event, latest, others));
      } catch (error) {
        throw new Error(`${state} + ${event} (latest=${String(latest)}, others=${String(others)})`, { cause: error });
      }
    }
  });

  it("NEW-3: double payment, any reversal or doubt on the duplicate keeps the order paid and alerts", () => {
    for (const event of ["refund", "partial_refund", "chargeback", "partial_chargeback", "challenge", "cancel"] as const) {
      expect(transitionOrder("paid", event, { otherSettledAttempts: 1 })).toEqual({ kind: "stay", alert: true });
      expect(transitionOrder("paid", event, { otherSettledAttempts: 2, eventAttemptIsLatest: false })).toEqual({
        kind: "stay",
        alert: true,
      });
    }
  });

  it("a settlement from a different attempt on a paid order stays paid and alerts", () => {
    expect(transitionOrder("paid", "settlement", { otherSettledAttempts: 1 })).toEqual({ kind: "stay", alert: true });
  });

  it("deny / cancel / expire / failure from a non-latest attempt are ignored", () => {
    for (const event of NEGATIVE) {
      expect(transitionOrder("pending", event, { eventAttemptIsLatest: false })).toEqual({ kind: "stay", alert: false });
    }
  });

  it("the default context reproduces the base table", () => {
    for (const state of ORDER_STATUSES) {
      for (const event of COLUMNS) {
        expect(transitionOrder(state, event, {})).toEqual(transitionOrder(state, event));
      }
    }
  });

  it("rejects an invalid otherSettledAttempts", () => {
    expect(() => transitionOrder("paid", "refund", { otherSettledAttempts: -1 })).toThrow(RangeError);
    expect(() => transitionOrder("paid", "refund", { otherSettledAttempts: 0.5 })).toThrow(RangeError);
  });
});
