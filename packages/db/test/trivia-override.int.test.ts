// US-018 (M5b) database guarantees:
//   - the question content lock has exactly one bypass, the Owner's scoring override function,
//     and no admin_rw / worker_rw / public_rw session can reach it any other way (no SET ROLE, no
//     GUC, no deleting or moving attempts or sets, no deleting the results snapshot);
//   - the override DERIVES every score it writes (security review H1: it takes no rows from the
//     caller), checks reason, actor and scope, writes its own audit row, and is refused once the
//     results snapshot exists or grace is over;
//   - bounds as CHECKs: question points / timer, program defaults, non-negative totals, whole-ms
//     answer timestamps, the OTP / rate-limit settings;
//   - the contest lock: exclusive vs shared;
//   - prize tier rank ranges never overlap within a program and freeze with the snapshot;
//   - legal page versions: drafts are inserted, published versions are immutable, none is deleted.
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { APP_SETTING_BOUNDS } from "../src/schema/governance.ts";
import { asRole, first, sql, sqlState, suffix, type Tx } from "./db.ts";
import { createAttempt, createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

type Id = { id: string };

interface Locked {
  programId: string;
  setId: string;
  q1: Question;
  q2: Question;
  playerId: string;
  attemptId: string;
  answerId: string;
}

/** Whole milliseconds, a minute ago (answer timestamps are whole ms, CHECK). */
const minuteAgo = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);

/** A program with a set whose q1 was answered right (option 1) after 10 s by one player: the set is locked. */
async function lockedSet(): Promise<Locked> {
  const { programId } = await createProgram();
  const { setId, q1, q2 } = await createTriviaSet(programId, 1);
  const { playerId } = await createPlayer({ programId, eligible: true });
  const attemptId = await createAttempt(playerId, setId);
  const served = minuteAgo();
  const answer = first(
    await sql<Id[]>`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms)
      VALUES (${attemptId}, ${q1.id}, 1, ${q1.options}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)},
              ${new Date(served.getTime() + 10_000)}, ${q1.options[0]}, true, 10, 10000)
      RETURNING id`,
  );
  await sql`UPDATE set_attempts SET score = 10, total_ms = 10000 WHERE id = ${attemptId}`;
  await sql`INSERT INTO player_program_stats (player_id, program_id, score, total_ms) VALUES (${playerId}, ${programId}, 10, 10000)`;
  return { programId, setId, q1, q2, playerId, attemptId, answerId: answer.id };
}

let ownerId = "";
let staffId = "";
beforeAll(async () => {
  for (const role of ["owner", "staff"] as const) {
    const id = `${role}-${suffix()}`;
    await sql`INSERT INTO admin_auth."user" (id, name, email, "emailVerified") VALUES (${id}, ${role}, ${`${id}@example.test`}, true)`;
    await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name) VALUES (${id}, ${role}, ${role})`;
    if (role === "owner") ownerId = id;
    else staffId = id;
  }
});

interface OverrideArgs {
  programId: string;
  setId: string;
  questionId: string;
  points: number;
  timer: number;
  correct: string;
  reason?: string;
  actor?: string | null;
}

/** Calls the override as `role`. */
function override(role: "admin_rw" | "worker_rw" | "public_rw" | "internal_rw", args: OverrideArgs, isolation?: string) {
  return asRole(
    role,
    (tx) => tx<{ result: Record<string, unknown> }[]>`
      SELECT public.override_question_scoring(${args.programId}, ${args.setId}, ${args.questionId}, ${args.points}, ${args.timer}, ${args.correct},
        ${args.reason ?? "Kunci jawaban salah ketik."}, ${args.actor === undefined ? ownerId : args.actor}, 'req-1', '198.51.100.9'::inet) AS result`,
    isolation,
  );
}

const answerRow = async (id: string) => first(await sql<{ correct: boolean | null; points: number; elapsed: number | null }[]>`SELECT correct, points, elapsed_ms AS elapsed FROM attempt_questions WHERE id = ${id}`);
const statsScore = async (playerId: string, programId: string) =>
  first(await sql<{ score: number; total: number }[]>`SELECT score, total_ms::int AS total FROM player_program_stats WHERE player_id = ${playerId} AND program_id = ${programId}`);

/** A throwaway LOGIN role in `group` (roles are cluster-global: dropped afterwards). */
async function asLogin<T>(group: string, fn: (db: postgres.Sql) => Promise<T>): Promise<T> {
  const name = `ebt_ovr_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(16).toString("hex");
  await sql.unsafe(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' IN ROLE ${group}`);
  const url = new URL(inject("dbUrl"));
  url.username = name;
  url.password = password;
  const db = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    return await fn(db);
  } finally {
    await db.end();
    await sql.unsafe(`DROP ROLE IF EXISTS ${name}`);
  }
}

describe("content lock bypass: only the override function", () => {
  let s: Locked;
  beforeAll(async () => {
    s = await lockedSet();
  });

  it("admin_rw cannot change points, timer or the correct option directly (ET020), whatever GUC it sets", async () => {
    for (const statement of [
      `UPDATE public.questions SET points = 99 WHERE id = '${s.q1.id}'`,
      `UPDATE public.questions SET timer_seconds = 5 WHERE id = '${s.q1.id}'`,
      `UPDATE public.question_options SET is_correct = false WHERE id = '${s.q1.options[0]}'`,
    ]) {
      expect(
        await sqlState(
          asRole("admin_rw", async (tx) => {
            for (const guc of ["ebt.override", "app.override", "trivia.override"]) await tx`SELECT set_config(${guc}, 'on', true)`;
            await tx.unsafe(statement);
          }),
        ),
      ).toBe("ET020");
    }
  });

  it("no session can become trivia_override: SET ROLE is refused for admin_rw, worker_rw and public_rw logins (42501)", async () => {
    for (const group of ["admin_rw", "worker_rw", "public_rw"]) {
      await asLogin(group, async (db) => {
        expect(await sqlState(db.unsafe("SET ROLE trivia_override"))).toBe("42501");
        expect(await sqlState(db.unsafe("SET SESSION AUTHORIZATION trivia_override"))).toBe("42501");
      });
    }
  });

  it("only admin_rw may call the override function (42501 for worker_rw, public_rw, internal_rw)", async () => {
    for (const role of ["worker_rw", "public_rw", "internal_rw"] as const) {
      expect(await sqlState(override(role, { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 20, timer: 20, correct: s.q1.options[0] }))).toBe("42501");
    }
  });

  it("admin_rw cannot unlock a set by deleting or moving its attempts, nor write play rows (42501)", async () => {
    const { setId: otherSet } = await createTriviaSet(s.programId, 2);
    for (const statement of [
      `DELETE FROM public.attempt_questions WHERE attempt_id = '${s.attemptId}'`,
      `DELETE FROM public.set_attempts WHERE id = '${s.attemptId}'`,
      `UPDATE public.set_attempts SET set_id = '${otherSet}' WHERE id = '${s.attemptId}'`,
      `UPDATE public.attempt_questions SET points = 1000 WHERE id = '${s.answerId}'`,
      `UPDATE public.player_program_stats SET score = 1000 WHERE player_id = '${s.playerId}'`,
      `INSERT INTO public.leaderboard_snapshots (program_id, frozen_at, entries) VALUES ('${s.programId}', now(), '[]')`,
    ]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });

  it("a set with attempts never moves to another program, for any writer (ET020, security review L1)", async () => {
    const { programId: other } = await createProgram();
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET program_id = ${other} WHERE id = ${s.setId}`))).toBe("ET020");
    expect(await sqlState(sql`UPDATE trivia_sets SET program_id = ${other} WHERE id = ${s.setId}`)).toBe("ET020");
    const { setId: free } = await createTriviaSet(s.programId, 9);
    await asRole("admin_rw", (tx) => tx`UPDATE public.trivia_sets SET program_id = ${other} WHERE id = ${free}`);
  });

  it("the worker cannot edit questions at all (42501)", async () => {
    expect(await sqlState(asRole("worker_rw", (tx) => tx`UPDATE public.questions SET points = 99 WHERE id = ${s.q1.id}`))).toBe("42501");
  });

  it("trivia_override itself holds only the scored columns: no insert, delete, reorder, text change or stored-pick change", async () => {
    for (const statement of [
      `INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds) VALUES ('${s.setId}', 9, 'x', 10, 20)`,
      `DELETE FROM public.question_options WHERE id = '${s.q1.options[2]}'`,
      `UPDATE public.questions SET position = 9 WHERE id = '${s.q1.id}'`,
      `UPDATE public.questions SET prompt = 'x' WHERE id = '${s.q1.id}'`,
      `UPDATE public.attempt_questions SET option_id = NULL WHERE id = '${s.answerId}'`,
      `UPDATE public.attempt_questions SET answered_at = NULL WHERE id = '${s.answerId}'`,
      `UPDATE public.set_attempts SET player_id = gen_random_uuid() WHERE id = '${s.attemptId}'`,
      `UPDATE public.player_program_stats SET program_id = gen_random_uuid() WHERE player_id = '${s.playerId}'`,
    ]) {
      expect(
        await sqlState(
          sql.begin(async (tx) => {
            await tx.unsafe("SET LOCAL ROLE trivia_override");
            await tx.unsafe(statement);
          }),
        ),
        statement,
      ).toBe("42501");
    }
  });
});

describe("override_question_scoring derives every score it writes", () => {
  it("re-scores the question's answers, the attempt and the stats from the answer rows, and writes its own audit row", async () => {
    const s = await lockedSet();
    const [row] = await override("admin_rw", { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 15, timer: 30, correct: s.q1.options[1], reason: "  Kunci jawaban salah ketik.  " });
    expect(row?.result).toMatchObject({ question_changed: true, options_changed: true, players: 1, answers_scored: 1, answers_changed: 1, attempts_changed: 1, stats_changed: 1, score_before: 10, score_after: 0 });
    expect(first(await sql<{ points: number; timer: number }[]>`SELECT points, timer_seconds AS timer FROM questions WHERE id = ${s.q1.id}`)).toEqual({ points: 15, timer: 30 });
    expect((await sql<Id[]>`SELECT id FROM question_options WHERE question_id = ${s.q1.id} AND is_correct`).map((o) => o.id)).toEqual([s.q1.options[1]]);
    expect(await answerRow(s.answerId)).toEqual({ correct: false, points: 0, elapsed: 10000 });
    expect(await statsScore(s.playerId, s.programId)).toEqual({ score: 0, total: 10000 });
    const audit = first(
      await sql<{ actor: string; action: string; entity: string; changes: Record<string, unknown>; request: string; ip: string }[]>`
        SELECT actor_admin_user_id AS actor, action, entity_id AS entity, changes, request_id AS request, host(ip) AS ip
          FROM audit_log WHERE action = 'question.rescore_override' AND entity_id = ${s.q1.id}`,
    );
    expect(audit).toMatchObject({ actor: ownerId, action: "question.rescore_override", request: "req-1", ip: "198.51.100.9" });
    expect(audit.changes).toMatchObject({ points: { before: 10, after: 15 }, timer_seconds: { before: 20, after: 30 }, correct_option: { before: 1, after: 2 }, reason: "Kunci jawaban salah ketik.", score_before: 10, score_after: 0 });
    expect(JSON.stringify(audit.changes)).not.toContain(s.playerId);
    // The lock is back in force right after it, in another transaction.
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.questions SET points = 5 WHERE id = ${s.q1.id}`))).toBe("ET020");
  });

  it("an unchanged rule restores scores tampered with elsewhere: nothing the caller sends can set a score (security review H1)", async () => {
    const s = await lockedSet();
    await sql`UPDATE attempt_questions SET points = 1000000 WHERE id = ${s.answerId}`;
    await sql`UPDATE player_program_stats SET score = 1000000 WHERE player_id = ${s.playerId}`;
    const [row] = await override("admin_rw", { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 10, timer: 20, correct: s.q1.options[0] });
    expect(row?.result).toMatchObject({ question_changed: false, options_changed: false, answers_changed: 1, score_after: 10 });
    expect(await answerRow(s.answerId)).toEqual({ correct: true, points: 10, elapsed: 10000 });
    expect(await statsScore(s.playerId, s.programId)).toEqual({ score: 10, total: 10000 });
  });

  it("is refused once the program's results snapshot exists, its contest has ended or grace is over (ET022)", async () => {
    const s = await lockedSet();
    const args = { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 20, timer: 20, correct: s.q1.options[0] };
    await sql`UPDATE programs SET status = 'awaiting_confirmation' WHERE id = ${s.programId}`;
    expect(await sqlState(override("admin_rw", args))).toBe("ET022");
    await sql`UPDATE programs SET status = 'published' WHERE id = ${s.programId}`;
    const ended = await lockedSet();
    await sql`UPDATE programs SET sales_start_at = now() - interval '40 days', sales_end_at = now() - interval '31 days', grace_days = 30 WHERE id = ${ended.programId}`;
    expect(await sqlState(override("admin_rw", { programId: ended.programId, setId: ended.setId, questionId: ended.q1.id, points: 20, timer: 20, correct: ended.q1.options[0] }))).toBe("ET022");
    await sql`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${s.programId}, now(), '[]')`;
    expect(await sqlState(override("admin_rw", args))).toBe("ET022");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.leaderboard_snapshots WHERE program_id = ${s.programId}`))).toBe("42501");
    expect(first(await sql<{ points: number }[]>`SELECT points FROM questions WHERE id = ${s.q1.id}`).points).toBe(10);
  });

  it("checks ids against their parents, the reason and the actor (ET023)", async () => {
    const s = await lockedSet();
    const other = await lockedSet();
    const base: OverrideArgs = { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 10, timer: 20, correct: s.q1.options[0] };
    const cases: [string, OverrideArgs][] = [
      ["question of another set", { ...base, questionId: other.q1.id }],
      ["set of another program", { ...base, programId: other.programId }],
      ["option of another question", { ...base, correct: s.q2.options[0] }],
      ["a reason under 10 characters", { ...base, reason: "salah" }],
      ["a reason with an e-mail address", { ...base, reason: "Dilaporkan budi@example.test" }],
      ["a reason with a phone number", { ...base, reason: "Pemain 0812 3456 7890 melapor" }],
      ["no actor", { ...base, actor: null }],
      ["a Staff actor", { ...base, actor: staffId }],
      ["an unknown actor", { ...base, actor: "nobody" }],
    ];
    for (const [what, args] of cases) expect(await sqlState(override("admin_rw", args)), what).toBe("ET023");
    expect(await answerRow(other.answerId)).toEqual({ correct: true, points: 10, elapsed: 10000 });
  });

  it.each(["repeatable read", "serializable"])("must run under READ COMMITTED (ET021 under %s)", async (level) => {
    const s = await lockedSet();
    expect(await sqlState(override("admin_rw", { programId: s.programId, setId: s.setId, questionId: s.q1.id, points: 20, timer: 20, correct: s.q1.options[0] }, `isolation level ${level}`))).toBe("ET021");
  });
});

describe("bounds and precision as CHECKs (every writer)", () => {
  it("question points 0-1000 and timer 5-600 s; program defaults the same; totals never negative", async () => {
    const { programId } = await createProgram();
    const { q1, setId } = await createTriviaSet(programId, 1);
    for (const statement of [
      `UPDATE questions SET points = 1001 WHERE id = '${q1.id}'`,
      `UPDATE questions SET points = -1 WHERE id = '${q1.id}'`,
      `UPDATE questions SET timer_seconds = 4 WHERE id = '${q1.id}'`,
      `UPDATE questions SET timer_seconds = 601 WHERE id = '${q1.id}'`,
      `UPDATE programs SET default_points = 1001 WHERE id = '${programId}'`,
      `UPDATE programs SET default_timer_seconds = 4 WHERE id = '${programId}'`,
    ]) {
      expect(await sqlState(sql.unsafe(statement)), statement).toBe("23514");
    }
    await sql`UPDATE questions SET points = 1000, timer_seconds = 600 WHERE id = ${q1.id}`;
    await sql`UPDATE questions SET points = 0, timer_seconds = 5 WHERE id = ${q1.id}`;
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await createAttempt(playerId, setId);
    for (const statement of [
      `INSERT INTO player_program_stats (player_id, program_id, score) VALUES ('${playerId}', '${programId}', -1)`,
      `INSERT INTO player_program_stats (player_id, program_id, total_ms) VALUES ('${playerId}', '${programId}', -1)`,
      `INSERT INTO player_program_stats (player_id, program_id, sets_completed) VALUES ('${playerId}', '${programId}', -1)`,
      `UPDATE set_attempts SET score = -1 WHERE id = '${attemptId}'`,
    ]) {
      expect(await sqlState(sql.unsafe(statement)), statement).toBe("23514");
    }
  });

  it("answer and finish timestamps hold whole milliseconds (security review L3)", async () => {
    const { programId } = await createProgram();
    const { q1, setId } = await createTriviaSet(programId, 1);
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await createAttempt(playerId, setId);
    const micro = "2027-01-01 00:00:00.000123+00";
    for (const column of ["served_at", "deadline_at", "answered_at"]) {
      expect(
        await sqlState(sql.unsafe(`INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, ${column}) VALUES ('${attemptId}', '${q1.id}', 1, '{}', '${micro}')`)),
        column,
      ).toBe("23514");
    }
    expect(await sqlState(sql.unsafe(`UPDATE set_attempts SET finished_at = '${micro}' WHERE id = '${attemptId}'`))).toBe("23514");
    expect(await sqlState(sql.unsafe(`INSERT INTO player_program_stats (player_id, program_id, finished_at) VALUES ('${playerId}', '${programId}', '${micro}')`))).toBe("23514");
    await sql`UPDATE set_attempts SET finished_at = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${attemptId}`;
  });

  it("admin_rw cannot delete a setting (security review N3: a missing otp.phone_cap would break OTP and checkout)", async () => {
    for (const key of [...Object.keys(APP_SETTING_BOUNDS), "midtrans.environment"]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.app_settings WHERE key = ${key}`)), key).toBe("42501");
    }
    expect(first(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_settings WHERE key = ANY (${Object.keys(APP_SETTING_BOUNDS)})`).n).toBe(Object.keys(APP_SETTING_BOUNDS).length);
  });

  it("admin_rw cannot rename a setting's key (D1), but still updates values, also by the admin's upsert", async () => {
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.app_settings SET key = 'otp.phone_cap_x' WHERE key = 'otp.phone_cap'`))).toBe("42501");
    await asRole("admin_rw", async (tx) => {
      await tx`SELECT value FROM public.app_settings WHERE key = 'otp.phone_cap' FOR UPDATE`;
      await tx`UPDATE public.app_settings SET value = '4'::jsonb, updated_by_admin_user_id = 'owner-x', updated_at = clock_timestamp() WHERE key = 'otp.phone_cap'`;
      await tx`
        INSERT INTO public.app_settings (key, value, updated_by_admin_user_id, updated_at) VALUES ('otp.phone_cap', '3'::jsonb, 'owner-x', clock_timestamp())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
    });
    expect(first(await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'otp.phone_cap'`).value).toBe(3);
    expect(await sql`SELECT 1 FROM app_settings WHERE key = 'otp.phone_cap_x'`).toHaveLength(0);
  });

  it("every OTP / rate-limit setting stays inside APP_SETTING_BOUNDS, also for admin_rw (security review L4)", async () => {
    for (const [key, [min, max]] of Object.entries(APP_SETTING_BOUNDS)) {
      for (const bad of [min - 1, max + 1]) {
        expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.app_settings SET value = ${String(bad)}::text::jsonb WHERE key = ${key}`)), `${key}=${String(bad)}`).toBe("23514");
      }
      expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.app_settings SET value = '"300"'::jsonb WHERE key = ${key}`)), `${key} as a string`).toBe("23514");
      // Inside the bounds but not a whole number: app_settings_positive_int_check (US-020 adds checkout.* and captcha.*).
      expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.app_settings SET value = ${`${String(min)}.5`}::text::jsonb WHERE key = ${key}`)), `${key} fractional`).toBe("23514");
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE admin_rw");
        await tx`UPDATE public.app_settings SET value = ${String(min)}::text::jsonb WHERE key = ${key}`;
        await tx`UPDATE public.app_settings SET value = ${String(max)}::text::jsonb WHERE key = ${key}`;
        throw new Error("rollback");
      }).catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "rollback") throw e;
      });
    }
    expect(Object.keys(APP_SETTING_BOUNDS)).toEqual([
      "otp.code_ttl_seconds",
      "otp.max_attempts",
      "otp.phone_cap",
      "otp.phone_window_seconds",
      "otp.ip_cap",
      "otp.ip_window_seconds",
      "otp.cooldown_seconds",
      "otp.global_send_cap",
      "orders.expiry_seconds",
      "orders.sales_close_buffer_minutes",
      "checkout.ip_cap",
      "checkout.ip_window_seconds",
      "checkout.phone_cap",
      "checkout.phone_window_seconds",
      "checkout.lp_cap",
      "checkout.lp_window_seconds",
      "captcha.ip_cap",
      "captcha.ip_window_seconds",
      "captcha.ip48_cap",
      "trivia.extension_max_minutes",
      "delivery.wa_delay_seconds",
    ]);
  });
});

describe("the contest lock (exclusive / shared)", () => {
  /** Holds `lock(programId)` in a transaction until released. */
  async function hold(fn: "lock_program_contest" | "lock_program_contest_shared", programId: string) {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = (): void => undefined;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const done = sql.begin(async (tx) => {
      await tx.unsafe(`SELECT public.${fn}($1)`, [programId]);
      locked();
      await gate;
    });
    await held;
    return { release, done };
  }
  const tryLock = async (fn: "lock_program_contest" | "lock_program_contest_shared", programId: string): Promise<string> =>
    sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '300ms'");
      await tx.unsafe(`SELECT public.${fn}($1)`, [programId]);
      return "acquired";
    }).catch((e: unknown) => (e as { code?: string }).code ?? "error");

  it("shared holders do not block each other; an exclusive holder blocks both, and a shared holder blocks the exclusive", async () => {
    const { programId } = await createProgram();
    const shared = await hold("lock_program_contest_shared", programId);
    expect(await tryLock("lock_program_contest_shared", programId)).toBe("acquired");
    expect(await tryLock("lock_program_contest", programId)).toBe("55P03");
    shared.release();
    await shared.done;
    const exclusive = await hold("lock_program_contest", programId);
    expect(await tryLock("lock_program_contest_shared", programId)).toBe("55P03");
    expect(await tryLock("lock_program_contest", programId)).toBe("55P03");
    exclusive.release();
    await exclusive.done;
  });

  it("a results snapshot waits for a transaction holding the program's contest lock", async () => {
    const { programId } = await createProgram();
    const holder = await hold("lock_program_contest", programId);
    let inserted = false;
    // US-028: only create_leaderboard_snapshot (contest.int.test.ts) writes a snapshot; any insert waits.
    const snapshot = sql`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]')`.then(() => {
      inserted = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(inserted).toBe(false);
    holder.release();
    await holder.done;
    await snapshot;
    expect(inserted).toBe(true);
  });

  it("only trivia_play (the play guards inside the US-027 play functions) may take the shared lock (42501 for the others)", async () => {
    const { programId } = await createProgram();
    await asRole("trivia_play", (tx) => tx`SELECT public.lock_program_contest_shared(${programId})`);
    for (const role of ["public_rw", "worker_rw", "admin_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.lock_program_contest_shared(${programId})`)), role).toBe("42501");
    }
  });
});

describe("prize tiers (ET071 overlap, ET072 frozen by the snapshot)", () => {
  const tier = (tx: Tx | typeof sql, programId: string, from: number, to: number) =>
    tx<Id[]>`INSERT INTO public.prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, ${from}, ${to}, 'Hadiah', 100000) RETURNING id`;

  it("refuses overlapping rank ranges in one program, for every writer; adjacent ranges and other programs are fine", async () => {
    const { programId } = await createProgram();
    const { programId: otherProgram } = await createProgram();
    await asRole("admin_rw", (tx) => tier(tx, programId, 1, 1));
    await asRole("admin_rw", (tx) => tier(tx, programId, 2, 5));
    await asRole("admin_rw", (tx) => tier(tx, otherProgram, 1, 10));
    for (const [from, to] of [[1, 1], [5, 9], [3, 4], [1, 10]] as const) {
      expect(await sqlState(asRole("admin_rw", (tx) => tier(tx, programId, from, to))), `${String(from)}-${String(to)}`).toBe("ET071");
    }
    expect(await sqlState(tier(sql, programId, 4, 6))).toBe("ET071");
    const [last] = await asRole("admin_rw", (tx) => tier(tx, programId, 6, 10));
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.prize_tiers SET rank_from = 5 WHERE id = ${last?.id ?? ""}`))).toBe("ET071");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.prize_tiers SET program_id = ${otherProgram} WHERE id = ${last?.id ?? ""}`))).toBe("ET071");
    await asRole("admin_rw", (tx) => tx`UPDATE public.prize_tiers SET rank_to = 12, name = 'Hadiah 6-12' WHERE id = ${last?.id ?? ""}`);
  });

  it("two concurrent overlapping inserts: one commits, the other is refused", async () => {
    const { programId } = await createProgram();
    const results = await Promise.allSettled([asRole("admin_rw", (tx) => tier(tx, programId, 1, 3)), asRole("admin_rw", (tx) => tier(tx, programId, 2, 4))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect((failed?.reason as { code?: string } | undefined)?.code).toBe("ET071");
  });

  it("freezes a program's tiers once its results snapshot exists (insert, update, delete)", async () => {
    const { programId } = await createProgram();
    const [t] = await asRole("admin_rw", (tx) => tier(tx, programId, 1, 1));
    await sql`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${programId}, now(), '[]')`;
    expect(await sqlState(asRole("admin_rw", (tx) => tier(tx, programId, 2, 2)))).toBe("ET072");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.prize_tiers SET value_idr = 1 WHERE id = ${t?.id ?? ""}`))).toBe("ET072");
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.prize_tiers WHERE id = ${t?.id ?? ""}`))).toBe("ET072");
  });

  it("must run under READ COMMITTED (ET021)", async () => {
    const { programId } = await createProgram();
    expect(await sqlState(asRole("admin_rw", (tx) => tier(tx, programId, 1, 1), "isolation level repeatable read"))).toBe("ET021");
  });
});

describe("legal pages (ET073 immutable, ET074 never deleted)", () => {
  const draft = (tx: Tx | typeof sql, programId: string, version: number, publishedAt: Date | null = null) =>
    tx<Id[]>`INSERT INTO public.legal_pages (program_id, kind, version, title, body, published_at) VALUES (${programId}, 'terms', ${version}, 'S&K', 'Isi', ${publishedAt}) RETURNING id`;

  it("inserts drafts only, publishes a draft with the clock's time, then never changes it", async () => {
    const { programId } = await createProgram();
    expect(await sqlState(asRole("admin_rw", (tx) => draft(tx, programId, 1, new Date())))).toBe("ET073");
    const [page] = await asRole("admin_rw", (tx) => draft(tx, programId, 1));
    const id = page?.id ?? "";
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.legal_pages SET body = 'Diubah' WHERE id = ${id}`))).toBe("ET073");
    await asRole("admin_rw", (tx) => tx`UPDATE public.legal_pages SET published_at = '2000-01-01' WHERE id = ${id}`);
    const published = first(await sql<{ at: Date }[]>`SELECT published_at AS at FROM legal_pages WHERE id = ${id}`);
    expect(Math.abs(published.at.getTime() - Date.now())).toBeLessThan(60_000);
    for (const statement of [
      `UPDATE public.legal_pages SET body = 'Diubah' WHERE id = '${id}'`,
      `UPDATE public.legal_pages SET published_at = NULL WHERE id = '${id}'`,
      `UPDATE public.legal_pages SET published_at = now() WHERE id = '${id}'`,
    ]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement))), statement).toBe("ET073");
      expect(await sqlState(sql.unsafe(statement)), `superuser: ${statement}`).toBe("ET073");
    }
  });

  it("never deletes or truncates a version, not even the owner or a superuser (ET074)", async () => {
    const { programId } = await createProgram();
    const [page] = await asRole("admin_rw", (tx) => draft(tx, programId, 1));
    expect(await sqlState(asRole("admin_rw", (tx) => tx`DELETE FROM public.legal_pages WHERE id = ${page?.id ?? ""}`))).toBe("ET074");
    expect(await sqlState(asRole("migrator", (tx) => tx`DELETE FROM public.legal_pages WHERE id = ${page?.id ?? ""}`))).toBe("ET074");
    expect(await sqlState(sql`TRUNCATE public.legal_pages CASCADE`)).toBe("ET074");
  });
});
