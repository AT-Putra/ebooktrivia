// A program's contest results (US-028; plan M9 items 4-6, §10 items 3 and 16; AC-A9): the frozen
// results snapshot and its winners, the anti-cheat flags, the Owner's winner confirmation and the
// Owner's deadline-extension tool for outages. The full trivia report (completion per set, the
// leaderboard, the winners export) is US-029's.
//
// The writes are the database's: public.confirm_program_winners and
// public.extend_open_question_deadlines (packages/db sql/contest.sql), SECURITY DEFINER functions
// owned by contest_results that check the actor is an active Owner, take the program's exclusive
// contest lock, refuse once the contest is in the wrong state, and write their own audit row (no
// player id, name or contact) in the same transaction, like the scoring override (rescore.ts). This
// module bounds the transaction (statement_timeout 15 s, lock_timeout 5 s), passes the actor,
// request id and IP of the mutation scope, and turns the database's refusals into form messages.
//
// The anti-cheat flags are computed here on read (core CONTEST_FLAGS), never acted on: the Owner
// decides. Players are shown in full (name, phone, e-mail: the Owner's decision of 2026-11-25) with a short reference.
import { CONTEST_FLAGS } from "@ebooktrivia/core";
import { currentMutationScope, NoMutationScopeError, type Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { formValue, InvalidInput, multiLine, sqlState } from "./fields.ts";
import { parseReason } from "./rescore.ts";
import { BUSY } from "./trivia.ts";

const WIB_OFFSET_MS = 7 * 3_600_000;
/** Flagged players listed on the page (the winners' flags are always computed). */
export const FLAGGED_LIST_LIMIT = 500;

export const RESULTS_NOT_READY = "This program has no results awaiting confirmation (its grace period has not ended, or the winners are already confirmed).";
export const WINNER_BLOCKED = "A winner has been refunded or flagged since the results snapshot. Confirmation is blocked until that winner is resolved.";
export const CONTEST_ENDED = "This program's contest has ended (results snapshot, status or end of grace): deadlines are final.";

const COMMON: Readonly<Record<string, string>> = {
  ET100: "The request could not run safely. Try again.",
  ET101: "Only an active Owner can do this, with valid values. Reload the page and check the form.",
  "40001": "Someone changed this program at the same moment. Try again.",
  "40P01": "Someone changed this program at the same moment. Try again.",
  "55P03": BUSY,
  "57014": BUSY,
};
const CONFIRM_MESSAGES: Readonly<Record<string, string>> = { ...COMMON, ET102: RESULTS_NOT_READY, ET107: WINNER_BLOCKED };
const EXTEND_MESSAGES: Readonly<Record<string, string>> = { ...COMMON, ET102: CONTEST_ENDED };

export type FlagKind = "fast_median" | "shared_fingerprint" | "shared_ip" | "shared_ua" | "chargeback";

export const FLAG_LABELS: Readonly<Record<FlagKind, string>> = {
  fast_median: `Median answer time under ${String(CONTEST_FLAGS.fastMedianMs)} ms`,
  shared_fingerprint: "Answer times identical to another player's on a set",
  shared_ip: `More than ${String(CONTEST_FLAGS.sharedDevice)} players on one IP address`,
  shared_ua: `More than ${String(CONTEST_FLAGS.sharedDevice)} players on one browser (user agent)`,
  chargeback: "A chargeback on an order of this program",
};

export interface FlaggedPlayer {
  readonly playerId: string;
  /** The first 8 characters of the player id: enough to tell rows apart, not an identity. */
  readonly ref: string;
  /** In full ('' / null / null after a deletion request). */
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly flags: readonly FlagKind[];
  readonly medianMs: number | null;
  readonly pickedAnswers: number;
  readonly ipPlayers: number;
  readonly uaPlayers: number;
}

export interface ResultWinner {
  /** US-030: the winner row (the Owner's revoke and re-award, reinstatement). */
  readonly winnerId: string;
  /** US-030: the player asked for their data to be deleted (the confirmation is refused until the prize is re-awarded). */
  readonly erased: boolean;
  readonly rank: number;
  readonly prizeName: string;
  readonly ref: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly status: string;
  /** Still paid and not refunded (confirmation is refused otherwise). */
  readonly eligible: boolean;
  readonly flags: readonly FlagKind[];
}

export interface ContestResults {
  readonly programId: string;
  readonly name: string;
  readonly status: string;
  readonly graceEnd: Date;
  readonly winnersConfirmedAt: Date | null;
  readonly snapshot: { readonly frozenAt: Date; readonly createdAt: Date; readonly ranked: number } | null;
  readonly winners: readonly ResultWinner[];
  /** The first FLAGGED_LIST_LIMIT flagged players, most flags first. */
  readonly flagged: readonly FlaggedPlayer[];
  /** How many players are flagged in all. */
  readonly flaggedTotal: number;
  /** Served questions not answered yet (what an extension could reach). */
  readonly openQuestions: number;
  readonly extensionMaxMinutes: number;
}

const ref = (playerId: string): string => playerId.slice(0, 8);

interface FlagRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly picked: number;
  readonly median_ms: number | null;
  readonly twins: number;
  readonly ip_players: number;
  readonly ua_players: number;
  readonly chargeback: boolean;
  readonly flag_count: number;
  readonly total: number;
}

/**
 * Per flagged player of the program, with the count of all flagged players. A pick slower than its
 * question's timer (a late pick, scored as a timeout) is no evidence of speed: medians and
 * fingerprints use on-time picks only (code review MINOR-7). A chargeback (US-021 security review
 * P2-3) is any Midtrans chargeback or partial chargeback, processed (payments) or still in the
 * notification inbox, on one of the player's orders of the program. `only` restricts to some players
 * (the winners: their flags whatever the list's limit), else the first `limit` by flag count.
 */
async function flagRows(sql: Sql, programId: string, scope: { readonly only: readonly string[] } | { readonly limit: number }): Promise<FlagRow[]> {
  const only = "only" in scope ? scope.only : null;
  const limit = "limit" in scope ? scope.limit : null;
  return sql<FlagRow[]>`
    WITH answers AS (
      SELECT a.player_id, a.id AS attempt_id, a.set_id, aq.question_id, aq.option_id, aq.elapsed_ms, aq.ip, aq.ua_hash,
             q.timer_seconds::bigint * 1000 AS timer_ms
        FROM public.attempt_questions aq
        JOIN public.set_attempts a ON a.id = aq.attempt_id
        JOIN public.trivia_sets s ON s.id = a.set_id
        JOIN public.questions q ON q.id = aq.question_id
       WHERE s.program_id = ${programId}
    ), picked AS (
      SELECT * FROM answers WHERE option_id IS NOT NULL AND elapsed_ms IS NOT NULL AND elapsed_ms < timer_ms
    ), medians AS (
      SELECT player_id, count(*)::int AS picked, percentile_cont(0.5) WITHIN GROUP (ORDER BY elapsed_ms)::float8 AS median_ms
        FROM picked GROUP BY player_id
    ), prints AS (
      SELECT player_id, set_id, count(*)::int AS n,
             string_agg(question_id::text || ':' || elapsed_ms::text, ',' ORDER BY question_id) AS print
        FROM picked GROUP BY player_id, attempt_id, set_id
    ), twins AS (
      SELECT p.player_id, count(DISTINCT o.player_id)::int AS twins
        FROM prints p JOIN prints o ON o.set_id = p.set_id AND o.print = p.print AND o.player_id <> p.player_id
       WHERE p.n >= ${CONTEST_FLAGS.minAnswers}
       GROUP BY p.player_id
    ), ips AS (
      SELECT ip, count(DISTINCT player_id)::int AS players FROM answers WHERE ip IS NOT NULL GROUP BY ip
    ), uas AS (
      SELECT ua_hash, count(DISTINCT player_id)::int AS players FROM answers WHERE ua_hash IS NOT NULL GROUP BY ua_hash
    ), shared AS (
      SELECT x.player_id, coalesce(max(i.players), 0)::int AS ip_players, coalesce(max(u.players), 0)::int AS ua_players
        FROM (SELECT DISTINCT player_id, ip, ua_hash FROM answers) x
        LEFT JOIN ips i ON i.ip = x.ip
        LEFT JOIN uas u ON u.ua_hash = x.ua_hash
       GROUP BY x.player_id
    ), chargebacks AS (
      SELECT DISTINCT o.player_id
        FROM public.orders o
       WHERE o.program_id = ${programId} AND o.player_id IS NOT NULL
         AND (EXISTS (SELECT 1 FROM public.payments pay
                       WHERE pay.order_id = o.id AND pay.transaction_status IN ('chargeback', 'partial_chargeback'))
              OR EXISTS (SELECT 1 FROM public.midtrans_attempts ma
                           JOIN public.payment_notifications n ON n.midtrans_order_id = ma.midtrans_order_id
                          WHERE ma.order_id = o.id AND n.transaction_status IN ('chargeback', 'partial_chargeback')))
    ), roster AS (
      SELECT player_id FROM answers UNION SELECT player_id FROM chargebacks
    ), flagged AS (
      SELECT r.player_id, coalesce(m.picked, 0)::int AS picked, m.median_ms, coalesce(t.twins, 0)::int AS twins,
             coalesce(sh.ip_players, 0)::int AS ip_players, coalesce(sh.ua_players, 0)::int AS ua_players,
             (cb.player_id IS NOT NULL) AS chargeback,
             ((coalesce(m.picked, 0) >= ${CONTEST_FLAGS.minAnswers} AND m.median_ms < ${CONTEST_FLAGS.fastMedianMs})::int
              + (coalesce(t.twins, 0) > 0)::int + (coalesce(sh.ip_players, 0) > ${CONTEST_FLAGS.sharedDevice})::int
              + (coalesce(sh.ua_players, 0) > ${CONTEST_FLAGS.sharedDevice})::int + (cb.player_id IS NOT NULL)::int) AS flag_count
        FROM roster r
        LEFT JOIN shared sh ON sh.player_id = r.player_id
        LEFT JOIN medians m ON m.player_id = r.player_id
        LEFT JOIN twins t ON t.player_id = r.player_id
        LEFT JOIN chargebacks cb ON cb.player_id = r.player_id
    )
    SELECT pl.id, pl.name, pl.phone, pl.email, f.picked, f.median_ms, f.twins, f.ip_players, f.ua_players, f.chargeback, f.flag_count,
           (count(*) OVER ())::int AS total
      FROM flagged f JOIN public.players pl ON pl.id = f.player_id
     WHERE f.flag_count > 0 AND (${only}::uuid[] IS NULL OR f.player_id = ANY (${only}::uuid[]))
     ORDER BY f.flag_count DESC, pl.id
     LIMIT ${limit}`;
}

function flagsOf(r: FlagRow): FlagKind[] {
  const flags: FlagKind[] = [];
  if (r.picked >= CONTEST_FLAGS.minAnswers && r.median_ms !== null && r.median_ms < CONTEST_FLAGS.fastMedianMs) flags.push("fast_median");
  if (r.twins > 0) flags.push("shared_fingerprint");
  if (r.ip_players > CONTEST_FLAGS.sharedDevice) flags.push("shared_ip");
  if (r.ua_players > CONTEST_FLAGS.sharedDevice) flags.push("shared_ua");
  if (r.chargeback) flags.push("chargeback");
  return flags;
}

/** The program's flagged players, most flags first (at most `limit`), and how many there are. */
export async function listFlaggedPlayers(sql: Sql, programId: string, limit = FLAGGED_LIST_LIMIT): Promise<{ readonly players: FlaggedPlayer[]; readonly total: number }> {
  const rows = await flagRows(sql, programId, { limit });
  return {
    players: rows.map((r) => ({
      playerId: r.id,
      ref: ref(r.id),
      name: r.name,
      phone: r.phone,
      email: r.email,
      flags: flagsOf(r),
      medianMs: r.median_ms,
      pickedAnswers: r.picked,
      ipPlayers: r.ip_players,
      uaPlayers: r.ua_players,
    })),
    total: rows[0]?.total ?? 0,
  };
}

/** Everything the results page shows, or null for an unknown program. */
export async function getContestResults(sql: Sql, programId: string): Promise<ContestResults | null> {
  const [program] = await sql<{ id: string; name: string; status: string; grace_end: Date; winners_confirmed_at: Date | null }[]>`
    SELECT p.id, p.name, p.status::text AS status, p.sales_end_at + make_interval(days => p.grace_days) AS grace_end, p.winners_confirmed_at
      FROM public.programs p WHERE p.id = ${programId}`;
  if (program === undefined) return null;
  const [snapshot] = await sql<{ frozen_at: Date; created_at: Date; ranked: number }[]>`
    SELECT frozen_at, created_at, jsonb_array_length(entries)::int AS ranked FROM public.leaderboard_snapshots WHERE program_id = ${programId}`;
  const winners = await sql<{ winner_id: string; rank: number; prize: string; id: string; name: string; phone: string | null; email: string | null; status: string; eligible: boolean; erased: boolean }[]>`
    SELECT w.id AS winner_id, w.rank, t.name AS prize, pl.id, pl.name, pl.phone, pl.email, w.status::text AS status, coalesce(pp.eligible, false) AS eligible,
           pl.anonymized_at IS NOT NULL AS erased
      FROM public.winners w
      JOIN public.prize_tiers t ON t.id = w.prize_tier_id
      JOIN public.players pl ON pl.id = w.player_id
      LEFT JOIN public.player_programs pp ON pp.player_id = w.player_id AND pp.program_id = w.program_id
     WHERE w.program_id = ${programId}
     ORDER BY w.rank`;
  const [open] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id JOIN public.trivia_sets s ON s.id = a.set_id
     WHERE s.program_id = ${programId} AND aq.served_at IS NOT NULL AND aq.answered_at IS NULL`;
  const flagged = await listFlaggedPlayers(sql, programId);
  const winnerFlags = new Map(
    winners.length === 0 ? [] : (await flagRows(sql, programId, { only: winners.map((w) => w.id) })).map((r) => [r.id, flagsOf(r)] as const),
  );
  return {
    programId: program.id,
    name: program.name,
    status: program.status,
    graceEnd: program.grace_end,
    winnersConfirmedAt: program.winners_confirmed_at,
    snapshot: snapshot === undefined ? null : { frozenAt: snapshot.frozen_at, createdAt: snapshot.created_at, ranked: snapshot.ranked },
    winners: winners.map((w) => ({
      winnerId: w.winner_id,
      erased: w.erased,
      rank: w.rank,
      prizeName: w.prize,
      ref: ref(w.id),
      name: w.name,
      phone: w.phone,
      email: w.email,
      status: w.status,
      eligible: w.eligible,
      flags: winnerFlags.get(w.id) ?? [],
    })),
    flagged: flagged.players,
    flaggedTotal: flagged.total,
    openQuestions: open?.n ?? 0,
    extensionMaxMinutes: await extensionMaxMinutes(sql),
  };
}

/** app_settings trivia.extension_max_minutes: the longest outage the extension covers (the database refuses more). */
export async function extensionMaxMinutes(sql: Sql): Promise<number> {
  const [setting] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = 'trivia.extension_max_minutes'`;
  return typeof setting?.value === "number" ? setting.value : 60;
}

/** "YYYY-MM-DDTHH:MM" of an instant in WIB (the datetime-local input's value). */
export const wibLocal = (at: Date): string => new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 16);

export interface ExtensionInput {
  readonly outageStartedAt: Date;
  readonly outageEndedAt: Date;
  readonly reason: string;
}

/** A datetime-local value ("YYYY-MM-DDTHH:MM") read as WIB, or null. */
function wibInstant(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw);
  const at = match === null ? null : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])) - WIB_OFFSET_MS);
  return at === null || Number.isNaN(at.getTime()) || wibLocal(at) !== raw ? null : at;
}

/**
 * The extension form: when the outage started and ended (WIB; start <= end <= now, the start within
 * the last `maxMinutes`) and a reason.
 */
export function parseExtension(form: FormData, maxMinutes: number, now: Date): ExtensionInput {
  const startedAt = wibInstant(formValue(form, "outageStartedAt").trim());
  if (startedAt === null) throw new InvalidInput("Enter when the outage started (date and time, WIB).");
  const endedAt = wibInstant(formValue(form, "outageEndedAt").trim());
  if (endedAt === null) throw new InvalidInput("Enter when the outage ended (date and time, WIB).");
  if (startedAt.getTime() > now.getTime() || startedAt.getTime() < now.getTime() - maxMinutes * 60_000) {
    throw new InvalidInput(`The outage must have started within the last ${String(maxMinutes)} minutes, and not in the future.`);
  }
  if (endedAt.getTime() < startedAt.getTime() || endedAt.getTime() > now.getTime()) {
    throw new InvalidInput("The outage must end after it started, and not in the future.");
  }
  return {
    outageStartedAt: startedAt,
    outageEndedAt: endedAt,
    // Length first (this form's message), then rescore.ts's no-personal-data rule (the database's too).
    reason: parseReason(multiLine(formValue(form, "reason").trim(), "Give the reason for the extension (10 to 500 characters).", { min: 10, max: 500 })),
  };
}

export function actor(): { readonly userId: string; readonly requestId: string | null; readonly ip: string | null } {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  if (scope.actor.kind !== "admin") throw new Error("contest results are an admin action");
  return { userId: scope.actor.userId, requestId: scope.requestId, ip: scope.ip };
}

/** One bounded transaction; the database's refusals become this call's form messages. */
export async function bounded<T>(sql: Sql, messages: Readonly<Record<string, string>>, run: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      return run(tx);
    });
  } catch (error) {
    const message = messages[sqlState(error) ?? ""];
    if (message !== undefined) throw new InvalidInput(message);
    throw error;
  }
}

/** The Owner confirms every winner of the program's snapshot; the banner then shows them, masked. */
export async function confirmWinners(sql: Sql, programId: string): Promise<{ readonly winners: number }> {
  const a = actor();
  const summary = await bounded(sql, CONFIRM_MESSAGES, async (tx) => {
    const [row] = await tx<{ summary: Record<string, unknown> }[]>`
      SELECT public.confirm_program_winners(${programId}::uuid, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS summary`;
    return row?.summary ?? {};
  });
  return { winners: Number(summary["winners_confirmed"] ?? 0) };
}

/** The Owner's outage tool: gives each question cut short by the outage back the time it lost. */
export async function extendDeadlines(sql: Sql, programId: string, input: ExtensionInput): Promise<{ readonly questions: number; readonly players: number }> {
  const a = actor();
  const summary = await bounded(sql, EXTEND_MESSAGES, async (tx) => {
    const [row] = await tx<{ summary: Record<string, unknown> }[]>`
      SELECT public.extend_open_question_deadlines(${programId}::uuid, ${input.outageStartedAt}, ${input.outageEndedAt}, ${input.reason},
                                                   ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS summary`;
    return row?.summary ?? {};
  });
  return { questions: Number(summary["questions_extended"] ?? 0), players: Number(summary["players_affected"] ?? 0) };
}
