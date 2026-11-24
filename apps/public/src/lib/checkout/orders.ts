// The order side of a checkout (US-020; plan M6.2), as public_rw. The Snap call is made by the caller
// between these transactions, OUTSIDE any transaction (plan §2 "explicit exception").
//
//   tx1 openOrder   READ COMMITTED. Takes pg_advisory_xact_lock(phone + landing page), then reads the
//                   newest pending / snap_create_failed order of the SAME BUYER (phone + buyer_key,
//                   Owner decision D1) on the page inside the dedupe window (FOR UPDATE) and applies
//                   core decideCheckout:
//                     new      INSERT the order (price from the catalog, AC-S5), its consents and
//                              attempt 1 (`requested`), one transaction;
//                     retry    the same order with attempt n + 1: snap_attempt_count = n, URL cleared,
//                              status pending, attempt row n inserted (rows 1..n-1 are kept);
//                     deduped  nothing but the consent of this submission;
//                     in_flight  nothing.
//                   Another buyer on the same phone never sees this buyer's order: it gets its own.
//   tx2 snapCreated stores the redirect URL on attempt n and on the order, and calls enqueue_mo(order),
//                   in one transaction, and only while attempt n is still the order's latest and no
//                   URL is stored: a late answer of a superseded attempt changes nothing but its own
//                   attempt row.
//   snapFailed      attempt n -> failed (a definite refusal) or stays requested (unknown outcome, e.g.
//                   a timeout: Midtrans may have created it; reconciliation US-021 checks every
//                   attempt), order -> snap_create_failed.
//
// DEDUPE UNDER CONCURRENCY: the advisory lock serialises every tx1 of one phone + landing page, and
// under READ COMMITTED the read after the lock sees the order the previous holder committed. So two
// simultaneous submits of the same buyer create ONE order: the second finds the first (pending, no
// URL yet) and waits for its URL (in_flight) instead of inserting. The lock key is a 64-bit hash: a collision only
// serialises two unrelated buyers for a moment. A unique partial index cannot express "within 30
// minutes" (now() is not immutable) and would block a later legitimate order while an old one stays
// pending for its 24 h expiry; the lock does not.
// MO AT MOST ONCE: enqueue_mo writes orders.mo_outbox_id (no app role may) and an outbox row with the
// unique dedupe_key conversion.mo:<order id>; it runs only in tx2, after Snap succeeded.
import { createHash } from "node:crypto";
import {
  buyerKey,
  type CheckoutDecision,
  decideCheckout,
  DEDUPE_WINDOW_MS,
  midtransOrderId,
  newOrderCode,
  newPublicId,
  type OpenOrder,
  snapExpiry,
} from "@ebooktrivia/core";
import { sqlState } from "@ebooktrivia/db/sql-state";
import type { Sql, Tx } from "../db.ts";
import { idrOf, type LandingPage, type PublishedLegal } from "./data.ts";
import type { Attribution, CheckoutInput } from "./request.ts";

export interface OrderRef {
  readonly id: string;
  readonly publicId: string;
  readonly eventId: string;
  readonly amountIdr: number;
}

export type OpenResult =
  | { readonly kind: "deduped"; readonly order: OrderRef; readonly redirectUrl: string }
  | { readonly kind: "snap"; readonly order: OrderRef; readonly n: number; readonly expiryMinutes: number; readonly snapExpiresAt: Date; readonly reused: boolean }
  | { readonly kind: "in_flight"; readonly order: OrderRef; readonly n: number }
  /** Not even a minute of payment window is left (or the program went off sale meanwhile, ET043). */
  | { readonly kind: "closed" };

export interface OpenOrderInput {
  readonly lp: LandingPage;
  readonly input: CheckoutInput;
  readonly legal: PublishedLegal;
  readonly attribution: Attribution;
  readonly visitId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly expirySeconds: number;
}

interface OpenOrderRow {
  id: string;
  public_id: string;
  event_id: string;
  amount_idr: string;
  status: "pending" | "snap_create_failed";
  snap_attempt_count: number;
  snap_redirect_url: string | null;
  snap_expires_at: Date | null;
  expires_at: Date;
  created_at: Date;
  last_attempt_at: Date | null;
  now: Date;
}

/** SHA-256 of the user agent (never the text), or null. Shared with the visit beacon (lib/sdk-routes.ts). */
export const uaHash = (userAgent: string | null): Buffer | null => (userAgent === null || userAgent === "" ? null : createHash("sha256").update(userAgent).digest());

const lockKey = (landingPageId: string, phone: string): string => `ebooktrivia/checkout/v1|${landingPageId}|${phone}`;

async function recordConsents(tx: Tx, orderId: string, o: OpenOrderInput): Promise<void> {
  // AC-A10: the exact published versions accepted, with the time (consented_at default) and the client.
  for (const page of [o.legal.terms, o.legal.privacy]) {
    await tx`
      INSERT INTO public.consents (order_id, legal_page_id, ip, ua_hash)
      VALUES (${orderId}, ${page.id}, ${o.ip}, ${uaHash(o.userAgent)})
      ON CONFLICT (order_id, legal_page_id) DO NOTHING`;
  }
}

async function insertAttempt(tx: Tx, order: OrderRef, n: number): Promise<void> {
  await tx`
    INSERT INTO public.midtrans_attempts (order_id, n, midtrans_order_id, status)
    VALUES (${order.id}, ${n}, ${midtransOrderId(order.publicId, n)}, 'requested')`;
}

const refOf = (row: { id: string; public_id: string; event_id: string; amount_idr: string }): OrderRef => ({
  id: row.id,
  publicId: row.public_id,
  eventId: row.event_id,
  amountIdr: idrOf(row.amount_idr),
});

async function openOrderTx(tx: Tx, o: OpenOrderInput): Promise<OpenResult> {
  const { lp, input } = o;
  await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey(lp.id, input.phone)}, 0::bigint))`;
  const key = buyerKey(input);
  // After the lock, under READ COMMITTED: this statement sees every order a previous holder committed.
  const [row] = await tx<OpenOrderRow[]>`
    SELECT o.id, o.public_id, o.event_id, o.amount_idr::text AS amount_idr, o.status::text AS status, o.snap_attempt_count,
           o.snap_redirect_url, o.snap_expires_at, o.expires_at, o.created_at,
           (SELECT a.created_at FROM public.midtrans_attempts a WHERE a.order_id = o.id AND a.n = o.snap_attempt_count) AS last_attempt_at,
           clock_timestamp() AS now
      FROM public.orders o
     WHERE o.landing_page_id = ${lp.id} AND o.buyer_phone = ${input.phone} AND o.buyer_key = ${key}
       AND o.created_at > clock_timestamp() - ${DEDUPE_WINDOW_MS} * interval '1 millisecond'
       AND o.status IN ('pending', 'snap_create_failed')
     ORDER BY o.created_at DESC
     LIMIT 1
       FOR UPDATE OF o`;
  const now = row?.now ?? (await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]?.now ?? new Date();
  const open: OpenOrder | undefined =
    row === undefined
      ? undefined
      : {
          status: row.status,
          attemptCount: row.snap_attempt_count,
          redirectUrl: row.snap_redirect_url,
          snapExpiresAt: row.snap_expires_at,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          lastAttemptAt: row.last_attempt_at,
        };
  const decision: CheckoutDecision = decideCheckout(open, now);

  if (decision.kind !== "new" && row !== undefined) {
    const order = refOf(row);
    switch (decision.kind) {
      case "deduped":
        await recordConsents(tx, order.id, o);
        if (row.snap_redirect_url === null) throw new Error("a deduped order has no Snap URL");
        return { kind: "deduped", order, redirectUrl: row.snap_redirect_url };
      case "in_flight":
        return { kind: "in_flight", order, n: row.snap_attempt_count };
      case "retry": {
        const expiry = snapExpiry(now, row.expires_at, lp.salesEndAt);
        if (expiry === null) return { kind: "closed" };
        const moved = await tx`
          UPDATE public.orders SET status = 'pending', snap_attempt_count = ${decision.n}, snap_redirect_url = NULL, snap_expires_at = NULL, updated_at = now()
           WHERE id = ${order.id} AND snap_attempt_count = ${decision.n - 1} AND snap_redirect_url IS NULL`;
        if (moved.count !== 1) throw new Error("the reused order changed under its row lock");
        await insertAttempt(tx, order, decision.n);
        await recordConsents(tx, order.id, o);
        return { kind: "snap", order, n: decision.n, expiryMinutes: expiry.minutes, snapExpiresAt: expiry.expiresAt, reused: true };
      }
    }
  }

  const expiresAt = new Date(now.getTime() + o.expirySeconds * 1000);
  const expiry = snapExpiry(now, expiresAt, lp.salesEndAt);
  if (expiry === null) return { kind: "closed" };
  const values = o.attribution.values;
  const [inserted] = await tx<{ id: string; public_id: string; event_id: string; amount_idr: string }[]>`
    INSERT INTO public.orders ${tx({
      public_id: newPublicId(),
      order_code: newOrderCode(),
      landing_page_id: lp.id,
      program_id: lp.programId,
      product_id: lp.productId,
      buyer_name: input.name,
      buyer_phone: input.phone,
      buyer_email: input.email,
      buyer_key: key,
      // AC-S5: the catalog price, never the client's; orders_checkout_guard checks it again (ET041).
      amount_idr: lp.priceIdr,
      status: "pending",
      snap_attempt_count: 1,
      expires_at: expiresAt,
      visit_id: o.visitId,
      adnet_id: o.attribution.adnetId,
      clickid: values.clickid ?? null,
      sub_id: values.sub_id ?? null,
      pub: values.pub ?? null,
      utm_source: values.utm_source ?? null,
      utm_medium: values.utm_medium ?? null,
      utm_campaign: values.utm_campaign ?? null,
      utm_content: values.utm_content ?? null,
      utm_term: values.utm_term ?? null,
      fbclid: values.fbclid ?? null,
      fbp: values.fbp ?? null,
      fbc: values.fbc ?? null,
      ttclid: values.ttclid ?? null,
      gclid: values.gclid ?? null,
      ip: o.ip,
      ua_hash: uaHash(o.userAgent),
    })}
    RETURNING id, public_id, event_id, amount_idr::text AS amount_idr`;
  if (inserted === undefined) throw new Error("order insert returned no row");
  const order = refOf(inserted);
  await recordConsents(tx, order.id, o);
  await insertAttempt(tx, order, 1);
  return { kind: "snap", order, n: 1, expiryMinutes: expiry.minutes, snapExpiresAt: expiry.expiresAt, reused: false };
}

/** tx1. A program that went off sale between the read and the insert (orders_checkout_guard ET043) is `closed`. */
export async function openOrder(sql: Sql, o: OpenOrderInput): Promise<OpenResult> {
  try {
    return await sql.begin("isolation level read committed", (tx) => openOrderTx(tx, o));
  } catch (error) {
    if (sqlState(error) === "ET043") return { kind: "closed" };
    throw error;
  }
}

/** tx2. True when the URL was stored and the MO enqueued; false when attempt n was superseded meanwhile. */
export async function snapCreated(sql: Sql, order: OrderRef, n: number, snap: { readonly token: string; readonly redirectUrl: string; readonly expiresAt: Date }): Promise<boolean> {
  return sql.begin(async (tx) => {
    // The order first, then its attempt: the worker's payment transaction (US-021 applyRequery) takes
    // them in the same order, so the two can never deadlock.
    await tx`SELECT 1 FROM public.orders WHERE id = ${order.id} FOR UPDATE`;
    await tx`
      UPDATE public.midtrans_attempts SET status = 'created', snap_token = ${snap.token}, redirect_url = ${snap.redirectUrl}, error = NULL, updated_at = now()
       WHERE order_id = ${order.id} AND n = ${n}`;
    // snap_create_failed too: the sweeper may have marked a slow attempt; it is still the latest.
    const stored = await tx`
      UPDATE public.orders SET status = 'pending', snap_redirect_url = ${snap.redirectUrl}, snap_expires_at = ${snap.expiresAt}, updated_at = now()
       WHERE id = ${order.id} AND snap_attempt_count = ${n} AND status IN ('pending', 'snap_create_failed') AND snap_redirect_url IS NULL`;
    if (stored.count !== 1) return false;
    await tx`SELECT public.enqueue_mo(${order.id})`;
    return true;
  });
}

/** Snap failed for attempt n: `definite` = Midtrans refused it (failed), else its outcome is unknown (stays requested). */
export async function snapFailed(sql: Sql, order: OrderRef, n: number, error: string, definite: boolean): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM public.orders WHERE id = ${order.id} FOR UPDATE`;
    await tx`
      UPDATE public.midtrans_attempts SET status = ${definite ? "failed" : "requested"}, error = ${error.slice(0, 200)}, updated_at = now()
       WHERE order_id = ${order.id} AND n = ${n} AND status = 'requested'`;
    await tx`
      UPDATE public.orders SET status = 'snap_create_failed', updated_at = now()
       WHERE id = ${order.id} AND snap_attempt_count = ${n} AND status = 'pending' AND snap_redirect_url IS NULL`;
  });
}

export type Waited = { readonly kind: "url"; readonly redirectUrl: string } | { readonly kind: "failed" } | { readonly kind: "timeout" };

/** Polls an in-flight order (another request is creating its Snap transaction) until it has a URL or failed. */
export async function waitForUrl(sql: Sql, orderId: string, options: { readonly timeoutMs: number; readonly intervalMs: number }): Promise<Waited> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const [row] = await sql<{ status: string; snap_redirect_url: string | null }[]>`
      SELECT status::text AS status, snap_redirect_url FROM public.orders WHERE id = ${orderId}`;
    if (row?.snap_redirect_url != null && row.status === "pending") return { kind: "url", redirectUrl: row.snap_redirect_url };
    if (row === undefined || row.status !== "pending") return { kind: "failed" };
    if (Date.now() >= deadline) return { kind: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
