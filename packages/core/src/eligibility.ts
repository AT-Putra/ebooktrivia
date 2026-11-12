// Prize / play eligibility (spec "Business rules", AC-Q1, AC-Q11; plan M2.1 player_programs.eligible):
// a player is eligible for a program iff they have a paid, non-refunded order for it. A refunded
// order has status `refunded` (never `paid`), and `review` is not paid, so only `paid` counts.
// One buyer = one player = one score per program, however many orders they have.

import type { OrderStatus } from "./order-machine.ts";

export interface EligibilityOrder {
  readonly programId: string;
  readonly status: OrderStatus;
}

export function isEligible(orders: readonly EligibilityOrder[], programId: string): boolean {
  return orders.some((order) => order.programId === programId && order.status === "paid");
}
