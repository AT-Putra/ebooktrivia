// US-018 (M5b) against a real database, as the admin_rw login the app uses:
//   - sets / questions editor: defaults from the program, Staff refused on a set with attempts
//     (every change), the Owner's text fix allowed and audited, locked fields refused, the set
//     count / order frozen after the first PAID order;
//   - CSV / XLSX import: all or nothing with row-level errors, through the route handler too;
//   - the Owner's scoring override: re-score with seeded attempt rows (correct option, timer),
//     audited with the reason and totals and no PII, idempotent, blocked after the snapshot;
//   - content images re-encoded to WebP under the data directory;
//   - prize tiers, versioned legal pages, OTP / rate limits (bounded, audited, read by SQL).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";
import { questionImport, triviaImage } from "../src/lib/next/content-routes.ts";
import type { RouteContext } from "../src/lib/next/route.ts";
import { NO_SETTINGS, type SettingsConfig } from "../src/lib/settings/env.ts";
import { InvalidInput, NotAllowed } from "../src/lib/settings/fields.ts";
import { listLegalVersions, publishLegalPage, saveLegalDraft } from "../src/lib/settings/legal.ts";
import { getLimits, LIMITS, saveLimits } from "../src/lib/settings/limits.ts";
import { createPrizeTier, deletePrizeTier, updatePrizeTier } from "../src/lib/settings/prizes.ts";
import { GRACE_OVER, overrideQuestion } from "../src/lib/settings/rescore.ts";
import { importQuestionFile } from "../src/lib/settings/trivia-import.ts";
import { storeImage } from "../src/lib/settings/images.ts";
import { type Actor, createQuestion, createSet, deleteQuestion, deleteSet, getSet, LABEL_SWAP, moveSet, renameSet, setQuestionImage, STAFF_LOCKED, updateQuestion } from "../src/lib/settings/trivia.ts";

type Id = { id: string };
let dataDir = "";
let settings: SettingsConfig;
let rt: ReturnType<typeof newRuntime>;
let owner: Actor;
let staff: Actor;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ebt-admin-trivia-"));
  settings = { ...NO_SETTINGS, dataDir };
  rt = newRuntime(undefined, settings);
  owner = { userId: (await createTestAdmin(rt, "owner")).userId, role: "owner" };
  staff = { userId: (await createTestAdmin(rt, "staff")).userId, role: "staff" };
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => asAdmin(actor.userId, fn);
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
const refused = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof InvalidInput) return error.message;
    if (error instanceof NotAllowed) return "NOT_ALLOWED";
    throw error;
  }
  throw new Error("expected a refusal");
};
const lastAudit = (action: string) => one(root<{ changes: Record<string, unknown>; text: string; actor: string }[]>`
  SELECT changes, row_to_json(a)::text AS text, actor_admin_user_id AS actor FROM audit_log a WHERE action = ${action} ORDER BY id DESC LIMIT 1`);

/** A published program on sale now (defaults 15 points / 25 s) with one set. */
async function program(): Promise<{ programId: string; setId: string; slug: string }> {
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const slug = `trivia-${suffix()}`;
  const p = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days, default_points, default_timer_seconds)
    VALUES (${product.id}, ${slug}, 'Musim Uji', 'published', now() - interval '1 day', now() + interval '30 days', 30, 15, 25) RETURNING id`);
  const setId = await as(owner, () => createSet(rt.sql, p.id, "Set 1"));
  return { programId: p.id, setId, slug };
}

const draft = (prompt: string, correct = 1) => ({ prompt, options: ["A", "B", "C"], correct, points: 10, timerSeconds: 20, explanation: null });

/** Five minutes ago, in whole milliseconds (answer timestamps are whole ms, CHECK). */
const servedAt = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000 - 300_000);

/**
 * An eligible player who answered `questionId` with option `position` after `seconds`, shown a 20 s
 * deadline, stored the way the answer path stores it (the stats are the sums of the answers).
 */
async function answered(programId: string, setId: string, questionId: string, position: number, seconds: number, phone: string): Promise<{ playerId: string; attemptId: string; answerId: string }> {
  const player = await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${phone}, 'Budi Rahasia') RETURNING id`);
  await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now(), true)`;
  const attempt = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${player.id}, ${setId}) RETURNING id`);
  const options = await root<Id[]>`SELECT id FROM question_options WHERE question_id = ${questionId} ORDER BY position`;
  const chosen = options[position - 1]?.id ?? null;
  const correct = await one(root<{ ok: boolean; points: number }[]>`SELECT o.is_correct AS ok, q.points FROM question_options o JOIN questions q ON q.id = o.question_id WHERE o.id = ${chosen}`);
  const served = servedAt();
  const late = seconds * 1000 > 21_500;
  const points = correct.ok && !late ? correct.points : 0;
  const elapsed = Math.min(seconds * 1000, 20_000);
  const answer = await one(root<Id[]>`
    INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms)
    VALUES (${attempt.id}, ${questionId}, 1, ${options.map((o) => o.id)}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)},
            ${new Date(served.getTime() + seconds * 1000)}, ${chosen}, ${correct.ok && !late}, ${points}, ${elapsed})
    RETURNING id`);
  await root`UPDATE set_attempts SET score = ${points}, total_ms = ${elapsed} WHERE id = ${attempt.id}`;
  await root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms) VALUES (${player.id}, ${programId}, ${points}, ${elapsed})`;
  return { playerId: player.id, attemptId: attempt.id, answerId: answer.id };
}

const phone = (): string => `+62812${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

describe("sets and questions: content lock, Staff and Owner", () => {
  it("Staff edit an unlocked set; once it has an attempt, Staff can change nothing in it and the Owner only its text", async () => {
    const { programId, setId } = await program();
    const qid = await as(staff, () => createQuestion(rt.sql, staff, programId, setId, draft("Pertanyaan satu?")));
    await as(staff, () => updateQuestion(rt.sql, staff, { programId, setId, questionId: qid }, { prompt: "Pertanyaan 1?", explanation: null, options: ["A", "B", "C", "D"], correct: 2, points: 12, timerSeconds: 30 }));
    let set = await getSet(rt.sql, programId, setId);
    expect(set?.questions[0]).toMatchObject({ prompt: "Pertanyaan 1?", points: 12, timerSeconds: 30, options: [{ label: "A", isCorrect: false }, { label: "B", isCorrect: true }, { label: "C" }, { label: "D" }] });

    await answered(programId, setId, qid, 2, 4, phone());
    const ids = { programId, setId, questionId: qid };
    const textOnly = { prompt: "Pertanyaan 1 (typo)?", explanation: "Karena B.", options: ["A", "B", "C", "D (diperbaiki)"], correct: null, points: null, timerSeconds: null };
    const staffChanges: (() => Promise<unknown>)[] = [
      () => renameSet(rt.sql, staff, programId, setId, "Judul baru"),
      () => updateQuestion(rt.sql, staff, ids, textOnly),
      () => deleteQuestion(rt.sql, staff, ids),
      () => createQuestion(rt.sql, staff, programId, setId, draft("Baru?")),
      () => deleteSet(rt.sql, staff, programId, setId),
      () => moveSet(rt.sql, staff, programId, setId, "down"),
    ];
    for (const change of staffChanges) expect(await refused(as(staff, change))).toBe("NOT_ALLOWED");
    // The Owner fixes text (audited, marked locked) but cannot change scoring fields, add or delete.
    await as(owner, () => updateQuestion(rt.sql, owner, ids, textOnly));
    expect((await lastAudit("question.update")).changes).toMatchObject({ prompt: { before: "Pertanyaan 1?", after: "Pertanyaan 1 (typo)?" }, options: { after: ["A", "B", "C", "D (diperbaiki)"] }, locked: true });
    await as(owner, () => renameSet(rt.sql, owner, programId, setId, "Judul baru"));
    expect(await refused(as(owner, () => updateQuestion(rt.sql, owner, ids, { ...textOnly, points: 99 })))).toMatch(/locked/);
    expect(await refused(as(owner, () => updateQuestion(rt.sql, owner, ids, { ...textOnly, correct: 1 })))).toMatch(/locked/);
    expect(await refused(as(owner, () => updateQuestion(rt.sql, owner, ids, { ...textOnly, options: ["A", "B", "C"] })))).toMatch(/locked/);
    expect(await refused(as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Baru?"))))).toMatch(/locked/);
    expect(await refused(as(owner, () => deleteQuestion(rt.sql, owner, ids)))).toMatch(/locked/);
    set = await getSet(rt.sql, programId, setId);
    expect(set).toMatchObject({ title: "Judul baru", attempts: 1, questions: [{ prompt: "Pertanyaan 1 (typo)?", points: 12, timerSeconds: 30 }] });
  });

  it("scopes every child id to its parent (a question of another program's set is not found)", async () => {
    const a = await program();
    const b = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, b.programId, b.setId, draft("Milik B?")));
    expect(await refused(as(owner, () => deleteQuestion(rt.sql, owner, { programId: a.programId, setId: b.setId, questionId: qid })))).toMatch(/no longer exists/);
    expect(await refused(as(owner, () => deleteQuestion(rt.sql, owner, { programId: a.programId, setId: a.setId, questionId: qid })))).toMatch(/no longer exists/);
    expect(await refused(as(owner, () => renameSet(rt.sql, owner, a.programId, b.setId, "x")))).toMatch(/no longer exists/);
  });

  it("on a locked set, an option cannot take another option's text (a swap would move the answer), and Staff get the lock message", async () => {
    const { programId, setId } = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, { prompt: "Tukar?", options: ["Jakarta", "Bandung", "Medan"], correct: 1, points: 10, timerSeconds: 20, explanation: null }));
    await answered(programId, setId, qid, 1, 3, phone());
    const ids = { programId, setId, questionId: qid };
    const text = { prompt: "Tukar?", explanation: null, correct: null, points: null, timerSeconds: null };
    for (const options of [["Bandung", "Jakarta", "Medan"], ["Medan", "Bandung", "Jakarta"], [" bandung ", "Bandung 2", "Medan"]]) {
      expect(await refused(as(owner, () => updateQuestion(rt.sql, owner, ids, { ...text, options }))), options.join("|")).toBe(LABEL_SWAP);
    }
    await as(owner, () => updateQuestion(rt.sql, owner, ids, { ...text, options: ["Jakarta (DKI)", "Bandung", "Medan"] }));
    // Staff racing the first attempt see why (not a 403 page): the refusal carries the lock message.
    let message = "";
    try {
      await as(staff, () => updateQuestion(rt.sql, staff, ids, { ...text, options: ["Jakarta", "Bandung", "Medan"] }));
    } catch (error) {
      if (error instanceof NotAllowed) message = error.message;
    }
    expect(message).toBe(STAFF_LOCKED);
  });

  it("freezes the set count and order after the program's first PAID order (ET047 -> message)", async () => {
    const { programId, setId } = await program();
    await as(owner, () => createSet(rt.sql, programId, "Set 2"));
    const lp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`);
    const product = await one(root<{ id: string }[]>`SELECT product_id AS id FROM programs WHERE id = ${programId}`);
    await root`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at, status, paid_at)
      VALUES (${`pid${suffix()}${suffix()}`}, ${`K0C${suffix()}`.toUpperCase()}, ${lp.id}, ${programId}, ${product.id}, 'Pembeli', ${phone()}, 'b@example.invalid', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day', 'paid', now())`;
    expect(await refused(as(owner, () => createSet(rt.sql, programId, "Set 3")))).toMatch(/paid order/);
    expect(await refused(as(owner, () => moveSet(rt.sql, owner, programId, setId, "down")))).toMatch(/paid order/);
    expect(await refused(as(owner, () => deleteSet(rt.sql, owner, programId, setId)))).toMatch(/paid order/);
    await as(owner, () => renameSet(rt.sql, owner, programId, setId, "Masih bisa diganti"));
  });
});

const CSV_HEADER = "prompt,option_1,option_2,option_3,option_4,correct,points,timer_seconds,explanation";
const csvFile = (body: string) => ({ bytes: Buffer.from(body, "utf8"), filename: "soal.csv", mimeType: "text/csv" });

describe("CSV / XLSX import (AC-Q15): all or nothing", () => {
  it("writes nothing when any row is invalid, listing every bad row; then imports a valid file with the program's defaults", async () => {
    const { programId, setId } = await program();
    const bad = await as(owner, () => importQuestionFile(rt.sql, owner, { programId, setId }, csvFile(`${CSV_HEADER}\nSatu?,A,B,,,1,,,\nDua?,A,,,,1,,,\nTiga?,A,B,,,5,,,\n`)));
    expect(bad).toEqual({ kind: "rejected", errors: [{ row: 3, message: "Enter 2 to 4 options, in order without gaps." }, { row: 4, message: "The correct answer is the number of a filled option (1 to 2)." }] });
    expect((await getSet(rt.sql, programId, setId))?.questionCount).toBe(0);
    const good = await as(staff, () => importQuestionFile(rt.sql, staff, { programId, setId }, csvFile(`${CSV_HEADER}\nSatu?,A,B,,,1,,,\nDua?,A,B,C,D,4,5,10,Karena D.\n`)));
    expect(good).toEqual({ kind: "imported", count: 2 });
    const set = await getSet(rt.sql, programId, setId);
    expect(set?.questions.map((q) => [q.position, q.prompt, q.points, q.timerSeconds, q.options.length, q.options.find((o) => o.isCorrect)?.position])).toEqual([
      [1, "Satu?", 15, 25, 2, 1],
      [2, "Dua?", 5, 10, 4, 4],
    ]);
    expect((await lastAudit("question.import")).changes).toMatchObject({ questions: 2, file_type: "csv", program_id: programId });
  });

  it("through the route handler: 422 with the rows, 403 for Staff on a locked set, 400 for an unknown parameter", async () => {
    const { programId, setId } = await program();
    const ctx = (actor: Actor): RouteContext => ({ rt, req: { headers: new Headers(), ip: null }, admin: { userId: actor.userId, sessionId: "s", role: actor.role, displayName: "x" } });
    const post = (actor: Actor, query: string, body: string) =>
      as(actor, () => questionImport(ctx(actor), new Request(`http://admin.test/uploads/questions?${query}`, { method: "POST", headers: { "content-type": "text/csv", "x-file-name": "soal.csv" }, body })));
    const rejected = await post(staff, `program=${programId}&set=${setId}`, `${CSV_HEADER}\nSatu?,A,A,,,1,,,\n`);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ error: "rows", errors: [{ row: 2, message: "Two options have the same text." }] });
    expect((await post(staff, `program=${programId}&set=${setId}&extra=1`, `${CSV_HEADER}\nSatu?,A,B,,,1,,,\n`)).status).toBe(400);
    const set = await getSet(rt.sql, programId, setId);
    expect(set?.questionCount).toBe(0);
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Ada?")));
    await answered(programId, setId, qid, 1, 3, phone());
    const forbidden = await post(staff, `program=${programId}&set=${setId}`, `${CSV_HEADER}\nSatu?,A,B,,,1,,,\n`);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: STAFF_LOCKED });
  });
});

describe("the Owner's scoring override (re-score with seeded attempt rows)", () => {
  async function lockedProgram() {
    const { programId, setId } = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Kunci?", 1)));
    const phones = [phone(), phone(), phone()];
    const right = await answered(programId, setId, qid, 1, 4, phones[0] ?? ""); // correct now, 4 s
    const wrong = await answered(programId, setId, qid, 2, 6, phones[1] ?? ""); // wrong now, 6 s
    const slow = await answered(programId, setId, qid, 1, 15, phones[2] ?? ""); // correct now, 15 s
    return { programId, setId, qid, right, wrong, slow, phones };
  }
  const stats = (programId: string) =>
    root<{ playerId: string; score: number; totalMs: number }[]>`SELECT player_id AS "playerId", score, total_ms::float8 AS "totalMs" FROM player_program_stats WHERE program_id = ${programId}`;
  const answerRow = (id: string) => one(root<{ correct: boolean; points: number; elapsed: number }[]>`SELECT correct, points, elapsed_ms AS elapsed FROM attempt_questions WHERE id = ${id}`);

  it("changing the correct option re-scores every affected player at once, audited with the reason and totals and no PII", async () => {
    const s = await lockedProgram();
    const summary = await as(owner, () => overrideQuestion(rt.sql, { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 20, correct: 2, reason: "Kunci jawaban salah ketik, yang benar B." }));
    expect(summary).toEqual({ players: 3, answersChanged: 3, scoreBefore: 20, scoreAfter: 10 });
    expect(await answerRow(s.right.answerId)).toEqual({ correct: false, points: 0, elapsed: 4000 });
    expect(await answerRow(s.wrong.answerId)).toEqual({ correct: true, points: 10, elapsed: 6000 });
    const byPlayer = new Map((await stats(s.programId)).map((r) => [r.playerId, r.score]));
    expect([byPlayer.get(s.right.playerId), byPlayer.get(s.wrong.playerId), byPlayer.get(s.slow.playerId)]).toEqual([0, 10, 0]);
    const correct = await root<{ position: number }[]>`SELECT position FROM question_options WHERE question_id = ${s.qid} AND is_correct`;
    expect(correct).toEqual([{ position: 2 }]);
    const audit = await lastAudit("question.rescore_override");
    expect(audit.actor).toBe(owner.userId);
    expect(audit.changes).toMatchObject({
      correct_option: { before: 1, after: 2 },
      reason: "Kunci jawaban salah ketik, yang benar B.",
      players: 3,
      answers_changed: 3,
      score_before: 20,
      score_after: 10,
      total_ms_before: 25000,
      total_ms_after: 25000,
    });
    for (const pii of [...s.phones, "Budi Rahasia", s.right.playerId, s.wrong.playerId]) expect(audit.text).not.toContain(pii);
    // Idempotent: the same override again changes nothing.
    const again = await as(owner, () => overrideQuestion(rt.sql, { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 20, correct: 2, reason: "Menjalankan ulang re-score yang sama." }));
    expect(again).toMatchObject({ players: 3, answersChanged: 0, scoreBefore: 10, scoreAfter: 10 });
  });

  it("a shortened timer turns the answer after the new deadline (+1.5 s) into a timeout; restoring it restores the answer", async () => {
    const s = await lockedProgram();
    await as(owner, () => overrideQuestion(rt.sql, { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 10, correct: 1, reason: "Timer seharusnya 10 detik." }));
    expect(await answerRow(s.slow.answerId)).toEqual({ correct: false, points: 0, elapsed: 10000 });
    expect(await answerRow(s.right.answerId)).toEqual({ correct: true, points: 10, elapsed: 4000 });
    await as(owner, () => overrideQuestion(rt.sql, { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 20, correct: 1, reason: "Timer dikembalikan ke 20 detik." }));
    expect(await answerRow(s.slow.answerId)).toEqual({ correct: true, points: 10, elapsed: 15000 });
  });

  it("a lengthened timer never rewards a pick made after the deadline the player was shown", async () => {
    const s = await lockedProgram();
    const late = await answered(s.programId, s.setId, s.qid, 1, 25, phone()); // right pick, 25 s: past 20 s + 1.5 s
    expect(await answerRow(late.answerId)).toEqual({ correct: false, points: 0, elapsed: 20000 });
    await as(owner, () => overrideQuestion(rt.sql, { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 30, correct: 1, reason: "Timer seharusnya 30 detik." }));
    // Still a timeout, and its time stays capped at the 20 s deadline it was shown (security review N1).
    expect(await answerRow(late.answerId)).toEqual({ correct: false, points: 0, elapsed: 20000 });
    expect(await answerRow(s.slow.answerId)).toEqual({ correct: true, points: 10, elapsed: 15000 });
  });

  it("is blocked once the results snapshot exists, by the app and by the database (ET022)", async () => {
    const s = await lockedProgram();
    await root`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${s.programId}, now(), '[]')`;
    const input = { programId: s.programId, setId: s.setId, questionId: s.qid, points: 99, timerSeconds: 20, correct: 2, reason: "Seharusnya ditolak setelah snapshot." };
    expect(await refused(as(owner, () => overrideQuestion(rt.sql, input)))).toMatch(/results snapshot exists/);
    const option = await one(root<Id[]>`SELECT id FROM question_options WHERE question_id = ${s.qid} AND position = 2`);
    await expect(
      rt.sql`SELECT public.override_question_scoring(${s.programId}, ${s.setId}, ${s.qid}, 99, 20, ${option.id}, 'Seharusnya ditolak setelah snapshot.', ${owner.userId}, NULL, NULL)`,
    ).rejects.toMatchObject({ code: "ET022" });
    expect((await answerRow(s.right.answerId)).points).toBe(10);
  });

  it("is blocked once grace is over (sales end + grace days), by the app and by the database (ET022)", async () => {
    const s = await lockedProgram();
    await root`UPDATE programs SET sales_start_at = now() - interval '40 days', sales_end_at = now() - interval '35 days', grace_days = 30 WHERE id = ${s.programId}`;
    const input = { programId: s.programId, setId: s.setId, questionId: s.qid, points: 99, timerSeconds: 20, correct: 2, reason: "Seharusnya ditolak setelah grace." };
    expect(await refused(as(owner, () => overrideQuestion(rt.sql, input)))).toBe(GRACE_OVER);
    const option = await one(root<Id[]>`SELECT id FROM question_options WHERE question_id = ${s.qid} AND position = 2`);
    await expect(
      rt.sql`SELECT public.override_question_scoring(${s.programId}, ${s.setId}, ${s.qid}, 99, 20, ${option.id}, 'Seharusnya ditolak setelah grace.', ${owner.userId}, NULL, NULL)`,
    ).rejects.toMatchObject({ code: "ET022" });
  });

  it("refuses more answer rows than the cap, and a held contest lock ends in a 'try again' message, never a bare error", async () => {
    const s = await lockedProgram();
    const input = { programId: s.programId, setId: s.setId, questionId: s.qid, points: 10, timerSeconds: 20, correct: 2, reason: "Kunci jawaban salah ketik." };
    expect(await refused(as(owner, () => overrideQuestion(rt.sql, input, { maxAnswers: 2 })))).toMatch(/more than 2 answers/);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const locked = new Promise<void>((resolve) => (held = resolve));
    const holder = root.begin(async (tx) => {
      await tx`SELECT public.lock_program_contest(${s.programId})`;
      held();
      await gate;
    });
    await locked;
    const started = Date.now();
    expect(await refused(as(owner, () => overrideQuestion(rt.sql, input)))).toMatch(/busy/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500);
    release();
    await holder;
    expect((await answerRow(s.right.answerId)).points).toBe(10);
  });

  it("refuses an override on a set without attempts (edit the question directly)", async () => {
    const { programId, setId } = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Belum dimainkan?")));
    expect(await refused(as(owner, () => overrideQuestion(rt.sql, { programId, setId, questionId: qid, points: 5, timerSeconds: 20, correct: 1, reason: "Tidak perlu override di sini." })))).toMatch(/no attempts yet/);
  });

  it("the app pool ends a transaction left idle (the contest lock is never held by a stuck request)", async () => {
    const [row] = await rt.sql<{ v: string }[]>`SELECT current_setting('idle_in_transaction_session_timeout') AS v`;
    expect(row?.v).toBe("1min");
  });
});

// A 1x1 PNG followed by text a polyglot would carry after IEND.
const PNG = Buffer.concat([
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  Buffer.from("<script>alert(1)</script>"),
]);

describe("content images", () => {
  it("re-encodes a question image to WebP under images/, links it, and never stores the original bytes", async () => {
    const { programId, setId } = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Gambar?")));
    await as(owner, async () => setQuestionImage(rt.sql, owner, { programId, setId, questionId: qid }, await storeImage(settings, { bytes: PNG, filename: "soal.png", mimeType: "image/png" })));
    const row = await one(root<{ path: string; type: string; kind: string }[]>`
      SELECT u.storage_path AS path, u.content_type AS type, u.kind FROM questions q JOIN uploads u ON u.id = q.image_upload_id WHERE q.id = ${qid}`);
    expect(row).toMatchObject({ type: "image/webp", kind: "image" });
    expect(row.path).toMatch(/^images\/[0-9a-f-]{36}\.webp$/);
    const stored = await readFile(join(dataDir, row.path));
    expect(stored.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(stored.subarray(8, 12).toString("latin1")).toBe("WEBP");
    expect(stored.includes(Buffer.from("<script>"))).toBe(false);
  });

  it("refuses Staff on a locked set and SVG anywhere, leaving no file behind", async () => {
    const { programId, setId } = await program();
    const qid = await as(owner, () => createQuestion(rt.sql, owner, programId, setId, draft("Terkunci?")));
    await answered(programId, setId, qid, 1, 3, phone());
    const before = (await readdir(join(dataDir, "images")).catch(() => [])).length;
    const ctx: RouteContext = { rt, req: { headers: new Headers(), ip: null }, admin: { userId: staff.userId, sessionId: "s", role: "staff", displayName: "x" } };
    const response = await as(staff, () =>
      triviaImage(ctx, new Request(`http://admin.test/uploads/image/trivia?program=${programId}&set=${setId}&question=${qid}`, { method: "POST", headers: { "content-type": "image/png", "x-file-name": "soal.png" }, body: PNG })),
    );
    expect(response.status).toBe(403);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await refused(storeImage(settings, { bytes: svg, filename: "x.svg", mimeType: "image/svg+xml" }))).toMatch(/SVG/);
    expect((await readdir(join(dataDir, "images"))).length).toBe(before);
  });
});

describe("prize tiers, legal pages, limits (Owner settings, audited before / after)", () => {
  it("prize tiers: no overlapping ranks, audited, final after the results snapshot", async () => {
    const { programId } = await program();
    const first = await as(owner, () => createPrizeTier(rt.sql, programId, { rankFrom: 1, rankTo: 1, name: "Juara 1", description: null, valueIdr: 5_000_000 }));
    expect(await refused(as(owner, () => createPrizeTier(rt.sql, programId, { rankFrom: 1, rankTo: 3, name: "Bentrok", description: null, valueIdr: 1 })))).toMatch(/overlap/);
    const second = await as(owner, () => createPrizeTier(rt.sql, programId, { rankFrom: 2, rankTo: 5, name: "Hiburan", description: null, valueIdr: 100_000 }));
    expect(await refused(as(owner, () => updatePrizeTier(rt.sql, programId, second, { rankFrom: 1, rankTo: 5, name: "Hiburan", description: null, valueIdr: 100_000 })))).toMatch(/overlap/);
    await as(owner, () => updatePrizeTier(rt.sql, programId, first, { rankFrom: 1, rankTo: 1, name: "Juara 1", description: "Voucher belanja", valueIdr: 7_500_000 }));
    expect((await lastAudit("prize_tier.update")).changes).toEqual({ description: { before: null, after: "Voucher belanja" }, value_idr: { before: 5_000_000, after: 7_500_000 }, program_id: programId });
    await root`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]')`;
    expect(await refused(as(owner, () => deletePrizeTier(rt.sql, programId, second)))).toMatch(/final/);
    expect(await refused(as(owner, () => createPrizeTier(rt.sql, programId, { rankFrom: 9, rankTo: 9, name: "Telat", description: null, valueIdr: 1 })))).toMatch(/final/);
  });

  it("legal pages: every save a new draft version, publish the latest, published versions immutable", async () => {
    const { programId } = await program();
    expect(await as(owner, () => saveLegalDraft(rt.sql, programId, "terms", { title: "S&K", body: "# Ketentuan\nVersi satu." }))).toBe(1);
    expect(await as(owner, () => saveLegalDraft(rt.sql, programId, "terms", { title: "S&K", body: "# Ketentuan\nVersi dua." }))).toBe(2);
    expect(await refused(as(owner, () => saveLegalDraft(rt.sql, programId, "terms", { title: "S&K", body: "# Ketentuan\nVersi dua." })))).toMatch(/Nothing changed/);
    const versions = await listLegalVersions(rt.sql, programId);
    const [v2, v1] = versions;
    expect(await refused(as(owner, () => publishLegalPage(rt.sql, programId, "terms", v1?.id ?? "")))).toMatch(/Only the latest/);
    await as(owner, () => publishLegalPage(rt.sql, programId, "terms", v2?.id ?? ""));
    expect(await refused(as(owner, () => publishLegalPage(rt.sql, programId, "terms", v2?.id ?? "")))).toMatch(/already published/);
    const audit = await lastAudit("legal_page.publish");
    expect(audit.changes).toMatchObject({ kind: "terms", version: 2, published_at: { before: null } });
    const saved = (await lastAudit("legal_page.save")).changes as { version?: unknown; body_sha256?: { after?: unknown } };
    expect(saved.version).toEqual({ before: 1, after: 2 });
    expect(saved.body_sha256?.after).toMatch(/^[0-9a-f]{64}$/);
    await expect(rt.sql`UPDATE public.legal_pages SET body = 'x' WHERE id = ${v2?.id ?? ""}`).rejects.toMatchObject({ code: "ET073" });
    await expect(rt.sql`DELETE FROM public.legal_pages WHERE id = ${v1?.id ?? ""}`).rejects.toMatchObject({ code: "ET074" });
  });

  it("limits: bounded values saved per key with before / after, and read by SQL (the OTP expiry clamp)", async () => {
    const current = await getLimits(rt.sql);
    const next = { ...current, "otp.code_ttl_seconds": 120, "otp.cooldown_seconds": 30 };
    expect(await as(owner, () => saveLimits(rt.sql, owner.userId, next))).toBe(2);
    expect(await getLimits(rt.sql)).toEqual(next);
    const audit = await one(root<{ changes: unknown }[]>`SELECT changes FROM audit_log WHERE action = 'app_setting.update' AND entity_id = 'otp.code_ttl_seconds' ORDER BY id DESC LIMIT 1`);
    expect(audit.changes).toEqual({ value: { before: current["otp.code_ttl_seconds"], after: 120 } });
    expect(await refused(as(owner, () => saveLimits(rt.sql, owner.userId, next)))).toMatch(/Nothing changed/);
    // The player_otps trigger clamps a new code's expiry to the new validity.
    const otp = await one(root<{ ttl: number }[]>`
      INSERT INTO player_otps (phone, mac, sealed_code, expires_at) VALUES (${phone()}, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(54, 2)}, now() + interval '1 hour')
      RETURNING extract(epoch FROM expires_at - created_at)::int AS ttl`);
    expect(otp.ttl).toBe(120);
    await as(owner, () => saveLimits(rt.sql, owner.userId, current));
    // Every limit is a positive whole number (the database's positive-integer check), except the proactive WhatsApp delay, where 0 means "at once".
    expect(LIMITS.filter((l) => l.min < 1).map((l) => l.key)).toEqual(["delivery.wa_delay_seconds"]);
  });
});
