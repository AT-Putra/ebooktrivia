// The order page's claim of the browser MT pixel (components/order/order-live.tsx calls it once the order is
// paid): ask the database for the exactly-once claim, fire the pixels if this call won it. With injected
// effects so the React development double mount can be simulated without a browser.
//
// The latch (the component's ref) says "a claim is under way or done in this page". It is set only AFTER a
// one-tick wait and an abort check. React's development double mount runs the effect, aborts it and runs it
// again within the same tick: the first run's claim must never be sent (a request that reached the server and
// lost its answer to the abort would use the claim up, and the second run would get `fire: false`), and it
// must not hold the latch either (or the second run would not claim). In production the effect runs once and
// the tick costs nothing.
import type { OrderClaimBody } from "./contract.ts";

/** Waits between the claim requests of one page after a failed one: three requests in all. */
export const CLAIM_RETRY_MS: readonly number[] = [2000, 5000];

export type WonClaim = Extract<OrderClaimBody, { readonly fire: true }>;

export interface ClaimDeps {
  readonly signal: AbortSignal;
  /** Resolves after `ms`, or at once when the signal aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** One claim request: the answer, or null when it failed (network, 429, 5xx, a body that is not an answer). */
  readonly request: () => Promise<OrderClaimBody | null>;
  /** Fires the pixels of a claim this call won. */
  readonly fire: (claim: WonClaim) => Promise<void>;
}

export interface ClaimLatch {
  current: boolean;
}

export async function claimAndFire(latch: ClaimLatch, deps: ClaimDeps): Promise<void> {
  // A function, so the compiler does not take an earlier check for the last word: the signal can abort during any await.
  const aborted = (): boolean => deps.signal.aborted;
  await deps.sleep(0, deps.signal);
  if (aborted() || latch.current) return;
  latch.current = true;
  for (let attempt = 0; attempt <= CLAIM_RETRY_MS.length; attempt++) {
    const claim = await deps.request();
    // The page was left while the request was out: the claim is not retried (and, if it was won, is lost to
    // the server-side conversion with the same event_id).
    if (aborted()) return;
    if (claim !== null) {
      if (claim.fire) await deps.fire(claim);
      return;
    }
    const wait = CLAIM_RETRY_MS[attempt];
    if (wait === undefined) return;
    await deps.sleep(wait, deps.signal);
    if (aborted()) return;
  }
}
