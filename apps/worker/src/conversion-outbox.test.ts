// The single order.paid consumer (US-024 conversions, US-025 delivery): every nudge runs, whatever the others do.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrderPaidConsumer, type OrderPaidNudge } from "./conversion-outbox.ts";

const row = (payload: unknown) => ({ id: randomUUID(), topic: "order.paid", payload, sealed: null, attempts: 1 });
const run = (nudges: readonly OrderPaidNudge[], payload: unknown) => createOrderPaidConsumer(nudges).perform(row(payload), new AbortController().signal);

describe("createOrderPaidConsumer", () => {
  it("runs every nudge with the order id", async () => {
    const orderId = randomUUID();
    const seen: string[] = [];
    const nudge = (name: string): OrderPaidNudge => (id) => {
      seen.push(`${name}:${id}`);
      return Promise.resolve();
    };
    expect(await run([nudge("a"), nudge("b")], { order_id: orderId })).toBeUndefined();
    expect(seen.sort()).toEqual([`a:${orderId}`, `b:${orderId}`]);
  });

  it("does not let a failing nudge hold back the others, and still fails the row so the outbox retries", async () => {
    const orderId = randomUUID();
    let delivered = false;
    const failing: OrderPaidNudge = () => Promise.reject(new Error("the conversion queue is down"));
    const slow: OrderPaidNudge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      delivered = true;
    };
    // Sequentially the failing first nudge used to stop the loop: the delivery nudge behind it never ran.
    await expect(run([failing, slow], { order_id: orderId })).rejects.toThrow("the conversion queue is down");
    expect(delivered).toBe(true);
  });

  it("refuses a payload without an order id", async () => {
    await expect(run([], { nothing: true })).rejects.toThrow("order.paid payload has no order id");
  });
});
