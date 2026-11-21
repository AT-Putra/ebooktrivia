// Pool health (US-025; plan M8.1, §8 monitoring; the ban mitigation of plan §10 item 23). Every active WhatsApp number's status is
// polled from WAHA (waha_sessions.status and status_at: the pool only sends from a number that was WORKING a moment ago, core
// POOL_STATUS_MAX_AGE_MS), and the pool's own state is persisted as alerts, deduplicated per hour:
//   wa_pool_empty       critical  active numbers exist and none is WORKING (the order page's WhatsApp button has no number either)
//   waha_session_down   warning   a number is not WORKING (STOPPED, SCAN_QR_CODE, FAILED, or WAHA did not answer)
// (A number that fails sends repeatedly raises waha_session_failing where the failure is recorded, deliver.ts; a pool with no
// number to send from raises wa_pool_empty / wa_pool_exhausted where the delivery finds out.) Old send-ledger rows are pruned here
// too, at most once an hour.
//
// WhatsApp's own limits on a WORKING number (WAHA docs, Sessions: Reachout timelock, Message capping) are the likely cause of first messages that silently do
// not arrive: WhatsApp shadow-restricts a number that writes to too many NEW contacts; the session STAYS WORKING, WAHA does not block the API call and WhatsApp
// may not push the state. So each WORKING number's state is polled every LIMITS_EVERY_MS and right after any 463 / 475 (refreshSessionLimits), best effort (an
// instance without them answers 404, a failing call is skipped), and also arrives with a verified session.status webhook (record_waha_session_state). Both
// are persisted on the session (timelock_active / timelock_ends_at, capping_status / quotas / cycle end, limits_checked_at):
//   timelock isActive or capping CAPPED  the number sends no NEW-contact message until WAHA's own end (timeEnforcementEnds, cycleEnd; an hour when it names none);
//                                        it still sends into existing chats (replies, the PDF after a reply). Never restarted, logged out or re-paired.
//   FIRST_WARNING / SECOND_WARNING       the number's new-contact budget shrinks and its gap grows (core warningSlowdown) until the warning ends.
// An alert is raised for any such state (waha_limits, critical when the number is held back, a warning for a capping warning), once an hour per state, with the
// 463 / 475 counts of the number.
import { SESSION_WORKING, type WarningLevel } from "@ebooktrivia/core";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { raiseAlert } from "../sweepers.ts";
import { markReachoutBlocked, pruneSends } from "./pool.ts";
import type { WahaAccess } from "./ports.ts";

/** A status poll must be quick: a WAHA box that does not answer in this time is not WORKING. */
export const STATUS_TIMEOUT_MS = 5000;
export const UNREACHABLE = "UNREACHABLE";
/** How often a WORKING number's WhatsApp limits are read (the status is polled more often). */
export const LIMITS_EVERY_MS = 3 * 60_000;
const PRUNE_EVERY_MS = 3_600_000;
const POLL_CONCURRENCY = 5;

export interface HealthDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  /** Wall clock for the schedules; default Date.now. */
  readonly now?: () => number;
}

export interface PollResult {
  readonly total: number;
  readonly working: number;
}

/**
 * Reads one number's timelock and capping state from WAHA, persists it and raises its alert (see the header); it also lifts the block of a number WAHA says is not
 * limited. Best effort: a number WAHA cannot be asked about, or whose instance has neither endpoint, is left as it is. Returns whether the state was read.
 */
export async function refreshSessionLimits(deps: Pick<HealthDeps, "sql" | "log" | "waha" | "now">, id: string, options: { readonly keepHold?: boolean } = {}): Promise<boolean> {
  const { sql } = deps;
  const now = new Date((deps.now ?? Date.now)());
  const state = await deps.waha
    .withSession(
      id,
      async ({ sessionName, client }) => ({
        timelock: await client.reachoutTimelock(sessionName).catch(() => undefined),
        capping: await client.messageCapping(sessionName).catch(() => undefined),
      }),
      { timeoutMs: STATUS_TIMEOUT_MS },
    )
    .catch(() => undefined);
  if (state === undefined) return false;
  const { timelock, capping } = state;
  // null = this instance has no such state (404); undefined = the call failed: neither says anything.
  const knownTimelock = timelock === null || timelock === undefined ? undefined : timelock;
  const knownCapping = capping === null || capping === undefined ? undefined : capping;
  if (knownTimelock === undefined && knownCapping === undefined) return false;
  const held = knownTimelock?.isActive === true ? (knownTimelock.endsAt ?? "unknown_end") : knownCapping?.status === "CAPPED" ? (knownCapping.cycleEnd ?? "unknown_end") : null;
  const warning: WarningLevel | undefined = knownCapping === undefined ? undefined : knownCapping.status === "FIRST_WARNING" ? "first" : knownCapping.status === "SECOND_WARNING" ? "second" : "none";
  const until = held === null ? null : await markReachoutBlocked(sql, id, now, held === "unknown_end" ? undefined : held);
  // The poll is the authority on the number's limits (the webhook may only extend a block, and by 24 hours at most): when WAHA answers BOTH calls and says the
  // number is not limited, any block is lifted. Not right after a refusal of WhatsApp itself (`keepHold`): WAHA's state may not show it yet, and the hold the refusal
  // put on the number stands until the next poll.
  const lift = held === null && knownTimelock !== undefined && knownCapping !== undefined && options.keepHold !== true;
  const [row] = await sql<{ ban_463_count: number; ban_475_count: number }[]>`
    UPDATE public.waha_sessions SET
           timelock_active = ${knownTimelock === undefined ? sql`timelock_active` : knownTimelock.isActive},
           timelock_ends_at = ${knownTimelock === undefined ? sql`timelock_ends_at` : knownTimelock.endsAt},
           capping_status = ${knownCapping === undefined ? sql`capping_status` : knownCapping.status},
           capping_total_quota = ${knownCapping === undefined ? sql`capping_total_quota` : knownCapping.totalQuota},
           capping_used_quota = ${knownCapping === undefined ? sql`capping_used_quota` : knownCapping.usedQuota},
           capping_cycle_end = ${knownCapping === undefined ? sql`capping_cycle_end` : knownCapping.cycleEnd},
           warning_level = ${warning ?? sql`warning_level`},
           reachout_until = ${lift ? null : sql`reachout_until`},
           limits_checked_at = ${now}
     WHERE id = ${id} RETURNING ban_463_count, ban_475_count`;
  if (held !== null || (warning !== undefined && warning !== "none")) {
    const blocked = held !== null;
    await raiseAlert(sql, {
      kind: "waha_limits",
      severity: blocked ? "critical" : "warning",
      dedupeKey: `waha_limits:${id}:${blocked ? "held" : String(warning)}`,
      message: blocked
        ? "WhatsApp holds this number back from new contacts (reachout timelock or message capping): it sends no new-contact message until it is lifted, but still answers existing chats; do not restart, log out or re-pair it"
        : "WhatsApp warns that this number is nearing its cap of new contacts: its new-contact budget is reduced and its openers are slowed until the warning ends",
      payload: {
        session_id: id,
        timelock_active: knownTimelock?.isActive ?? null,
        capping_status: knownCapping?.status ?? null,
        until: until?.toISOString() ?? null,
        refused_463: row?.ban_463_count ?? 0,
        refused_475: row?.ban_475_count ?? 0,
      },
    }).catch((error: unknown) => {
      deps.log.error({ err: error }, "the WhatsApp limits alert could not be raised");
    });
  }
  return true;
}

export function createSessionPoller(deps: HealthDeps): () => Promise<PollResult> {
  const { sql, log } = deps;
  const now = deps.now ?? Date.now;
  let lastPrune = 0;
  const lastLimits = new Map<string, number>();

  async function statusOf(id: string): Promise<string> {
    try {
      return await deps.waha.withSession(id, ({ sessionName, client }) => client.sessionStatus(sessionName), { timeoutMs: STATUS_TIMEOUT_MS });
    } catch {
      return UNREACHABLE;
    }
  }

  return async () => {
    const sessions = await sql<{ id: string }[]>`
      SELECT s.id FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id WHERE s.active AND w.active ORDER BY s.id`;
    let working = 0;
    for (let i = 0; i < sessions.length; i += POLL_CONCURRENCY) {
      const chunk = sessions.slice(i, i + POLL_CONCURRENCY);
      const statuses = await Promise.all(chunk.map(async ({ id }) => ({ id, status: await statusOf(id) })));
      for (const { id, status } of statuses) {
        await sql`UPDATE public.waha_sessions SET status = ${status}, status_at = clock_timestamp() WHERE id = ${id}`;
        if (status === SESSION_WORKING) {
          working++;
          if (now() - (lastLimits.get(id) ?? 0) >= LIMITS_EVERY_MS) {
            lastLimits.set(id, now());
            await refreshSessionLimits(deps, id).catch((error: unknown) => {
              log.error({ err: error }, "a number's WhatsApp limits could not be recorded");
            });
          }
          continue;
        }
        await raiseAlert(sql, {
          kind: "waha_session_down",
          severity: "warning",
          dedupeKey: `waha_session_down:${id}`,
          message: "a WhatsApp number is not WORKING and is out of the pool until it is",
          payload: { session_id: id, status },
        }).catch((error: unknown) => {
          log.error({ err: error }, "the session alert could not be raised");
        });
      }
    }
    if (sessions.length > 0 && working === 0) {
      await raiseAlert(sql, {
        kind: "wa_pool_empty",
        severity: "critical",
        dedupeKey: "wa_pool_empty",
        message: "no WhatsApp number is WORKING (or none is configured): WhatsApp deliveries wait, e-mail is unaffected",
        payload: { reason: "no_working_session" },
      }).catch((error: unknown) => {
        log.error({ err: error }, "the pool alert could not be raised");
      });
    }
    if (now() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now();
      const pruned = await pruneSends(sql);
      if (pruned > 0) log.debug({ pruned }, "old WhatsApp send ledger rows pruned");
    }
    return { total: sessions.length, working };
  };
}
