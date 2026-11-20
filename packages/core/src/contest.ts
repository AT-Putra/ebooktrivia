// The end of a program's contest (US-028; plan M9 items 4-6, §10 items 3, 16, 19; spec AC-Q10,
// AC-Q11, AC-A9). Pure. finalizeContest is THE definition of the frozen result: the database's
// public.create_leaderboard_snapshot (packages/db sql/contest.sql) computes the same in SQL, and
// apps/admin test/contest-oracle.int.test.ts proves them equal on random play histories.
//
// At the grace end G (programs.sales_end_at + grace_days, graceEndAt) every set is unlocked for
// every player who paid by then (unlock.ts: the last set unlocks on D_end, and G falls on or after
// D_end; contest.test.ts proves it as a property). The finalize, in whole milliseconds:
//   1. every answer row of a started attempt still without answered_at becomes a timeout:
//      served      -> answered_at = deadline_at (served_at + the current timer if none was stored);
//      never served-> answered_at = G (a row served at or after G counts as never served, and is
//                     scored so; the play guards refuse such a serve, only a trusted writer could);
//      then every row of the program is scored with rescore.ts scoreAnswer under the current rules
//      (a stored score is never trusted);
//   2. attempts: score / total_ms are sums; finished_at = the last answered_at once every question
//      of the set has a row served before G (after step 1 every row is finalized), else NULL: a set
//      started and never served is not finished, so it cannot beat a set never started;
//   3. per player: score = sum of attempt scores; total_ms = sum of attempt totals PLUS unplayedMs,
//      the summed CURRENT timers of every question of the program the player has no answer row for
//      (the sets never started, and any question of a started set without a row), as ONE aggregate:
//      no per-question rows are written. So skipping a question never costs less time than playing
//      it (an answer's elapsed never exceeds its timer), and a skipped set leaves finished_at NULL,
//      which ranks last (NULLS LAST): skipping never beats playing (§10 item 19).
//      sets_completed = finished attempts; finished_at = the last attempt finish once every set of
//      the program is finished (the player's last finalized timestamp), else NULL. A player who
//      paid after G is treated the same (they cannot gain by not having played);
//   4. ranking, eligible players only (refunded players are excluded, AC-Q11): score desc, total_ms
//      asc, finished_at asc NULLS LAST (AC-Q10, ranking.ts compareRanking), then the STABLE FINAL
//      TIE-BREAKERS: first_paid_at asc (the earlier buyer, in line with §10 item 12) and player id
//      asc (a last resort that two players can never share). Ranks are therefore unique, 1..n, and
//      a prize tier never gets more candidates than places;
//   5. winners: every ranked player whose rank lies inside a prize tier's [rankFrom, rankTo].
import { compareRanking } from "./ranking.ts";
import { type AnswerFacts, type AttemptScore, type ScoringRule, scoreAnswer } from "./rescore.ts";
import { DAY_MS } from "./unlock.ts";

/** The grace-end sweeper waits this long after G, so answers recorded just before G have committed. */
export const GRACE_END_SETTLE_MS = 60_000;

/**
 * Anti-cheat flags (plan M9 item 5, §10 item 3): shown to the admins, never acted on automatically.
 *   fastMedianMs   the median elapsed of a player's picked answers is below this (and the player
 *                  picked at least minAnswers times);
 *   minAnswers     picked answers needed before the median or a fingerprint counts;
 *   sharedDevice   more than this many players answered from one IP address, or one UA hash;
 *   fingerprint    two players' attempts on the same set have identical elapsed times on the same
 *                  questions (at least minAnswers picked answers).
 */
export const CONTEST_FLAGS = { fastMedianMs: 800, minAnswers: 3, sharedDevice: 3 } as const;

/** G: programs.sales_end_at + grace_days (the SQL's sales_end_at + make_interval(days => grace_days)). */
export function graceEndAt(salesEnd: Date, graceDays: number): Date {
  if (!(salesEnd instanceof Date) || Number.isNaN(salesEnd.getTime())) throw new RangeError("salesEnd must be a valid Date");
  if (!Number.isSafeInteger(graceDays) || graceDays < 0) throw new RangeError("graceDays must be a non-negative safe integer");
  return new Date(salesEnd.getTime() + graceDays * DAY_MS);
}

export interface ContestQuestion extends ScoringRule {
  readonly id: string;
  readonly setId: string;
}

export interface ContestPlayer {
  readonly id: string;
  /** player_programs.eligible at the snapshot (paid, not refunded). */
  readonly eligible: boolean;
  readonly firstPaidAt: Date | null;
}

export interface ContestAttempt {
  readonly id: string;
  readonly playerId: string;
  readonly setId: string;
}

export interface ContestAnswer extends AnswerFacts {
  readonly id: string;
  readonly attemptId: string;
  readonly questionId: string;
}

export interface ContestTier {
  readonly id: string;
  readonly rankFrom: number;
  readonly rankTo: number;
}

export interface ContestInput {
  /** G, in whole milliseconds. */
  readonly graceEnd: Date;
  /** Every set of the program. */
  readonly setIds: readonly string[];
  /** Every question of those sets, with its current rules. */
  readonly questions: readonly ContestQuestion[];
  /** Every player of the program: paid at some point, or holding an attempt. */
  readonly players: readonly ContestPlayer[];
  readonly attempts: readonly ContestAttempt[];
  readonly answers: readonly ContestAnswer[];
  readonly tiers: readonly ContestTier[];
}

export interface FinalAnswer {
  readonly id: string;
  readonly answeredAt: Date;
  readonly correct: boolean;
  readonly points: number;
  readonly elapsedMs: number;
}

export interface FinalStats {
  readonly playerId: string;
  readonly score: number;
  /** Includes unplayedMs. */
  readonly totalMs: number;
  readonly setsCompleted: number;
  readonly finishedAt: Date | null;
  /** The aggregate of step 3: timers of the questions the player has no answer row for. */
  readonly unplayedMs: number;
}

export interface SnapshotEntry extends FinalStats {
  /** 1..n, unique (see the tie-breakers above). */
  readonly rank: number;
}

export interface ContestWinner {
  readonly tierId: string;
  readonly playerId: string;
  readonly rank: number;
}

export interface ContestResult {
  /** Every answer row of the program, finalized and scored, sorted by id. */
  readonly answers: readonly FinalAnswer[];
  /** Every attempt of the program, sorted by id. */
  readonly attempts: readonly ({ readonly id: string } & AttemptScore)[];
  /** Every player of the input, sorted by player id. */
  readonly stats: readonly FinalStats[];
  /** Eligible players, by rank. */
  readonly entries: readonly SnapshotEntry[];
  /** By rank. */
  readonly winners: readonly ContestWinner[];
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The ranking order of the snapshot: AC-Q10's three keys, then first payment, then player id. */
export function compareFinal(
  a: { readonly score: number; readonly totalMs: number; readonly finishedAt: Date | null; readonly firstPaidAt: Date | null; readonly playerId: string },
  b: { readonly score: number; readonly totalMs: number; readonly finishedAt: Date | null; readonly firstPaidAt: Date | null; readonly playerId: string },
): number {
  const ranking = compareRanking(a, b);
  if (ranking !== 0) return ranking;
  if (a.firstPaidAt !== null && b.firstPaidAt !== null && a.firstPaidAt.getTime() !== b.firstPaidAt.getTime()) return a.firstPaidAt.getTime() - b.firstPaidAt.getTime();
  if ((a.firstPaidAt === null) !== (b.firstPaidAt === null)) return a.firstPaidAt === null ? 1 : -1;
  return byKey(a.playerId, b.playerId);
}

/** A question served at or after G counts as never served (step 1; play refuses such a serve anyway). */
export const servedBefore = (servedAt: Date | null, graceEnd: Date): Date | null => (servedAt !== null && servedAt.getTime() < graceEnd.getTime() ? servedAt : null);

/** answered_at the finalize gives a row still open at G (step 1). */
export function finalizedAt(answer: AnswerFacts, timerSeconds: number, graceEnd: Date): Date {
  if (answer.answeredAt !== null) return answer.answeredAt;
  const servedAt = servedBefore(answer.servedAt, graceEnd);
  if (servedAt === null) return graceEnd;
  return answer.deadlineAt ?? new Date(servedAt.getTime() + timerSeconds * 1000);
}

function unique<T>(items: readonly T[], key: (item: T) => string, what: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) throw new RangeError(`duplicate ${what} ${k}`);
    map.set(k, item);
  }
  return map;
}

const later = (a: Date | null, b: Date): Date => (a === null || b.getTime() > a.getTime() ? b : a);

/** The frozen result of a program at its grace end (see the rules at the top of this file). */
export function finalizeContest(input: ContestInput): ContestResult {
  const graceEnd = input.graceEnd;
  if (!(graceEnd instanceof Date) || Number.isNaN(graceEnd.getTime())) throw new RangeError("graceEnd must be a valid Date");
  const sets = new Set(input.setIds);
  if (sets.size !== input.setIds.length) throw new RangeError("duplicate set id");
  const questions = unique(input.questions, (q) => q.id, "question");
  const questionsPerSet = new Map<string, number>();
  let programTimerMs = 0;
  for (const q of questions.values()) {
    if (!sets.has(q.setId)) throw new RangeError(`question ${q.id} is not in one of the program's sets`);
    questionsPerSet.set(q.setId, (questionsPerSet.get(q.setId) ?? 0) + 1);
    programTimerMs += q.timerSeconds * 1000;
  }
  const players = unique(input.players, (p) => p.id, "player");
  const attempts = unique(input.attempts, (a) => a.id, "attempt");
  const attemptKeys = new Set<string>();
  for (const a of attempts.values()) {
    if (!sets.has(a.setId)) throw new RangeError(`attempt ${a.id} is not on one of the program's sets`);
    if (!players.has(a.playerId)) throw new RangeError(`attempt ${a.id} of a player not in the input`);
    const key = `${a.playerId}\u0000${a.setId}`;
    if (attemptKeys.has(key)) throw new RangeError(`player ${a.playerId} has two attempts on set ${a.setId}`);
    attemptKeys.add(key);
  }

  const answers: FinalAnswer[] = [];
  const perAttempt = new Map<string, { score: number; totalMs: number; served: number; last: Date | null }>();
  const coveredMs = new Map<string, number>();
  const pairs = new Set<string>();
  for (const answer of input.answers) {
    const attempt = attempts.get(answer.attemptId);
    if (attempt === undefined) throw new RangeError(`answer ${answer.id} of an unknown attempt`);
    const question = questions.get(answer.questionId);
    if (question?.setId !== attempt.setId) throw new RangeError(`answer ${answer.id} is not for a question of its attempt's set`);
    const pair = `${answer.attemptId}\u0000${answer.questionId}`;
    if (pairs.has(pair)) throw new RangeError(`attempt ${answer.attemptId} answers question ${answer.questionId} twice`);
    pairs.add(pair);
    const answeredAt = finalizedAt(answer, question.timerSeconds, graceEnd);
    const scored = scoreAnswer(question, { ...answer, servedAt: servedBefore(answer.servedAt, graceEnd), answeredAt });
    // answeredAt is set, so scoreAnswer returns a decided row (correct and elapsed not null).
    const final: FinalAnswer = { id: answer.id, answeredAt, correct: scored.correct === true, points: scored.points, elapsedMs: scored.elapsedMs ?? 0 };
    answers.push(final);
    const sum = perAttempt.get(attempt.id) ?? { score: 0, totalMs: 0, served: 0, last: null };
    sum.score += final.points;
    sum.totalMs += final.elapsedMs;
    if (servedBefore(answer.servedAt, graceEnd) !== null) sum.served++;
    sum.last = later(sum.last, answeredAt);
    perAttempt.set(attempt.id, sum);
    coveredMs.set(attempt.playerId, (coveredMs.get(attempt.playerId) ?? 0) + question.timerSeconds * 1000);
  }
  if (new Set(answers.map((a) => a.id)).size !== answers.length) throw new RangeError("duplicate answer id");

  const attemptScores: ({ readonly id: string } & AttemptScore)[] = [];
  const perPlayer = new Map<string, { score: number; totalMs: number; setsCompleted: number; last: Date | null }>();
  for (const attempt of attempts.values()) {
    const sum = perAttempt.get(attempt.id) ?? { score: 0, totalMs: 0, served: 0, last: null };
    const count = questionsPerSet.get(attempt.setId) ?? 0;
    const finishedAt = count > 0 && sum.served === count ? sum.last : null;
    attemptScores.push({ id: attempt.id, score: sum.score, totalMs: sum.totalMs, finishedAt });
    const player = perPlayer.get(attempt.playerId) ?? { score: 0, totalMs: 0, setsCompleted: 0, last: null };
    player.score += sum.score;
    player.totalMs += sum.totalMs;
    if (finishedAt !== null) {
      player.setsCompleted++;
      player.last = later(player.last, finishedAt);
    }
    perPlayer.set(attempt.playerId, player);
  }

  const stats: FinalStats[] = [];
  for (const player of players.values()) {
    const p = perPlayer.get(player.id) ?? { score: 0, totalMs: 0, setsCompleted: 0, last: null };
    const unplayedMs = programTimerMs - (coveredMs.get(player.id) ?? 0);
    stats.push({
      playerId: player.id,
      score: p.score,
      totalMs: p.totalMs + unplayedMs,
      setsCompleted: p.setsCompleted,
      finishedAt: sets.size > 0 && p.setsCompleted === sets.size ? p.last : null,
      unplayedMs,
    });
  }
  stats.sort((a, b) => byKey(a.playerId, b.playerId));

  const ranked = stats
    .filter((s) => players.get(s.playerId)?.eligible === true)
    .map((s) => ({ stats: s, key: { ...s, firstPaidAt: players.get(s.playerId)?.firstPaidAt ?? null } }))
    .sort((a, b) => compareFinal(a.key, b.key));
  const entries: SnapshotEntry[] = ranked.map((r, index) => ({ ...r.stats, rank: index + 1 }));

  const tiers = [...input.tiers].sort((a, b) => a.rankFrom - b.rankFrom);
  for (const [i, tier] of tiers.entries()) {
    if (!Number.isSafeInteger(tier.rankFrom) || tier.rankFrom < 1 || !Number.isSafeInteger(tier.rankTo) || tier.rankTo < tier.rankFrom) {
      throw new RangeError(`prize tier ${tier.id} has an invalid rank range`);
    }
    const previous = tiers[i - 1];
    if (previous !== undefined && previous.rankTo >= tier.rankFrom) throw new RangeError(`prize tiers ${previous.id} and ${tier.id} overlap`);
  }
  const winners: ContestWinner[] = [];
  for (const entry of entries) {
    const tier = tiers.find((t) => entry.rank >= t.rankFrom && entry.rank <= t.rankTo);
    if (tier !== undefined) winners.push({ tierId: tier.id, playerId: entry.playerId, rank: entry.rank });
  }

  return { answers: answers.sort((a, b) => byKey(a.id, b.id)), attempts: attemptScores.sort((a, b) => byKey(a.id, b.id)), stats, entries, winners };
}

// ---------------------------------------------------------------------------------------------
// Masking (AC-Q2, AC-A9: masked winners on the banner card, masked names on the leaderboard). The
// database's public.mask_name / public.mask_phone (sql/functions.sql) are the same rules (the
// banner read path masks in SQL, so it never returns a raw name or phone; the oracle test checks
// both on random input). Fixed-length masks, so a mask does not tell the length of what it hides.

/** Each word (split on ASCII whitespace) keeps its first character, then "***"; no word -> "***". */
export function maskName(name: string): string {
  const words = name.split(/[\t\n\v\f\r ]+/).filter((w) => w !== "");
  if (words.length === 0) return "***";
  return words.map((w) => `${Array.from(w)[0] ?? ""}***`).join(" ");
}

/** "****" and the last 3 digits (an anonymized player has no phone: null). */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  return `****${phone.replace(/[^0-9]/g, "").slice(-3)}`;
}
