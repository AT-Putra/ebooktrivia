// US-027 (M9b): the question flow and the leaderboard over HTTP, against the real PostgreSQL (public_rw login), the
// real Valkey (ACL user `public`) and the real Better Auth player instance: every request carries a real session
// cookie and goes through withPlayer, as the routes do.
//   - a refresh keeps the timer; options are opaque ids without correctness (AC-Q9: the body and headers say
//     nothing about it before the answer); the answer reveals the correct option once;
//   - a double answer: one accepted (409 for the other); a parallel start: one attempt;
//   - IDOR: another player's attempt / answer row, another program's set or leaderboard: 403, the same as an
//     unknown id; no session 401, no Origin 403;
//   - play is rejected after the grace end (409 closed);
//   - the leaderboard: masked, the top N cached 5 s while the player's own rank is fresh, refreshes rate-limited;
//   - logout everywhere ends every session of the player;
//   - oracles: sql/play.sql play_unlocked_count equals core unlockedCount, and the live ranking equals core
//     compareFinal (D4), on random inputs.
import { randomBytes, randomInt } from "node:crypto";
import { compareFinal, issueMagicLink, unlockedCount } from "@ebooktrivia/core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { capProviders } from "../src/lib/cap-routes.ts";
import { createPlayAuth, PLAY_SESSION_COOKIE } from "../src/lib/play/auth.ts";
import { createPlayDb } from "../src/lib/play/db.ts";
import { handleLogoutAll, handleMagicLink, loadOtpSettings, type PlayDeps, readPlayer, withPlayer } from "../src/lib/play/handlers.ts";
import { createTopCache } from "../src/lib/play/leaderboard-cache.ts";
import { handleAnswer, handleCurrent, handleStartSet, LEADERBOARD_LIMITS, leaderboardHandler, limitPageLoad, PAGE_LIMITS, type PlayerHandler } from "../src/lib/play/trivia.ts";
import { CAPTCHA_KEY, DOMAIN, freshIp, one, publicSql, root, SMALL_CHALLENGES, suffix, uniquePhone, valkey } from "./support.ts";

const PLAY_ORIGIN = `https://play.${DOMAIN}`;
const playDb = createPlayDb(inject("publicDbUrl"));
afterAll(async () => {
  await playDb.close();
});
const auth = createPlayAuth({
  config: { playOrigin: PLAY_ORIGIN, playerAuthSecrets: [{ version: 1, value: randomBytes(32).toString("hex") }], otpPepper: randomBytes(32) },
  sql: publicSql,
  db: playDb.db,
  log: () => undefined,
  maxAttempts: async () => (await loadOtpSettings(publicSql))["otp.max_attempts"],
});
const deps: PlayDeps = {
  sql: publicSql,
  valkey,
  auth,
  capFor: capProviders(valkey, CAPTCHA_KEY, SMALL_CHALLENGES),
  sealer: { sealOtp: () => Buffer.alloc(54) },
  otpPepper: randomBytes(32),
  playOrigin: PLAY_ORIGIN,
  log: () => undefined,
  defer: () => undefined,
};

type Json = Record<string, unknown>;

interface Req {
  readonly cookie?: string | null;
  readonly origin?: string | null;
  readonly method?: string;
  readonly ip?: string;
}
function request(path: string, body: unknown, options: Req = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": options.ip ?? freshIp(), "user-agent": "trivia-int-test/1.0" };
  if (options.origin !== null) headers["origin"] = options.origin ?? PLAY_ORIGIN;
  if (options.cookie !== undefined && options.cookie !== null) headers["cookie"] = options.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${PLAY_ORIGIN}${path}`, { method: options.method ?? "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** Runs a player route as its route file does: withPlayer, then the handler with the session's player. */
const route = (handler: PlayerHandler, req: Request) => withPlayer(deps, req, (playerId) => handler(deps, req, playerId));

/** A player of `programId` (eligible), signed in with a magic link: the session cookie. */
async function signedIn(programId: string, name = "Budi Santoso"): Promise<{ id: string; cookie: string }> {
  const phone = uniquePhone();
  const player = await one(root<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${phone}, ${name}) RETURNING id`);
  await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${programId}, now(), true)`;
  return { id: player.id, cookie: await sessionOf(player.id) };
}
async function sessionOf(playerId: string): Promise<string> {
  const link = issueMagicLink({ channel: "whatsapp" });
  await root`SELECT issue_magic_link(${playerId}, 'whatsapp', ${link.tokenHash})`;
  const response = await handleMagicLink(deps, request("/api/v1/play/auth/magic-link", { channel: "whatsapp", token: link.token }));
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${PLAY_SESSION_COOKIE}=`));
  return (cookie ?? "").split(";")[0] ?? "";
}

/** A published program on sale with `sets` sets of 2 questions (10 points, 20 s, option 1 correct, an explanation). */
async function program(sets = 2): Promise<{ id: string; setIds: string[]; correct: Map<string, string> }> {
  const product = await one(root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const p = await one(root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days, leaderboard_top_n)
    VALUES (${product.id}, ${`prog-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30, 3) RETURNING id`);
  const setIds: string[] = [];
  const correct = new Map<string, string>();
  for (let s = 1; s <= sets; s++) {
    const set = await one(root<{ id: string }[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${p.id}, ${s}, ${`Set ${String(s)}`}) RETURNING id`);
    setIds.push(set.id);
    for (let q = 1; q <= 2; q++) {
      const question = await one(root<{ id: string }[]>`
        INSERT INTO questions (set_id, position, prompt, points, timer_seconds, explanation)
        VALUES (${set.id}, ${q}, ${`Pertanyaan ${String(q)}`}, 10, 20, 'Karena begitu') RETURNING id`);
      const [right] = await root<{ id: string }[]>`
        INSERT INTO question_options (question_id, position, label, is_correct)
        VALUES (${question.id}, 1, 'Benar', true), (${question.id}, 2, 'Salah', false), (${question.id}, 3, 'Keliru', false) RETURNING id`;
      correct.set(question.id, right?.id ?? "");
    }
  }
  return { id: p.id, setIds, correct };
}

const json = async (response: Response): Promise<Json> => (await response.json()) as Json;
const start = (cookie: string, setId: string, options: Req = {}) => route(handleStartSet, request("/api/v1/play/sets/start", { set_id: setId }, { cookie, ...options }));
const current = (cookie: string, attemptId: string, options: Req = {}) => route(handleCurrent, request("/api/v1/play/attempts/current", { attempt_id: attemptId }, { cookie, ...options }));
const answer = (cookie: string, answerId: string, optionId: string, options: Req = {}) =>
  route(handleAnswer, request("/api/v1/play/attempts/answer", { answer_id: answerId, option_id: optionId }, { cookie, ...options }));
const questionOf = async (answerId: string) => (await one(root<{ q: string }[]>`SELECT question_id AS q FROM attempt_questions WHERE id = ${answerId}`)).q;

describe("the question flow over HTTP", () => {
  let p: Awaited<ReturnType<typeof program>>;
  beforeAll(async () => {
    p = await program();
  });

  it("serves once and keeps the timer on a refresh; nothing about correctness before the answer, the reveal after it", async () => {
    const me = await signedIn(p.id);
    const started = await start(me.cookie, p.setIds[0] ?? "");
    expect(started.status).toBe(200);
    const attemptId = String((await json(started))["attempt_id"]);
    const first = await current(me.cookie, attemptId);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const shown = await json(first);
    expect(shown).toMatchObject({ v: 1, state: "question", position: 1, total: 2, window_ms: 20_000 });
    const answerId = String(shown["answer_id"]);
    // AC-Q9: the payload and the headers carry nothing about which option is right.
    expect(JSON.stringify(shown)).not.toMatch(/correct|explanation|points/i);
    expect([...first.headers.keys()].sort()).toEqual(["cache-control", "content-type", "x-content-type-options"]);
    const correctOption = p.correct.get(await questionOf(answerId)) ?? "";
    const options = shown["options"] as { id: string; label: string }[];
    expect(options.map((o) => o.id)).toContain(correctOption);
    // A refresh 5 s later: the same question, 5 s less, the stored serve untouched.
    await root`UPDATE attempt_questions SET served_at = served_at - interval '5 seconds', deadline_at = deadline_at - interval '5 seconds' WHERE id = ${answerId}`;
    const refreshed = await json(await current(me.cookie, attemptId));
    expect(refreshed["answer_id"]).toBe(answerId);
    expect(Number(refreshed["remaining_ms"])).toBeLessThanOrEqual(15_000);
    expect(refreshed["options"]).toEqual(options);
    const result = await answer(me.cookie, answerId, correctOption);
    expect(result.status).toBe(200);
    expect(await json(result)).toMatchObject({ v: 1, state: "answered", correct: true, points: 10, correct_option_id: correctOption, explanation: "Karena begitu" });
  });

  it("records exactly one of two concurrent answers (both see the recorded pick's reveal; a timeout's stays 409), and starts ONE attempt for parallel starts", async () => {
    const me = await signedIn(p.id);
    const starts = await Promise.all(Array.from({ length: 5 }, () => start(me.cookie, p.setIds[0] ?? "")));
    const ids = await Promise.all(starts.map(async (r) => String((await json(r))["attempt_id"])));
    expect(starts.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(ids).size).toBe(1);
    expect((await root`SELECT 1 FROM set_attempts WHERE player_id = ${me.id}`).length).toBe(1);
    const attemptId = ids[0] ?? "";
    const answerId = String((await json(await current(me.cookie, attemptId)))["answer_id"]);
    const correctOption = p.correct.get(await questionOf(answerId)) ?? "";
    const wrongOption = (await one(root<{ id: string }[]>`SELECT id FROM question_options WHERE question_id = ${await questionOf(answerId)} AND NOT is_correct LIMIT 1`)).id;
    const both = await Promise.all([answer(me.cookie, answerId, correctOption), answer(me.cookie, answerId, wrongOption)]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    // The second (ET144) is the reveal of the pick that was recorded, not its own.
    const recorded = (await one(root<{ option_id: string }[]>`SELECT option_id FROM attempt_questions WHERE id = ${answerId} AND answered_at IS NOT NULL`)).option_id;
    for (const body of await Promise.all(both.map(json))) {
      expect(body).toMatchObject({ v: 1, state: "answered", option_id: recorded, correct: recorded === correctOption, correct_option_id: correctOption });
    }
    // A question closed as a timeout has no pick to reveal: an answer to it stays 409.
    const second = String((await json(await current(me.cookie, attemptId)))["answer_id"]);
    await root`UPDATE attempt_questions SET served_at = served_at - interval '25 seconds', deadline_at = deadline_at - interval '25 seconds' WHERE id = ${second}`;
    expect(await json(await current(me.cookie, attemptId))).toMatchObject({ state: "finished", timed_out: 1 });
    const late = await answer(me.cookie, second, p.correct.get(await questionOf(second)) ?? "");
    expect(late.status).toBe(409);
    expect(await json(late)).toEqual({ v: 1, error: "already_answered" });
  });

  it("refuses another player's attempt and answer row, another program's set and an unknown id alike: 403 forbidden", async () => {
    const owner = await signedIn(p.id);
    const intruder = await signedIn(p.id);
    const attemptId = String((await json(await start(owner.cookie, p.setIds[0] ?? "")))["attempt_id"]);
    const answerId = String((await json(await current(owner.cookie, attemptId)))["answer_id"]);
    const correctOption = p.correct.get(await questionOf(answerId)) ?? "";
    const other = await program(1);
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const response of [
      await current(intruder.cookie, attemptId),
      await answer(intruder.cookie, answerId, correctOption),
      await start(intruder.cookie, other.setIds[0] ?? ""),
      await current(intruder.cookie, unknown),
      await answer(intruder.cookie, unknown, correctOption),
      await start(intruder.cookie, unknown),
    ]) {
      expect(response.status).toBe(403);
      expect(await json(response)).toEqual({ v: 1, error: "forbidden" });
    }
    // The owner's question is still open, untouched by the intruder.
    expect((await root`SELECT 1 FROM attempt_questions WHERE id = ${answerId} AND answered_at IS NULL`).length).toBe(1);
    // A locked set: 409; malformed ids: 400.
    expect(await json(await start(owner.cookie, p.setIds[1] ?? ""))).toEqual({ v: 1, error: "locked" });
    expect((await start(owner.cookie, "not-a-uuid")).status).toBe(400);
  });

  it("needs a session (401) and the exact Origin on every POST (403 origin, before the session is read)", async () => {
    const me = await signedIn(p.id);
    expect((await start(me.cookie, p.setIds[0] ?? "", { origin: null })).status).toBe(403);
    expect((await start(me.cookie, p.setIds[0] ?? "", { origin: "https://order.ebooktrivia.example.test" })).status).toBe(403);
    expect(await json(await start("", p.setIds[0] ?? ""))).toEqual({ v: 1, error: "unauthenticated" });
    expect((await root`SELECT 1 FROM set_attempts WHERE player_id = ${me.id}`).length).toBe(0);
  });

  it("rejects play after the grace end: no start (409 closed), no next question", async () => {
    const q = await program(2);
    const me = await signedIn(q.id);
    await root`UPDATE player_programs SET first_paid_at = now() - interval '40 days' WHERE player_id = ${me.id}`;
    const attemptId = String((await json(await start(me.cookie, q.setIds[0] ?? "")))["attempt_id"]);
    await root`UPDATE programs SET sales_start_at = now() - interval '50 days', sales_end_at = now() - interval '3 days', grace_days = 2 WHERE id = ${q.id}`;
    expect(await json(await start(me.cookie, q.setIds[1] ?? ""))).toEqual({ v: 1, error: "closed" });
    expect(await json(await current(me.cookie, attemptId))).toEqual({ v: 1, state: "closed", timed_out: 0 });
  });
});

describe("the leaderboard over HTTP", () => {
  it("answers the masked top N (cached 5 s) with the player's own rank fresh; another program is 403; refreshes are limited", async () => {
    const p = await program(1);
    let now = 1_000_000;
    const handler = leaderboardHandler(createTopCache(() => now));
    const board = (cookie: string, programId = p.id, ip?: string) =>
      route(handler, request(`/api/v1/play/leaderboard?program=${programId}`, undefined, { cookie, method: "GET", origin: null, ...(ip === undefined ? {} : { ip }) }));
    const ayu = await signedIn(p.id, "Ayu Lestari");
    const budi = await signedIn(p.id, "Budi Santoso");
    await root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms) VALUES (${ayu.id}, ${p.id}, 20, 9000)`;
    const first = await json(await board(budi.cookie));
    // D8: Budi has answered nothing, and still ranks, with every timer of the program (two 20 s questions).
    expect(first).toMatchObject({
      v: 1,
      top: [
        { rank: 1, name: "A*** L***", score: 20, total_ms: 9000, finished: false },
        { rank: 2, name: "B*** S***", score: 0, total_ms: 40_000, finished: false },
      ],
      me: { rank: 2, name: "B*** S***", score: 0, total_ms: 40_000, ranked: 2 },
    });
    expect(JSON.stringify(first)).not.toContain(ayu.id);
    // Budi scores: his own rank is fresh at once, the top N stays cached until 5 s have passed.
    await root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms) VALUES (${budi.id}, ${p.id}, 30, 9000)`;
    const cached = await json(await board(budi.cookie));
    expect(cached["top"]).toEqual(first["top"]);
    expect(cached["me"]).toMatchObject({ rank: 1, score: 30, ranked: 2 });
    now += 5_000;
    expect(((await json(await board(budi.cookie)))["top"] as Json[]).map((r) => r["name"])).toEqual(["B*** S***", "A*** L***"]);
    // Another program's board: 403, the same as an unknown one; a malformed id: 400.
    const other = await program(1);
    expect(await json(await board(budi.cookie, other.id))).toEqual({ v: 1, error: "forbidden" });
    expect(await json(await board(budi.cookie, "00000000-0000-4000-8000-000000000000"))).toEqual({ v: 1, error: "forbidden" });
    expect((await board(budi.cookie, "x")).status).toBe(400);
    // The per-player refresh budget (the calls above count too).
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < LEADERBOARD_LIMITS.perPlayer; i++) statuses.push((await board(ayu.cookie, p.id, ip)).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(LEADERBOARD_LIMITS.perPlayer);
    const limited = await board(ayu.cookie, p.id, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("the trivia pages' load budget (security review LOW-2)", () => {
  it("counts PAGE_LIMITS.perPlayer loads a minute per player, then refuses with a wait; other players are not affected", async () => {
    const p = await program(1);
    const me = await signedIn(p.id);
    const other = await signedIn(p.id);
    for (let i = 0; i < PAGE_LIMITS.perPlayer; i++) expect((await limitPageLoad(valkey, me.id)).allowed).toBe(true);
    const refused = await limitPageLoad(valkey, me.id);
    expect(refused).toMatchObject({ allowed: false });
    expect(refused.allowed ? 0 : refused.retryAfterSeconds).toBeGreaterThan(0);
    expect((await limitPageLoad(valkey, other.id)).allowed).toBe(true);
  });
});

describe("logout everywhere", () => {
  it("ends every session of the player, and only theirs", async () => {
    const p = await program(1);
    const me = await signedIn(p.id);
    const phone2 = await sessionOf(me.id);
    const someoneElse = await signedIn(p.id);
    const sessionPlayer = (cookie: string) => readPlayer(deps, new Headers({ cookie }));
    expect(await sessionPlayer(phone2)).toBe(me.id);
    expect((await handleLogoutAll(deps, request("/api/v1/play/auth/logout-all", {}, { cookie: me.cookie, origin: null }))).status).toBe(403);
    const response = await handleLogoutAll(deps, request("/api/v1/play/auth/logout-all", {}, { cookie: me.cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join()).toContain(`${PLAY_SESSION_COOKIE}=;`);
    expect(await sessionPlayer(me.cookie)).toBeNull();
    expect(await sessionPlayer(phone2)).toBeNull();
    expect(await sessionPlayer(someoneElse.cookie)).toBe(someoneElse.id);
  });
});

describe("oracles: sql/play.sql against @ebooktrivia/core", () => {
  const DAY = 86_400_000;

  it("play_unlocked_count equals core unlockedCount (max rule) on random schedules, times and floors", async () => {
    const cases = Array.from({ length: 400 }, () => {
      const setCount = randomInt(0, 120);
      const salesEnd = new Date(Date.UTC(2027, 0, 1) + randomInt(0, 400) * DAY + randomInt(0, DAY));
      const graceDays = randomInt(0, 90);
      const firstPaidAt = new Date(salesEnd.getTime() - randomInt(1, 200 * DAY));
      const now = new Date(firstPaidAt.getTime() + randomInt(-2 * DAY, 300 * DAY));
      const attempted = setCount === 0 ? 0 : randomInt(0, setCount + 1);
      const floor = setCount === 0 ? 0 : randomInt(0, setCount + 1);
      return { setCount, salesEnd, graceDays, firstPaidAt, now, attempted, floor };
    });
    // Day boundaries exactly: 00:00 WIB and one millisecond before.
    const boundary = new Date(Date.UTC(2027, 5, 9, 17));
    cases.push(
      { setCount: 90, salesEnd: new Date(Date.UTC(2027, 5, 30, 17)), graceDays: 30, firstPaidAt: new Date(Date.UTC(2027, 5, 1, 3)), now: boundary, attempted: 0, floor: 0 },
      { setCount: 90, salesEnd: new Date(Date.UTC(2027, 5, 30, 17)), graceDays: 30, firstPaidAt: new Date(Date.UTC(2027, 5, 1, 3)), now: new Date(boundary.getTime() - 1), attempted: 0, floor: 0 },
    );
    const rows = await root<{ i: number; n: number }[]>`
      SELECT c.i, public.play_unlocked_count(c.sales_end, c.grace_days, c.set_count, c.first_paid_at, c.now, c.attempted, c.floor) AS n
        FROM jsonb_to_recordset(${JSON.stringify(cases.map((c, i) => ({ i, sales_end: c.salesEnd.toISOString(), grace_days: c.graceDays, set_count: c.setCount, first_paid_at: c.firstPaidAt.toISOString(), now: c.now.toISOString(), attempted: c.attempted, floor: c.floor })))}::text::jsonb)
             AS c(i int, sales_end timestamptz, grace_days int, set_count int, first_paid_at timestamptz, now timestamptz, attempted int, floor int)
       ORDER BY c.i`;
    expect(rows.map((r) => r.n)).toEqual(cases.map((c) => unlockedCount(c)));
  });

  it("the live ranking (play_ranking) equals core compareFinal on random stats with many ties", async () => {
    const p = await program(1);
    const players: { playerId: string; score: number; totalMs: number; finishedAt: Date | null; firstPaidAt: Date | null }[] = [];
    for (let i = 0; i < 40; i++) {
      const player = await one(root<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${uniquePhone()}, 'Pemain') RETURNING id`);
      const firstPaidAt = new Date(Date.UTC(2027, 0, 1) + randomInt(0, 3) * DAY);
      const entry = { playerId: player.id, score: randomInt(0, 3) * 10, totalMs: randomInt(0, 3) * 1000, finishedAt: randomInt(0, 3) === 0 ? null : new Date(Date.UTC(2027, 1, 1) + randomInt(0, 2) * DAY), firstPaidAt };
      await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${p.id}, ${firstPaidAt}, true)`;
      await root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms, finished_at) VALUES (${player.id}, ${p.id}, ${entry.score}, ${entry.totalMs}, ${entry.finishedAt})`;
      players.push(entry);
    }
    const ranked = await root<{ player_id: string; rank: number }[]>`SELECT player_id, rank FROM public.play_ranking(${p.id}) ORDER BY rank`;
    expect(ranked.map((r) => r.rank)).toEqual(players.map((_, i) => i + 1));
    expect(ranked.map((r) => r.player_id)).toEqual([...players].sort(compareFinal).map((e) => e.playerId));
  });
});
