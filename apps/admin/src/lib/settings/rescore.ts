// The Owner's scoring override (plan M5b, §10 item 21; US-018): changes points, timer or the
// correct option of a question in a set that already has attempts, and re-scores every affected
// player in the SAME transaction. Owner only (rescore.override); everything else about a locked
// set's scoring is refused by the database (ET020).
//
// The database function public.override_question_scoring (packages/db sql/override.sql) does the
// work: it derives every score it writes from the answer rows (with the rules of @ebooktrivia/core
// rescore.ts, its oracle in test/rescore-oracle.int.test.ts), takes no scores from the caller, and
// writes its own audit row (the reason, the field changes, the totals before / after over the
// affected players; no player id, name or contact). This module, in one transaction:
//   1. bounds the transaction (statement_timeout 15 s, lock_timeout 5 s) and takes the program's
//      exclusive contest lock and its sets FOR UPDATE, as the function does again, so the checks
//      below see what the function will see and no attempt starts meanwhile;
//   2. refuses first with a message for the form (the function refuses the same, ET022 / ET023):
//      the results snapshot exists, the contest ended or grace is over; the question is not in
//      the set; the set has no attempts; more than OVERRIDE_MAX_ANSWERS answer rows to sum over;
//   3. calls the function with the actor, request id and IP of the mutation scope.
// A lock wait or statement that runs out of time, and any serialisation or deadlock error, becomes
// a "try again" message, never a bare 500.
import { currentMutationScope, NoMutationScopeError } from "../audit.ts";
import type { Sql } from "../db.ts";
import { InvalidInput, multiLine, sqlState } from "./fields.ts";
import { BUSY } from "./trivia.ts";

export const OVERRIDE_BLOCKED = "This program's results snapshot exists (its contest has ended): scores are final and can no longer be overridden.";
export const GRACE_OVER = "This program's grace period is over: scores are final and can no longer be overridden.";
/** Answer rows the re-score may sum over in one request (code review US-018 F2). */
export const OVERRIDE_MAX_ANSWERS = 200_000;

const MESSAGES: Readonly<Record<string, string>> = {
  ET022: OVERRIDE_BLOCKED,
  ET023: "This question no longer matches its set or program. Reload the page.",
  "40001": "Someone changed this program at the same moment. Try again.",
  "40P01": "Someone changed this program at the same moment. Try again.",
  "55P03": BUSY,
  "57014": BUSY,
};

export interface OverrideInput {
  readonly programId: string;
  readonly setId: string;
  readonly questionId: string;
  readonly points: number;
  readonly timerSeconds: number;
  /** Position (1-4) of the new correct option. */
  readonly correct: number;
  readonly reason: string;
}

export interface OverrideSummary {
  readonly players: number;
  readonly answersChanged: number;
  readonly scoreBefore: number;
  readonly scoreAfter: number;
}

/**
 * 10-500 characters. The audit log holds no PII, so text that looks like an e-mail address or a phone
 * number (an Indonesian mobile number, or any run of 10+ digits) is refused (the database refuses the
 * same); names cannot be detected, the form asks for none.
 */
export function parseReason(raw: string): string {
  const reason = multiLine(raw.trim(), "Give the reason for the override (10 to 500 characters).", { min: 10, max: 500 });
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(reason) || /(?:\+?62[\s.-]?|\b0)8[\d\s.-]{7,}|\d{10,}/.test(reason)) {
    throw new InvalidInput("Describe the reason without personal data (no e-mail addresses or phone numbers).");
  }
  return reason;
}

export async function overrideQuestion(sql: Sql, input: OverrideInput, limits: { readonly maxAnswers: number } = { maxAnswers: OVERRIDE_MAX_ANSWERS }): Promise<OverrideSummary> {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  if (scope.actor.kind !== "admin") throw new Error("the scoring override is an admin action");
  const actorId = scope.actor.userId;
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '15s'");
      await tx.unsafe("SET LOCAL lock_timeout = '5s'");
      await tx`SELECT public.lock_program_contest(${input.programId})`;
      await tx`SELECT 1 FROM public.trivia_sets WHERE program_id = ${input.programId} ORDER BY id FOR UPDATE`;
      const [program] = await tx<{ status: string; snapshot: boolean; graceOver: boolean }[]>`
        SELECT p.status::text AS status, EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p.id) AS snapshot,
               clock_timestamp() >= p.sales_end_at + make_interval(days => p.grace_days) AS "graceOver"
          FROM public.programs p WHERE p.id = ${input.programId}`;
      if (program === undefined) throw new InvalidInput("This program no longer exists.");
      if (program.snapshot || (program.status !== "draft" && program.status !== "published")) throw new InvalidInput(OVERRIDE_BLOCKED);
      if (program.graceOver) throw new InvalidInput(GRACE_OVER);
      const [question] = await tx`
        SELECT 1 FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id
         WHERE q.id = ${input.questionId} AND q.set_id = ${input.setId} AND s.program_id = ${input.programId}`;
      if (question === undefined) throw new InvalidInput("This question no longer exists.");
      const [option] = await tx<{ id: string }[]>`SELECT id FROM public.question_options WHERE question_id = ${input.questionId} AND position = ${input.correct}`;
      if (option === undefined) throw new InvalidInput("Choose the correct answer among the question's options.");
      const [counts] = await tx<{ attempts: number; answers: number }[]>`
        SELECT (SELECT count(*)::int FROM public.set_attempts WHERE set_id = ${input.setId}) AS attempts,
               (SELECT count(*)::int FROM public.attempt_questions aq
                  JOIN public.set_attempts a ON a.id = aq.attempt_id JOIN public.trivia_sets s ON s.id = a.set_id
                 WHERE s.program_id = ${input.programId}
                   AND a.player_id IN (SELECT x.player_id FROM public.set_attempts x WHERE x.set_id = ${input.setId})) AS answers`;
      if ((counts?.attempts ?? 0) === 0) throw new InvalidInput("This set has no attempts yet: edit the question directly.");
      if ((counts?.answers ?? 0) > limits.maxAnswers) {
        throw new InvalidInput(`This re-score would sum over more than ${limits.maxAnswers.toLocaleString("en-US")} answers, too many for one request. Ask the developers to run it as a job.`);
      }
      const [row] = await tx<{ summary: Record<string, unknown> }[]>`
        SELECT public.override_question_scoring(${input.programId}, ${input.setId}, ${input.questionId}, ${input.points}, ${input.timerSeconds}, ${option.id},
                                                ${input.reason}, ${actorId}, ${scope.requestId}, ${scope.ip}::inet) AS summary`;
      const summary = row?.summary ?? {};
      return {
        players: Number(summary["players"] ?? 0),
        answersChanged: Number(summary["answers_changed"] ?? 0),
        scoreBefore: Number(summary["score_before"] ?? 0),
        scoreAfter: Number(summary["score_after"] ?? 0),
      };
    });
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    const message = MESSAGES[sqlState(error) ?? ""];
    if (message !== undefined) throw new InvalidInput(message);
    throw error;
  }
}
