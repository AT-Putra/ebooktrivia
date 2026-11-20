// Trivia sets and questions (AC-A3, AC-Q15; US-018). Manage trivia is a Staff permission (AC-A1),
// with the content lock on top (plan §10 item 18, policy.ts `staff_unlocked`):
//   - a set with at least one attempt is LOCKED. Staff may change nothing in it (title,
//     thumbnail, questions, options, images): the console hides the controls and every change
//     below is refused inside its transaction (NotAllowed -> 403). The set row is locked FOR UPDATE
//     first, which conflicts with the key-share lock a first attempt takes, so the check and the
//     write see the same state;
//   - the Owner may still fix TEXT on a locked set (prompt, explanation, image, option labels,
//     title, thumbnail), audited. Points, timers, the correct option and the question / option
//     lists are refused for everyone by the database (ET020, sql/triggers.sql); they change only
//     through the Owner's scoring override (lib/settings/rescore.ts);
//   - after the program's first PAID order its set count and order are frozen (ET047, US-017):
//     sets cannot be added, removed or reordered.
// Every id is scoped to its parent in the WHERE clause (question -> set -> program). Content edits
// run under READ COMMITTED (the server default; the lock triggers refuse anything else, ET021).
// Defaults: a new question gets the program's default points and timer (programs.default_*).
import { can, type Role } from "../policy.ts";
import type { AuditRecorder, FieldKind, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import { formValue, InvalidInput, multiLine, NotAllowed, singleLine, wholeNumber } from "./fields.ts";
import { insertImageRow, linkImage, type StoredImage } from "./image-link.ts";

export interface Actor {
  readonly userId: string;
  readonly role: Role;
}

export const TRIVIA_LIMITS = {
  title: 120,
  prompt: 500,
  option: 120,
  explanation: 1000,
  points: { min: 0, max: 1000 },
  timer: { min: 5, max: 600 },
  options: { min: 2, max: 4 },
} as const;

export const SET_FIELDS: Readonly<Record<string, FieldKind>> = { title: "value", position: "value", thumbnail_upload_id: "value" };
/** `options`: the option labels in order; `correct_option`: the position (1-4) of the correct one. */
export const QUESTION_FIELDS: Readonly<Record<string, FieldKind>> = {
  prompt: "value",
  explanation: "value",
  image_upload_id: "value",
  points: "value",
  timer_seconds: "value",
  position: "value",
  options: "value",
  correct_option: "value",
};

export const LOCKED_SET =
  "This set has attempts: its points, timers, correct answers and question list are locked. The Owner can fix text, or change scoring with Override scoring.";
export const PROGRAM_PAID = "This program has a paid order: its trivia sets can no longer be added, removed or reordered.";

/** A lock wait or statement ran out of time (lock_timeout / statement_timeout): never a bare 500. */
export const BUSY = "The program is busy (a re-score or a results snapshot is running). Try again in a minute.";
/** Staff on a set with attempts: what the form shows (Staff may have raced its first attempt). */
export const STAFF_LOCKED = `${LOCKED_SET} Only the Owner can change it now.`;
/** Changing which label sits at which position on a locked set would change the correct answer. */
export const LABEL_SWAP = "On a set with attempts an option cannot take another option's text (that would change the answer): use Override scoring.";

const MESSAGES: Readonly<Record<string, string>> = {
  ET020: LOCKED_SET,
  ET047: PROGRAM_PAID,
  "23505": CONCURRENT_SAVE,
  "40001": CONCURRENT_SAVE,
  "40P01": CONCURRENT_SAVE,
  "55P03": BUSY,
  "57014": BUSY,
};

const audited = <T>(sql: Sql, mutate: (tx: Tx, audit: AuditRecorder) => Promise<T>): Promise<T> => auditedChange(sql, mutate, MESSAGES);

// ---------------------------------------------------------------------------------------------
// Validation (shared by the forms and the CSV / XLSX import)

export interface QuestionDraft {
  readonly prompt: string;
  readonly explanation: string | null;
  readonly options: readonly string[];
  /** Position (1-based) of the correct option. */
  readonly correct: number;
  readonly points: number;
  readonly timerSeconds: number;
}

export interface QuestionText {
  readonly prompt: string;
  /** Up to four option cells, in order; empty cells at the end are unused options. */
  readonly options: readonly string[];
  readonly correct: string;
  readonly points: string;
  readonly timerSeconds: string;
  readonly explanation: string;
}

export interface Defaults {
  readonly points: number;
  readonly timerSeconds: number;
}

export const parsePrompt = (raw: string): string => multiLine(raw.trim(), `Enter the question (up to ${String(TRIVIA_LIMITS.prompt)} characters).`, { max: TRIVIA_LIMITS.prompt });
export const parseExplanation = (raw: string): string | null =>
  raw.trim() === "" ? null : multiLine(raw.trim(), `The explanation is up to ${String(TRIVIA_LIMITS.explanation)} characters.`, { max: TRIVIA_LIMITS.explanation });
export const parsePoints = (raw: string, fallback: number): number =>
  raw.trim() === "" ? fallback : wholeNumber(raw, `Points are a whole number from ${String(TRIVIA_LIMITS.points.min)} to ${String(TRIVIA_LIMITS.points.max)}.`, TRIVIA_LIMITS.points);
export const parseTimer = (raw: string, fallback: number): number =>
  raw.trim() === "" ? fallback : wholeNumber(raw, `The timer is a whole number of seconds from ${String(TRIVIA_LIMITS.timer.min)} to ${String(TRIVIA_LIMITS.timer.max)}.`, TRIVIA_LIMITS.timer);

/** 2-4 non-empty option labels, in order without gaps, all different. */
export function parseOptions(cells: readonly string[]): string[] {
  const trimmed = cells.map((c) => c.trim());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  if (trimmed.length > TRIVIA_LIMITS.options.max) throw new InvalidInput("A question has at most 4 options.");
  if (trimmed.length < TRIVIA_LIMITS.options.min || trimmed.includes("")) throw new InvalidInput("Enter 2 to 4 options, in order without gaps.");
  const labels = trimmed.map((label, i) => singleLine(label, `Option ${String(i + 1)} is up to ${String(TRIVIA_LIMITS.option)} characters on one line.`, { max: TRIVIA_LIMITS.option }));
  if (new Set(labels.map((l) => l.toLocaleLowerCase("id-ID"))).size !== labels.length) throw new InvalidInput("Two options have the same text.");
  return labels;
}

export function parseCorrect(raw: string, optionCount: number): number {
  const value = raw.trim();
  const n = /^[1-4]$/.test(value) ? Number(value) : 0;
  if (n < 1 || n > optionCount) throw new InvalidInput(`The correct answer is the number of a filled option (1 to ${String(optionCount)}).`);
  return n;
}

/** The question in `text`, or the first problem found (a fixed message, never the value). */
export function validateQuestion(text: QuestionText, defaults: Defaults): QuestionDraft | { readonly error: string } {
  try {
    const prompt = parsePrompt(text.prompt);
    const options = parseOptions(text.options);
    return {
      prompt,
      options,
      correct: parseCorrect(text.correct, options.length),
      points: parsePoints(text.points, defaults.points),
      timerSeconds: parseTimer(text.timerSeconds, defaults.timerSeconds),
      explanation: parseExplanation(text.explanation),
    };
  } catch (error) {
    if (error instanceof InvalidInput) return { error: error.message };
    throw error;
  }
}

export const parseSetTitle = (raw: string): string => singleLine(raw, `Enter a title (up to ${String(TRIVIA_LIMITS.title)} characters).`, { max: TRIVIA_LIMITS.title });

/** Form fields of the question forms (new and edit), ids included. */
export const QUESTION_FORM_FIELDS = ["programId", "setId", "questionId", "prompt", "option1", "option2", "option3", "option4", "correct", "points", "timerSeconds", "explanation"] as const;

const optionCells = (form: FormData): string[] => ["option1", "option2", "option3", "option4"].map((name) => formValue(form, name));

/** The new-question form; empty points / timer take the program's defaults. */
export function parseNewQuestion(form: FormData, defaults: Defaults): QuestionDraft {
  const result = validateQuestion(
    { prompt: formValue(form, "prompt"), options: optionCells(form), correct: formValue(form, "correct"), points: formValue(form, "points"), timerSeconds: formValue(form, "timerSeconds"), explanation: formValue(form, "explanation") },
    defaults,
  );
  if ("error" in result) throw new InvalidInput(result.error);
  return result;
}

/** The edit form. A locked set's form has no correct / points / timer fields: those stay unchanged. */
export function parseQuestionEdit(form: FormData): QuestionEdit {
  const options = parseOptions(optionCells(form));
  const required = (name: string, parse: (raw: string) => number): number | null => (form.has(name) ? parse(formValue(form, name)) : null);
  return {
    prompt: parsePrompt(formValue(form, "prompt")),
    explanation: parseExplanation(formValue(form, "explanation")),
    options,
    correct: required("correct", (raw) => parseCorrect(raw, options.length)),
    points: required("points", (raw) => wholeNumber(raw, `Points are a whole number from ${String(TRIVIA_LIMITS.points.min)} to ${String(TRIVIA_LIMITS.points.max)}.`, TRIVIA_LIMITS.points)),
    timerSeconds: required("timerSeconds", (raw) => wholeNumber(raw, `The timer is a whole number of seconds from ${String(TRIVIA_LIMITS.timer.min)} to ${String(TRIVIA_LIMITS.timer.max)}.`, TRIVIA_LIMITS.timer)),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads

export interface TriviaProgram {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly defaultPoints: number;
  readonly defaultTimerSeconds: number;
  /** First PAID order: the set count and order are frozen (ET047). */
  readonly paid: boolean;
  /** The results snapshot exists: scores are final, no override. */
  readonly snapshot: boolean;
  readonly sets: number;
}

const PROGRAM_COLUMNS = (sql: Sql) => sql`
  p.id, p.name, p.slug, p.status::text AS status, p.default_points AS "defaultPoints", p.default_timer_seconds AS "defaultTimerSeconds",
  (p.locked_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.orders o WHERE o.program_id = p.id AND o.paid_at IS NOT NULL)) AS paid,
  EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p.id) AS snapshot,
  (SELECT count(*)::int FROM public.trivia_sets s WHERE s.program_id = p.id) AS sets`;

export async function listTriviaPrograms(sql: Sql): Promise<TriviaProgram[]> {
  return sql<TriviaProgram[]>`SELECT ${PROGRAM_COLUMNS(sql)} FROM public.programs p ORDER BY p.created_at DESC`;
}

export async function getTriviaProgram(sql: Sql, programId: string): Promise<TriviaProgram | null> {
  const [row] = await sql<TriviaProgram[]>`SELECT ${PROGRAM_COLUMNS(sql)} FROM public.programs p WHERE p.id = ${programId}`;
  return row ?? null;
}

export interface SetSummary {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly thumbnailUploadId: string | null;
  readonly questionCount: number;
  readonly attempts: number;
}

const SET_COLUMNS = (sql: Sql) => sql`
  s.id, s.position, s.title, s.thumbnail_upload_id AS "thumbnailUploadId",
  (SELECT count(*)::int FROM public.questions q WHERE q.set_id = s.id) AS "questionCount",
  (SELECT count(*)::int FROM public.set_attempts a WHERE a.set_id = s.id) AS attempts`;

export async function listSets(sql: Sql, programId: string): Promise<SetSummary[]> {
  return sql<SetSummary[]>`SELECT ${SET_COLUMNS(sql)} FROM public.trivia_sets s WHERE s.program_id = ${programId} ORDER BY s.position`;
}

export interface OptionView {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly isCorrect: boolean;
}

export interface QuestionView {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly explanation: string | null;
  readonly imageUploadId: string | null;
  readonly points: number;
  readonly timerSeconds: number;
  readonly options: readonly OptionView[];
}

export interface SetDetail extends SetSummary {
  readonly questions: readonly QuestionView[];
}

export async function getSet(sql: Sql, programId: string, setId: string): Promise<SetDetail | null> {
  const [set] = await sql<SetSummary[]>`SELECT ${SET_COLUMNS(sql)} FROM public.trivia_sets s WHERE s.id = ${setId} AND s.program_id = ${programId}`;
  if (set === undefined) return null;
  const questions = await sql<(Omit<QuestionView, "options"> & { options: OptionView[] | null })[]>`
    SELECT q.id, q.position, q.prompt, q.explanation, q.image_upload_id AS "imageUploadId", q.points, q.timer_seconds AS "timerSeconds",
           (SELECT json_agg(json_build_object('id', o.id, 'position', o.position, 'label', o.label, 'isCorrect', o.is_correct) ORDER BY o.position)
              FROM public.question_options o WHERE o.question_id = q.id) AS options
      FROM public.questions q WHERE q.set_id = ${setId}
     ORDER BY q.position`;
  return { ...set, questions: questions.map((q) => ({ ...q, options: q.options ?? [] })) };
}

// ---------------------------------------------------------------------------------------------
// Writes

interface LockedSet {
  readonly id: string;
  readonly title: string;
  readonly position: number;
  readonly thumbnailUploadId: string | null;
  readonly locked: boolean;
}

/** The set, scoped to its program, locked for this transaction, with its content-lock state. */
async function lockSet(tx: Tx, programId: string, setId: string): Promise<LockedSet> {
  const [set] = await tx<Omit<LockedSet, "locked">[]>`
    SELECT s.id, s.title, s.position, s.thumbnail_upload_id AS "thumbnailUploadId"
      FROM public.trivia_sets s WHERE s.id = ${setId} AND s.program_id = ${programId} FOR UPDATE`;
  if (set === undefined) throw new InvalidInput("This trivia set no longer exists.");
  const [state] = await tx<{ locked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM public.set_attempts a WHERE a.set_id = ${setId}) AS locked`;
  return { ...set, locked: state?.locked === true };
}

/** Staff may change nothing in a set with attempts (policy.ts staff_unlocked); the Owner may fix text. */
function allow(actor: Actor, set: LockedSet, permission: "question.content.edit" | "question.import" = "question.content.edit"): void {
  if (!can(actor.role, permission, { setLocked: set.locked })) throw new NotAllowed(STAFF_LOCKED);
}

export async function createSet(sql: Sql, programId: string, title: string): Promise<string> {
  return audited(sql, async (tx, audit) => {
    const [program] = await tx`SELECT 1 FROM public.programs WHERE id = ${programId}`;
    if (program === undefined) throw new InvalidInput("This program no longer exists.");
    const [row] = await tx<{ id: string; position: number }[]>`
      INSERT INTO public.trivia_sets (program_id, position, title)
      SELECT ${programId}, coalesce(max(position), 0) + 1, ${title} FROM public.trivia_sets WHERE program_id = ${programId}
      RETURNING id, position`;
    const id = row?.id ?? "";
    audit({ action: "trivia_set.create", entityType: "trivia_set", entityId: id, fields: SET_FIELDS, after: { title, position: row?.position ?? null }, facts: { program_id: programId } });
    return id;
  });
}

export async function renameSet(sql: Sql, actor: Actor, programId: string, setId: string, title: string): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, programId, setId);
    allow(actor, set);
    if (set.title === title) throw new InvalidInput("Nothing changed.");
    await tx`UPDATE public.trivia_sets SET title = ${title}, updated_at = clock_timestamp() WHERE id = ${setId} AND program_id = ${programId}`;
    audit({ action: "trivia_set.update", entityType: "trivia_set", entityId: setId, fields: SET_FIELDS, before: { title: set.title }, after: { title }, facts: { program_id: programId, locked: set.locked } });
  });
}

/** Swaps the set with its neighbour (refused after the first PAID order, ET047). */
export async function moveSet(sql: Sql, actor: Actor, programId: string, setId: string, direction: "up" | "down"): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, programId, setId);
    allow(actor, set);
    const [neighbour] =
      direction === "up"
        ? await tx<{ id: string; position: number }[]>`
            SELECT id, position FROM public.trivia_sets WHERE program_id = ${programId} AND position < ${set.position} ORDER BY position DESC LIMIT 1 FOR UPDATE`
        : await tx<{ id: string; position: number }[]>`
            SELECT id, position FROM public.trivia_sets WHERE program_id = ${programId} AND position > ${set.position} ORDER BY position LIMIT 1 FOR UPDATE`;
    if (neighbour === undefined) throw new InvalidInput(direction === "up" ? "This set is already first." : "This set is already last.");
    // trivia_sets_program_id_position_key is checked row by row: park one set on a free position first.
    await tx`UPDATE public.trivia_sets SET position = -1 * ${set.position} - 1000000, updated_at = clock_timestamp() WHERE id = ${setId}`;
    await tx`UPDATE public.trivia_sets SET position = ${set.position}, updated_at = clock_timestamp() WHERE id = ${neighbour.id}`;
    await tx`UPDATE public.trivia_sets SET position = ${neighbour.position}, updated_at = clock_timestamp() WHERE id = ${setId}`;
    audit({ action: "trivia_set.move", entityType: "trivia_set", entityId: setId, fields: SET_FIELDS, before: { position: set.position }, after: { position: neighbour.position }, facts: { program_id: programId, swapped_with: neighbour.id } });
  });
}

export async function deleteSet(sql: Sql, actor: Actor, programId: string, setId: string): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, programId, setId);
    allow(actor, set);
    if (set.locked) throw new InvalidInput("This set has attempts: it cannot be deleted.");
    const deleted = await tx`DELETE FROM public.trivia_sets WHERE id = ${setId} AND program_id = ${programId}`;
    audit({ action: "trivia_set.delete", entityType: "trivia_set", entityId: setId, fields: SET_FIELDS, before: { title: set.title, position: set.position }, facts: { program_id: programId, deleted: deleted.count } });
  });
}

/**
 * Pre-check before an image is re-encoded and written (code review US-018 F8): the set (and the
 * question) exist in their parents and the role may change them now. No lock: the linking
 * transaction checks again.
 */
export async function checkImageTarget(sql: Sql, actor: Actor, ids: { readonly programId: string; readonly setId: string; readonly questionId?: string }): Promise<void> {
  const [row] = await sql<{ locked: boolean; question: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM public.set_attempts a WHERE a.set_id = s.id) AS locked,
           (${ids.questionId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM public.questions q WHERE q.id = ${ids.questionId ?? null}::uuid AND q.set_id = s.id)) AS question
      FROM public.trivia_sets s WHERE s.id = ${ids.setId} AND s.program_id = ${ids.programId}`;
  if (row === undefined || !row.question) throw new InvalidInput(ids.questionId === undefined ? "This trivia set no longer exists." : "This question no longer exists.");
  if (!can(actor.role, "question.content.edit", { setLocked: row.locked })) throw new NotAllowed(STAFF_LOCKED);
}

/** Links a stored image (lib/settings/images.ts storeImage) as the set's thumbnail, or clears it (null). */
export async function setSetThumbnail(sql: Sql, actor: Actor, programId: string, setId: string, image: StoredImage | null): Promise<void> {
  const link = () =>
    audited(sql, async (tx, audit) => {
      const set = await lockSet(tx, programId, setId);
      allow(actor, set);
      if (image === null && set.thumbnailUploadId === null) throw new InvalidInput("This set has no thumbnail.");
      if (image !== null) await insertImageRow(tx, image, actor.userId);
      const next = image?.uploadId ?? null;
      await tx`UPDATE public.trivia_sets SET thumbnail_upload_id = ${next}, updated_at = clock_timestamp() WHERE id = ${setId} AND program_id = ${programId}`;
      audit({
        action: "trivia_set.thumbnail",
        entityType: "trivia_set",
        entityId: setId,
        fields: SET_FIELDS,
        before: { thumbnail_upload_id: set.thumbnailUploadId },
        after: { thumbnail_upload_id: next },
        facts: { program_id: programId, locked: set.locked, ...(image === null ? {} : { size_bytes: image.sizeBytes }) },
      });
    });
  await (image === null ? link() : linkImage(image, link));
}

interface QuestionRow {
  readonly id: string;
  readonly position: number;
  readonly prompt: string;
  readonly explanation: string | null;
  readonly image_upload_id: string | null;
  readonly points: number;
  readonly timer_seconds: number;
}

interface OptionRow {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly is_correct: boolean;
}

async function lockQuestion(tx: Tx, setId: string, questionId: string): Promise<{ question: QuestionRow; options: OptionRow[] }> {
  const [question] = await tx<QuestionRow[]>`
    SELECT id, position, prompt, explanation, image_upload_id, points, timer_seconds
      FROM public.questions WHERE id = ${questionId} AND set_id = ${setId} FOR UPDATE`;
  if (question === undefined) throw new InvalidInput("This question no longer exists.");
  const options = await tx<OptionRow[]>`
    SELECT id, position, label, is_correct FROM public.question_options WHERE question_id = ${questionId} ORDER BY position FOR UPDATE`;
  return { question, options };
}

const auditQuestion = (q: QuestionRow, options: readonly OptionRow[]) => ({
  prompt: q.prompt,
  explanation: q.explanation,
  points: q.points,
  timer_seconds: q.timer_seconds,
  options: options.map((o) => o.label),
  correct_option: options.find((o) => o.is_correct)?.position ?? null,
});

const draftValues = (d: QuestionDraft) => ({
  prompt: d.prompt,
  explanation: d.explanation,
  points: d.points,
  timer_seconds: d.timerSeconds,
  options: [...d.options],
  correct_option: d.correct,
});

/** Inserts `drafts` after the set's last question (the caller locked the set). */
async function insertQuestions(tx: Tx, setId: string, drafts: readonly QuestionDraft[]): Promise<string[]> {
  const [last] = await tx<{ position: number }[]>`SELECT coalesce(max(position), 0) AS position FROM public.questions WHERE set_id = ${setId}`;
  let position = last?.position ?? 0;
  const ids: string[] = [];
  for (const d of drafts) {
    position++;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds, explanation)
      VALUES (${setId}, ${position}, ${d.prompt}, ${d.points}, ${d.timerSeconds}, ${d.explanation}) RETURNING id`;
    const id = row?.id ?? "";
    ids.push(id);
    for (const [i, label] of d.options.entries()) {
      await tx`INSERT INTO public.question_options (question_id, position, label, is_correct) VALUES (${id}, ${i + 1}, ${label}, ${i + 1 === d.correct})`;
    }
  }
  return ids;
}

export async function createQuestion(sql: Sql, actor: Actor, programId: string, setId: string, draft: QuestionDraft): Promise<string> {
  return audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, programId, setId);
    allow(actor, set);
    if (set.locked) throw new InvalidInput(LOCKED_SET);
    const [id = ""] = await insertQuestions(tx, setId, [draft]);
    audit({ action: "question.create", entityType: "question", entityId: id, fields: QUESTION_FIELDS, after: draftValues(draft), facts: { program_id: programId, set_id: setId } });
    return id;
  });
}

/** A question edit from the form. Fields absent from the form (a locked set's form) stay unchanged. */
export interface QuestionEdit {
  readonly prompt: string;
  readonly explanation: string | null;
  readonly options: readonly string[];
  readonly correct: number | null;
  readonly points: number | null;
  readonly timerSeconds: number | null;
}

export async function updateQuestion(sql: Sql, actor: Actor, ids: { readonly programId: string; readonly setId: string; readonly questionId: string }, edit: QuestionEdit): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, ids.programId, ids.setId);
    allow(actor, set);
    const { question, options } = await lockQuestion(tx, ids.setId, ids.questionId);
    const before = auditQuestion(question, options);
    const correct = edit.correct ?? before.correct_option;
    const points = edit.points ?? question.points;
    const timer = edit.timerSeconds ?? question.timer_seconds;
    const structural = edit.options.length !== options.length || correct !== before.correct_option || points !== question.points || timer !== question.timer_seconds;
    if (set.locked && structural) throw new InvalidInput(LOCKED_SET);
    // Security review US-018 L5: on a locked set a label may be fixed, but never take another
    // option's current text (a swap would move the correct answer without a re-score).
    // Accepted residual (both US-018 re-reviews): three saves (A -> tmp, B -> A, tmp -> B) can still
    // move what the correct option means. Only the Owner can edit a locked set's text, and every save
    // is audited with the labels before / after (question.update), so such a rename is on record;
    // changing the answer itself is what Override scoring (re-scored, audited) is for.
    if (set.locked) {
      const key = (label: string): string => label.trim().toLocaleLowerCase("id-ID");
      for (const [i, label] of edit.options.entries()) {
        if (options.some((o) => o.position !== i + 1 && key(o.label) === key(label))) throw new InvalidInput(LABEL_SWAP);
      }
    }
    if (correct === null || correct > edit.options.length) throw new InvalidInput("Choose the correct answer.");
    const after = { prompt: edit.prompt, explanation: edit.explanation, points, timer_seconds: timer, options: [...edit.options], correct_option: correct };
    if (JSON.stringify(after) === JSON.stringify(before)) throw new InvalidInput("Nothing changed.");
    await tx`
      UPDATE public.questions SET prompt = ${edit.prompt}, explanation = ${edit.explanation}, points = ${points}, timer_seconds = ${timer}, updated_at = clock_timestamp()
       WHERE id = ${ids.questionId} AND set_id = ${ids.setId}`;
    if (correct !== before.correct_option) {
      await tx`UPDATE public.question_options SET is_correct = false, updated_at = clock_timestamp() WHERE question_id = ${ids.questionId} AND is_correct`;
    }
    for (const [i, label] of edit.options.entries()) {
      const current = options.find((o) => o.position === i + 1);
      if (current === undefined) {
        await tx`INSERT INTO public.question_options (question_id, position, label) VALUES (${ids.questionId}, ${i + 1}, ${label})`;
      } else if (current.label !== label) {
        await tx`UPDATE public.question_options SET label = ${label}, updated_at = clock_timestamp() WHERE id = ${current.id} AND question_id = ${ids.questionId}`;
      }
    }
    if (options.length > edit.options.length) {
      await tx`DELETE FROM public.question_options WHERE question_id = ${ids.questionId} AND position > ${edit.options.length}`;
    }
    if (correct !== before.correct_option) {
      await tx`UPDATE public.question_options SET is_correct = true, updated_at = clock_timestamp() WHERE question_id = ${ids.questionId} AND position = ${correct}`;
    }
    audit({ action: "question.update", entityType: "question", entityId: ids.questionId, fields: QUESTION_FIELDS, before, after, facts: { program_id: ids.programId, set_id: ids.setId, locked: set.locked } });
  });
}

export async function deleteQuestion(sql: Sql, actor: Actor, ids: { readonly programId: string; readonly setId: string; readonly questionId: string }): Promise<void> {
  await audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, ids.programId, ids.setId);
    allow(actor, set);
    if (set.locked) throw new InvalidInput(LOCKED_SET);
    const { question, options } = await lockQuestion(tx, ids.setId, ids.questionId);
    await tx`DELETE FROM public.questions WHERE id = ${ids.questionId} AND set_id = ${ids.setId}`;
    audit({ action: "question.delete", entityType: "question", entityId: ids.questionId, fields: QUESTION_FIELDS, before: auditQuestion(question, options), facts: { program_id: ids.programId, set_id: ids.setId } });
  });
}

/** Links a stored image as the question's image, or clears it (null). */
export async function setQuestionImage(
  sql: Sql,
  actor: Actor,
  ids: { readonly programId: string; readonly setId: string; readonly questionId: string },
  image: StoredImage | null,
): Promise<void> {
  const link = () =>
    audited(sql, async (tx, audit) => {
      const set = await lockSet(tx, ids.programId, ids.setId);
      allow(actor, set);
      const { question } = await lockQuestion(tx, ids.setId, ids.questionId);
      if (image === null && question.image_upload_id === null) throw new InvalidInput("This question has no image.");
      if (image !== null) await insertImageRow(tx, image, actor.userId);
      const next = image?.uploadId ?? null;
      await tx`UPDATE public.questions SET image_upload_id = ${next}, updated_at = clock_timestamp() WHERE id = ${ids.questionId} AND set_id = ${ids.setId}`;
      audit({
        action: "question.image",
        entityType: "question",
        entityId: ids.questionId,
        fields: QUESTION_FIELDS,
        before: { image_upload_id: question.image_upload_id },
        after: { image_upload_id: next },
        facts: { program_id: ids.programId, set_id: ids.setId, locked: set.locked, ...(image === null ? {} : { size_bytes: image.sizeBytes }) },
      });
    });
  await (image === null ? link() : linkImage(image, link));
}

/**
 * Adds all `drafts` to the set or none (AC-Q15 import, lib/settings/trivia-import.ts validated
 * them). Staff need the set unlocked (question.import); nobody adds to a locked set (ET020).
 */
export async function insertImported(
  sql: Sql,
  actor: Actor,
  ids: { readonly programId: string; readonly setId: string },
  drafts: readonly QuestionDraft[],
  file: { readonly type: string; readonly sizeBytes: number; readonly sha256: string },
): Promise<number> {
  return audited(sql, async (tx, audit) => {
    const set = await lockSet(tx, ids.programId, ids.setId);
    allow(actor, set, "question.import");
    if (set.locked) throw new InvalidInput("This set has attempts: questions can no longer be added.");
    const created = await insertQuestions(tx, ids.setId, drafts);
    audit({
      action: "question.import",
      entityType: "trivia_set",
      entityId: ids.setId,
      facts: { program_id: ids.programId, questions: created.length, file_type: file.type, file_bytes: file.sizeBytes, file_sha256: file.sha256 },
    });
    return created.length;
  });
}

/** The program's defaults and the set's lock state, for the import's pre-check (no lock taken). */
export async function importTarget(sql: Sql, programId: string, setId: string): Promise<{ readonly defaults: Defaults; readonly locked: boolean } | null> {
  const [row] = await sql<{ points: number; timer: number; locked: boolean }[]>`
    SELECT p.default_points AS points, p.default_timer_seconds AS timer,
           EXISTS (SELECT 1 FROM public.set_attempts a WHERE a.set_id = s.id) AS locked
      FROM public.trivia_sets s JOIN public.programs p ON p.id = s.program_id
     WHERE s.id = ${setId} AND s.program_id = ${programId}`;
  return row === undefined ? null : { defaults: { points: row.points, timerSeconds: row.timer }, locked: row.locked };
}
