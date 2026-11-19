// Login throttle in PostgreSQL (admin_auth.login_throttle), so it survives restarts and holds
// across instances. Budget per key: MAX_FAILURES failures per WINDOW_SECONDS; the failure that
// spends it locks the key for LOCK_SECONDS. Keys: the account (normalized e-mail at the password
// step, the user id at the second factor) and the client address (lib/client-ip.ts
// throttleBucket: IPv4, or the IPv6 /64), stored as SHA-256 so no e-mail or IP is kept here.
//
// An attempt is counted when it STARTS (one atomic upsert per key), before the password or code
// is checked, so N concurrent guesses cannot all pass the check; `succeeded` refunds it (and
// clears the account key), `failed` keeps it and locks keys whose budget is spent, `abandoned`
// refunds it (an infrastructure error is not a failed guess).
//
// Long-term budget (security review US-016 SM2): the window resets after each lock, so a key alone
// would allow 5 guesses every ~15 minutes forever. Keys passed as `consecutive` (the per-user
// second-factor key) also count failures across windows; only a success (`succeeded` deletes the
// row) or the recovery CLI (clearThrottle) resets that count, and at MAX_CONSECUTIVE the key is
// hard-locked until the CLI clears it. The worker's sweeper keeps such rows.
import { createHash } from "node:crypto";
import { LOGIN_THROTTLE_WINDOW_SECONDS } from "@ebooktrivia/db/login-throttle";
import type postgres from "postgres";
import type { Sql } from "../db.ts";

export const MAX_FAILURES = 5;
/** Shared with the worker's sweeper (@ebooktrivia/db/login-throttle). */
export const WINDOW_SECONDS = LOGIN_THROTTLE_WINDOW_SECONDS;
export const LOCK_SECONDS = 15 * 60;
export const MAX_CONSECUTIVE = 20;

export type ThrottleKind = "account" | "second_factor" | "ip";

export function throttleKey(kind: ThrottleKind, value: string): string {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

export interface FailureResult {
  /** Keys this failure locked for LOCK_SECONDS. */
  readonly locked: string[];
  /** Consecutive keys this failure hard-locked (MAX_CONSECUTIVE reached). */
  readonly hardLocked: string[];
}

export interface Attempt {
  /** Refunds the attempt on every key and clears the `reset` keys entirely (consecutive count too). */
  succeeded(reset?: readonly string[]): Promise<void>;
  /** Keeps the attempt counted. */
  failed(): Promise<FailureResult>;
  /** Refunds the attempt (the check never ran). */
  abandoned(): Promise<void>;
}

export type Gate =
  | { readonly allowed: true; readonly attempt: Attempt }
  | { readonly allowed: false; readonly retryAfterSeconds: number; readonly hardLocked: boolean };

interface KeyState {
  failures: number;
  locked: boolean;
  hard_locked: boolean;
  retry_after: number;
}

/** Takes one counted attempt back from each key (never below zero). */
export async function refund(sql: Sql, keys: readonly string[]): Promise<void> {
  await sql`UPDATE admin_auth.login_throttle SET failures = greatest(failures - 1, 0) WHERE key = ANY(${[...keys]})`;
}

/**
 * Starts an attempt on every key; refused (and nothing counted) while any key is locked, spent or
 * hard-locked. `consecutive` keys (a subset of `keys`) also count consecutive failures.
 */
export async function beginAttempt(sql: Sql, keys: readonly string[], consecutive: readonly string[] = []): Promise<Gate> {
  // Sorted, so two attempts on the same keys take the row locks in the same order.
  const all = [...new Set(keys)].sort();
  const counted = consecutive.filter((k) => all.includes(k));
  const states = await sql.begin(async (tx) => {
    const out: KeyState[] = [];
    for (const key of all) {
      const [row] = await tx<KeyState[]>`
        INSERT INTO admin_auth.login_throttle AS t (key, failures, window_started_at)
        VALUES (${key}, 1, clock_timestamp())
        ON CONFLICT (key) DO UPDATE SET
          failures = CASE WHEN t.window_started_at <= clock_timestamp() - make_interval(secs => ${WINDOW_SECONDS})
                           AND (t.locked_until IS NULL OR t.locked_until <= clock_timestamp())
                          THEN 1 ELSE t.failures + 1 END,
          window_started_at = CASE WHEN t.window_started_at <= clock_timestamp() - make_interval(secs => ${WINDOW_SECONDS})
                                    AND (t.locked_until IS NULL OR t.locked_until <= clock_timestamp())
                                   THEN clock_timestamp() ELSE t.window_started_at END,
          locked_until = CASE WHEN t.locked_until <= clock_timestamp() THEN NULL ELSE t.locked_until END
        RETURNING failures,
          (locked_until IS NOT NULL AND locked_until > clock_timestamp()) AS locked,
          hard_locked_at IS NOT NULL AS hard_locked,
          greatest(ceil(extract(epoch FROM coalesce(locked_until, window_started_at + make_interval(secs => ${WINDOW_SECONDS}))
                                         - clock_timestamp())), 1)::int AS retry_after`;
      if (row !== undefined) out.push(row);
    }
    return out;
  });
  const blocked = states.filter((s) => s.locked || s.hard_locked || s.failures > MAX_FAILURES);
  if (blocked.length > 0) {
    await refund(sql, all);
    return { allowed: false, retryAfterSeconds: Math.max(...blocked.map((s) => s.retry_after)), hardLocked: blocked.some((s) => s.hard_locked) };
  }
  return {
    allowed: true,
    attempt: {
      async succeeded(reset = []) {
        const cleared = all.filter((k) => reset.includes(k));
        const refunded = all.filter((k) => !reset.includes(k));
        if (cleared.length > 0) await sql`DELETE FROM admin_auth.login_throttle WHERE key = ANY(${cleared})`;
        if (refunded.length > 0) await refund(sql, refunded);
      },
      async failed() {
        const locked = await sql<{ key: string }[]>`
          UPDATE admin_auth.login_throttle
             SET locked_until = clock_timestamp() + make_interval(secs => ${LOCK_SECONDS})
           WHERE key = ANY(${all}) AND failures >= ${MAX_FAILURES} AND locked_until IS NULL
          RETURNING key`;
        const hard =
          counted.length === 0
            ? []
            : await sql<{ key: string; consecutive: number }[]>`
                UPDATE admin_auth.login_throttle
                   SET consecutive = consecutive + 1,
                       hard_locked_at = CASE WHEN consecutive + 1 >= ${MAX_CONSECUTIVE} THEN coalesce(hard_locked_at, clock_timestamp()) ELSE hard_locked_at END
                 WHERE key = ANY(${counted})
                RETURNING key, consecutive`;
        return { locked: locked.map((r) => r.key), hardLocked: hard.filter((r) => r.consecutive === MAX_CONSECUTIVE).map((r) => r.key) };
      },
      async abandoned() {
        await refund(sql, all);
      },
    },
  };
}

/** Clears keys, consecutive counts and hard locks included (recovery CLI, Owner reset). */
export async function clearThrottle(sql: Sql | postgres.TransactionSql, keys: readonly string[]): Promise<void> {
  await sql`DELETE FROM admin_auth.login_throttle WHERE key = ANY(${[...keys]})`;
}
