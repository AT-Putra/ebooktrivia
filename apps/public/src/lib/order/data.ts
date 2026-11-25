// What the order status page reads and writes (as public_rw): the two SECURITY DEFINER entry points of
// packages/db/sql/functions.sql (get_order_status, claim_browser_mt), the pool number of the WhatsApp buttons
// (pending and paid), and the paid page's wording. The publicId is the page's capability: every function takes it as the one
// key, answers an unknown id with no row, and never raises for a malformed one.
import { PAID_PAGE_DEFAULTS, PAID_PAGE_SETTING_KEY, type PaidPageWording, paidPageWordingOf } from "@ebooktrivia/core/paid-page";
import { PUBLIC_ID_PATTERN } from "@ebooktrivia/core/public-id";
import type { Sql } from "../db.ts";
import { idrOf } from "../checkout/data.ts";
import { type PixelIds, parsePixelIds } from "./vendors.ts";

/** A well-formed public id (a malformed one never reaches the database). */
export const isPublicId = (value: unknown): value is string => typeof value === "string" && PUBLIC_ID_PATTERN.test(value);

export interface OrderRecord {
  /** orders.status, the DB enum. */
  readonly status: string;
  readonly orderCode: string;
  /** Masked in the database (public.mask_name / public.mask_phone_tail, "0812-3456-****"): the raw values never reach this process. */
  readonly maskedName: string;
  readonly maskedPhone: string;
  readonly productTitle: string;
  readonly amountIdr: number;
  readonly pixels: PixelIds;
  /** A registered host of the landing page the order came from (where "order again" leads). */
  readonly lpHost: string | null;
}

export async function getOrderStatus(sql: Sql, publicId: string): Promise<OrderRecord | undefined> {
  if (!isPublicId(publicId)) return undefined;
  const [row] = await sql<
    { status: string; order_code: string; masked_name: string; masked_phone: string; product_title: string; amount_idr: string; pixels: unknown; lp_host: string | null }[]
  >`
    SELECT status, order_code, masked_name, masked_phone, product_title, amount_idr::text AS amount_idr, pixels, lp_host
      FROM public.get_order_status(${publicId})`;
  if (row === undefined) return undefined;
  return {
    status: row.status,
    orderCode: row.order_code,
    maskedName: row.masked_name,
    maskedPhone: row.masked_phone,
    productTitle: row.product_title,
    amountIdr: idrOf(row.amount_idr),
    pixels: parsePixelIds(row.pixels),
    lpHost: row.lp_host,
  };
}

/** What the browser needs to fire the MT pixels once: the pixel contract (event_id, transaction_id) and the ids. */
export interface BrowserMtClaim {
  /** orders.event_id: the id the server-side conversion (Meta CAPI, TikTok Events API) carries too. */
  readonly eventId: string;
  /** orders.id: the transaction id of the order (the same value the adnet postback's {txid} has). */
  readonly transactionId: string;
  readonly valueIdr: number;
  readonly pixels: PixelIds;
}

/** The exactly-once claim: the claim of the one caller that wins it, undefined for every other call. */
export async function claimBrowserMt(sql: Sql, publicId: string): Promise<BrowserMtClaim | undefined> {
  if (!isPublicId(publicId)) return undefined;
  const [row] = await sql<{ order_id: string; event_id: string; amount_idr: string; pixels: unknown }[]>`
    SELECT order_id, event_id, amount_idr::text AS amount_idr, pixels FROM public.claim_browser_mt(${publicId})`;
  if (row === undefined) return undefined;
  return { eventId: row.event_id, transactionId: row.order_id, valueIdr: idrOf(row.amount_idr), pixels: parsePixelIds(row.pixels) };
}

/**
 * The texts of the page after a successful payment (the Owner's, admin Message templates; core paid-page.ts): read with the order, and the defaults
 * when nothing is saved, a stored text breaks a rule, or the read fails (the page never waits on, or breaks over, its wording).
 */
export async function paidPageWording(sql: Sql): Promise<PaidPageWording> {
  try {
    const [row] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = ${PAID_PAGE_SETTING_KEY}`;
    return paidPageWordingOf(row?.value);
  } catch {
    return PAID_PAGE_DEFAULTS;
  }
}

/**
 * The digits (country code first, no "+") of one WhatsApp number of the pool that is paired and
 * WORKING, for the wa.me link; chosen at random so the load spreads. Undefined when none is.
 */
export async function poolNumber(sql: Sql): Promise<string | undefined> {
  const [row] = await sql<{ phone: string }[]>`
    SELECT phone FROM public.waha_sessions WHERE active AND status = 'WORKING' AND phone IS NOT NULL ORDER BY random() LIMIT 1`;
  return row === undefined ? undefined : row.phone.replace(/^\+/, "");
}
