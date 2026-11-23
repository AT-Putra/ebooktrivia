// Programs (AC-A3 "programs (dates, grace, clone)", plan §10 item 10; US-017). Owner only
// (program.edit / program.reschedule, owner decision 2026-11-18).
//
// Dates are entered as WIB calendar days: sales open at 00:00 WIB of the first day and close at
// 00:00 WIB after the last sales day (stored as sales_end_at = last day + 1 at 00:00 WIB, the
// US-010 carry-over; core unlock.ts reads D_end from it). Grace days follow the last sales day.
//
// Field lock: after the first PAID order (programs.locked_at, stamped by sql/triggers.sql
// orders_lock_program) product, slug and sales start never change, and the only date change is
// Reschedule, which may only extend the last sales day and the grace days. This module refuses
// first with a message for the form; the database refuses the same for every writer (ET047 /
// ET048), so a race or another client cannot get round it. Every change is audited with before /
// after values (none of these fields is PII).
import type { AuditChange, FieldKind, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { calendarDate, formValue, InvalidInput, singleLine, slug, uuid, wholeNumber } from "./fields.ts";
import { insertImageRow, linkImage, type StoredImage } from "./image-link.ts";
import { PRIZE_RANKS_SQL } from "./prizes.ts";

const DAY_MS = 86_400_000;
const WIB_OFFSET_MS = 7 * 3_600_000;

export const PROGRAM_FIELDS: Readonly<Record<string, FieldKind>> = {
  product_id: "value",
  slug: "value",
  name: "value",
  status: "value",
  sales_start_at: "value",
  sales_end_at: "value",
  grace_days: "value",
  default_points: "value",
  default_timer_seconds: "value",
  leaderboard_top_n: "value",
  banner_upload_id: "value",
};

export const LOCKED_MESSAGE =
  "This program has a paid order, so its product, slug and sales start are locked and its dates can only be extended (use Reschedule).";
const EXTEND_ONLY_MESSAGE = "Reschedule can only move the last sales day and the end of grace later.";
const ENDED_MESSAGE = "This program's contest has ended (the results snapshot exists), so its dates can no longer change.";
const SLUG_TAKEN = "Another program already uses this slug.";

/** 00:00 WIB of a calendar day. */
export const wibMidnight = (day: { readonly y: number; readonly m: number; readonly d: number }): Date => new Date(Date.UTC(day.y, day.m - 1, day.d) - WIB_OFFSET_MS);

/** The WIB calendar day of an instant, "YYYY-MM-DD". */
export const wibDay = (at: Date): string => new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);

/** The last sales day ("YYYY-MM-DD", WIB) of a sales_end_at stored as the next day's 00:00 WIB. */
export const lastSalesDay = (salesEndAt: Date): string => wibDay(new Date(salesEndAt.getTime() - 1));

/** The last day of grace (WIB), D_end of the unlock schedule. */
export const graceEndDay = (salesEndAt: Date, graceDays: number): string => wibDay(new Date(salesEndAt.getTime() - 1 + graceDays * DAY_MS));

export interface ProgramFields {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly salesStartAt: Date;
  readonly salesEndAt: Date;
  readonly graceDays: number;
  readonly defaultPoints: number;
  readonly defaultTimerSeconds: number;
  readonly leaderboardTopN: number;
}

/** The sales window of a first and a last sales day (WIB). */
export function salesWindow(firstDay: string, lastDay: string): { readonly salesStartAt: Date; readonly salesEndAt: Date } {
  const start = calendarDate(firstDay, "Enter the first sales day.");
  const last = calendarDate(lastDay, "Enter the last sales day.");
  const salesStartAt = wibMidnight(start);
  const salesEndAt = new Date(wibMidnight(last).getTime() + DAY_MS);
  if (salesEndAt <= salesStartAt) throw new InvalidInput("The last sales day cannot be before the first sales day.");
  return { salesStartAt, salesEndAt };
}

export const graceDays = (raw: string): number => wholeNumber(raw, "Grace is 0 to 365 days.", { min: 0, max: 365 });

/** Parses the program form (create and edit). */
export function parseProgramForm(form: FormData): ProgramFields {
  return {
    productId: uuid(formValue(form, "productId"), "Choose the ebook (product)."),
    slug: slug(formValue(form, "slug"), "The slug is lowercase letters, digits and single hyphens (up to 64), e.g. musim-1."),
    name: singleLine(formValue(form, "name"), "Enter a name (up to 120 characters).", { max: 120 }),
    ...salesWindow(formValue(form, "firstDay"), formValue(form, "lastDay")),
    graceDays: graceDays(formValue(form, "graceDays")),
    defaultPoints: wholeNumber(formValue(form, "defaultPoints"), "Default points are 0 to 1000.", { min: 0, max: 1000 }),
    defaultTimerSeconds: wholeNumber(formValue(form, "defaultTimerSeconds"), "The default timer is 5 to 600 seconds.", { min: 5, max: 600 }),
    leaderboardTopN: wholeNumber(formValue(form, "leaderboardTopN"), "The leaderboard shows 1 to 100 players.", { min: 1, max: 100 }),
  };
}

interface ProgramRow {
  readonly id: string;
  readonly product_id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly sales_start_at: Date;
  readonly sales_end_at: Date;
  readonly grace_days: number;
  readonly default_points: number;
  readonly default_timer_seconds: number;
  readonly leaderboard_top_n: number;
  readonly banner_upload_id: string | null;
  readonly locked: boolean;
}

const auditValues = (r: Omit<ProgramRow, "id" | "locked">) => ({
  product_id: r.product_id,
  slug: r.slug,
  name: r.name,
  status: r.status,
  sales_start_at: r.sales_start_at,
  sales_end_at: r.sales_end_at,
  grace_days: r.grace_days,
  default_points: r.default_points,
  default_timer_seconds: r.default_timer_seconds,
  leaderboard_top_n: r.leaderboard_top_n,
});

const rowValues = (p: ProgramFields, status: string) => ({
  product_id: p.productId,
  slug: p.slug,
  name: p.name,
  status,
  sales_start_at: p.salesStartAt,
  sales_end_at: p.salesEndAt,
  grace_days: p.graceDays,
  default_points: p.defaultPoints,
  default_timer_seconds: p.defaultTimerSeconds,
  leaderboard_top_n: p.leaderboardTopN,
});

const MESSAGES: Readonly<Record<string, string>> = {
  ET047: LOCKED_MESSAGE,
  ET048: LOCKED_MESSAGE,
  "23505": SLUG_TAKEN,
  "23503": "The chosen ebook does not exist.",
};

const audited = <T>(sql: Sql, mutate: (tx: Tx, audit: (change: AuditChange) => void) => Promise<T>): Promise<T> => auditedChange(sql, mutate, MESSAGES);

async function lockRow(tx: Tx, id: string): Promise<ProgramRow> {
  const [row] = await tx<ProgramRow[]>`
    SELECT p.id, p.product_id, p.slug, p.name, p.status::text AS status, p.sales_start_at, p.sales_end_at, p.grace_days,
           p.default_points, p.default_timer_seconds, p.leaderboard_top_n, p.banner_upload_id,
           (p.locked_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.orders o WHERE o.program_id = p.id AND o.paid_at IS NOT NULL)) AS locked
      FROM public.programs p WHERE p.id = ${id} FOR UPDATE`;
  if (row === undefined) throw new InvalidInput("This program no longer exists.");
  return row;
}

export async function createProgram(sql: Sql, input: ProgramFields): Promise<string> {
  return audited(sql, async (tx, audit) => {
    const values = rowValues(input, "draft");
    const [row] = await tx<{ id: string }[]>`INSERT INTO public.programs ${tx(values)} RETURNING id`;
    const id = row?.id ?? "";
    audit({ action: "program.create", entityType: "program", entityId: id, fields: PROGRAM_FIELDS, after: values });
    return id;
  });
}

/** Edits a program. Once locked, only name, defaults and leaderboard size may change. */
export async function updateProgram(sql: Sql, id: string, input: ProgramFields): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const current = await lockRow(tx, id);
    if (current.status !== "draft" && current.status !== "published" && (input.salesEndAt.getTime() !== current.sales_end_at.getTime() || input.graceDays !== current.grace_days)) {
      throw new InvalidInput(ENDED_MESSAGE);
    }
    if (
      current.locked &&
      (input.productId !== current.product_id ||
        input.slug !== current.slug ||
        input.salesStartAt.getTime() !== current.sales_start_at.getTime() ||
        input.salesEndAt.getTime() !== current.sales_end_at.getTime() ||
        input.graceDays !== current.grace_days)
    ) {
      throw new InvalidInput(LOCKED_MESSAGE);
    }
    const values = rowValues(input, current.status);
    await tx`UPDATE public.programs SET ${tx(values)}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({ action: "program.update", entityType: "program", entityId: id, fields: PROGRAM_FIELDS, before: auditValues(current), after: values, facts: { locked: current.locked } });
  });
}

/** Extend-only reschedule: a later (or the same) last sales day and more (or the same) grace days. */
export async function rescheduleProgram(sql: Sql, id: string, change: { readonly lastDay: string; readonly graceDays: number }): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const current = await lockRow(tx, id);
    // Code review US-017 CM4: after the grace-end snapshot the dates are history (the DB refuses too, ET048).
    if (current.status !== "draft" && current.status !== "published") throw new InvalidInput(ENDED_MESSAGE);
    const salesEndAt = new Date(wibMidnight(calendarDate(change.lastDay, "Enter the new last sales day.")).getTime() + DAY_MS);
    if (salesEndAt < current.sales_end_at || change.graceDays < current.grace_days) throw new InvalidInput(EXTEND_ONLY_MESSAGE);
    if (salesEndAt.getTime() === current.sales_end_at.getTime() && change.graceDays === current.grace_days) {
      throw new InvalidInput("Nothing to reschedule: choose a later last sales day or more grace days.");
    }
    await tx`UPDATE public.programs SET sales_end_at = ${salesEndAt}, grace_days = ${change.graceDays}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({
      action: "program.reschedule",
      entityType: "program",
      entityId: id,
      fields: PROGRAM_FIELDS,
      before: { sales_end_at: current.sales_end_at, grace_days: current.grace_days },
      after: { sales_end_at: salesEndAt, grace_days: change.graceDays },
      facts: { locked: current.locked, grace_end_before: graceEndDay(current.sales_end_at, current.grace_days), grace_end_after: graceEndDay(salesEndAt, change.graceDays) },
    });
  });
}

/** draft <-> published. A program with paid orders cannot go back to draft. */
export async function setProgramStatus(sql: Sql, id: string, status: "draft" | "published"): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const current = await lockRow(tx, id);
    if (current.status !== "draft" && current.status !== "published") throw new InvalidInput("This program's contest has ended; its status is managed by the results flow.");
    if (current.status === status) throw new InvalidInput(`The program is already ${status}.`);
    if (status === "draft" && current.locked) throw new InvalidInput("A program with paid orders cannot go back to draft.");
    if (status === "published") {
      const [product] = await tx<{ pdf: boolean; active: boolean }[]>`
        SELECT pdf_upload_id IS NOT NULL AS pdf, active FROM public.products WHERE id = ${current.product_id}`;
      if (product?.pdf !== true) throw new InvalidInput("Upload the ebook PDF of this program's product before publishing.");
      if (!product.active) throw new InvalidInput("This program's product is not on sale. Put it on sale (Products) before publishing.");
    }
    await tx`UPDATE public.programs SET status = ${status}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({ action: status === "published" ? "program.publish" : "program.unpublish", entityType: "program", entityId: id, fields: PROGRAM_FIELDS, before: { status: current.status }, after: { status } });
  });
}

/**
 * A new draft program with the source's settings and content (banner, trivia sets, questions, options,
 * prize tiers), unlocked, linked by cloned_from_program_id. The source is not changed.
 */
export async function cloneProgram(sql: Sql, sourceId: string, target: { readonly slug: string; readonly name: string }): Promise<string> {
  return audited(sql, async (tx, audit) => {
    const source = await lockRow(tx, sourceId);
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO public.programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days, default_points,
                                   default_timer_seconds, leaderboard_top_n, banner_upload_id, cloned_from_program_id)
      SELECT product_id, ${target.slug}, ${target.name}, 'draft', sales_start_at, sales_end_at, grace_days, default_points,
             default_timer_seconds, leaderboard_top_n, banner_upload_id, id
        FROM public.programs WHERE id = ${sourceId}
      RETURNING id`;
    const id = created?.id ?? "";
    const sets = await tx`
      INSERT INTO public.trivia_sets (program_id, position, title, thumbnail_upload_id)
      SELECT ${id}, position, title, thumbnail_upload_id FROM public.trivia_sets WHERE program_id = ${sourceId}`;
    const questions = await tx`
      INSERT INTO public.questions (set_id, position, prompt, image_upload_id, points, timer_seconds, explanation)
      SELECT ns.id, q.position, q.prompt, q.image_upload_id, q.points, q.timer_seconds, q.explanation
        FROM public.questions q
        JOIN public.trivia_sets os ON os.id = q.set_id AND os.program_id = ${sourceId}
        JOIN public.trivia_sets ns ON ns.program_id = ${id} AND ns.position = os.position`;
    await tx`
      INSERT INTO public.question_options (question_id, position, label, is_correct)
      SELECT nq.id, o.position, o.label, o.is_correct
        FROM public.question_options o
        JOIN public.questions oq ON oq.id = o.question_id
        JOIN public.trivia_sets os ON os.id = oq.set_id AND os.program_id = ${sourceId}
        JOIN public.trivia_sets ns ON ns.program_id = ${id} AND ns.position = os.position
        JOIN public.questions nq ON nq.set_id = ns.id AND nq.position = oq.position`;
    const tiers = await tx`
      INSERT INTO public.prize_tiers (program_id, rank_from, rank_to, name, description, image_upload_id, value_idr)
      SELECT ${id}, rank_from, rank_to, name, description, image_upload_id, value_idr FROM public.prize_tiers WHERE program_id = ${sourceId}`;
    audit({
      action: "program.clone",
      entityType: "program",
      entityId: id,
      fields: PROGRAM_FIELDS,
      // The clone starts with the source's banner (the same upload: a field of the new program, so it is recorded as one).
      after: { ...auditValues(source), slug: target.slug, name: target.name, status: "draft", banner_upload_id: source.banner_upload_id },
      facts: { cloned_from: sourceId, trivia_sets: sets.count, questions: questions.count, prize_tiers: tiers.count },
    });
    return id;
  });
}

/** Pre-check before the banner is re-encoded and written (the link checks again): the program exists. */
export async function checkBannerTarget(sql: Sql, programId: string): Promise<void> {
  const [row] = await sql`SELECT 1 FROM public.programs WHERE id = ${programId}`;
  if (row === undefined) throw new InvalidInput("Program ini sudah tidak ada.");
}

/**
 * Links a stored image (lib/settings/images.ts storeImage, purpose banner) as the picture the play page's banner card shows
 * for the program, or clears it (null: the built-in art). Owner only (program.edit, decided by the caller). The picture is
 * cosmetic, so it may change at any time, also after the first paid order. A replaced or removed image keeps its file and
 * uploads row (a clone may still use it).
 */
export async function setProgramBanner(sql: Sql, adminUserId: string, programId: string, image: StoredImage | null): Promise<void> {
  const link = () =>
    audited(sql, async (tx, audit) => {
      const [current] = await tx<{ banner_upload_id: string | null }[]>`SELECT banner_upload_id FROM public.programs WHERE id = ${programId} FOR UPDATE`;
      if (current === undefined) throw new InvalidInput("Program ini sudah tidak ada.");
      if (image === null && current.banner_upload_id === null) throw new InvalidInput("Program ini belum punya gambar banner.");
      if (image !== null) await insertImageRow(tx, image, adminUserId);
      const next = image?.uploadId ?? null;
      await tx`UPDATE public.programs SET banner_upload_id = ${next}, updated_at = clock_timestamp() WHERE id = ${programId}`;
      audit({
        action: "program.banner",
        entityType: "program",
        entityId: programId,
        fields: PROGRAM_FIELDS,
        before: { banner_upload_id: current.banner_upload_id },
        after: { banner_upload_id: next },
        ...(image === null ? {} : { facts: { size_bytes: image.sizeBytes } }),
      });
    });
  await (image === null ? link() : linkImage(image, link));
}

export interface ProgramListRow {
  readonly id: string;
  readonly productId: string;
  readonly productTitle: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly salesStartAt: Date;
  readonly salesEndAt: Date;
  readonly graceDays: number;
  readonly defaultPoints: number;
  readonly defaultTimerSeconds: number;
  readonly leaderboardTopN: number;
  readonly lockedAt: Date | null;
  readonly bannerUploadId: string | null;
  /** The highest rank any prize tier covers (0 with none): the leaderboard should show at least this many players. */
  readonly prizeRanks: number;
  readonly paidOrders: number;
  readonly sets: number;
}

export async function listPrograms(sql: Sql): Promise<ProgramListRow[]> {
  return sql<ProgramListRow[]>`
    SELECT p.id, p.product_id AS "productId", pr.title AS "productTitle", p.slug, p.name, p.status::text AS status,
           p.sales_start_at AS "salesStartAt", p.sales_end_at AS "salesEndAt", p.grace_days AS "graceDays",
           p.default_points AS "defaultPoints", p.default_timer_seconds AS "defaultTimerSeconds",
           p.leaderboard_top_n AS "leaderboardTopN", p.locked_at AS "lockedAt", p.banner_upload_id AS "bannerUploadId",
           ${PRIZE_RANKS_SQL(sql)} AS "prizeRanks",
           (SELECT count(*)::int FROM public.orders o WHERE o.program_id = p.id AND o.paid_at IS NOT NULL) AS "paidOrders",
           (SELECT count(*)::int FROM public.trivia_sets s WHERE s.program_id = p.id) AS sets
      FROM public.programs p JOIN public.products pr ON pr.id = p.product_id
     ORDER BY p.created_at DESC`;
}
