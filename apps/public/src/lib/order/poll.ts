// The order page's status poll: a loop with a backoff, an overall time limit, and nothing but injected
// effects (the fetch, the sleep, the clock), so a test drives it with a fake clock and no timers.
//
//   - Fast at first (the webhook usually lands within seconds of paying), then slower, then at most every
//     POLL_MAX_MS: 3 s for the first 30 s, x1.5 per poll after that up to 30 s.
//   - A failed poll (network, 429, 5xx) backs off exponentially from the current delay up to
//     FAILURE_MAX_MS, honouring a Retry-After, and the loop goes on: a bad moment never ends it, and never
//     makes it tight.
//   - It stops at a terminal state (contract.ts: paid, refunded), when the order turns out unknown (404),
//     when the overall time limit passes (the page then offers a manual check), or when aborted. An order
//     that can still be paid late (expired, failed, review) is polled at the slowest interval, not stopped.
import { isLatePayable, isTerminal, type PageState } from "./contract.ts";

export const POLL_FAST_MS = 3000;
export const POLL_FAST_COUNT = 10;
export const POLL_MAX_MS = 30_000;
export const FAILURE_MAX_MS = 60_000;
/** An hour: past it the page stops asking by itself and offers a button. */
export const POLL_TOTAL_MS = 60 * 60 * 1000;

/** The wait before poll number `attempt` (0 for the first) after successful polls. */
export function pollDelayMs(attempt: number): number {
  if (attempt < POLL_FAST_COUNT) return POLL_FAST_MS;
  return Math.min(POLL_MAX_MS, Math.round(POLL_FAST_MS * 1.5 ** (attempt - POLL_FAST_COUNT + 1)));
}

/** The wait after `failures` polls in a row that failed (>= 1), at least the server's Retry-After. */
export function failureDelayMs(failures: number, retryAfterMs: number | undefined): number {
  const backoff = Math.min(FAILURE_MAX_MS, POLL_FAST_MS * 2 ** failures);
  return Math.min(FAILURE_MAX_MS, Math.max(backoff, retryAfterMs ?? 0));
}

export type PollResult =
  | { readonly kind: "status"; readonly status: PageState }
  /** 404: the order is not known (the id was lost or is wrong). */
  | { readonly kind: "gone" }
  | { readonly kind: "retry"; readonly retryAfterMs?: number };

export type PollOutcome = "terminal" | "gone" | "timeout" | "aborted";

export interface PollDeps {
  readonly fetchStatus: () => Promise<PollResult>;
  /** Resolves after `ms`, or at once when the signal aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly signal: AbortSignal;
  /** The state changed (never called for the same state twice in a row). */
  readonly onStatus: (status: PageState) => void;
  /** A poll came back (any result), at `at` (the clock's ms). */
  readonly onChecked: (at: number) => void;
  readonly totalMs?: number;
}

export async function pollOrder(initial: PageState, deps: PollDeps): Promise<PollOutcome> {
  const started = deps.now();
  const totalMs = deps.totalMs ?? POLL_TOTAL_MS;
  let state = initial;
  let attempt = 0;
  let failures = 0;
  let retryAfterMs: number | undefined;
  // A function, not `deps.signal.aborted` inline: the signal can abort during any await below.
  const aborted = (): boolean => deps.signal.aborted;
  while (!isTerminal(state)) {
    if (aborted()) return "aborted";
    if (deps.now() - started >= totalMs) return "timeout";
    const next = isLatePayable(state) ? POLL_MAX_MS : pollDelayMs(attempt);
    // After a failure: the longer of the failure backoff and the normal wait (a late-payable order is never asked faster than every 30 s).
    await deps.sleep(failures > 0 ? Math.max(failureDelayMs(failures, retryAfterMs), next) : next, deps.signal);
    if (aborted()) return "aborted";
    const result = await deps.fetchStatus();
    if (aborted()) return "aborted";
    deps.onChecked(deps.now());
    if (result.kind === "gone") return "gone";
    if (result.kind === "retry") {
      failures++;
      retryAfterMs = result.retryAfterMs;
      continue;
    }
    failures = 0;
    retryAfterMs = undefined;
    attempt++;
    if (result.status !== state) {
      state = result.status;
      deps.onStatus(state);
    }
  }
  return "terminal";
}
