import { describe, expect, it } from "vitest";
import { type Pending, type SettleFetch, settleLoop, type SettleOptions } from "./settle.ts";

const orders = (n: number): Pending[] => Array.from({ length: n }, (_, i) => ({ midtransOrderId: `ORDER${String(i)}-1`, amountIdr: 10_000 }));

/** A clock and sleep that advance together, so rate limiting and the idle exit run instantly. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: (ms: number) => Promise.resolve(void (t += ms)) };
}

const base = (fetch: SettleFetch, pending: SettleOptions["pending"], extra: Partial<SettleOptions> = {}): SettleOptions => ({
  mode: "stub",
  pending,
  fetch,
  ratePerMinute: 50,
  idleExitMs: 10_000,
  stubUrl: "http://stub.test/",
  notifyUrl: "http://app.test/api/v1/webhooks/midtrans",
  ...clock(),
  ...extra,
});

describe("settleLoop, stub mode", () => {
  it("puts each pending order in settlement and has the stub notify the app, once per order, paced at the rate", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const c = clock();
    const times: number[] = [];
    const fetch: SettleFetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body ?? "{}") });
      if (url.endsWith("/state")) times.push(c.now());
      return Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
    };
    // The same three orders are listed on every poll (still pending in the database): each is settled once.
    const result = await settleLoop(base(fetch, () => Promise.resolve(orders(3)), { ...c }));
    expect(result).toEqual({ settled: 3, failed: 0, stoppedBecause: "idle" });
    expect(calls.map((x) => x.url)).toEqual([
      "http://stub.test/__stub/transactions/ORDER0-1/state",
      "http://stub.test/__stub/notify",
      "http://stub.test/__stub/transactions/ORDER1-1/state",
      "http://stub.test/__stub/notify",
      "http://stub.test/__stub/transactions/ORDER2-1/state",
      "http://stub.test/__stub/notify",
    ]);
    expect(calls[0]?.body).toEqual({ transaction_status: "settlement", payment_type: "qris" });
    expect(calls[1]?.body).toEqual({ order_id: "ORDER0-1", targetUrl: "http://app.test/api/v1/webhooks/midtrans" });
    // 50 a minute is one every 1.2 s.
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(1200);
  });

  it("waits for the first order for the start timeout (the orders run makes its Cap pool first), then exits idle only after the last order", async () => {
    const c = clock();
    const first = c.now() + 100_000;
    const fetch: SettleFetch = () => Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
    const pending = (): Promise<Pending[]> => Promise.resolve(c.now() >= first ? orders(2) : []);
    // Without a start timeout the old rule applies: 10 s of nothing ends the run before any order exists.
    expect(await settleLoop(base(fetch, pending, { ...c }))).toEqual({ settled: 0, failed: 0, stoppedBecause: "idle" });
    const c2 = clock();
    const first2 = c2.now() + 100_000;
    const late = (): Promise<Pending[]> => Promise.resolve(c2.now() >= first2 ? orders(2) : []);
    expect(await settleLoop(base(fetch, late, { ...c2, startTimeoutMs: 300_000 }))).toEqual({ settled: 2, failed: 0, stoppedBecause: "idle" });
  });

  // Review item 2: WhatsApp must be off for every poll, not only at the start.
  it("runs the guard before EVERY poll and, when it throws, settles nothing more", async () => {
    let fetched = 0;
    const fetch: SettleFetch = () => {
      fetched++;
      return Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
    };
    let polls = 0;
    const guard = (): Promise<void> => (++polls >= 2 ? Promise.reject(new Error("a WAHA session is active")) : Promise.resolve());
    await expect(settleLoop(base(fetch, () => Promise.resolve(orders(2)), { beforeEachPoll: guard }))).rejects.toThrow("a WAHA session is active");
    expect(polls).toBe(2);
    expect(fetched).toBe(4); // the first poll's two orders (two calls each); the second poll settled nothing
    // refused at the very first poll: not one call
    fetched = 0;
    await expect(settleLoop(base(fetch, () => Promise.resolve(orders(2)), { beforeEachPoll: () => Promise.reject(new Error("no")) }))).rejects.toThrow("no");
    expect(fetched).toBe(0);
  });

  it("stops at --limit, and counts a refused state change as a failure without stopping", async () => {
    let n = 0;
    const fetch: SettleFetch = (url) => Promise.resolve({ status: url.endsWith("/state") && n++ === 0 ? 404 : 200, json: () => Promise.resolve({}) });
    const result = await settleLoop(base(fetch, () => Promise.resolve(orders(5)), { limit: 2 }));
    expect(result).toEqual({ settled: 2, failed: 1, stoppedBecause: "limit" });
  });
});

describe("settleLoop, sandbox-card mode (unverified)", () => {
  const card = (body: unknown): SettleFetch => (url) => Promise.resolve({ status: 200, json: () => Promise.resolve(url.includes("/v2/token") ? { status_code: "200", token_id: "tok" } : body) });

  it("gets a card token with the client key, charges the order's own midtrans order id with its amount, and expects capture + accept", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch: SettleFetch = (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return card({ status_code: "200", transaction_status: "capture", fraud_status: "accept" })(url, init);
    };
    const result = await settleLoop(base(fetch, () => Promise.resolve(orders(1)), { mode: "sandbox-card", serverKey: "SB-Mid-server-X", clientKey: "SB-Mid-client-Y" }));
    expect(result.settled).toBe(1);
    expect(seen[0]?.url).toContain("https://api.sandbox.midtrans.com/v2/token?client_key=SB-Mid-client-Y&card_number=4811111111111114");
    expect(seen[1]?.url).toBe("https://api.sandbox.midtrans.com/v2/charge");
    expect(seen[1]?.headers["authorization"]).toBe(`Basic ${Buffer.from("SB-Mid-server-X:").toString("base64")}`);
    expect(seen[1]?.body).toEqual({
      payment_type: "credit_card",
      transaction_details: { order_id: "ORDER0-1", gross_amount: 10_000 },
      credit_card: { token_id: "tok", authentication: false },
    });
  });

  it("stops after three identical refusals instead of failing 500 orders one by one", async () => {
    const lines: string[] = [];
    const result = await settleLoop(
      base(card({ status_code: "406", status_message: "order id already used", transaction_status: "deny" }), () => Promise.resolve(orders(10)), {
        mode: "sandbox-card",
        serverKey: "SB-Mid-server-X",
        clientKey: "SB-Mid-client-Y",
        log: (l) => lines.push(l),
      }),
    );
    expect(result).toEqual({ settled: 0, failed: 3, stoppedBecause: "refused" });
    expect(lines.at(-1)).toMatch(/three identical refusals/);
  });
});
