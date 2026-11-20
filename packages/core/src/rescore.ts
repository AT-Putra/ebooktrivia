// Scoring of trivia answers and the re-score of a program's play rows (US-018, plan M5b and §10
// item 21; spec AC-Q10). Pure. These rules are THE definition of a score. The same per-answer rule
// exists once in SQL, public.score_answer (packages/db sql/functions.sql); the database's Owner
// override (sql/override.sql, override_question_scoring) applies it to every answer of the
// affected players and derives their attempts and stats as rescorePlayers does.
// apps/admin test/rescore-oracle.int.test.ts proves score_answer equals scoreAnswer on random
// inputs and the override's result equals rescorePlayers row for row. M9 is the first production
// caller of these rules: its answer path and grace-end finalize must use score_answer (or this
// module), so a re-score of rows nobody changed changes nothing.
//
// Per answer row (attempt_questions), in whole milliseconds (the database CHECKs them, so this and
// the SQL agree to the millisecond), with raw = answered_at - served_at (0 if negative), timer = the
// question's CURRENT timer, shown = deadline_at - served_at when a deadline was shown, and
// cap = min(timer, shown):
//   pending   answered_at NULL: not scored yet (correct NULL, 0 points, elapsed NULL).
//   unserved  answered_at set but served_at NULL (finalized without ever being shown): a timeout
//             with the full CURRENT timer (correct false, 0 points, elapsed = timer). The one
//             asymmetry: no deadline was shown, so a changed timer changes this elapsed.
//   timeout   finalized without a pick (option_id NULL): correct false, 0 points, elapsed = min(raw, cap).
//   late      a pick with raw > cap + ANSWER_LATENCY_GRACE_MS (1500 ms, plan §10 item 5): scored as
//             a timeout (correct false, 0 points, elapsed = min(raw, cap)). SHORTENING a timer makes
//             an answer given after the new deadline late: under the new rule it could not have
//             been accepted. LENGTHENING a timer changes nothing for a SERVED row (one shown a
//             deadline): the cap stays at that deadline, so no late pick is rewarded and no served
//             timeout gains time. An unserved row counts the current timer, so it does gain time.
//             The pick itself stays stored (option_id is never rewritten), so restoring the timer
//             restores the answer.
//   answered  correct = the pick is the question's correct option; points = correct ? question
//             points : 0; elapsed = min(raw, cap) (an answer inside the latency grace counts the
//             full cap, never more).
// Per attempt (set_attempts): score = sum of points, total_ms = sum of elapsed, finished_at = the
// last answered_at once every question of the set has a finalized answer, else NULL.
// Per player and program (player_program_stats): score and total_ms = sums over the player's
// attempts in the program, sets_completed = finished attempts, finished_at = the last attempt
// finish once every set of the program is finished, else NULL (ranked NULLS LAST, ranking.ts).
// Only before the grace-end finalize: it does not model the timeouts finalize adds for unlocked
// sets never started (plan §10 item 19); the override is refused once the snapshot exists.
//
// Deterministic (outputs sorted by id, input order irrelevant) and idempotent: it reads only the
// raw facts (pick, timestamps) and the questions' rules, never a stored score, so re-scoring its
// own output changes nothing.

export const ANSWER_LATENCY_GRACE_MS = 1500;

/** What a question scores with (its current values, or the values an override sets). */
export interface ScoringRule {
  readonly points: number;
  readonly timerSeconds: number;
  /** The one correct option, or null (then every pick is wrong). */
  readonly correctOptionId: string | null;
}

/** The raw facts of one answer row. */
export interface AnswerFacts {
  readonly optionId: string | null;
  readonly servedAt: Date | null;
  /** The deadline the player was shown (attempt_questions.deadline_at); null = served_at + timer. */
  readonly deadlineAt: Date | null;
  readonly answeredAt: Date | null;
}

export interface AnswerScore {
  /** null while the answer is pending. */
  readonly correct: boolean | null;
  readonly points: number;
  /** null while the answer is pending. */
  readonly elapsedMs: number | null;
}

export interface AttemptScore {
  readonly score: number;
  readonly totalMs: number;
  readonly finishedAt: Date | null;
}

export interface PlayerStats {
  readonly playerId: string;
  readonly score: number;
  readonly totalMs: number;
  readonly setsCompleted: number;
  readonly finishedAt: Date | null;
}

export interface RescoreQuestion extends ScoringRule {
  readonly id: string;
  readonly setId: string;
}

export interface RescoreAnswer extends AnswerFacts {
  readonly id: string;
  readonly attemptId: string;
  readonly questionId: string;
  /** What is stored now (only compared, never trusted). */
  readonly stored: AnswerScore;
}

export interface RescoreAttempt {
  readonly id: string;
  readonly playerId: string;
  readonly setId: string;
  readonly stored: AttemptScore;
}

export interface RescoreInput {
  /** Every set of the program (S, the sets a player must finish for finished_at). */
  readonly setIds: readonly string[];
  /** Every question of those sets, with the rules to score by (an override already applied). */
  readonly questions: readonly RescoreQuestion[];
  /** Every attempt in the program of the players to re-score. */
  readonly attempts: readonly RescoreAttempt[];
  /** Every answer row of those attempts. */
  readonly answers: readonly RescoreAnswer[];
  /** The stored stats of those players; a player without a row has none yet. */
  readonly stats: readonly PlayerStats[];
}

export interface RescoreTotals {
  readonly score: number;
  readonly totalMs: number;
  readonly setsCompleted: number;
  /** Players with finished_at set (finished every set). */
  readonly finished: number;
}

export interface RescoreResult {
  /** Players re-scored (those with an attempt in the input). */
  readonly players: number;
  /** Answer rows scored (pending ones included). */
  readonly answersScored: number;
  /** Only the rows whose stored values differ from the re-score, sorted by id. */
  readonly answers: readonly ({ readonly id: string } & AnswerScore)[];
  readonly attempts: readonly ({ readonly id: string } & AttemptScore)[];
  /** Changed or missing stats rows, sorted by player id. */
  readonly stats: readonly PlayerStats[];
  /** Sums over the re-scored players: stored before, re-scored after. */
  readonly before: RescoreTotals;
  readonly after: RescoreTotals;
}

const assertCount = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

const assertDate = (value: Date | null, name: string): void => {
  if (value !== null && (!(value instanceof Date) || Number.isNaN(value.getTime()))) throw new RangeError(`${name} must be a valid Date or null`);
};

function assertRule(rule: ScoringRule): void {
  assertCount(rule.points, "points");
  if (!Number.isSafeInteger(rule.timerSeconds) || rule.timerSeconds < 1) throw new RangeError("timerSeconds must be a positive safe integer");
}

/** Scores one answer row under `rule` (see the rules at the top of this file). */
export function scoreAnswer(rule: ScoringRule, facts: AnswerFacts): AnswerScore {
  assertRule(rule);
  assertDate(facts.servedAt, "servedAt");
  assertDate(facts.answeredAt, "answeredAt");
  assertDate(facts.deadlineAt, "deadlineAt");
  if (facts.answeredAt === null) return { correct: null, points: 0, elapsedMs: null };
  const timerMs = rule.timerSeconds * 1000;
  if (facts.servedAt === null) return { correct: false, points: 0, elapsedMs: timerMs };
  const raw = Math.max(0, facts.answeredAt.getTime() - facts.servedAt.getTime());
  const cap = facts.deadlineAt === null ? timerMs : Math.min(timerMs, facts.deadlineAt.getTime() - facts.servedAt.getTime());
  const elapsedMs = Math.min(raw, cap);
  if (facts.optionId === null || raw > cap + ANSWER_LATENCY_GRACE_MS) return { correct: false, points: 0, elapsedMs };
  const correct = facts.optionId === rule.correctOptionId;
  return { correct, points: correct ? rule.points : 0, elapsedMs };
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sameTime = (a: Date | null, b: Date | null): boolean => (a === null || b === null ? a === b : a.getTime() === b.getTime());
const later = (a: Date | null, b: Date): Date => (a === null || b.getTime() > a.getTime() ? b : a);

function indexUnique<T>(items: readonly T[], key: (item: T) => string, what: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) throw new RangeError(`duplicate ${what} ${k}`);
    map.set(k, item);
  }
  return map;
}

function totals(stats: Iterable<PlayerStats>): RescoreTotals {
  let score = 0;
  let totalMs = 0;
  let setsCompleted = 0;
  let finished = 0;
  for (const s of stats) {
    score += s.score;
    totalMs += s.totalMs;
    setsCompleted += s.setsCompleted;
    if (s.finishedAt !== null) finished++;
  }
  return { score, totalMs, setsCompleted, finished };
}

/** Re-scores every answer, attempt and per-program stats row of the players in `input`. */
export function rescorePlayers(input: RescoreInput): RescoreResult {
  const sets = new Set(input.setIds);
  if (sets.size !== input.setIds.length) throw new RangeError("duplicate set id");
  const questions = indexUnique(input.questions, (q) => q.id, "question");
  const questionsPerSet = new Map<string, number>();
  for (const q of questions.values()) {
    if (!sets.has(q.setId)) throw new RangeError(`question ${q.id} is not in one of the program's sets`);
    assertRule(q);
    questionsPerSet.set(q.setId, (questionsPerSet.get(q.setId) ?? 0) + 1);
  }
  const attempts = indexUnique(input.attempts, (a) => a.id, "attempt");
  const players = new Set<string>();
  const attemptKeys = new Set<string>();
  for (const a of attempts.values()) {
    if (!sets.has(a.setId)) throw new RangeError(`attempt ${a.id} is not on one of the program's sets`);
    const key = `${a.playerId}\u0000${a.setId}`;
    if (attemptKeys.has(key)) throw new RangeError(`player ${a.playerId} has two attempts on set ${a.setId}`);
    attemptKeys.add(key);
    players.add(a.playerId);
  }
  const storedStats = indexUnique(input.stats, (s) => s.playerId, "stats row of player");
  for (const playerId of storedStats.keys()) {
    if (!players.has(playerId)) throw new RangeError(`stats of player ${playerId} without an attempt`);
  }

  const answerChanges: ({ readonly id: string } & AnswerScore)[] = [];
  const perAttempt = new Map<string, { score: number; totalMs: number; finalized: number; lastAnswer: Date | null }>();
  const seenAnswers = new Set<string>();
  const seenAnswerQuestions = new Set<string>();
  for (const answer of input.answers) {
    if (seenAnswers.has(answer.id)) throw new RangeError(`duplicate answer ${answer.id}`);
    seenAnswers.add(answer.id);
    const attempt = attempts.get(answer.attemptId);
    if (attempt === undefined) throw new RangeError(`answer ${answer.id} of an unknown attempt`);
    const question = questions.get(answer.questionId);
    if (question?.setId !== attempt.setId) throw new RangeError(`answer ${answer.id} is not for a question of its attempt's set`);
    const pair = `${answer.attemptId}\u0000${answer.questionId}`;
    if (seenAnswerQuestions.has(pair)) throw new RangeError(`attempt ${answer.attemptId} answers question ${answer.questionId} twice`);
    seenAnswerQuestions.add(pair);
    const scored = scoreAnswer(question, answer);
    if (scored.correct !== answer.stored.correct || scored.points !== answer.stored.points || scored.elapsedMs !== answer.stored.elapsedMs) {
      answerChanges.push({ id: answer.id, ...scored });
    }
    const sum = perAttempt.get(attempt.id) ?? { score: 0, totalMs: 0, finalized: 0, lastAnswer: null };
    sum.score += scored.points;
    sum.totalMs += scored.elapsedMs ?? 0;
    if (answer.answeredAt !== null) {
      sum.finalized++;
      sum.lastAnswer = later(sum.lastAnswer, answer.answeredAt);
    }
    perAttempt.set(attempt.id, sum);
  }

  const attemptChanges: ({ readonly id: string } & AttemptScore)[] = [];
  const perPlayer = new Map<string, { score: number; totalMs: number; setsCompleted: number; lastFinish: Date | null }>();
  for (const playerId of players) perPlayer.set(playerId, { score: 0, totalMs: 0, setsCompleted: 0, lastFinish: null });
  for (const attempt of attempts.values()) {
    const sum = perAttempt.get(attempt.id) ?? { score: 0, totalMs: 0, finalized: 0, lastAnswer: null };
    const questionCount = questionsPerSet.get(attempt.setId) ?? 0;
    const finishedAt = questionCount > 0 && sum.finalized === questionCount ? sum.lastAnswer : null;
    if (sum.score !== attempt.stored.score || sum.totalMs !== attempt.stored.totalMs || !sameTime(finishedAt, attempt.stored.finishedAt)) {
      attemptChanges.push({ id: attempt.id, score: sum.score, totalMs: sum.totalMs, finishedAt });
    }
    const player = perPlayer.get(attempt.playerId);
    if (player === undefined) continue; // unreachable: every attempt's player is in `players`
    player.score += sum.score;
    player.totalMs += sum.totalMs;
    if (finishedAt !== null) {
      player.setsCompleted++;
      player.lastFinish = later(player.lastFinish, finishedAt);
    }
  }

  const after: PlayerStats[] = [];
  const statsChanges: PlayerStats[] = [];
  for (const [playerId, p] of perPlayer) {
    const row: PlayerStats = {
      playerId,
      score: p.score,
      totalMs: p.totalMs,
      setsCompleted: p.setsCompleted,
      finishedAt: sets.size > 0 && p.setsCompleted === sets.size ? p.lastFinish : null,
    };
    after.push(row);
    const stored = storedStats.get(playerId);
    if (
      stored?.score !== row.score ||
      stored.totalMs !== row.totalMs ||
      stored.setsCompleted !== row.setsCompleted ||
      !sameTime(stored.finishedAt, row.finishedAt)
    ) {
      statsChanges.push(row);
    }
  }

  return {
    players: players.size,
    answersScored: input.answers.length,
    answers: answerChanges.sort(byId),
    attempts: attemptChanges.sort(byId),
    stats: statsChanges.sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0)),
    before: totals(storedStats.values()),
    after: totals(after),
  };
}
