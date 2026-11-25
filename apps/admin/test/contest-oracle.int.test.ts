// The grace-end finalize, ranking and winners of the database (packages/db sql/contest.sql,
// public.create_leaderboard_snapshot) equal @ebooktrivia/core contest.ts finalizeContest, the oracle,
// on random play histories (property test): sets never started, questions without a row, never
// served / open / answered / late / clock-skewed rows, rows served at or after the grace end, outage
// extensions, missing deadlines,
// tampered stored scores, refunded players, players who never paid, exact ties and prize tiers.
// The SQL masking (public.mask_name / mask_phone: the order page and the snapshot) equals core maskName / maskPhone. The play
// board and the winners banner show the phone with public.mask_phone_tail since 2026-11-25 (tested in packages/db play-flow).
import { type ContestAnswer, type ContestInput, type ContestPlayer, type ContestQuestion, finalizeContest, maskName, maskPhone, maskPhoneTail } from "@ebooktrivia/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { root, suffix } from "./support.ts";

type Id = { id: string };
const DAY = 86_400_000;
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

type Play =
  | { readonly kind: "missing" }
  | { readonly kind: "unserved" }
  | { readonly kind: "closedUnserved"; readonly at: number }
  | { readonly kind: "open"; readonly served: number; readonly extension: number; readonly noDeadline: boolean }
  | { readonly kind: "answered"; readonly served: number; readonly after: number; readonly pick: "r" | "w" | null; readonly extension: number; readonly noDeadline: boolean }
  | { readonly kind: "servedAfterG"; readonly at: number; readonly answered: boolean };

const playArb: fc.Arbitrary<Play> = fc.oneof(
  fc.constant({ kind: "missing" as const }),
  fc.constant({ kind: "unserved" as const }),
  fc.record({ kind: fc.constant("closedUnserved" as const), at: fc.integer({ min: 0, max: 50_000 }) }),
  fc.record({
    kind: fc.constant("open" as const),
    served: fc.integer({ min: 0, max: 50_000 }),
    extension: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 600_000 })),
    noDeadline: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("answered" as const),
    served: fc.integer({ min: 0, max: 50_000 }),
    after: fc.integer({ min: -2_000, max: 40_000 }),
    pick: fc.constantFrom<"r" | "w" | null>("r", "w", null),
    extension: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 30_000 }) }),
    noDeadline: fc.boolean(),
  }),
  // Served at or after the grace end (only a trusted writer could): counts as never served.
  fc.record({ kind: fc.constant("servedAfterG" as const), at: fc.integer({ min: 0, max: 50_000 }), answered: fc.boolean() }),
);

const historyArb = fc.record({
  sets: fc.array(fc.array(fc.record({ timer: fc.constantFrom(5, 20, 30), points: fc.integer({ min: 0, max: 20 }) }), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
  players: fc.array(
    fc.record({
      kind: fc.constantFrom<"eligible" | "refunded" | "unpaid">("eligible", "eligible", "eligible", "refunded", "unpaid"),
      paidDay: fc.integer({ min: 0, max: 2 }),
      plays: fc.array(fc.option(fc.array(playArb, { minLength: 3, maxLength: 3 }), { nil: undefined }), { minLength: 3, maxLength: 3 }),
      stored: fc.integer({ min: 0, max: 50 }),
    }),
    { minLength: 1, maxLength: 6 },
  ),
  tiers: fc.constantFrom<readonly (readonly [number, number])[]>([], [[1, 1]], [[1, 2], [3, 4]], [[2, 3]]),
});

type History = typeof historyArb extends fc.Arbitrary<infer T> ? T : never;

/** Seeds one program as the history says; returns core's input with the database ids. */
async function seed(h: History): Promise<{ programId: string; input: ContestInput }> {
  const graceEnd = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const { id: programId } = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`oracle-${suffix()}${suffix()}`}, 'Oracle', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2) RETURNING id`);
  const setIds: string[] = [];
  const questions: (ContestQuestion & { right: string; wrong: string })[] = [];
  for (const [s, set] of h.sets.entries()) {
    const { id: setId } = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, ${s + 1}, 'Set') RETURNING id`);
    setIds.push(setId);
    for (const [i, q] of set.entries()) {
      const { id } = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${setId}, ${i + 1}, 'Q', ${q.points}, ${q.timer}) RETURNING id`);
      const [right, wrong] = await root<Id[]>`
        INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${id}, 1, 'A', true), (${id}, 2, 'B', false) RETURNING id`;
      questions.push({ id, setId, points: q.points, timerSeconds: q.timer, correctOptionId: right?.id ?? null, right: right?.id ?? "", wrong: wrong?.id ?? "" });
    }
  }
  const tiers = [];
  for (const [from, to] of h.tiers) tiers.push({ id: (await one(root<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${programId}, ${from}, ${to}, 'Hadiah') RETURNING id`)).id, rankFrom: from, rankTo: to });

  const base = graceEnd.getTime() - DAY;
  const players: ContestPlayer[] = [];
  const attempts: ContestInput["attempts"][number][] = [];
  const answers: ContestAnswer[] = [];
  for (const p of h.players) {
    const { id: playerId } = await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${`+62816${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`}, 'Pemain') RETURNING id`);
    const firstPaidAt = p.kind === "unpaid" ? null : new Date(graceEnd.getTime() - (20 - p.paidDay) * DAY);
    await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${playerId}, ${programId}, ${firstPaidAt}, ${p.kind === "eligible"})`;
    if (p.kind === "unpaid") continue; // never paid: no play, not in the contest
    players.push({ id: playerId, eligible: p.kind === "eligible", firstPaidAt });
    for (const [s, setId] of setIds.entries()) {
      const plays = p.plays[s];
      if (plays === undefined) continue;
      const { id: attemptId } = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id, score, total_ms) VALUES (${playerId}, ${setId}, ${p.stored}, ${p.stored}) RETURNING id`);
      attempts.push({ id: attemptId, playerId, setId });
      for (const [i, q] of questions.filter((x) => x.setId === setId).entries()) {
        const play = plays[i] ?? { kind: "missing" };
        if (play.kind === "missing") continue;
        let servedAt: Date | null = null;
        let deadlineAt: Date | null = null;
        let answeredAt: Date | null = null;
        let optionId: string | null = null;
        let extensionMs = 0;
        if (play.kind === "closedUnserved") answeredAt = new Date(base + play.at);
        if (play.kind === "open" || play.kind === "answered") {
          servedAt = new Date(base + play.served);
          extensionMs = play.noDeadline ? 0 : play.extension;
          deadlineAt = play.noDeadline ? null : new Date(servedAt.getTime() + q.timerSeconds * 1000 + extensionMs);
        }
        if (play.kind === "answered" && servedAt !== null) {
          answeredAt = new Date(servedAt.getTime() + play.after);
          optionId = play.pick === null ? null : play.pick === "r" ? q.right : q.wrong;
        }
        if (play.kind === "servedAfterG") {
          servedAt = new Date(graceEnd.getTime() + play.at);
          deadlineAt = new Date(servedAt.getTime() + q.timerSeconds * 1000);
          if (play.answered) {
            answeredAt = new Date(servedAt.getTime() + 2000);
            optionId = q.right;
          }
        }
        const { id } = await one(root<Id[]>`
          INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms)
          VALUES (${attemptId}, ${q.id}, ${i + 1}, ${[q.right, q.wrong]}::uuid[], ${servedAt}, ${deadlineAt === null ? null : new Date(deadlineAt.getTime() - extensionMs)},
                  ${answeredAt}, ${optionId}, true, ${p.stored}, ${p.stored})
          RETURNING id`);
        // An extension is the Owner's tool's alone, once (ET106 for any other writer): applied as its owner role.
        if (extensionMs > 0) {
          await root.begin(async (tx) => {
            await tx.unsafe("SET LOCAL ROLE contest_results");
            await tx`UPDATE public.attempt_questions SET deadline_at = deadline_at + ${extensionMs} * interval '1 millisecond', deadline_extension_ms = ${extensionMs} WHERE id = ${id}`;
          });
        }
        answers.push({ id, attemptId, questionId: q.id, optionId, servedAt, deadlineAt, answeredAt, extensionMs });
      }
    }
  }
  return { programId, input: { graceEnd, setIds, questions, players, attempts, answers, tiers } };
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

describe("create_leaderboard_snapshot equals core finalizeContest (property)", () => {
  it("on random play histories: every answer, attempt, stats row, snapshot entry and winner", async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (h) => {
        const { programId, input } = await seed(h);
        await root.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE worker_rw");
          await tx`SELECT public.create_leaderboard_snapshot(${programId}::uuid)`;
        });
        const expected = finalizeContest(input);

        const answers = await root<{ id: string; answered_at: Date; correct: boolean; points: number; elapsed_ms: number }[]>`
          SELECT aq.id, aq.answered_at, aq.correct, aq.points, aq.elapsed_ms FROM attempt_questions aq
            JOIN set_attempts a ON a.id = aq.attempt_id JOIN trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${programId} ORDER BY aq.id`;
        expect(answers.map((a) => ({ id: a.id, answeredAt: a.answered_at, correct: a.correct, points: a.points, elapsedMs: a.elapsed_ms }))).toEqual(
          [...expected.answers].sort((a, b) => (a.id < b.id ? -1 : 1)),
        );
        const attempts = await root<{ id: string; score: number; total_ms: string; finished_at: Date | null }[]>`
          SELECT a.id, a.score, a.total_ms::text, a.finished_at FROM set_attempts a JOIN trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${programId}`;
        expect(new Map(attempts.map((a) => [a.id, { score: a.score, totalMs: Number(a.total_ms), finishedAt: a.finished_at }]))).toEqual(
          new Map(expected.attempts.map((a) => [a.id, { score: a.score, totalMs: a.totalMs, finishedAt: a.finishedAt }])),
        );
        const stats = await root<{ player_id: string; score: number; total_ms: string; sets_completed: number; finished_at: Date | null }[]>`
          SELECT player_id, score, total_ms::text, sets_completed, finished_at FROM player_program_stats WHERE program_id = ${programId}`;
        expect(new Map(stats.map((s) => [s.player_id, { score: s.score, totalMs: Number(s.total_ms), setsCompleted: s.sets_completed, finishedAt: s.finished_at }]))).toEqual(
          new Map(expected.stats.map((s) => [s.playerId, { score: s.score, totalMs: s.totalMs, setsCompleted: s.setsCompleted, finishedAt: s.finishedAt }])),
        );
        const snapshot = await one(root<{ id: string; frozen_at: Date; entries: Record<string, unknown>[] }[]>`SELECT id, frozen_at, entries FROM leaderboard_snapshots WHERE program_id = ${programId}`);
        expect(snapshot.frozen_at).toEqual(input.graceEnd);
        expect(snapshot.entries).toEqual(
          expected.entries.map((e) => ({ rank: e.rank, player_id: e.playerId, score: e.score, total_ms: e.totalMs, finished_at: iso(e.finishedAt), sets_completed: e.setsCompleted, unplayed_ms: e.unplayedMs })),
        );
        const winners = await root<{ prize_tier_id: string; player_id: string; rank: number }[]>`SELECT prize_tier_id, player_id, rank FROM winners WHERE snapshot_id = ${snapshot.id} ORDER BY rank`;
        expect(winners.map((w) => ({ tierId: w.prize_tier_id, playerId: w.player_id, rank: w.rank }))).toEqual(expected.winners);
      }),
      { numRuns: 60 },
    );
  });
});

describe("public.mask_name / mask_phone equal core maskName / maskPhone (property)", () => {
  // Letters (ASCII, accented, combining, emoji, CJK), digits, punctuation, NBSP (not a separator)
  // and every ASCII whitespace character the rule splits on.
  const CHARS = ["a", "B", "z", "é", "é", "Ñ", "😀", "名", "7", "-", "*", ".", " ", " ", "\t", "\n", "\v", "\f", "\r"];
  const text = fc.array(fc.constantFrom(...CHARS), { maxLength: 24 }).map((parts) => parts.join(""));

  it("on random names", async () => {
    await fc.assert(
      fc.asyncProperty(text, async (name) => {
        const [row] = await root<{ masked: string }[]>`SELECT public.mask_name(${name}) AS masked`;
        expect(row?.masked).toBe(maskName(name));
      }),
      { numRuns: 300 },
    );
  });

  it("on random phones, and NULL", async () => {
    const phone = fc.array(fc.constantFrom("+", "6", "2", "8", "1", "0", "9", " ", "-", "x"), { maxLength: 18 }).map((parts) => parts.join(""));
    await fc.assert(
      fc.asyncProperty(phone, async (value) => {
        const [row] = await root<{ masked: string | null }[]>`SELECT public.mask_phone(${value}) AS masked`;
        expect(row?.masked).toBe(maskPhone(value));
      }),
      { numRuns: 200 },
    );
    const [none] = await root<{ masked: string | null }[]>`SELECT public.mask_phone(NULL) AS masked`;
    expect(none?.masked).toBeNull();
  });
});

describe("public.mask_phone_tail equals core maskPhoneTail (property; Owner decision 2026-11-25: the one masked form of a number)", () => {
  it("on random phones, and NULL", async () => {
    const phone = fc.array(fc.constantFrom("+", "6", "2", "8", "1", "0", "9", "5", " ", "-", "x"), { maxLength: 20 }).map((parts) => parts.join(""));
    await fc.assert(
      fc.asyncProperty(phone, async (value) => {
        const [row] = await root<{ masked: string }[]>`SELECT public.mask_phone_tail(${value}) AS masked`;
        expect(row?.masked).toBe(maskPhoneTail(value));
      }),
      { numRuns: 300 },
    );
    const [none] = await root<{ masked: string }[]>`SELECT public.mask_phone_tail(NULL) AS masked`;
    expect(none?.masked).toBe(maskPhoneTail(null));
  });
});
