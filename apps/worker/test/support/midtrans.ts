// Payment fixtures (US-021): infra/midtrans-stub in-process behind a fetch that can fail, lag or hold
// the status re-queries, the MidtransSource the consumer and the reconciliation use, and orders with
// their Midtrans attempts and inbox rows (inserted as the superuser: bypasses grants, not triggers).
import { randomBytes, randomInt } from "node:crypto";
import { type HttpFetch, type HttpResponse, MIDTRANS_ENDPOINTS } from "@ebooktrivia/adapters";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
// The stub is not a dependency of the worker package; its Hono app is loaded straight from infra/.
import { createMidtransStubApp } from "../../../../infra/midtrans-stub/src/app.ts";
import postgres from "postgres";
import { afterAll, inject } from "vitest";
import { createLogger } from "../../src/log.ts";
import type { MidtransSource } from "../../src/payments.ts";
import { first, sql, suffix } from "./db.ts";

export const STUB_SERVER_KEY = "SB-Mid-server-WORKERINT0123456789";
export const PRICE_IDR = 49_000;
export const WA_DELAY_MS = 180_000;
export const silentLog = createLogger({ level: "silent", role: "worker" });

const pools: postgres.Sql[] = [];
/** A pool of the worker's LOGIN role (group worker_rw), as the worker process connects. */
export function workerPool(max = 4): postgres.Sql {
  const pool = postgres(inject("workerDbUrl"), { ...PG_CONNECTION_OPTIONS, max, onnotice: () => undefined });
  pools.push(pool);
  return pool;
}
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
});

const answer = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

export type StatusFailure = "503" | "network" | "404";
/** Permanent answers: a status whose signature does not verify, or a body that is not an object. */
export type StatusRefusal = "bad_signature" | "bad_response";

export interface MidtransStub {
  readonly source: MidtransSource;
  /** Every status re-query, by Midtrans order id, in order. */
  readonly statusCalls: string[];
  /** What the next status re-queries do instead of reaching the stub. */
  readonly failures: StatusFailure[];
  /** Every re-query of these Midtrans order ids is answered so, always. */
  readonly refuse: Map<string, StatusRefusal>;
  /** Awaited before each status re-query is answered (a barrier for the race tests). */
  hold: (() => Promise<void>) | undefined;
  create(midtransOrderId: string, grossAmountIdr?: number): Promise<void>;
  /** The stub's control plane: transaction_status, fraud_status, gross_amount, currency, new_transaction. */
  setState(midtransOrderId: string, state: Record<string, unknown>): Promise<void>;
}

export function midtransStub(): MidtransStub {
  const app = createMidtransStubApp({ serverKey: STUB_SERVER_KEY });
  const auth = `Basic ${Buffer.from(`${STUB_SERVER_KEY}:`).toString("base64")}`;
  const control = async (path: string, body: unknown): Promise<void> => {
    const response = await app.request(path, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status !== 200 && response.status !== 201) throw new Error(`stub ${path} answered ${String(response.status)}`);
  };
  const stub: MidtransStub = {
    statusCalls: [],
    failures: [],
    refuse: new Map(),
    hold: undefined,
    source: () =>
      Promise.resolve({
        serverKey: STUB_SERVER_KEY,
        ...MIDTRANS_ENDPOINTS.sandbox,
        fetch,
      }),
    create: (id, gross = PRICE_IDR) => control("/snap/v1/transactions", { transaction_details: { order_id: id, gross_amount: gross } }),
    setState: (id, state) => control(`/__stub/transactions/${id}/state`, state),
  };
  const fetch: HttpFetch = async (url, init) => {
    const status = /\/v2\/([^/]+)\/status$/.exec(url);
    if (status !== null) {
      const id = decodeURIComponent(status[1] ?? "");
      stub.statusCalls.push(id);
      if (stub.hold !== undefined) await stub.hold();
      const refusal = stub.refuse.get(id);
      if (refusal === "bad_response") return answer(200, ["not", "an", "object"]);
      if (refusal === "bad_signature") {
        return answer(200, { status_code: "200", order_id: id, gross_amount: `${String(PRICE_IDR)}.00`, transaction_status: "settlement", signature_key: "f".repeat(128) });
      }
      const failure = stub.failures.shift();
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "503") return answer(503, { status_code: "503", status_message: "stub: unavailable" });
      if (failure === "404") return answer(404, { status_code: "404", status_message: "Transaction does not exist." });
    }
    return app.fetch(new Request(url, { method: init.method, headers: init.headers, body: typeof init.body === "string" ? init.body : null }));
  };
  return stub;
}

/** A barrier: the first `n` callers wait until all `n` arrived. */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived++;
    if (arrived >= n) open();
    await opened;
  };
}

export interface Shop {
  readonly programId: string;
  readonly landingPageId: string;
  readonly productId: string;
  /** An adnet with an MT and a reversal postback template. */
  readonly adnetId: string;
}

/** Product + published program + landing page with Meta, TikTok and Google pixels + an adnet with a reversal template. */
export async function createShop(): Promise<Shop> {
  const tag = suffix();
  const product = first(await sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, ${PRICE_IDR}) RETURNING id`);
  const program = first(
    await sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`pay-${tag}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`,
  );
  const lp = first(
    await sql<{ id: string }[]>`
      INSERT INTO landing_pages (lp_key, name, program_id, pixels)
      VALUES (${`lp_${tag}${suffix()}`}, 'LP', ${program.id}, ${JSON.stringify({ meta: "1234567890", tiktok: "C0TIKTOK", gtag: "AW-123" })}::text::jsonb) RETURNING id`,
  );
  const adnet = first(
    await sql<{ id: string }[]>`
      INSERT INTO adnets (slug, name, clickid_param, mt_url_template, reversal_url_template, endpoint_host)
      VALUES (${`adn-${tag}`}, 'Adnet', 'cid', 'https://pb.example.test/mt?c={clickid}&t={txid}&p={payout}&s={status}',
              'https://pb.example.test/rev?c={clickid}&t={txid}&p={payout}&s={status}', 'pb.example.test') RETURNING id`,
  );
  return { programId: program.id, landingPageId: lp.id, productId: product.id, adnetId: adnet.id };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const uniquePhone = (): string => `+62813${randomInt(10_000_000, 99_999_999).toString()}`;

export interface Order {
  readonly id: string;
  readonly publicId: string;
  readonly phone: string;
  /** midtrans_attempts rows by n. */
  readonly attempts: ReadonlyMap<number, string>;
  midtransId(n?: number): string;
}

export interface OrderOptions {
  readonly phone?: string;
  /** Attempt n -> its midtrans_attempts.status (default one `created` attempt). */
  readonly attempts?: readonly ("requested" | "created" | "failed")[];
  /** S2S attribution (default: the shop's adnet with a click id). */
  readonly attributed?: boolean;
  readonly status?: string;
  /** Backdates the order and its attempts (the reconciliation window). */
  readonly ageDays?: number;
}

/** A pending order of the shop with its Midtrans attempts (midtrans_order_id = {public_id}-{n}). */
export async function createOrder(shop: Shop, options: OrderOptions = {}): Promise<Order> {
  const publicId = Array.from(randomBytes(22), (b) => BASE62.charAt(b % 62)).join("");
  const phone = options.phone ?? uniquePhone();
  const attempts = options.attempts ?? ["created"];
  const attributed = options.attributed ?? true;
  const age = `${String(options.ageDays ?? 0)} days`;
  const order = first(
    await sql<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key,
                          amount_idr, status, snap_attempt_count, expires_at, adnet_id, clickid, created_at, updated_at)
      VALUES (${publicId}, ${Array.from(randomBytes(10), (b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ".charAt(b % 32)).join("")}, ${shop.landingPageId}, ${shop.programId},
              ${shop.productId}, 'Budi Santoso', ${phone}, 'budi@example.test', ${randomBytes(32)}, ${PRICE_IDR}, ${options.status ?? "pending"},
              ${attempts.length}, now() + interval '23 hours', ${attributed ? shop.adnetId : null}, ${attributed ? `click-${suffix()}` : null},
              now() - ${age}::interval, now() - ${age}::interval)
      RETURNING id`,
  );
  const ids = new Map<number, string>();
  for (const [i, status] of attempts.entries()) {
    const n = i + 1;
    const row = first(
      await sql<{ id: string }[]>`
        INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status, created_at, updated_at)
        VALUES (${order.id}, ${n}, ${`${publicId}-${String(n)}`}, ${status}, now() - ${age}::interval, now() - ${age}::interval) RETURNING id`,
    );
    ids.set(n, row.id);
  }
  return { id: order.id, publicId, phone, attempts: ids, midtransId: (n = 1) => `${publicId}-${String(n)}` };
}

/** One inbox row (as the public route stores it) and its outbox row (enqueue_notification); returns the outbox id. */
export async function notification(midtransOrderId: string, label = "settlement"): Promise<string> {
  const inbox = first(
    await sql<{ id: string }[]>`
      INSERT INTO payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw)
      VALUES (${midtransOrderId}, ${label}, '200', ${randomBytes(64).toString("hex")}, '{}') RETURNING id`,
  );
  return first(await sql<{ id: string }[]>`SELECT public.enqueue_notification(${inbox.id}) AS id`).id;
}

export interface Effects {
  status: string;
  paid_at: Date | null;
  refunded_at: Date | null;
  player_id: string | null;
  deliveries: number;
  mt: string[];
  reversals: string[];
  order_paid_outbox: number;
  paid_transitions: number;
}

/** What the order's PAID / refund effects add up to. */
export const effectsOf = async (orderId: string): Promise<Effects> =>
  first(
    await sql<Effects[]>`
      SELECT o.status::text AS status, o.paid_at, o.refunded_at, o.player_id,
             (SELECT count(*)::int FROM deliveries d WHERE d.order_id = o.id) AS deliveries,
             coalesce((SELECT array_agg(c.sink ORDER BY c.sink) FROM conversion_events c WHERE c.order_id = o.id AND c.kind = 'mt'), '{}') AS mt,
             coalesce((SELECT array_agg(c.sink ORDER BY c.sink) FROM conversion_events c WHERE c.order_id = o.id AND c.kind = 'reversal'), '{}') AS reversals,
             (SELECT count(*)::int FROM outbox x WHERE x.dedupe_key = 'order.paid:' || o.id::text) AS order_paid_outbox,
             (SELECT count(*)::int FROM audit_log a WHERE a.entity_type = 'order' AND a.entity_id = o.id::text AND a.action = 'order.status'
                 AND a.changes -> 'status' ->> 'after' = 'paid') AS paid_transitions
        FROM orders o WHERE o.id = ${orderId}`,
  );

export const alertsFor = (orderId: string) =>
  sql<{ kind: string; severity: string; payload: Record<string, unknown> }[]>`
    SELECT kind, severity, payload FROM alerts WHERE payload ->> 'order_id' = ${orderId} ORDER BY created_at, kind`;

/**
 * A winner row of the player in the shop's program (its prize tier and results snapshot are made on
 * first use: tiers are final once the snapshot exists), `confirmed` by the Owner or awaiting. US-028: a
 * winner is confirmed only inside contest_results' functions (the winners guard), so the confirmation
 * runs as that role; the fulfillment row is the admin's.
 */
export async function crownWinner(shop: Shop, playerId: string, options: { readonly confirmed?: boolean; readonly fulfillment?: boolean } = {}): Promise<string> {
  let [snapshot] = await sql<{ id: string }[]>`SELECT id FROM leaderboard_snapshots WHERE program_id = ${shop.programId}`;
  let [tier] = await sql<{ id: string }[]>`SELECT id FROM prize_tiers WHERE program_id = ${shop.programId} ORDER BY rank_from LIMIT 1`;
  if (snapshot === undefined || tier === undefined) {
    tier = first(await sql<{ id: string }[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${shop.programId}, 1, 10, 'Juara') RETURNING id`);
    snapshot = first(await sql<{ id: string }[]>`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${shop.programId}, now(), '[]') RETURNING id`);
  }
  const rank = first(await sql<{ n: number }[]>`SELECT count(*)::int + 1 AS n FROM winners WHERE snapshot_id = ${snapshot.id}`).n;
  const winner = first(
    await sql<{ id: string }[]>`INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES (${shop.programId}, ${snapshot.id}, ${tier.id}, ${playerId}, ${rank}) RETURNING id`,
  );
  if (options.confirmed ?? true) {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE contest_results`;
      await tx`UPDATE public.winners SET status = 'confirmed', confirmed_at = now() WHERE id = ${winner.id}`;
      await tx`RESET ROLE`;
      await tx`SET LOCAL ROLE admin_rw`;
      if (options.fulfillment ?? false) await tx`INSERT INTO public.fulfillments (winner_id) VALUES (${winner.id})`;
    });
  }
  return winner.id;
}

export const winnerOf = async (id: string) =>
  first(await sql<{ status: string; flag_reason: string | null }[]>`SELECT status::text AS status, flag_reason FROM winners WHERE id = ${id}`);

export const eligibilityOf = async (playerId: string, programId: string) =>
  first(await sql<{ eligible: boolean; first_paid_at: Date | null }[]>`SELECT eligible, first_paid_at FROM player_programs WHERE player_id = ${playerId} AND program_id = ${programId}`);

/** The order's deliveries / MT rows: status and last_error, by channel / sink. */
export const effectRows = async (orderId: string) => ({
  deliveries: await sql<{ channel: string; status: string; last_error: string | null }[]>`
    SELECT channel, status::text AS status, last_error FROM deliveries WHERE order_id = ${orderId} ORDER BY channel`,
  mt: await sql<{ sink: string; status: string; last_error: string | null }[]>`
    SELECT sink, status::text AS status, last_error FROM conversion_events WHERE order_id = ${orderId} AND kind = 'mt' ORDER BY sink`,
});

/**
 * Retires what a payment test file leaves behind in the shared database: pending deliveries and
 * conversions of the shop's orders (the due sweepers of later files count every due row) and the
 * payment.notification / order.paid outbox rows (no later relay or sweeper should meet them).
 */
export async function retireEffects(shop: Shop): Promise<void> {
  await sql`UPDATE deliveries SET status = 'cancelled' WHERE status = 'pending' AND order_id IN (SELECT id FROM orders WHERE program_id = ${shop.programId})`;
  await sql`
    UPDATE conversion_events SET status = 'failed', failed_at = now()
     WHERE status = 'pending' AND order_id IN (SELECT id FROM orders WHERE program_id = ${shop.programId})`;
  await sql`UPDATE outbox SET processed_at = now() WHERE topic IN ('payment.notification', 'order.paid') AND processed_at IS NULL`;
}
