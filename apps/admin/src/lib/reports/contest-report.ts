// The trivia (contest) report (AC-A9): players and completion per set, the leaderboard (frozen once the results snapshot exists, live
// before), and the anti-cheat flags and winners (lib/settings/contest.ts, US-028: listFlaggedPlayers, getContestResults). Players are
// shown MASKED: the leaderboard masks in SQL (public.mask_name / mask_phone, the one masking rule of the product), and the flag and
// winner lists come from US-028's code, which masks with the same rule. The winners export (contact details) is Owner-only
// (lib/reports/exports.ts). Everything here reads the play tables as they are; US-027's play flow adds rows to them, not columns.
import { rateBps } from "@ebooktrivia/core";
import type { Sql } from "../db.ts";

export interface ProgramChoice {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export async function programChoices(sql: Sql): Promise<ProgramChoice[]> {
  return sql<ProgramChoice[]>`SELECT id, name, status::text AS status FROM public.programs ORDER BY created_at DESC LIMIT 100`;
}

export interface SetCompletion {
  readonly setId: string;
  readonly position: number;
  readonly title: string;
  readonly started: number;
  readonly completed: number;
  /** completed / started in basis points; null when nobody started the set. */
  readonly completionBps: number | null;
}

export interface Participation {
  /** Players with a paid, non-refunded order of the program (eligible to play). */
  readonly eligiblePlayers: number;
  /** Eligible or not, players with at least one attempt. */
  readonly playersStarted: number;
  /** Players who finished every set of the program. */
  readonly playersCompletedAll: number;
  readonly sets: readonly SetCompletion[];
}

export async function participation(sql: Sql, programId: string): Promise<Participation> {
  const [people] = await sql<{ eligible: number; started: number; completed_all: number }[]>`
    SELECT (SELECT count(*) FROM public.player_programs pp WHERE pp.program_id = ${programId} AND pp.eligible)::int AS eligible,
           (SELECT count(DISTINCT a.player_id) FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${programId})::int AS started,
           (SELECT count(*) FROM public.player_program_stats st
             WHERE st.program_id = ${programId} AND st.sets_completed >= (SELECT count(*) FROM public.trivia_sets s WHERE s.program_id = ${programId})
               AND (SELECT count(*) FROM public.trivia_sets s WHERE s.program_id = ${programId}) > 0)::int AS completed_all`;
  const sets = await sql<{ id: string; position: number; title: string; started: number; completed: number }[]>`
    SELECT s.id, s.position, s.title, (count(a.id))::int AS started, (count(a.id) FILTER (WHERE a.finished_at IS NOT NULL))::int AS completed
      FROM public.trivia_sets s LEFT JOIN public.set_attempts a ON a.set_id = s.id
     WHERE s.program_id = ${programId}
     GROUP BY s.id ORDER BY s.position`;
  return {
    eligiblePlayers: people?.eligible ?? 0,
    playersStarted: people?.started ?? 0,
    playersCompletedAll: people?.completed_all ?? 0,
    sets: sets.map((s) => ({ setId: s.id, position: s.position, title: s.title, started: s.started, completed: s.completed, completionBps: rateBps(s.completed, s.started) })),
  };
}

export interface LeaderboardRow {
  readonly rank: number;
  /** The first 8 characters of the player id: tells rows apart, not an identity. */
  readonly ref: string;
  readonly name: string;
  readonly phone: string | null;
  readonly score: number;
  readonly totalMs: number;
  readonly finishedAt: Date | null;
}

export interface Leaderboard {
  /** The frozen results snapshot (written at the end of grace) or the live standings. */
  readonly frozen: boolean;
  readonly frozenAt: Date | null;
  readonly rows: readonly LeaderboardRow[];
  /** Ranked players in all (the rows are the first `limit`). */
  readonly total: number;
}

export const LEADERBOARD_LIMIT = 50;

/**
 * Eligible players only (a refunded player is out: AC-Q11). The live standings rank EXACTLY like the frozen snapshot (packages/db sql/contest.sql,
 * create_leaderboard_snapshot step 4; Owner decision D4): score desc, total answer time asc, earliest finish asc (unfinished last), the
 * earlier first payment, then the player id; a unique rank per player, so what the Owner sees live is what freezes.
 */
export async function leaderboard(sql: Sql, programId: string, limit = LEADERBOARD_LIMIT): Promise<Leaderboard> {
  const [snapshot] = await sql<{ frozen_at: Date; total: number }[]>`
    SELECT frozen_at, jsonb_array_length(entries)::int AS total FROM public.leaderboard_snapshots WHERE program_id = ${programId}`;
  type Row = { rank: number; player_id: string; name: string; phone: string | null; score: number; total_ms: string; finished_at: Date | null };
  const toRow = (r: Row): LeaderboardRow => ({ rank: r.rank, ref: r.player_id.slice(0, 8), name: r.name, phone: r.phone, score: r.score, totalMs: Number(r.total_ms), finishedAt: r.finished_at });
  if (snapshot !== undefined) {
    const rows = await sql<Row[]>`
      SELECT (e.value ->> 'rank')::int AS rank, pl.id AS player_id, public.mask_name(pl.name) AS name, public.mask_phone(pl.phone) AS phone,
             (e.value ->> 'score')::int AS score, (e.value ->> 'total_ms') AS total_ms, (e.value ->> 'finished_at')::timestamptz AS finished_at
        FROM public.leaderboard_snapshots l
        CROSS JOIN LATERAL jsonb_array_elements(l.entries) AS e(value)
        JOIN public.players pl ON pl.id = (e.value ->> 'player_id')::uuid
       WHERE l.program_id = ${programId}
       ORDER BY (e.value ->> 'rank')::int, pl.id
       LIMIT ${limit}`;
    return { frozen: true, frozenAt: snapshot.frozen_at, rows: rows.map(toRow), total: snapshot.total };
  }
  const rows = await sql<(Row & { total: number })[]>`
    SELECT (row_number() OVER (ORDER BY st.score DESC, st.total_ms ASC, st.finished_at ASC NULLS LAST, pp.first_paid_at ASC NULLS LAST, st.player_id ASC))::int AS rank, st.player_id, public.mask_name(pl.name) AS name,
           public.mask_phone(pl.phone) AS phone, st.score, st.total_ms::text AS total_ms, st.finished_at, (count(*) OVER ())::int AS total
      FROM public.player_program_stats st
      JOIN public.player_programs pp ON pp.player_id = st.player_id AND pp.program_id = st.program_id AND pp.eligible
      JOIN public.players pl ON pl.id = st.player_id
     WHERE st.program_id = ${programId}
     ORDER BY rank, st.player_id
     LIMIT ${limit}`;
  return { frozen: false, frozenAt: null, rows: rows.map(toRow), total: rows[0]?.total ?? 0 };
}
