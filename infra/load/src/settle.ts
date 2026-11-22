// Settles the pending orders of the load-test landing page, so that the PAID leg of AC-P8 (deliveries, MT postbacks, outbox) has
// real PAID orders to carry. The worker still does everything the app does: it RE-QUERIES Midtrans and decides from the
// answer; this tool only makes the payment exist on the Midtrans side.
//
//   --mode stub          LOCAL ONLY (the dev stack). infra/midtrans-stub: put the transaction in `settlement`, then have the stub POST its
//                        signed notification to the app's webhook (--notify-url). This is the stub's own control plane (infra/midtrans-stub).
//   --mode sandbox-card  STAGING, UNVERIFIED. The Snap page cannot be scripted (captcha, signed calls: docs/spikes/R12.md), so this pays
//                        each order through Midtrans' documented CORE API instead: a card token from the public test card 4811 1111 1111
//                        1114 (GET /v2/token) and POST /v2/charge for the order's own midtrans_order_id, without 3-D Secure. The ASSUMPTION is
//                        that Midtrans accepts a Core API charge for an order id whose Snap transaction has no payment method chosen yet
//                        (R12: Get Status answers 404 for it, and the id can be created again): nobody has run this against the sandbox.
//                        Step 1 of the staging run is therefore a 5-order trial (--limit 5, README); if Midtrans refuses it, the
//                        tool stops after 3 identical refusals and says so, and the fallback is to pay N orders by hand in a browser
//                        (docs/spikes/R12.md "Refreshing the recording") and let verify-p8.ts cover those.
//   Midtrans then sends its notification to the notification URL of the sandbox dashboard (go-live: set to staging); with none, the
//   nightly reconciliation (or the Owner's review queue) settles the order within a day, so set it.
//
// node infra/load/src/settle.ts --mode stub|sandbox-card --lp-key lp_... [--rate 50] [--limit N] [--idle-exit 60] [--start-timeout 1800]
//        [--stub-url http://127.0.0.1:53001 --notify-url http://host.docker.internal:3410/api/v1/webhooks/midtrans]
//   env: LOAD_DATABASE_URL, LOAD_TARGET_ENV, LOAD_ALLOWED_DB_HOSTS (the guard);  MIDTRANS_SANDBOX_SERVER_KEY + MIDTRANS_SANDBOX_CLIENT_KEY (sandbox-card)
import { parseArgs } from "node:util";
import postgres from "postgres";
import { positiveNumber } from "./args.ts";
import { assertLoadTarget, assertLoadtestLandingPage, assertWhatsAppOff } from "./guard.ts";

export interface Pending {
  readonly midtransOrderId: string;
  readonly amountIdr: number;
}

export interface SettleFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface SettleOptions {
  readonly mode: "stub" | "sandbox-card";
  readonly pending: () => Promise<readonly Pending[]>;
  readonly fetch: SettleFetch;
  readonly ratePerMinute: number;
  /** Stop after this many orders (the trial). */
  readonly limit?: number | undefined;
  /** Stop when nothing new was pending for this long, counted from the last order seen. */
  readonly idleExitMs: number;
  /** How long to wait for the FIRST order before giving up (the orders run makes its Cap pool first, minutes); default idleExitMs. */
  readonly startTimeoutMs?: number | undefined;
  readonly stubUrl?: string | undefined;
  readonly notifyUrl?: string | undefined;
  readonly serverKey?: string | undefined;
  readonly clientKey?: string | undefined;
  /** Runs at the start of EVERY poll; a throw aborts the loop before anything is settled (the WhatsApp-off guard). */
  readonly beforeEachPoll?: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface SettleResult {
  readonly settled: number;
  readonly failed: number;
  readonly stoppedBecause: "limit" | "idle" | "refused";
}

const TEST_CARD = { number: "4811111111111114", month: "12", year: "2030", cvv: "123" } as const;
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" } as const;

async function settleStub(o: SettleOptions, p: Pending): Promise<void> {
  const base = (o.stubUrl ?? "").replace(/\/+$/, "");
  const state = await o.fetch(`${base}/__stub/transactions/${p.midtransOrderId}/state`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ transaction_status: "settlement", payment_type: "qris" }) });
  if (state.status !== 200) throw new Error(`the stub refused the state change (HTTP ${String(state.status)})`);
  const notify = await o.fetch(`${base}/__stub/notify`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ order_id: p.midtransOrderId, targetUrl: o.notifyUrl }) });
  if (notify.status !== 200) throw new Error(`the stub could not notify the app (HTTP ${String(notify.status)})`);
}

async function settleSandboxCard(o: SettleOptions, p: Pending): Promise<void> {
  const token = await o.fetch(
    `https://api.sandbox.midtrans.com/v2/token?client_key=${encodeURIComponent(o.clientKey ?? "")}&card_number=${TEST_CARD.number}&card_exp_month=${TEST_CARD.month}&card_exp_year=${TEST_CARD.year}&card_cvv=${TEST_CARD.cvv}`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  const tokenBody = (await token.json()) as { status_code?: string; token_id?: string };
  if (tokenBody.token_id === undefined) throw new Error(`no card token (status_code ${String(tokenBody.status_code)})`);
  const auth = `Basic ${Buffer.from(`${o.serverKey ?? ""}:`).toString("base64")}`;
  const charge = await o.fetch("https://api.sandbox.midtrans.com/v2/charge", {
    method: "POST",
    headers: { ...JSON_HEADERS, authorization: auth },
    body: JSON.stringify({
      payment_type: "credit_card",
      transaction_details: { order_id: p.midtransOrderId, gross_amount: p.amountIdr },
      credit_card: { token_id: tokenBody.token_id, authentication: false },
    }),
  });
  const body = (await charge.json()) as { status_code?: string; status_message?: string; transaction_status?: string; fraud_status?: string };
  if (body.transaction_status !== "capture" || body.fraud_status !== "accept") {
    throw new Error(`Midtrans did not capture the charge: status_code ${String(body.status_code)} "${String(body.status_message)}" (${String(body.transaction_status)}/${String(body.fraud_status)})`);
  }
}

export async function settleLoop(o: SettleOptions): Promise<SettleResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => undefined);
  const done = new Set<string>();
  const gap = 60_000 / o.ratePerMinute;
  let settled = 0;
  let failed = 0;
  let lastFailure = "";
  let sameFailure = 0;
  let lastNew = now();
  let seenAny = false;
  for (;;) {
    await o.beforeEachPoll?.();
    const fresh = (await o.pending()).filter((p) => !done.has(p.midtransOrderId));
    if (fresh.length > 0) {
      lastNew = now();
      seenAny = true;
    }
    for (const p of fresh) {
      if (o.limit !== undefined && settled >= o.limit) return { settled, failed, stoppedBecause: "limit" };
      done.add(p.midtransOrderId);
      const started = now();
      try {
        if (o.mode === "stub") await settleStub(o, p);
        else await settleSandboxCard(o, p);
        settled++;
        sameFailure = 0;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : "failed";
        sameFailure = message === lastFailure ? sameFailure + 1 : 1;
        lastFailure = message;
        log(`settle ${p.midtransOrderId}: ${message}`);
        if (o.mode === "sandbox-card" && sameFailure >= 3) {
          log("three identical refusals: the Core API route does not work for these orders (README: pay by hand instead)");
          return { settled, failed, stoppedBecause: "refused" };
        }
      }
      const wait = gap - (now() - started);
      if (wait > 0) await sleep(wait);
    }
    if (o.limit !== undefined && settled >= o.limit) return { settled, failed, stoppedBecause: "limit" };
    if (now() - lastNew >= (seenAny ? o.idleExitMs : (o.startTimeoutMs ?? o.idleExitMs))) return { settled, failed, stoppedBecause: "idle" };
    await sleep(2000);
  }
}

/** The pending orders of a landing page: the latest Snap attempt of every order that is still pending (a retry makes a newer attempt). */
export async function pendingOrders(sql: postgres.Sql, lpKey: string): Promise<Pending[]> {
  const rows = await sql<{ midtrans_order_id: string; amount_idr: string }[]>`
    SELECT a.midtrans_order_id, o.amount_idr::text AS amount_idr
      FROM public.midtrans_attempts a
      JOIN public.orders o ON o.id = a.order_id
      JOIN public.landing_pages lp ON lp.id = o.landing_page_id
     WHERE lp.lp_key = ${lpKey} AND o.status = 'pending' AND a.status = 'created'
       AND a.n = (SELECT max(n) FROM public.midtrans_attempts WHERE order_id = o.id)
     ORDER BY a.created_at`;
  return rows.map((r) => ({ midtransOrderId: r.midtrans_order_id, amountIdr: Number(r.amount_idr) }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      "lp-key": { type: "string" },
      rate: { type: "string", default: "50" },
      limit: { type: "string" },
      "idle-exit": { type: "string", default: "60" },
      "start-timeout": { type: "string", default: "1800" },
      "stub-url": { type: "string" },
      "notify-url": { type: "string" },
    },
  });
  const mode = values.mode;
  const databaseUrl = process.env["LOAD_DATABASE_URL"];
  if ((mode !== "stub" && mode !== "sandbox-card") || values["lp-key"] === undefined || databaseUrl === undefined) throw new Error("usage: settle.ts --mode stub|sandbox-card --lp-key <lp_...> [--rate 50] [--limit N] [--idle-exit 60] [--start-timeout 1800] [--stub-url U --notify-url U]");
  // A typo in a number must stop the tool (NaN would settle nothing, or wait forever).
  const rate = positiveNumber("rate", values.rate);
  const limit = values.limit === undefined ? undefined : positiveNumber("limit", values.limit, { integer: true });
  const idleExitMs = positiveNumber("idle-exit", values["idle-exit"]) * 1000;
  const startTimeoutMs = positiveNumber("start-timeout", values["start-timeout"]) * 1000;
  if (mode === "stub" && (values["stub-url"] === undefined || values["notify-url"] === undefined)) throw new Error("--mode stub needs --stub-url and --notify-url");
  const serverKey = process.env["MIDTRANS_SANDBOX_SERVER_KEY"];
  const clientKey = process.env["MIDTRANS_SANDBOX_CLIENT_KEY"];
  if (mode === "sandbox-card" && (!serverKey?.startsWith("SB-Mid-server-") || clientKey === undefined || !clientKey.startsWith("SB-Mid-client-"))) {
    throw new Error("--mode sandbox-card needs MIDTRANS_SANDBOX_SERVER_KEY (SB-Mid-server-...) and MIDTRANS_SANDBOX_CLIENT_KEY (SB-Mid-client-...): sandbox keys only");
  }
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    await assertLoadTarget(sql, databaseUrl, process.env);
    const lpKey = values["lp-key"];
    // Only a load-test landing page (its name is LOADTEST <run id>), and WhatsApp off, now and before every poll.
    await assertLoadtestLandingPage(sql, lpKey);
    await assertWhatsAppOff(sql);
    if (mode === "sandbox-card") process.stderr.write("settle: sandbox-card is UNVERIFIED against the real sandbox; watch the first orders (README)\n");
    const result = await settleLoop({
      mode,
      pending: () => pendingOrders(sql, lpKey),
      beforeEachPoll: () => assertWhatsAppOff(sql),
      fetch: (url, init) => fetch(url, init),
      ratePerMinute: rate,
      limit,
      idleExitMs,
      startTimeoutMs,
      stubUrl: values["stub-url"],
      notifyUrl: values["notify-url"],
      serverKey,
      clientKey,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`settle: ${JSON.stringify(result)}\n`);
    process.exitCode = result.stoppedBecause === "refused" ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "settle failed"}\n`);
    process.exit(1);
  });
}
