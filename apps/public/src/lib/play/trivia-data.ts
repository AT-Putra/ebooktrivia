// What the trivia page (play.<DOMAIN>/{programSlug}, US-027) and its API read, as public_rw. The player id
// comes from the session only (readPlayer / withPlayer). public_rw reads no question text, option, correctness,
// answer row or score (grants.sql, US-027 block): the page reads the catalog, the player's eligibility and which
// sets were started, and the scores and the leaderboard only through the SECURITY DEFINER reads of sql/play.sql
// (play_attempts, play_standing, play_leaderboard: masked, and refused inside a transaction that has written).
// Other players appear by their WhatsApp number with its last 4 digits hidden, masked in SQL (mask_phone_tail; Owner
// decision 2026-11-25); the signed-in player's OWN name, e-mail and number are read in full for the profile card only
// (player_profile_contact). Every query here is a statement (an autocommit transaction) of its own.
import type { Sql } from "../db.ts";
import { bannerImageUrl, prizeImageUrl, setImageUrl } from "./image-urls.ts";

export interface ProgramSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly setCount: number;
  /** The player's finished sets. */
  readonly done: number;
}

/** The programs the player may play or see the results of (eligible, not a draft), the first bought first. */
export async function playerPrograms(sql: Sql, playerId: string): Promise<ProgramSummary[]> {
  const rows = await sql<{ id: string; slug: string; name: string; set_count: number; done: number }[]>`
    SELECT p.id, p.slug, p.name,
           (SELECT count(*)::int FROM public.trivia_sets s WHERE s.program_id = p.id) AS set_count,
           (SELECT count(*)::int FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id
             WHERE s.program_id = p.id AND a.player_id = ${playerId} AND a.finished_at IS NOT NULL) AS done
      FROM public.player_programs pp
      JOIN public.programs p ON p.id = pp.program_id
     WHERE pp.player_id = ${playerId} AND pp.eligible AND p.status <> 'draft'
     ORDER BY pp.first_paid_at, p.id`;
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, setCount: r.set_count, done: r.done }));
}

export type ProgramStatus = "published" | "awaiting_confirmation" | "finalized";

export interface PageSet {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  /** The Owner's uploaded thumbnail (lib/play/images.ts serves it), or null: the grid shows its generic art. */
  readonly thumbnailUrl: string | null;
  readonly questionCount: number;
  /** The sum of the set's question points. */
  readonly maxScore: number;
  readonly attempt: { readonly id: string; readonly score: number; readonly finished: boolean } | null;
}

export interface PrizeTier {
  readonly id: string;
  readonly rankFrom: number;
  readonly rankTo: number;
  readonly name: string;
  readonly valueIdr: number;
  /** The Owner's uploaded image of the tier (lib/play/images.ts serves it), or null: the banner shows its generic art. */
  readonly imageUrl: string | null;
}

export interface BannerWinner {
  readonly rank: number;
  readonly prizeName: string;
  /** The winner's WhatsApp number with its last 4 digits hidden, "0812-3456-****" (masked in SQL). */
  readonly label: string;
}

export interface ProgramPage {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** The Owner's uploaded banner picture (lib/play/images.ts serves it), or null: the banner card shows the built-in art. */
  readonly bannerUrl: string | null;
  readonly status: ProgramStatus;
  readonly salesEnd: Date;
  readonly graceDays: number;
  readonly firstPaidAt: Date;
  /** player_programs.unlock_floor after this view raised it (core unlock.ts floor). */
  readonly floor: number;
  /** The database's clock: the unlock check of play_start_set uses it too. */
  readonly now: Date;
  readonly sets: readonly PageSet[];
  readonly tiers: readonly PrizeTier[];
  /** The confirmed winners, masked, once the program is finalized (program_winners_banner). */
  readonly winners: readonly BannerWinner[];
}

/**
 * The page of one program for the player, or null when there is none the player may see (unknown slug, a draft,
 * not eligible: the page answers the same 404 for all). Raises the player's unlock floor first
 * (play_note_unlocked), so what this view shows open stays open.
 */
export async function programPage(sql: Sql, playerId: string, slug: string): Promise<ProgramPage | null> {
  const [program] = await sql<{ id: string; slug: string; name: string; banner_upload_id: string | null; status: ProgramStatus; sales_end_at: Date; grace_days: number; first_paid_at: Date }[]>`
    SELECT p.id, p.slug, p.name, p.banner_upload_id, p.status::text AS status, p.sales_end_at, p.grace_days, pp.first_paid_at
      FROM public.programs p
      JOIN public.player_programs pp ON pp.program_id = p.id AND pp.player_id = ${playerId} AND pp.eligible
     WHERE p.slug = ${slug} AND p.status <> 'draft'`;
  if (program === undefined) return null;
  const [noted] = await sql<{ floor: number; now: Date }[]>`SELECT public.play_note_unlocked(${playerId}, ${program.id}) AS floor, clock_timestamp() AS now`;
  const sets = await sql<{ id: string; position: number; title: string; thumbnail_upload_id: string | null; question_count: number; max_score: number; attempt_id: string | null; score: number | null; finished: boolean | null }[]>`
    SELECT s.id, s.position, s.title, s.thumbnail_upload_id,
           (SELECT count(*)::int FROM public.questions q WHERE q.set_id = s.id) AS question_count,
           (SELECT coalesce(sum(q.points), 0)::int FROM public.questions q WHERE q.set_id = s.id) AS max_score,
           a.attempt_id, a.score, a.finished
      FROM public.trivia_sets s
      LEFT JOIN public.play_attempts(${playerId}, ${program.id}) a ON a.set_id = s.id
     WHERE s.program_id = ${program.id}
     ORDER BY s.position`;
  const tiers = await sql<{ id: string; rank_from: number; rank_to: number; name: string; value_idr: string; image_upload_id: string | null }[]>`
    SELECT id, rank_from, rank_to, name, value_idr, image_upload_id FROM public.prize_tiers WHERE program_id = ${program.id} ORDER BY rank_from`;
  const winners =
    program.status === "finalized"
      ? await sql<{ rank: number; prize_name: string; masked_phone: string }[]>`SELECT rank, prize_name, masked_phone FROM public.program_winners_banner(${program.id})`
      : [];
  return {
    id: program.id,
    slug: program.slug,
    name: program.name,
    bannerUrl: program.banner_upload_id === null ? null : bannerImageUrl(program.id, program.banner_upload_id),
    status: program.status,
    salesEnd: program.sales_end_at,
    graceDays: program.grace_days,
    firstPaidAt: program.first_paid_at,
    floor: noted?.floor ?? 0,
    now: noted?.now ?? new Date(),
    sets: sets.map((s) => ({
      id: s.id,
      position: s.position,
      title: s.title,
      thumbnailUrl: s.thumbnail_upload_id === null ? null : setImageUrl(s.id, s.thumbnail_upload_id),
      questionCount: s.question_count,
      maxScore: s.max_score,
      attempt: s.attempt_id === null ? null : { id: s.attempt_id, score: s.score ?? 0, finished: s.finished === true },
    })),
    tiers: tiers.map((t) => ({
      id: t.id,
      rankFrom: t.rank_from,
      rankTo: t.rank_to,
      name: t.name,
      valueIdr: Number(t.value_idr),
      imageUrl: t.image_upload_id === null ? null : prizeImageUrl(t.id, t.image_upload_id),
    })),
    winners: winners.map((w) => ({ rank: w.rank, prizeName: w.prize_name, label: w.masked_phone })),
  };
}

// ---------------------------------------------------------------------------------------------
// Leaderboard

export interface LeaderRow {
  readonly rank: number;
  /** The player as the board shows them: the WhatsApp number with its last 4 digits hidden, "0812-3456-****" (masked in SQL). */
  readonly name: string;
  readonly score: number;
  readonly totalMs: number;
  readonly finished: boolean;
}

export interface Standing {
  /** Every eligible player has a rank (D8: one who has played nothing ranks with score 0 and every timer). */
  readonly rank: number | null;
  /** The player's own row on the board, as the others see it: the number with its last 4 digits hidden. */
  readonly name: string;
  readonly score: number;
  readonly totalMs: number;
  readonly setsCompleted: number;
  readonly finished: boolean;
  /** Eligible players on the board. */
  readonly ranked: number;
}

/**
 * The program's top N (programs.leaderboard_top_n), masked, in the final order (play_leaderboard). The total time
 * is D8's: the answered questions' time plus the timers of every question not answered yet, as in the snapshot.
 */
export async function loadTop(sql: Sql, programId: string): Promise<LeaderRow[]> {
  const rows = await sql<{ rank: number; masked_phone: string; score: number; total_ms: string; finished: boolean }[]>`
    SELECT rank, masked_phone, score, total_ms, finished
      FROM public.play_leaderboard(${programId}, (SELECT p.leaderboard_top_n FROM public.programs p WHERE p.id = ${programId}))`;
  return rows.map((r) => ({ rank: r.rank, name: r.masked_phone, score: r.score, totalMs: Number(r.total_ms), finished: r.finished }));
}

/** The player's own standing, fresh (play_standing; ET141 when the player is not eligible for the program). */
export async function loadStanding(sql: Sql, playerId: string, programId: string): Promise<Standing> {
  const [row] = await sql<{ rank: number | null; masked_phone: string; score: number; total_ms: string; sets_completed: number; finished: boolean; ranked: number }[]>`
    SELECT rank, masked_phone, score, total_ms, sets_completed, finished, ranked FROM public.play_standing(${playerId}, ${programId})`;
  if (row === undefined) throw new Error("play_standing returned no row");
  return {
    rank: row.rank,
    name: row.masked_phone,
    score: row.score,
    totalMs: Number(row.total_ms),
    setsCompleted: row.sets_completed,
    finished: row.finished,
    ranked: row.ranked,
  };
}

// ---------------------------------------------------------------------------------------------
// Profile

/** The signed-in player's own contact, in full (Owner decision 2026-11-25): shown to that player only, on the profile card. */
export interface PlayerContact {
  readonly name: string;
  readonly email: string | null;
  /** E.164, as stored ("+6281234567890"); the card shows it as "0812-3456-7890" (lib/format.ts formatPhoneLocal). */
  readonly phone: string;
}

/**
 * The contact of the request's signed-in player (player_profile_contact, keyed by the live SESSION, never a player id), or null for
 * a session that has ended or a player who may not log in (anonymized, no program).
 */
export async function loadProfileContact(sql: Sql, sessionId: string): Promise<PlayerContact | null> {
  const [row] = await sql<{ name: string; email: string | null; phone: string }[]>`SELECT name, email, phone FROM public.player_profile_contact(${sessionId})`;
  return row === undefined ? null : { name: row.name, email: row.email === "" ? null : row.email, phone: row.phone };
}
