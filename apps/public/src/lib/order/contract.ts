// The wire contract between the order page's script (components/order/order-live.tsx) and its two
// same-origin routes (POST /api/v1/order/status and /claim, handler.ts). JSON, versioned like the SDK's,
// sent as POST with the order's public id in the BODY (never in a URL: access logs and Referer carry
// URLs). The id is the page's capability; an unknown id and a malformed one get the same answer.
import type { PixelIds } from "./vendors.ts";

export const ORDER_API = { status: "/api/v1/order/status", claim: "/api/v1/order/claim" } as const;

/** What the page shows. Not the DB enum: several DB statuses map to one page state (view.ts). */
export const PAGE_STATES = ["pending", "paid", "expired", "failed", "review", "refunded"] as const;
export type PageState = (typeof PAGE_STATES)[number];

/** Polling stops only at these: paid is what the page waits for, and a refund is the last word on an order. */
export const TERMINAL_STATES: readonly PageState[] = ["paid", "refunded"];
export const isTerminal = (state: PageState): boolean => TERMINAL_STATES.includes(state);

/**
 * States that can still become paid: the order machine (packages/core order-machine.ts) moves ANY non-paid,
 * non-refunded order to paid on a confirmed settlement, so an order that looks expired, failed or under
 * review can be paid late (a virtual account paid after the page gave up, say). The page keeps asking at
 * the slowest interval (poll.ts) within its time limit instead of stopping.
 */
export const LATE_PAYABLE_STATES: readonly PageState[] = ["expired", "failed", "review"];
export const isLatePayable = (state: PageState): boolean => LATE_PAYABLE_STATES.includes(state);

export interface OrderRequestBody {
  readonly v: 1;
  readonly id: string;
}

/** 200 of /status: the state and nothing else (the page already has the masked details). */
export interface OrderStatusBody {
  readonly v: 1;
  readonly status: PageState;
}

/** 200 of /claim. `fire: false` for every call but the one that wins the exactly-once claim. */
export type OrderClaimBody =
  | { readonly v: 1; readonly fire: false }
  | {
      readonly v: 1;
      readonly fire: true;
      /** orders.event_id: shared with the server-side conversion for dedupe. */
      readonly event_id: string;
      /** orders.id. */
      readonly transaction_id: string;
      readonly value_idr: number;
      readonly pixels: PixelIds;
    };

export type OrderErrorCode = "not_found" | "origin" | "rate_limited" | "unavailable";
export interface OrderErrorBody {
  readonly v: 1;
  readonly error: OrderErrorCode;
}
