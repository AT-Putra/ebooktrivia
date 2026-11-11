// Catalog: products, programs (one product + one season), trivia sets, questions, options.
// Question content is locked by trigger once its set has attempts (sql/triggers.sql).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, idr, nonNegative, tstz, updatedAt } from "./columns.ts";
import { uploads } from "./governance.ts";

export const products = pgTable(
  "products",
  {
    id: id(),
    title: text("title").notNull(),
    priceIdr: idr("price_idr").notNull(),
    pdfUploadId: uuid("pdf_upload_id").references(() => uploads.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("products_price_idr_check", sql`${t.priceIdr} > 0`)],
);

export const programStatus = pgEnum("program_status", ["draft", "published", "awaiting_confirmation", "finalized"]);

export const programs = pgTable(
  "programs",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique("programs_slug_key"),
    name: text("name").notNull(),
    status: programStatus("status").notNull().default("draft"),
    salesStartAt: tstz("sales_start_at").notNull(),
    /** Sales close here; the grace period after it is catch-up only. */
    salesEndAt: tstz("sales_end_at").notNull(),
    graceDays: integer("grace_days").notNull(),
    /** Set when the program's fields lock (AC-A3 field lock; reschedule is extend-only). */
    lockedAt: tstz("locked_at"),
    defaultPoints: integer("default_points").notNull().default(10),
    defaultTimerSeconds: integer("default_timer_seconds").notNull().default(20),
    leaderboardTopN: integer("leaderboard_top_n").notNull().default(10),
    clonedFromProgramId: uuid("cloned_from_program_id").references((): AnyPgColumn => programs.id, {
      onDelete: "set null",
    }),
    winnersConfirmedAt: tstz("winners_confirmed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("programs_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("programs_sales_window_check", sql`${t.salesEndAt} > ${t.salesStartAt}`),
    nonNegative("programs_grace_days_check", t.graceDays),
    nonNegative("programs_default_points_check", t.defaultPoints),
    check("programs_default_timer_check", sql`${t.defaultTimerSeconds} > 0`),
    check("programs_leaderboard_top_n_check", sql`${t.leaderboardTopN} > 0`),
  ],
);

export const triviaSets = pgTable(
  "trivia_sets",
  {
    id: id(),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    thumbnailUploadId: uuid("thumbnail_upload_id").references(() => uploads.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("trivia_sets_program_id_position_key").on(t.programId, t.position)],
);

export const questions = pgTable(
  "questions",
  {
    id: id(),
    setId: uuid("set_id")
      .notNull()
      .references(() => triviaSets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    prompt: text("prompt").notNull(),
    imageUploadId: uuid("image_upload_id").references(() => uploads.id, { onDelete: "set null" }),
    points: integer("points").notNull(),
    timerSeconds: integer("timer_seconds").notNull(),
    /** Shown with the correct answer after a wrong pick. */
    explanation: text("explanation"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("questions_set_id_position_key").on(t.setId, t.position),
    nonNegative("questions_points_check", t.points),
    check("questions_timer_seconds_check", sql`${t.timerSeconds} > 0`),
  ],
);

/** 2-4 options per question (position 1..4), at most one correct (partial unique index). */
export const questionOptions = pgTable(
  "question_options",
  {
    id: id(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    label: text("label").notNull(),
    isCorrect: boolean("is_correct").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("question_options_question_id_position_key").on(t.questionId, t.position),
    check("question_options_position_check", sql`${t.position} BETWEEN 1 AND 4`),
    uniqueIndex("question_options_one_correct_idx").on(t.questionId).where(sql`${t.isCorrect}`),
  ],
);
