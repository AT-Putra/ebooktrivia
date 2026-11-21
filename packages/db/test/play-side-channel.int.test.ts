// US-027, security review HIGH-1 residual (the reviewer's probes hot.probe / intime.probe, made permanent): a pick
// played and rolled back must not tell, by what it WROTE, whether it was right.
//   - the measurement: the WAL bytes the test's own backend wrote for a public_rw play_answer and its rollback
//     (pg_stat_get_backend_wal, so other sessions of a shared server add no noise) and the HOT / update counters of
//     its transaction, read by the test's superuser, are the same for the correct and the wrong options, in time and
//     inside the latency grace;
//   - the instruments themselves are refused to every app role (42501): the WAL position, the transaction's and the
//     tables' statistics counters (roles.sql, US-027 block), and kept for pg_monitor.
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, asRole, first, sql, sqlState } from "./db.ts";
import { createPlayer, createProgram, createTriviaSet, type Question } from "./fixtures.ts";

type Json = Record<string, unknown>;
const DEVICE = Buffer.alloc(32, 1);
const TABLES = ["attempt_questions", "set_attempts", "player_program_stats"] as const;

const currentOnce = (playerId: string, attemptId: string) =>
  asRole("public_rw", async (tx) => first(await tx<{ r: Json }[]>`SELECT public.play_current(${playerId}, ${attemptId}, '203.0.113.7', ${DEVICE}) AS r`).r);
async function shown(playerId: string, attemptId: string): Promise<Json> {
  for (let call = 0; call < 3; call++) {
    const r = await currentOnce(playerId, attemptId);
    if (r["state"] !== "served") return r;
  }
  throw new Error("served three times");
}

interface Measure {
  readonly walBytes: number;
  readonly counters: string;
}

/**
 * One pick of `optionId` as public_rw, measured by the superuser around it, then rolled back. Each starts from the
 * same pages: VACUUM first removes the versions earlier rolled-back picks left (the int files run one after another,
 * so nothing else writes meanwhile), else the page's fill, which only depends on how many picks came before, would
 * decide between a HOT update (216 bytes of WAL) and one to another page with its index entries (712).
 */
async function measurePick(playerId: string, answerId: string, optionId: string): Promise<Measure> {
  await sql.unsafe("VACUUM (INDEX_CLEANUP ON) public.attempt_questions, public.set_attempts, public.player_program_stats");
  const conn = await sql.reserve();
  const counters = TABLES.map((t) => `pg_stat_get_xact_tuples_hot_updated('public.${t}'::regclass) || '/' || pg_stat_get_xact_tuples_updated('public.${t}'::regclass)`).join(" || ' ' || ");
  // THIS backend's WAL (PostgreSQL 18 backend statistics), not the server's: the other sessions of a shared server write WAL at the
  // same time. A backend's counters reach the shared statistics when it goes idle; pg_stat_force_next_flush makes that flush happen
  // right after its own statement, so the next statement reads everything the backend wrote until then.
  const backendWal = async (): Promise<bigint> => {
    await conn.unsafe("SELECT pg_stat_force_next_flush()");
    const [row] = await conn.unsafe<{ bytes: string }[]>("SELECT wal_bytes::text AS bytes FROM pg_stat_get_backend_wal(pg_backend_pid())");
    return BigInt(row?.bytes ?? "0");
  };
  try {
    const walBefore = await backendWal();
    await conn.unsafe("BEGIN");
    const [before] = await conn.unsafe<{ counters: string }[]>(`SELECT ${counters} AS counters`);
    await conn.unsafe("SET LOCAL ROLE public_rw");
    await conn`SELECT public.play_answer(${playerId}, ${answerId}, ${optionId}, '203.0.113.7', ${DEVICE})`;
    await conn.unsafe("RESET ROLE");
    const [after] = await conn.unsafe<{ counters: string }[]>(`SELECT ${counters} AS counters`);
    await conn.unsafe("ROLLBACK");
    // The pick and the rollback's abort record (the same for every pick).
    const walBytes = Number((await backendWal()) - walBefore);
    // The counters' change: after minus before, per table and kind.
    const b = (before?.counters ?? "").split(/[ /]/).map(Number);
    const a = (after?.counters ?? "").split(/[ /]/).map(Number);
    return { walBytes, counters: a.map((x, i) => x - (b[i] ?? 0)).join(",") };
  } finally {
    await conn.unsafe("ROLLBACK").catch(() => undefined);
    conn.release();
  }
}

describe("a rolled-back pick writes the same for the right and the wrong option", () => {
  let programId: string;
  let setId: string;
  let questions: Question[];
  beforeAll(async () => {
    ({ programId } = await createProgram());
    const set = await createTriviaSet(programId, 1);
    setId = set.setId;
    questions = [set.q1, set.q2];
    await createTriviaSet(programId, 2);
  });

  it.each([
    ["in time (10.3 s into its 20 s)", 10_300],
    ["inside the latency grace (300 ms past the deadline)", 20_300],
  ])("%s: equal WAL bytes and counters for every option, and nothing kept", async (_name, agedMs) => {
    const { playerId } = await createPlayer({ programId, eligible: true });
    const attemptId = await asRole("public_rw", async (tx) => first(await tx<{ id: string }[]>`SELECT public.play_start_set(${playerId}, ${setId}) AS id`).id);
    // A first question answered (committed, settled), as in the reviewer's probe, so the stats row exists.
    const firstShown = await shown(playerId, attemptId);
    await asRole("public_rw", (tx) => tx`SELECT public.play_answer(${playerId}, ${String(firstShown["answer_id"])}, ${(firstShown["options"] as { id: string }[])[1]?.id ?? ""}, NULL, NULL)`);
    await asRole("public_rw", (tx) => tx`SELECT public.play_settle(${playerId}, ${String(firstShown["answer_id"])})`);
    const q = await shown(playerId, attemptId);
    const answerId = String(q["answer_id"]);
    const options = (q["options"] as { id: string }[]).map((o) => o.id);
    const correct = questions.find((x) => x.options.includes(options[0] ?? ""))?.options[0];
    await sql`UPDATE attempt_questions SET served_at = served_at - make_interval(secs => ${agedMs / 1000}), deadline_at = deadline_at - make_interval(secs => ${agedMs / 1000}) WHERE id = ${answerId}`;
    // 3 rounds over every option, the right one first in one round and last in another.
    const byOption = new Map<string, Measure[]>();
    for (const order of [options, [...options].reverse(), options]) {
      for (const option of order) byOption.set(option, [...(byOption.get(option) ?? []), await measurePick(playerId, answerId, option)]);
    }
    // Per option: the smallest WAL (a full-page image after a checkpoint only ever adds) and the counters seen.
    const summary = [...byOption.entries()].map(([option, ms]) => ({
      right: option === correct,
      wal: Math.min(...ms.map((m) => m.walBytes)),
      counters: [...new Set(ms.map((m) => m.counters))].sort().join("|"),
    }));
    expect(summary.filter((s) => s.right)).toHaveLength(1);
    // The measurement sees the pick at all (an update of the answer row and the abort record), so equal is not 0 = 0.
    for (const s of summary) expect(s.wal).toBeGreaterThan(100);
    const right = summary.find((s) => s.right);
    for (const s of summary) expect({ wal: s.wal, counters: s.counters }, `right=${String(s.right)}`).toEqual({ wal: right?.wal, counters: right?.counters });
    // Only the answer row was touched, and nothing was kept.
    expect(right?.counters.split("|")[0]?.split(",").slice(2)).toEqual(["0", "0", "0", "0"]);
    expect(first(await sql<{ answered_at: Date | null }[]>`SELECT answered_at FROM attempt_questions WHERE id = ${answerId}`).answered_at).toBeNull();
  });
});

describe("the instruments are refused to the app roles (roles.sql, US-027 block)", () => {
  it.each([
    "SELECT pg_current_wal_lsn()",
    "SELECT pg_current_wal_insert_lsn()",
    "SELECT pg_current_wal_flush_lsn()",
    // pg_catalog's own table, which every role may name: the refusal is the function's, not schema public's.
    "SELECT pg_stat_get_xact_tuples_hot_updated('pg_catalog.pg_class'::regclass)",
    "SELECT pg_stat_get_xact_tuples_updated('pg_catalog.pg_class'::regclass)",
    "SELECT pg_stat_get_tuples_hot_updated('pg_catalog.pg_class'::regclass)",
    "SELECT * FROM pg_stat_get_io()",
    "SELECT * FROM pg_stat_io",
    "SELECT pg_stat_get_backend_wal(pg_backend_pid())",
    "SELECT * FROM pg_stat_wal",
    "SELECT * FROM pg_stat_xact_user_tables",
    "SELECT * FROM pg_stat_user_tables",
    "SELECT * FROM pg_stat_all_tables",
  ])("%s: 42501 for every app role, allowed for pg_monitor", async (statement) => {
    for (const role of APP_ROLES) expect(await sqlState(asRole(role, (tx) => tx.unsafe(statement))), `${role}: ${statement}`).toBe("42501");
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE pg_monitor");
      await tx.unsafe(statement);
    });
  });
});
