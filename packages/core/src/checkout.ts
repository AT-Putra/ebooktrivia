// Checkout decisions (US-020; plan M6.2; spec AC-S8, AC-S10, AC-T8). Pure: the public app reads the
// rows, calls these, and writes what they decide.
//
//   - Sales window: open only from sales_start_at to sales_end_at minus the close buffer
//     (app_settings orders.sales_close_buffer_minutes, default 30): "refused when now > sales_end -
//     buffer", so a Snap page never gets a uselessly short expiry. An inactive landing page or product,
//     or a program that is not published, is closed too.
//   - Dedupe (AC-T8): the newest order of the SAME BUYER on the landing page created within
//     DEDUPE_WINDOW_MS that is still pending or snap_create_failed is reused. The same buyer (Owner
//     decision D1, 2026-11-20) is the same phone AND name AND e-mail, compared after normalisation
//     (NFC, whitespace runs collapsed, trimmed, lowercased): buyerKey. Another buyer on the same phone
//     gets an order of its own, never someone else's URL or event_id. A pending order with a stored
//     Snap URL is returned as it is (deduped: no Snap call, no MO). Dedupe never returns a missing URL.
//   - Crash window: a pending order whose URL is still missing SNAP_URL_STALE_MS after its latest
//     attempt started counts as snap_create_failed (the worker's sweeper marks it so too). A failed
//     order is retried with attempt n + 1 (a new Midtrans order id `{publicId}-{n+1}`), at most
//     MAX_SNAP_ATTEMPTS attempts per order; every attempt row is kept for reconciliation (US-021). An
//     order that used them all never blocks its buyer: the next submit is a new order (code review M2).
//   - An order whose payment window would be under MIN_PAYMENT_WINDOW_MS is not reused: a new order
//     is created instead (the old one expires on its own).
//   - Snap expiry = min(order expires_at, sales_end_at), in whole minutes, less one minute of margin
//     for the clock of Midtrans, which starts counting when it creates the transaction.

import { createHash } from "node:crypto";

export const DEDUPE_WINDOW_MS = 30 * 60_000;
export const SNAP_URL_STALE_MS = 60_000;
export const MAX_SNAP_ATTEMPTS = 5;
export const MIN_PAYMENT_WINDOW_MS = 5 * 60_000;
const SNAP_EXPIRY_MARGIN_MS = 60_000;

export type SalesState = "open" | "inactive" | "not_started" | "closed";

export interface SalesWindow {
  readonly landingPageActive: boolean;
  readonly productActive: boolean;
  readonly programStatus: string;
  readonly salesStartAt: Date;
  readonly salesEndAt: Date;
  /** app_settings orders.sales_close_buffer_minutes. */
  readonly closeBufferMinutes: number;
}

export function salesState(window: SalesWindow, now: Date): SalesState {
  if (!window.landingPageActive || !window.productActive || window.programStatus !== "published") return "inactive";
  if (now.getTime() < window.salesStartAt.getTime()) return "not_started";
  if (now.getTime() > window.salesEndAt.getTime() - window.closeBufferMinutes * 60_000) return "closed";
  return "open";
}

/** The newest reusable order of a phone + landing page (status pending or snap_create_failed). */
export interface OpenOrder {
  readonly status: "pending" | "snap_create_failed";
  /** orders.snap_attempt_count: n of the latest attempt (0 before the first). */
  readonly attemptCount: number;
  readonly redirectUrl: string | null;
  readonly snapExpiresAt: Date | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** created_at of attempt `attemptCount`; null when there is none. */
  readonly lastAttemptAt: Date | null;
}

export type CheckoutDecision =
  /** No reusable order: create one (attempt 1). */
  | { readonly kind: "new" }
  /** Return the stored URL; no Snap call, no MO. */
  | { readonly kind: "deduped" }
  /** Reuse the order with attempt n. */
  | { readonly kind: "retry"; readonly n: number }
  /** Another request is creating this order's Snap transaction right now. */
  | { readonly kind: "in_flight" };

export function decideCheckout(order: OpenOrder | undefined, now: Date): CheckoutDecision {
  const t = now.getTime();
  if (order === undefined || t - order.createdAt.getTime() >= DEDUPE_WINDOW_MS) return { kind: "new" };
  if (order.expiresAt.getTime() - t < MIN_PAYMENT_WINDOW_MS) return { kind: "new" };
  if (order.status === "pending" && order.redirectUrl !== null) {
    const payable = order.snapExpiresAt !== null && order.snapExpiresAt.getTime() - t >= MIN_PAYMENT_WINDOW_MS;
    return payable ? { kind: "deduped" } : { kind: "new" };
  }
  if (order.status === "pending" && order.lastAttemptAt !== null && t - order.lastAttemptAt.getTime() < SNAP_URL_STALE_MS) {
    return { kind: "in_flight" };
  }
  if (order.attemptCount >= MAX_SNAP_ATTEMPTS) return { kind: "new" };
  return { kind: "retry", n: order.attemptCount + 1 };
}

/**
 * The Snap expiry of a new attempt: min(order expires_at, sales_end_at) minus one minute of margin,
 * in whole minutes; null when not even one minute is left.
 */
export function snapExpiry(now: Date, orderExpiresAt: Date, salesEndAt: Date): { readonly minutes: number; readonly expiresAt: Date } | null {
  const end = Math.min(orderExpiresAt.getTime(), salesEndAt.getTime());
  const minutes = Math.floor((end - now.getTime() - SNAP_EXPIRY_MARGIN_MS) / 60_000);
  if (minutes < 1) return null;
  return { minutes, expiresAt: new Date(now.getTime() + minutes * 60_000) };
}

/** A buyer's name or e-mail as dedupe compares it (D1): NFC, whitespace runs collapsed to one space, trimmed, lowercased. */
export function normalizeBuyerText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

export const BUYER_KEY_VERSION = "ebooktrivia/buyer-key/v1";

/**
 * orders.buyer_key (32 bytes): SHA-256 of an unambiguous, versioned encoding of the buyer, the JSON
 * array [version, E.164 phone, normalised name, normalised e-mail], so no name or e-mail can shift
 * into the next field (a name may contain any separator).
 */
export function buyerKey(buyer: { readonly phone: string; readonly name: string; readonly email: string }): Buffer {
  return createHash("sha256").update(JSON.stringify([BUYER_KEY_VERSION, buyer.phone, normalizeBuyerText(buyer.name), normalizeBuyerText(buyer.email)]), "utf8").digest();
}
