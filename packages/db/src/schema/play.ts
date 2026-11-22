// Play: attempts (one per player per set), served questions, stats, snapshots, prizes, winners.
//
// public_rw writes set_attempts / attempt_questions / player_program_stats, gated by triggers to
// eligible players on published programs (sql/triggers.sql), but the stored score, points,
// correct and total_ms are still written by the internet-facing app. Finalize and re-score MUST
// recompute from attempt_questions.option_id joined to question_options.is_correct and
// questions.points (and the server timestamps), never trust the stored score.
//
// Answer and finish timestamps are whole milliseconds (CHECK, US-018): scores and the ranking
// tie-break are computed in milliseconds by @ebooktrivia/core and by SQL alike, so a re-score can
// never flip a tie on a sub-millisecond difference. Writers truncate: date_trunc('milliseconds', ...).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { programs, questionOptions, questions, triviaSets } from "./catalog.ts";
import { bytea, createdAt, id, idr, nonNegative, tstz, updatedAt, wholeMilliseconds } from "./columns.ts";
import { uploads } from "./governance.ts";
import { players } from "./player.ts";

export const setAttempts = pgTable(
  "set_attempts",
  {
    id: id(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    setId: uuid("set_id")
      .notNull()
      .references(() => triviaSets.id, { onDelete: "restrict" }),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    score: integer("score").notNull().default(0),
    totalMs: bigint("total_ms", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // AC-Q6: each set can be attempted only once per player.
    unique("set_attempts_player_id_set_id_key").on(t.playerId, t.setId),
    index("set_attempts_set_id_idx").on(t.setId),
    nonNegative("set_attempts_score_check", t.score),
    nonNegative("set_attempts_total_ms_check", t.totalMs),
    wholeMilliseconds("set_attempts_finished_at_ms_check", t.finishedAt),
  ],
);

/** One row per question of an attempt, in the player's shuffled order. */
export const attemptQuestions = pgTable(
  "attempt_questions",
  {
    id: id(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => setAttempts.id, { onDelete: "restrict" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    /** Option ids in the order shown to this player. */
    permutation: uuid("permutation").array().notNull(),
    /** Set once (only if NULL); a refresh never resets the timer. */
    servedAt: tstz("served_at"),
    deadlineAt: tstz("deadline_at"),
    answeredAt: tstz("answered_at"),
    optionId: uuid("option_id").references(() => questionOptions.id, { onDelete: "restrict" }),
    correct: boolean("correct"),
    points: integer("points").notNull().default(0),
    elapsedMs: integer("elapsed_ms"),
    ip: inet("ip"),
    uaHash: bytea("ua_hash"),
    /**
     * What the Owner's deadline-extension tool (US-028, outages) added to deadline_at; written only by
     * public.extend_open_question_deadlines. Scoring keeps charging at most the window the question
     * was served with (deadline_at - served_at - this), see core rescore.ts.
     */
    deadlineExtensionMs: integer("deadline_extension_ms").notNull().default(0),
  },
  (t) => [
    unique("attempt_questions_attempt_id_question_id_key").on(t.attemptId, t.questionId),
    unique("attempt_questions_attempt_id_position_key").on(t.attemptId, t.position),
    check("attempt_questions_deadline_check", sql`${t.deadlineAt} IS NULL OR ${t.deadlineAt} >= ${t.servedAt}`),
    // At most 7 days in total, and always inside the deadline it extended.
    check(
      "attempt_questions_deadline_extension_check",
      sql`${t.deadlineExtensionMs} BETWEEN 0 AND 604800000 AND (${t.deadlineExtensionMs} = 0 OR ${t.deadlineAt} - ${t.servedAt} >= ${t.deadlineExtensionMs} * interval '1 millisecond')`,
    ),
    nonNegative("attempt_questions_points_check", t.points),
    check("attempt_questions_elapsed_ms_check", sql`${t.elapsedMs} IS NULL OR ${t.elapsedMs} >= 0`),
    wholeMilliseconds("attempt_questions_served_at_ms_check", t.servedAt),
    wholeMilliseconds("attempt_questions_deadline_at_ms_check", t.deadlineAt),
    wholeMilliseconds("attempt_questions_answered_at_ms_check", t.answeredAt),
  ],
);

/**
 * The Owner's deadline extensions (US-028, outages): one row per extended answer, so an answer is
 * extended at most once (primary key). Written only by public.extend_open_question_deadlines, which
 * puts extension_id (one per use of the tool) into its audit row; append-only (sql/triggers.sql).
 */
export const deadlineExtensions = pgTable(
  "deadline_extensions",
  {
    attemptQuestionId: uuid("attempt_question_id")
      .primaryKey()
      .references(() => attemptQuestions.id, { onDelete: "restrict" }),
    extensionId: uuid("extension_id").notNull(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    /** The deadline the outage cut short. */
    originalDeadlineAt: tstz("original_deadline_at").notNull(),
    /** The time the answer lost to the outage, given back from the moment of the extension. */
    grantedMs: integer("granted_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("deadline_extensions_extension_id_idx").on(t.extensionId),
    check("deadline_extensions_granted_ms_check", sql`${t.grantedMs} > 0`),
    wholeMilliseconds("deadline_extensions_original_deadline_at_ms_check", t.originalDeadlineAt),
  ],
);

/**
 * The reveals of each answer (US-031, the US-027 accepted residual: a stolen public_rw login can act as a real
 * player and reveal its answers). Written only by public.play_reveal (owner trivia_play): `reveals` counts the reveals
 * it answered (the app reveals a pick right after it, again only on its own retry), `late_reveals` the ones it REFUSED
 * because they came more than 60 s after the answer (no answer content is ever revealed late), and `flagged_at` the
 * first refusal: play_reveal raises `play_reveal_misuse` when several distinct attempts are flagged within an hour.
 * Ids, counts and times only, no personal data; the app cannot read or write it. A rolled-back call leaves no row here,
 * but its RAISE LOG line stays in the server log (docs/runbooks/security-scans.md).
 */
export const answerReveals = pgTable(
  "answer_reveals",
  {
    answerId: uuid("answer_id")
      .primaryKey()
      .references(() => attemptQuestions.id, { onDelete: "cascade" }),
    reveals: integer("reveals").notNull().default(0),
    lateReveals: integer("late_reveals").notNull().default(0),
    firstRevealedAt: tstz("first_revealed_at").notNull(),
    lastRevealedAt: tstz("last_revealed_at").notNull(),
    flaggedAt: tstz("flagged_at"),
  },
  (t) => [
    index("answer_reveals_flagged_at_idx").on(t.flaggedAt).where(sql`${t.flaggedAt} IS NOT NULL`),
    check("answer_reveals_counts_check", sql`${t.reveals} >= 0 AND ${t.lateReveals} >= 0 AND ${t.reveals} + ${t.lateReveals} >= 1`),
    check("answer_reveals_flagged_check", sql`(${t.flaggedAt} IS NULL) = (${t.lateReveals} = 0)`),
  ],
);

/** Per player per program aggregate; ranking: score desc, total_ms asc, finished_at asc nulls last. */
export const playerProgramStats = pgTable(
  "player_program_stats",
  {
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    score: integer("score").notNull().default(0),
    totalMs: bigint("total_ms", { mode: "number" }).notNull().default(0),
    setsCompleted: integer("sets_completed").notNull().default(0),
    finishedAt: tstz("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "player_program_stats_pkey", columns: [t.playerId, t.programId] }),
    nonNegative("player_program_stats_score_check", t.score),
    nonNegative("player_program_stats_total_ms_check", t.totalMs),
    nonNegative("player_program_stats_sets_completed_check", t.setsCompleted),
    wholeMilliseconds("player_program_stats_finished_at_ms_check", t.finishedAt),
    index("player_program_stats_ranking_idx").on(
      t.programId,
      t.score.desc(),
      t.totalMs.asc(),
      t.finishedAt.asc().nullsLast(),
    ),
  ],
);

/** Leaderboard frozen at the end of grace: entries = [{rank, player_id, score, total_ms, finished_at}]. */
export const leaderboardSnapshots = pgTable(
  "leaderboard_snapshots",
  {
    id: id(),
    programId: uuid("program_id")
      .notNull()
      .unique("leaderboard_snapshots_program_id_key")
      .references(() => programs.id, { onDelete: "restrict" }),
    frozenAt: tstz("frozen_at").notNull(),
    entries: jsonb("entries").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("leaderboard_snapshots_entries_check", sql`jsonb_typeof(${t.entries}) = 'array'`)],
);

export const prizeTiers = pgTable(
  "prize_tiers",
  {
    id: id(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    rankFrom: integer("rank_from").notNull(),
    rankTo: integer("rank_to").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    imageUploadId: uuid("image_upload_id").references(() => uploads.id, { onDelete: "set null" }),
    valueIdr: idr("value_idr").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("prize_tiers_rank_check", sql`${t.rankFrom} >= 1 AND ${t.rankTo} >= ${t.rankFrom}`),
    nonNegative("prize_tiers_value_idr_check", t.valueIdr),
  ],
);

export const winnerStatus = pgEnum("winner_status", ["awaiting_confirmation", "confirmed", "flagged", "revoked"]);

export const winners = pgTable(
  "winners",
  {
    id: id(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "restrict" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => leaderboardSnapshots.id, { onDelete: "restrict" }),
    prizeTierId: uuid("prize_tier_id")
      .notNull()
      .references(() => prizeTiers.id, { onDelete: "restrict" }),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "restrict" }),
    rank: integer("rank").notNull(),
    status: winnerStatus("status").notNull().default("awaiting_confirmation"),
    confirmedAt: tstz("confirmed_at"),
    flaggedAt: tstz("flagged_at"),
    flagReason: text("flag_reason"),
    /**
     * US-030: the revoked winner whose prize this row re-awards (the Owner's revoke and re-award, sql/contest.sql
     * revoke_winner): the next eligible player of the snapshot, holding the revoked winner's prize tier at their own
     * snapshot rank. UNIQUE: a revoked winner is re-awarded at most once. Never changes (winners_status_guard).
     */
    replacesWinnerId: uuid("replaces_winner_id")
      .unique("winners_replaces_winner_id_key")
      .references((): AnyPgColumn => winners.id, { onDelete: "restrict" }),
    /**
     * US-030: the Owner's written reason for the last revoke or reinstatement. Kept here, not in the append-only audit log (which only
     * records that it was given), because free text may name the winner: the erasure of the winner's data blanks it.
     */
    decisionReason: text("decision_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("winners_snapshot_id_player_id_key").on(t.snapshotId, t.playerId),
    check("winners_rank_check", sql`${t.rank} >= 1`),
    check("winners_decision_reason_check", sql`${t.decisionReason} IS NULL OR char_length(${t.decisionReason}) BETWEEN 10 AND 500`),
  ],
);

export const fulfillmentStatus = pgEnum("fulfillment_status", ["pending", "contacted", "sent", "done"]);

/**
 * Prize fulfilment of a confirmed winner (US-030, AC-A9): pending -> contacted -> sent -> done, one step at a time,
 * written only by the SECURITY DEFINER functions of sql/fulfillment.sql (owner prize_fulfillment; the row itself is
 * created by sql/contest.sql at the confirmation, re-award or reinstatement). Each step stamps who and when; a
 * correction one step back clears the stamps of the step it undoes (the audit log keeps the history); done is final.
 * `notes` are the Owner's plain text (they may name the winner: the audit log only references them).
 */
export const fulfillments = pgTable(
  "fulfillments",
  {
    id: id(),
    winnerId: uuid("winner_id")
      .notNull()
      .unique("fulfillments_winner_id_key")
      .references(() => winners.id, { onDelete: "restrict" }),
    status: fulfillmentStatus("status").notNull().default("pending"),
    notes: text("notes"),
    proofUploadId: uuid("proof_upload_id")
      .unique("fulfillments_proof_upload_id_key")
      .references(() => uploads.id, { onDelete: "restrict" }),
    contactedAt: tstz("contacted_at"),
    contactedByAdminUserId: text("contacted_by_admin_user_id"),
    sentAt: tstz("sent_at"),
    sentByAdminUserId: text("sent_by_admin_user_id"),
    doneAt: tstz("done_at"),
    doneByAdminUserId: text("done_by_admin_user_id"),
    /** US-030: the written reason of the last correction one step back (the audit log records only that one was given; see winners.decision_reason). */
    correctionReason: text("correction_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("fulfillments_notes_check", sql`${t.notes} IS NULL OR char_length(${t.notes}) BETWEEN 1 AND 2000`),
    check("fulfillments_correction_reason_check", sql`${t.correctionReason} IS NULL OR char_length(${t.correctionReason}) BETWEEN 10 AND 500`),
    // Each step's stamps are there exactly when the status has reached it.
    check(
      "fulfillments_steps_check",
      sql`(${t.status} IN ('contacted', 'sent', 'done')) = (${t.contactedAt} IS NOT NULL) AND (${t.contactedAt} IS NULL) = (${t.contactedByAdminUserId} IS NULL)
          AND (${t.status} IN ('sent', 'done')) = (${t.sentAt} IS NOT NULL) AND (${t.sentAt} IS NULL) = (${t.sentByAdminUserId} IS NULL)
          AND (${t.status} = 'done') = (${t.doneAt} IS NOT NULL) AND (${t.doneAt} IS NULL) = (${t.doneByAdminUserId} IS NULL)`,
    ),
  ],
);
