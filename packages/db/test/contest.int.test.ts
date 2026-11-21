// US-028 (M9c) database guarantees, sql/contest.sql and its triggers:
//   - create_leaderboard_snapshot closes play, finalizes open and never-served answers as timeouts
//     (answered_at = deadline / grace end, elapsed = timer, 0 points), re-derives every score,
//     charges the sets never started as one aggregate, ranks eligible players only (NULLS LAST,
//     unique ranks), writes the snapshot, the winners and the audit row, and moves the program to
//     awaiting_confirmation;
//   - EXACTLY ONE snapshot per program: concurrent and repeated calls, under the exclusive contest
//     lock and the UNIQUE program_id;
//   - after it: the snapshot and the winners are immutable for every writer (ET104 / ET105), and the
//     override (ET022), prize tier edits (ET072), the extension tool (ET102) and play (ET050) are refused;
//   - the Owner's confirmation and the masked banner read path; the deadline-extension tool.
import { describe, expect, it } from "vitest";
import { asRole, first, sql, sqlState, suffix, type Tx, uniquePhone } from "./db.ts";

type Id = { id: string };
const DAY = 86_400_000;

/** Whole milliseconds. */
const ms = (t: number): Date => new Date(Math.floor(t));

interface Program {
  programId: string;
  graceEnd: Date;
  /** Per set: its id and its questions (id, timer, [right option, wrong option]). */
  sets: { id: string; questions: { id: string; timer: number; right: string; wrong: string }[] }[];
}

/** A published program whose grace ended `endedAgoMs` ago (negative: still running), with sets of the given timers. */
async function program(timers: number[][], endedAgoMs = 2 * 60_000, graceDays = 2): Promise<Program> {
  const product = first(await sql<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const graceEnd = ms(Date.now() - endedAgoMs);
  const salesEnd = new Date(graceEnd.getTime() - graceDays * DAY);
  const { id: programId } = first(
    await sql<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`contest-${suffix()}`}, 'Contest', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, ${graceDays})
      RETURNING id`,
  );
  const sets: Program["sets"] = [];
  for (const [s, set] of timers.entries()) {
    const { id } = first(await sql<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, ${s + 1}, 'Set') RETURNING id`);
    const questions = [];
    for (const [i, timer] of set.entries()) {
      const q = first(await sql<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${id}, ${i + 1}, 'Q', 10, ${timer}) RETURNING id`);
      const [right, wrong] = await sql<Id[]>`
        INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${q.id}, 1, 'A', true), (${q.id}, 2, 'B', false) RETURNING id`;
      questions.push({ id: q.id, timer, right: right?.id ?? "", wrong: wrong?.id ?? "" });
    }
    sets.push({ id, questions });
  }
  return { programId, graceEnd, sets };
}

async function player(p: Program, opts: { eligible?: boolean; paidAt?: Date; name?: string; phone?: string } = {}): Promise<string> {
  const { id } = first(await sql<Id[]>`INSERT INTO players (phone, name) VALUES (${opts.phone ?? uniquePhone()}, ${opts.name ?? "Pemain Uji"}) RETURNING id`);
  await sql`
    INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible)
    VALUES (${id}, ${p.programId}, ${opts.paidAt ?? ms(p.graceEnd.getTime() - 20 * DAY)}, ${opts.eligible ?? true})`;
  return id;
}

/** One answer row: pick "r" / "w" / null, served / answered as ms offsets from `base` (null = not yet). */
type Row = { pick: "r" | "w" | null; served: number | null; answered: number | null; points?: number };

async function attempt(p: Program, playerId: string, set: number, rows: Row[]): Promise<{ attemptId: string; rowIds: string[] }> {
  const s = p.sets[set];
  if (s === undefined) throw new Error("no set");
  const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${playerId}, ${s.id}) RETURNING id`);
  const base = p.graceEnd.getTime() - DAY;
  const rowIds: string[] = [];
  for (const [i, r] of rows.entries()) {
    const q = s.questions[i];
    if (q === undefined) throw new Error("no question");
    const servedAt = r.served === null ? null : ms(base + r.served);
    const row = first(
      await sql<Id[]>`
        INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, points)
        VALUES (${attemptId}, ${q.id}, ${i + 1}, ${[q.right, q.wrong]}::uuid[], ${servedAt}, ${servedAt === null ? null : ms(servedAt.getTime() + q.timer * 1000)},
                ${r.answered === null ? null : ms(base + r.answered)}, ${r.pick === null ? null : r.pick === "r" ? q.right : q.wrong}, ${r.points ?? 0})
        RETURNING id`,
    );
    rowIds.push(row.id);
  }
  return { attemptId, rowIds };
}

const snapshot = (programId: string, isolation?: string) =>
  asRole("worker_rw", async (tx) => first(await tx<{ summary: Record<string, unknown> }[]>`SELECT public.create_leaderboard_snapshot(${programId}::uuid) AS summary`).summary, isolation);

const tier = (programId: string, from: number, to: number) =>
  sql<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, ${from}, ${to}, ${`Hadiah ${String(from)}`}, 100000) RETURNING id`.then((r) => first(r).id);

let ownerId = "";
let staffId = "";
async function admins(): Promise<void> {
  if (ownerId !== "") return;
  for (const role of ["owner", "staff"] as const) {
    const id = `${role}-${suffix()}`;
    await sql`INSERT INTO admin_auth."user" (id, name, email, "emailVerified") VALUES (${id}, ${role}, ${`${id}@example.test`}, true)`;
    await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name) VALUES (${id}, ${role}, ${role})`;
    if (role === "owner") ownerId = id;
    else staffId = id;
  }
}

const confirm = (programId: string, actor: string | null = ownerId, role: "admin_rw" | "worker_rw" | "public_rw" = "admin_rw") =>
  asRole(role, async (tx) => first(await tx<{ summary: Record<string, unknown> }[]>`SELECT public.confirm_program_winners(${programId}::uuid, ${actor}, 'req-c', '198.51.100.7'::inet) AS summary`).summary);

interface Extension {
  outageStartedAt?: Date;
  outageEndedAt?: Date;
  reason?: string;
  actor?: string | null;
}
const extend = (programId: string, e: Extension = {}, role: "admin_rw" | "worker_rw" | "public_rw" = "admin_rw") =>
  asRole(role, async (tx: Tx) =>
    first(
      await tx<{ summary: Record<string, unknown> }[]>`
        SELECT public.extend_open_question_deadlines(${programId}::uuid, ${e.outageStartedAt ?? ms(Date.now() - 600_000)}, ${e.outageEndedAt ?? ms(Date.now())},
               ${e.reason ?? "Server mati sepuluh menit."}, ${e.actor === undefined ? ownerId : e.actor}, 'req-e', '198.51.100.8'::inet) AS summary`,
    ).summary,
  );

describe("create_leaderboard_snapshot: finalize, rank, freeze", () => {
  it("finalizes open and unserved rows, charges unstarted sets in aggregate, ranks eligible players NULLS LAST, awards tiers", async () => {
    const p = await program([
      [20, 20],
      [30, 10],
    ]);
    const gold = await tier(p.programId, 1, 1);
    const silver = await tier(p.programId, 2, 3);
    const a = await player(p, { name: "Ani Wijaya" });
    const b = await player(p);
    const c = await player(p);
    const refunded = await player(p, { eligible: false });
    // A: both sets, every answer right (5 s, 6 s, 7 s, 8 s); stored points tampered to 999 on one row.
    const aSet1 = await attempt(p, a, 0, [
      { pick: "r", served: 0, answered: 5_000, points: 999 },
      { pick: "r", served: 100_000, answered: 106_000 },
    ]);
    await attempt(p, a, 1, [
      { pick: "r", served: 200_000, answered: 207_000 },
      { pick: "r", served: 300_000, answered: 308_000 },
    ]);
    // B: set 1 only, q1 right in 4 s, q2 served and left open; never started set 2.
    const bSet1 = await attempt(p, b, 0, [
      { pick: "r", served: 0, answered: 4_000 },
      { pick: null, served: 500_000, answered: null },
    ]);
    // C: never played. Refunded: set 1 q1 right in 1 s, q2 never served.
    const r1 = await attempt(p, refunded, 0, [
      { pick: "r", served: 0, answered: 1_000 },
      { pick: null, served: null, answered: null },
    ]);

    const summary = await snapshot(p.programId);
    expect(summary).toMatchObject({ created: true, answers_finalized: 2, players_ranked: 3, winners: 3, frozen_at: p.graceEnd.toISOString() });

    const rows = await sql<{ id: string; answered_at: Date; correct: boolean; points: number; elapsed_ms: number }[]>`
      SELECT id, answered_at, correct, points, elapsed_ms FROM attempt_questions WHERE id = ANY (${[...aSet1.rowIds, ...bSet1.rowIds, ...r1.rowIds]}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const base = p.graceEnd.getTime() - DAY;
    expect(byId.get(aSet1.rowIds[0] ?? "")).toMatchObject({ points: 10, elapsed_ms: 5_000 });
    expect(byId.get(bSet1.rowIds[1] ?? "")).toEqual({ id: bSet1.rowIds[1], answered_at: new Date(base + 520_000), correct: false, points: 0, elapsed_ms: 20_000 });
    expect(byId.get(r1.rowIds[1] ?? "")).toEqual({ id: r1.rowIds[1], answered_at: p.graceEnd, correct: false, points: 0, elapsed_ms: 20_000 });

    const stats = await sql<{ player_id: string; score: number; total_ms: string; sets_completed: number; finished_at: Date | null }[]>`
      SELECT player_id, score, total_ms::text, sets_completed, finished_at FROM player_program_stats WHERE program_id = ${p.programId}`;
    const st = new Map(stats.map((s) => [s.player_id, s]));
    expect(st.get(a)).toMatchObject({ score: 40, total_ms: "26000", sets_completed: 2, finished_at: new Date(base + 308_000) });
    expect(st.get(b)).toMatchObject({ score: 10, total_ms: String(4_000 + 20_000 + 40_000), sets_completed: 1, finished_at: null });
    expect(st.get(c)).toMatchObject({ score: 0, total_ms: "80000", sets_completed: 0, finished_at: null });
    expect(st.get(refunded)).toMatchObject({ score: 10, total_ms: String(1_000 + 20_000 + 40_000) });

    const snap = first(await sql<{ id: string; frozen_at: Date; entries: Record<string, unknown>[] }[]>`SELECT id, frozen_at, entries FROM leaderboard_snapshots WHERE program_id = ${p.programId}`);
    expect(snap.frozen_at).toEqual(p.graceEnd);
    expect(snap.entries).toEqual([
      { rank: 1, player_id: a, score: 40, total_ms: 26_000, finished_at: new Date(base + 308_000).toISOString(), sets_completed: 2, unplayed_ms: 0 },
      { rank: 2, player_id: b, score: 10, total_ms: 64_000, finished_at: null, sets_completed: 1, unplayed_ms: 40_000 },
      { rank: 3, player_id: c, score: 0, total_ms: 80_000, finished_at: null, sets_completed: 0, unplayed_ms: 80_000 },
    ]);
    const winners = await sql<{ player_id: string; prize_tier_id: string; rank: number; status: string }[]>`
      SELECT player_id, prize_tier_id, rank, status::text FROM winners WHERE snapshot_id = ${snap.id} ORDER BY rank`;
    expect(winners).toEqual([
      { player_id: a, prize_tier_id: gold, rank: 1, status: "awaiting_confirmation" },
      { player_id: b, prize_tier_id: silver, rank: 2, status: "awaiting_confirmation" },
      { player_id: c, prize_tier_id: silver, rank: 3, status: "awaiting_confirmation" },
    ]);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${p.programId}`).status).toBe("awaiting_confirmation");
    const audit = first(await sql<{ actor_kind: string; changes: Record<string, unknown> }[]>`SELECT actor_kind, changes FROM audit_log WHERE action = 'contest.snapshot' AND entity_id = ${p.programId}`);
    expect(audit.actor_kind).toBe("system");
    for (const id of [a, b, c, refunded]) expect(JSON.stringify(audit.changes)).not.toContain(id);
  });

  it("skipping never beats playing: an all-wrong full-timer player who finished outranks one who skipped the set", async () => {
    const p = await program([[20], [20]]);
    const played = await player(p);
    const skipped = await player(p);
    await attempt(p, played, 0, [{ pick: "r", served: 0, answered: 5_000 }]);
    await attempt(p, played, 1, [{ pick: "w", served: 10_000, answered: 40_000 }]); // late, wrong: 0 points, 20 s
    await attempt(p, skipped, 0, [{ pick: "r", served: 0, answered: 5_000 }]);
    await snapshot(p.programId);
    const entries = first(await sql<{ entries: { player_id: string; total_ms: number; finished_at: string | null }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).entries;
    expect(entries.map((e) => e.player_id)).toEqual([played, skipped]);
    expect(entries.map((e) => e.total_ms)).toEqual([25_000, 25_000]);
    expect(entries[1]?.finished_at).toBeNull();
  });

  it("breaks an exact tie on the three keys by the earlier first payment, then the player id: ranks are unique", async () => {
    const p = await program([[20]]);
    await tier(p.programId, 1, 1);
    const early = ms(p.graceEnd.getTime() - 25 * DAY);
    const late = await player(p, { paidAt: ms(early.getTime() + 1) });
    const first1 = await player(p, { paidAt: early });
    const first2 = await player(p, { paidAt: early });
    await snapshot(p.programId);
    const entries = first(await sql<{ entries: { rank: number; player_id: string }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).entries;
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.player_id)).toEqual([...[first1, first2].sort(), late]);
    expect((await sql`SELECT 1 FROM winners WHERE program_id = ${p.programId}`).length).toBe(1);
  });

  it("does not count a set started and never served as finished: it cannot beat a set never started (security review N6)", async () => {
    const p = await program([[20, 20]]);
    await tier(p.programId, 1, 1);
    const early = ms(p.graceEnd.getTime() - 25 * DAY);
    const started = await player(p, { paidAt: ms(early.getTime() + 1) });
    const neverStarted = await player(p, { paidAt: early });
    const { attemptId } = await attempt(p, started, 0, [{ pick: null, served: null, answered: null }, { pick: null, served: null, answered: null }]);
    await snapshot(p.programId);
    expect(first(await sql<{ finished: Date | null }[]>`SELECT finished_at AS finished FROM set_attempts WHERE id = ${attemptId}`).finished).toBeNull();
    const entries = first(await sql<{ entries: { player_id: string; score: number; total_ms: number; finished_at: string | null }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).entries;
    // Same score, time and (no) finish: the earlier payment wins, not the started set.
    expect(entries.map((e) => [e.player_id, e.score, e.total_ms, e.finished_at])).toEqual([
      [neverStarted, 0, 40_000, null],
      [started, 0, 40_000, null],
    ]);
  });

  it("is refused before the grace end + 60 s (ET103), for a program that is not published (ET102), outside READ COMMITTED (ET100), for an unknown program (ET101)", async () => {
    const running = await program([[20]], -60_000);
    expect(await sqlState(snapshot(running.programId))).toBe("ET103");
    const settling = await program([[20]], 30_000);
    expect(await sqlState(snapshot(settling.programId))).toBe("ET103");
    const draft = await program([[20]]);
    await sql`UPDATE programs SET status = 'draft' WHERE id = ${draft.programId}`;
    expect(await sqlState(snapshot(draft.programId))).toBe("ET102");
    const due = await program([[20]]);
    expect(await sqlState(snapshot(due.programId, "isolation level repeatable read"))).toBe("ET100");
    expect(await sqlState(snapshot("00000000-0000-4000-8000-00000000abcd"))).toBe("ET101");
    expect(await sql`SELECT 1 FROM leaderboard_snapshots WHERE program_id IN (${running.programId}, ${settling.programId}, ${draft.programId}, ${due.programId})`).toHaveLength(0);
  });

  it("only worker_rw may call it (42501 for admin_rw, public_rw, internal_rw)", async () => {
    const p = await program([[20]]);
    for (const role of ["admin_rw", "public_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.create_leaderboard_snapshot(${p.programId}::uuid)`)), role).toBe("42501");
    }
  });
});

describe("exactly one snapshot per program", () => {
  it("two workers at once and repeated sweeps: one snapshot, one set of winners, the others return it unchanged", async () => {
    const p = await program([[20, 20]]);
    await tier(p.programId, 1, 2);
    for (let i = 0; i < 3; i++) await attempt(p, await player(p), 0, [{ pick: "r", served: i * 1000, answered: i * 1000 + 3000 }, { pick: null, served: null, answered: null }]);
    const results = await Promise.all([snapshot(p.programId), snapshot(p.programId), snapshot(p.programId), snapshot(p.programId)]);
    expect(results.filter((r) => r["created"] === true)).toHaveLength(1);
    const ids = new Set(results.map((r) => r["snapshot_id"]));
    expect(ids.size).toBe(1);
    const again = await snapshot(p.programId);
    expect(again).toEqual({ program_id: p.programId, snapshot_id: [...ids][0], created: false });
    expect(await sql`SELECT 1 FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM winners WHERE program_id = ${p.programId}`).toHaveLength(2);
    expect(await sql`SELECT 1 FROM audit_log WHERE action = 'contest.snapshot' AND entity_id = ${p.programId}`).toHaveLength(1);
  });

  it("waits for play holding the shared contest lock, and then for nothing else; a second snapshot row is impossible (UNIQUE)", async () => {
    const p = await program([[20]]);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const answer = sql.begin(async (tx) => {
      await tx`SELECT public.lock_program_contest_shared(${p.programId})`;
      held();
      await gate;
    });
    await holding;
    let done = false;
    const pending = snapshot(p.programId).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    release();
    await answer;
    await pending;
    expect(done).toBe(true);
    expect(await sqlState(sql`INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${p.programId}, now(), '[]')`)).toBe("23505");
  });
});

describe("after the snapshot", () => {
  it("the snapshot is immutable for every writer, the owner and superusers included (ET104; 42501 for app roles)", async () => {
    const p = await program([[20]]);
    await player(p);
    await snapshot(p.programId);
    for (const statement of [
      `UPDATE public.leaderboard_snapshots SET entries = '[]' WHERE program_id = '${p.programId}'`,
      `DELETE FROM public.leaderboard_snapshots WHERE program_id = '${p.programId}'`,
      "TRUNCATE public.leaderboard_snapshots CASCADE",
    ]) {
      expect(await sqlState(sql.unsafe(statement)), `superuser: ${statement}`).toBe("ET104");
      expect(await sqlState(asRole("migrator", (tx) => tx.unsafe(statement))), `migrator: ${statement}`).toBe("ET104");
      for (const role of ["admin_rw", "worker_rw", "public_rw"] as const) {
        expect(await sqlState(asRole(role, (tx) => tx.unsafe(statement))), `${role}: ${statement}`).toBe("42501");
      }
    }
  });

  it("refuses prize tier edits (ET072), the extension tool (ET102) and play (ET050, as the play functions' owner trivia_play; public_rw writes no score at all, 42501)", async () => {
    await admins();
    const p = await program([[20, 20]]);
    const t = await tier(p.programId, 1, 1);
    const pl = await player(p);
    const { attemptId, rowIds } = await attempt(p, pl, 0, [{ pick: "r", served: 0, answered: 3000 }, { pick: null, served: null, answered: null }]);
    await snapshot(p.programId);
    expect(await sqlState(asRole("admin_rw", (tx) => tx`UPDATE public.prize_tiers SET value_idr = 1 WHERE id = ${t}`))).toBe("ET072");
    expect(await sqlState(extend(p.programId))).toBe("ET102");
    expect(await sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET option_id = NULL WHERE id = ${rowIds[0] ?? ""}`))).toBe("ET050");
    expect(await sqlState(asRole("public_rw", (tx) => tx`UPDATE public.set_attempts SET score = 99 WHERE id = ${attemptId}`))).toBe("42501");
  });
});

describe("confirm_program_winners", () => {
  it("needs an active Owner (ET101) and results awaiting confirmation (ET102); only admin_rw may call it", async () => {
    await admins();
    const p = await program([[20]]);
    await tier(p.programId, 1, 1);
    await player(p);
    expect(await sqlState(confirm(p.programId))).toBe("ET102");
    await snapshot(p.programId);
    for (const actor of [staffId, "nobody", null]) expect(await sqlState(confirm(p.programId, actor)), String(actor)).toBe("ET101");
    for (const role of ["worker_rw", "public_rw"] as const) expect(await sqlState(confirm(p.programId, ownerId, role)), role).toBe("42501");
    expect(await sql`SELECT 1 FROM winners WHERE program_id = ${p.programId} AND status <> 'awaiting_confirmation'`).toHaveLength(0);
  });

  it("refuses while a winner has been refunded since the snapshot, or is flagged (ET107)", async () => {
    await admins();
    const p = await program([[20]]);
    await tier(p.programId, 1, 1);
    const pl = await player(p);
    await snapshot(p.programId);
    await sql`UPDATE player_programs SET eligible = false WHERE player_id = ${pl} AND program_id = ${p.programId}`;
    expect(await sqlState(confirm(p.programId))).toBe("ET107");
    const flagged = await program([[20]]);
    await tier(flagged.programId, 1, 1);
    await player(flagged);
    await snapshot(flagged.programId);
    await asRole("worker_rw", (tx) => tx`UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback' WHERE program_id = ${flagged.programId}`);
    expect(await sqlState(confirm(flagged.programId))).toBe("ET107");
  });

  // Security review P2-1: the eligibility check and a refund cannot interleave.
  it("waits for a refund in flight (the winners' eligibility is locked FOR SHARE), then refuses (ET107)", async () => {
    await admins();
    const p = await program([[20]]);
    await tier(p.programId, 1, 1);
    const pl = await player(p);
    await snapshot(p.programId);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const refund = sql.begin(async (tx) => {
      await tx`UPDATE player_programs SET eligible = false, updated_at = now() WHERE player_id = ${pl} AND program_id = ${p.programId}`;
      held();
      await gate;
    });
    await holding;
    let settled = false;
    const confirming = sqlState(confirm(p.programId)).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    release();
    await refund;
    expect(await confirming).toBe("ET107");
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM programs WHERE id = ${p.programId}`).status).toBe("awaiting_confirmation");
  });

  it("confirms every winner, finalizes the program, audits it; the banner then shows them masked, nothing before", async () => {
    await admins();
    const p = await program([[20]]);
    const t1 = await tier(p.programId, 1, 1);
    const t2 = await tier(p.programId, 2, 2);
    const a = await player(p, { name: "Budi Santoso", phone: "+6281234567890" });
    const b = await player(p, { name: "siti  nur", phone: "+6281299990123" });
    await player(p, { name: "Tidak Menang" });
    await attempt(p, a, 0, [{ pick: "r", served: 0, answered: 2000 }]);
    await attempt(p, b, 0, [{ pick: "r", served: 0, answered: 3000 }]);
    const banner = (role: "public_rw" | "admin_rw" = "public_rw") =>
      asRole(role, (tx) => tx<{ rank: number; prize_tier_id: string; prize_name: string; masked_name: string; masked_phone: string }[]>`SELECT * FROM public.program_winners_banner(${p.programId}::uuid)`);
    expect(await banner()).toEqual([]);
    await snapshot(p.programId);
    expect(await banner()).toEqual([]);
    const summary = await confirm(p.programId);
    expect(summary).toMatchObject({ winners_confirmed: 2 });
    const rows = await banner();
    expect(rows).toEqual([
      { rank: 1, prize_tier_id: t1, prize_name: "Hadiah 1", masked_name: "B*** S***", masked_phone: "****890" },
      { rank: 2, prize_tier_id: t2, prize_name: "Hadiah 2", masked_name: "s*** n***", masked_phone: "****123" },
    ]);
    expect(await banner("admin_rw")).toEqual(rows);
    const text = JSON.stringify(rows);
    for (const raw of ["Budi", "Santoso", "siti", "+62812", "4567890", a, b]) expect(text).not.toContain(raw);
    expect(await sqlState(asRole("worker_rw", (tx) => tx`SELECT * FROM public.program_winners_banner(${p.programId}::uuid)`))).toBe("42501");
    expect(first(await sql<{ status: string; confirmed: boolean }[]>`SELECT status::text, winners_confirmed_at IS NOT NULL AS confirmed FROM programs WHERE id = ${p.programId}`)).toEqual({ status: "finalized", confirmed: true });
    const audit = first(await sql<{ actor: string; request_id: string; changes: Record<string, unknown> }[]>`SELECT actor_admin_user_id AS actor, request_id, changes FROM audit_log WHERE action = 'contest.winners_confirm' AND entity_id = ${p.programId}`);
    expect(audit).toMatchObject({ actor: ownerId, request_id: "req-c", changes: { winners_confirmed: 2, status: { before: "awaiting_confirmation", after: "finalized" } } });
    expect(await sqlState(confirm(p.programId))).toBe("ET102");
    // Confirmed winners stay frozen too.
    expect(await sqlState(sql`UPDATE winners SET status = 'awaiting_confirmation' WHERE program_id = ${p.programId}`)).toBe("ET105");
  });
});

describe("extend_open_question_deadlines (the Owner's outage tool, security review P1-4)", () => {
  /** A running program with one attempt; rows are inserted by `row` with timestamps relative to now. */
  async function running(timers = [20, 20, 20, 20, 20]) {
    const p = await program([timers], -3 * DAY);
    const pl = await player(p);
    const s = p.sets[0];
    if (s === undefined) throw new Error("no set");
    const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${pl}, ${s.id}) RETURNING id`);
    const row = async (i: number, servedAgo: number | null, answeredAgo: number | null = null) => {
      const q = s.questions[i];
      if (q === undefined) throw new Error("no question");
      const served = servedAgo === null ? null : ms(Date.now() - servedAgo);
      return first(
        await sql<Id[]>`
          INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at)
          VALUES (${attemptId}, ${q.id}, ${i + 1}, ${[q.right, q.wrong]}::uuid[], ${served}, ${served === null ? null : ms(served.getTime() + q.timer * 1000)},
                  ${answeredAgo === null ? null : ms(Date.now() - answeredAgo)})
          RETURNING id`,
      ).id;
    };
    return { p, pl, s, attemptId, row };
  }
  const state = async (id: string) =>
    first(await sql<{ deadline: Date | null; ext: number }[]>`SELECT deadline_at AS deadline, deadline_extension_ms AS ext FROM attempt_questions WHERE id = ${id}`);

  it("gives back only the time each question lost to the outage, from now, once; the ledger and the audit row say which", async () => {
    await admins();
    const r = await running();
    const cut = await r.row(0, 90_000); // deadline 70 s ago: lost 10 s of the outage that began 80 s ago
    const servedDuring = await r.row(1, 30_000); // served during the outage, deadline 10 s ago: lost all 20 s
    const abandoned = await r.row(2, 70 * 3_600_000); // expired 70 h ago: not the outage's
    const runningNow = await r.row(3, 5_000); // deadline still ahead: not cut short
    const answered = await r.row(4, 60_000, 50_000);
    const before = new Map(await Promise.all([cut, servedDuring, abandoned, runningNow, answered].map(async (id) => [id, await state(id)] as const)));
    const now = Date.now();
    // The outage began 10 s before the first question's deadline (so it lost exactly 10 s).
    const outageStartedAt = ms((before.get(cut)?.deadline?.getTime() ?? 0) - 10_000);
    const summary = await extend(r.p.programId, { outageStartedAt });
    expect(summary).toMatchObject({ questions_extended: 2, players_affected: 1, granted_ms: 30_000 });
    for (const [id, lost] of [[cut, 10_000], [servedDuring, 20_000]] as const) {
      const after = await state(id);
      const old = before.get(id)?.deadline?.getTime() ?? 0;
      // The new deadline is now + exactly the time lost; the extension is new - old deadline.
      expect(Math.abs((after.deadline?.getTime() ?? 0) - lost - now)).toBeLessThan(3_000);
      expect(after.ext).toBe((after.deadline?.getTime() ?? 0) - old);
    }
    for (const id of [abandoned, runningNow, answered]) expect(await state(id)).toEqual(before.get(id));
    const ledger = await sql<{ attempt_question_id: string; extension_id: string; granted_ms: number; original_deadline_at: Date }[]>`
      SELECT attempt_question_id, extension_id, granted_ms, original_deadline_at FROM deadline_extensions WHERE program_id = ${r.p.programId} ORDER BY granted_ms`;
    expect(ledger.map((l) => [l.attempt_question_id, l.granted_ms, l.original_deadline_at])).toEqual([
      [cut, 10_000, before.get(cut)?.deadline],
      [servedDuring, 20_000, before.get(servedDuring)?.deadline],
    ]);
    expect(ledger[0]?.extension_id).toBe(summary["extension_id"]);
    const audit = first(await sql<{ actor: string; changes: Record<string, unknown> }[]>`
      SELECT actor_admin_user_id AS actor, changes FROM audit_log WHERE action = 'contest.deadline_extension' AND entity_id = ${r.p.programId}`);
    expect(audit).toMatchObject({ actor: ownerId, changes: { extension_id: summary["extension_id"], questions_extended: 2, reason: "Server mati sepuluh menit." } });
    expect(JSON.stringify(audit)).not.toContain(r.pl);
    // A pick inside the extension counts, charged the full 20 s.
    const q = r.s.questions[0];
    const [scored] = await sql<{ correct: boolean; points: number; elapsed_ms: number }[]>`
      SELECT x.* FROM attempt_questions aq, public.score_answer(10, 20, ${q?.right ?? ""}::uuid, ${q?.right ?? ""}::uuid, aq.served_at, aq.deadline_at,
                                                              ${ms(Date.now() + 1000)}, aq.deadline_extension_ms) x WHERE aq.id = ${cut}`;
    expect(scored).toEqual({ correct: true, points: 10, elapsed_ms: 20_000 });
    // A second use extends nothing already extended, even once its new deadline has passed inside the outage window.
    await sql`UPDATE attempt_questions SET deadline_at = deadline_at - interval '20 seconds' WHERE id = ${cut}`;
    expect(await extend(r.p.programId, { outageStartedAt })).toMatchObject({ questions_extended: 0 });
    expect(await sql`SELECT 1 FROM deadline_extensions WHERE program_id = ${r.p.programId}`).toHaveLength(2);
  });

  it("extends only questions served before the outage ended whose deadline fell inside it (security review N4)", async () => {
    await admins();
    const r = await running();
    const inside = await r.row(0, 100_000); // deadline 80 s ago, inside the outage
    const servedAfter = await r.row(1, 35_000); // served 5 s after the outage ended
    const dueAfter = await r.row(2, 50_000); // served before the end, but due 10 s after it
    const now = Date.now();
    const summary = await extend(r.p.programId, { outageStartedAt: ms(now - 120_000), outageEndedAt: ms(now - 40_000) });
    expect(summary).toMatchObject({ questions_extended: 1, granted_ms: 20_000 });
    expect((await state(inside)).ext).toBeGreaterThan(0);
    for (const id of [servedAfter, dueAfter]) expect((await state(id)).ext, id).toBe(0);
  });

  it("extends an answer at most once, for every writer (ET106), and keeps its ledger append-only (ET111)", async () => {
    await admins();
    const r = await running();
    const id = await r.row(0, 40_000);
    await extend(r.p.programId, { outageStartedAt: ms(Date.now() - 30_000) });
    const asContest = (statement: string) =>
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE contest_results");
        await tx.unsafe(statement);
      });
    expect(await sqlState(asContest(`UPDATE public.attempt_questions SET deadline_extension_ms = deadline_extension_ms + 1000, deadline_at = deadline_at + interval '1 second' WHERE id = '${id}'`))).toBe("ET106");
    expect(await sqlState(sql`UPDATE attempt_questions SET deadline_extension_ms = 0 WHERE id = ${id}`)).toBe("ET106");
    const fresh = await r.row(1, 1_000);
    expect(await sqlState(sql`UPDATE attempt_questions SET deadline_at = deadline_at + interval '30 seconds', deadline_extension_ms = 30000 WHERE id = ${fresh}`)).toBe("ET106");
    for (const statement of [
      `UPDATE public.deadline_extensions SET granted_ms = 1 WHERE attempt_question_id = '${id}'`,
      `DELETE FROM public.deadline_extensions WHERE attempt_question_id = '${id}'`,
      "TRUNCATE public.deadline_extensions",
    ]) {
      expect(await sqlState(sql.unsafe(statement)), statement).toBe("ET111");
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement))), `admin_rw: ${statement}`).toBe("42501");
    }
  });

  it("is bounded and validated (ET101), refused once grace is over (ET102), and only admin_rw may call it", async () => {
    await admins();
    const p = await program([[20]], -DAY);
    for (const [what, e] of [
      ["an outage in the future", { outageStartedAt: ms(Date.now() + 60_000), outageEndedAt: ms(Date.now() + 120_000) }],
      ["an outage ending before it started", { outageStartedAt: ms(Date.now() - 60_000), outageEndedAt: ms(Date.now() - 120_000) }],
      ["an outage ending in the future", { outageEndedAt: ms(Date.now() + 60_000) }],
      ["an outage longer than trivia.extension_max_minutes", { outageStartedAt: ms(Date.now() - 61 * 60_000) }],
      ["a short reason", { reason: "mati" }],
      ["a reason with a phone number", { reason: "Pemain 0812 3456 7890 melapor" }],
      ["a reason with an e-mail address", { reason: "Dilaporkan budi@example.test" }],
      ["a Staff actor", { actor: staffId }],
      ["no actor", { actor: null }],
    ] as [string, Extension][]) {
      expect(await sqlState(extend(p.programId, e)), what).toBe("ET101");
    }
    await sql`UPDATE app_settings SET value = '120' WHERE key = 'trivia.extension_max_minutes'`;
    try {
      await extend(p.programId, { outageStartedAt: ms(Date.now() - 90 * 60_000) });
    } finally {
      await sql`UPDATE app_settings SET value = '60' WHERE key = 'trivia.extension_max_minutes'`;
    }
    const over = await program([[20]], 30_000);
    expect(await sqlState(extend(over.programId))).toBe("ET102");
    for (const role of ["worker_rw", "public_rw"] as const) expect(await sqlState(extend(p.programId, {}, role)), role).toBe("42501");
  });

  it("public_rw cannot write an extension or a deadline itself (42501)", async () => {
    const r = await running();
    const id = await r.row(0, 1_000);
    for (const statement of [
      `UPDATE public.attempt_questions SET deadline_extension_ms = 1 WHERE id = '${id}'`,
      `UPDATE public.attempt_questions SET deadline_at = deadline_at + interval '1 hour' WHERE id = '${id}'`,
    ]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });
});

describe("a question still running at the grace end (code review MAJOR-1)", () => {
  it("holds the snapshot (ET103) until every question served before G has had its full time; one served at G counts as never served", async () => {
    const p = await program([[600, 20]], 2 * 60_000);
    const pl = await player(p);
    const s = p.sets[0];
    const [long, short] = s?.questions ?? [];
    if (s === undefined || long === undefined || short === undefined) throw new Error("no questions");
    const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${pl}, ${s.id}) RETURNING id`);
    const servedBeforeG = ms(p.graceEnd.getTime() - 5_000);
    const { id: running } = first(await sql<Id[]>`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
      VALUES (${attemptId}, ${long.id}, 1, ${[long.right, long.wrong]}::uuid[], ${servedBeforeG}, ${ms(servedBeforeG.getTime() + 600_000)}) RETURNING id`);
    const { id: servedAtG } = first(await sql<Id[]>`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
      VALUES (${attemptId}, ${short.id}, 2, ${[short.right, short.wrong]}::uuid[], ${p.graceEnd}, ${ms(Date.now() + 60_000)}) RETURNING id`);
    expect(await sqlState(snapshot(p.programId))).toBe("ET103");
    expect(await sql`SELECT 1 FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).toHaveLength(0);
    // Its deadline (+ 1500 ms) passes: the snapshot runs and closes it at its deadline.
    const deadline = ms(Date.now() - 2_000);
    await sql`UPDATE attempt_questions SET deadline_at = ${deadline} WHERE id = ${running}`;
    await snapshot(p.programId);
    const rows = new Map(
      (await sql<{ id: string; answered_at: Date; elapsed_ms: number }[]>`SELECT id, answered_at, elapsed_ms FROM attempt_questions WHERE attempt_id = ${attemptId}`).map((x) => [x.id, x]),
    );
    expect(rows.get(running)?.answered_at).toEqual(deadline);
    expect(rows.get(servedAtG)).toMatchObject({ answered_at: p.graceEnd, elapsed_ms: 20_000 });
  });
});

describe("the finalize against concurrent play (security review P1-1)", () => {
  /** An ended program with one player whose question expired before G and is still open. */
  async function endedWithOpenQuestion() {
    const p = await program([[20, 20]]);
    const pl = await player(p);
    const s = p.sets[0];
    const [q1, q2] = s?.questions ?? [];
    if (s === undefined || q1 === undefined || q2 === undefined) throw new Error("no questions");
    const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${pl}, ${s.id}) RETURNING id`);
    const served = ms(p.graceEnd.getTime() - 60_000);
    await sql`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
      VALUES (${attemptId}, ${q1.id}, 1, ${[q1.right, q1.wrong]}::uuid[], ${served}, ${ms(served.getTime() + 20_000)}, ${ms(served.getTime() + 4_000)}, ${q1.right})`;
    const { id: open } = first(await sql<Id[]>`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
      VALUES (${attemptId}, ${q2.id}, 2, ${[q2.right, q2.wrong]}::uuid[], ${ms(served.getTime() + 30_000)}, ${ms(served.getTime() + 50_000)}) RETURNING id`);
    return { p, pl, attemptId, open };
  }
  function gated() {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    return { gate, release, holding, held };
  }
  /** The frozen entry equals what the answer rows derive: score = points, total = elapsed + unplayed. */
  async function frozenMatchesDerived(programId: string, playerId: string): Promise<void> {
    const entries = first(await sql<{ entries: { player_id: string; score: number; total_ms: number; unplayed_ms: number }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${programId}`).entries;
    const entry = entries.find((e) => e.player_id === playerId);
    const derived = first(await sql<{ score: number; elapsed: number }[]>`
      SELECT coalesce(sum(x.points), 0)::int AS score, coalesce(sum(x.elapsed_ms), 0)::int AS elapsed
        FROM attempt_questions aq JOIN set_attempts a ON a.id = aq.attempt_id JOIN trivia_sets s ON s.id = a.set_id JOIN questions q ON q.id = aq.question_id,
             LATERAL public.score_answer(q.points, q.timer_seconds, (SELECT o.id FROM question_options o WHERE o.question_id = q.id AND o.is_correct),
                                         aq.option_id, aq.served_at, aq.deadline_at, aq.answered_at, aq.deadline_extension_ms) x
       WHERE a.player_id = ${playerId} AND s.program_id = ${programId}`);
    expect({ score: entry?.score, total: (entry?.total_ms ?? 0) - (entry?.unplayed_ms ?? 0) }).toEqual({ score: derived.score, total: derived.elapsed });
  }

  it("a play write that holds the shared lock first is fully reflected: the snapshot waits for it", async () => {
    const r = await endedWithOpenQuestion();
    const g = gated();
    const play = asRole("trivia_play", async (tx) => {
      await tx`UPDATE public.attempt_questions SET answered_at = now() WHERE id = ${r.open}`; // closes the timeout
      g.held();
      await g.gate;
    });
    await g.holding;
    let done = false;
    const finalize = snapshot(r.p.programId).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(done).toBe(false);
    g.release();
    await play;
    await finalize;
    const closed = first(await sql<{ answered: Date; deadline: Date }[]>`SELECT answered_at AS answered, deadline_at AS deadline FROM attempt_questions WHERE id = ${r.open}`);
    expect(closed.answered).toEqual(closed.deadline);
    await frozenMatchesDerived(r.p.programId, r.pl);
  });

  it("a play write that arrives during the finalize waits for it, then is refused (ET050); the frozen score equals the derived one", async () => {
    const r = await endedWithOpenQuestion();
    const g = gated();
    const finalize = sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      await tx`SELECT public.create_leaderboard_snapshot(${r.p.programId}::uuid)`;
      g.held();
      await g.gate;
    });
    await g.holding;
    let settled = false;
    const play = sqlState(asRole("trivia_play", (tx) => tx`UPDATE public.attempt_questions SET ip = '203.0.113.9' WHERE id = ${r.open}`)).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    g.release();
    await finalize;
    expect(await play).toBe("ET050");
    await frozenMatchesDerived(r.p.programId, r.pl);
    // Nothing starts or is added after G either.
    expect(await sqlState(asRole("trivia_play", (tx) => tx`INSERT INTO public.set_attempts (player_id, set_id) VALUES (${r.pl}, ${r.p.sets[0]?.id ?? ""})`))).toBe("ET050");
  });

  it("refuses a new question row of an existing attempt at or after G (ET110)", async () => {
    const p = await program([[20, 20]], 30_000);
    const pl = await player(p);
    const s = p.sets[0];
    const q = s?.questions[1];
    if (s === undefined || q === undefined) throw new Error("no question");
    const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${pl}, ${s.id}) RETURNING id`);
    expect(
      await sqlState(asRole("trivia_play", (tx) => tx`
        INSERT INTO public.attempt_questions (attempt_id, question_id, position, permutation) VALUES (${attemptId}, ${q.id}, 2, ${[q.right, q.wrong]}::uuid[])`)),
    ).toBe("ET110");
  });
});

describe("US-021's refunds and chargebacks against the results (combined with US-028)", () => {
  /** What US-021's refreshEligibility writes after the player's last paid order is refunded. */
  const refund = (programId: string, playerId: string) =>
    asRole("worker_rw", (tx) => tx`UPDATE public.player_programs SET eligible = false, first_paid_at = NULL, updated_at = now() WHERE player_id = ${playerId} AND program_id = ${programId}`);

  it("a refund that clears first_paid_at is never refused: before the snapshot the player is scored but not ranked, after it a winner is flagged, not frozen", async () => {
    const p = await program([[20]]);
    await tier(p.programId, 1, 2);
    const refunded = await player(p);
    const kept = await player(p);
    await attempt(p, refunded, 0, [{ pick: "r", served: 0, answered: 2_000 }]);
    await refund(p.programId, refunded);
    await snapshot(p.programId);
    const entries = first(await sql<{ entries: { player_id: string }[] }[]>`SELECT entries FROM leaderboard_snapshots WHERE program_id = ${p.programId}`).entries;
    expect(entries.map((e) => e.player_id)).toEqual([kept]);
    expect(first(await sql<{ score: number }[]>`SELECT score FROM player_program_stats WHERE player_id = ${refunded} AND program_id = ${p.programId}`).score).toBe(10);
    // After the snapshot: the winner's refund and US-021's chargeback flag both go through.
    await refund(p.programId, kept);
    await asRole("worker_rw", (tx) => tx`
      UPDATE public.winners SET status = 'flagged', flagged_at = now(), flag_reason = 'chargeback', updated_at = now()
       WHERE player_id = ${kept} AND program_id = ${p.programId} AND status IN ('awaiting_confirmation', 'confirmed')`);
    expect(first(await sql<{ status: string }[]>`SELECT status::text FROM winners WHERE player_id = ${kept}`).status).toBe("flagged");
    await admins();
    expect(await sqlState(confirm(p.programId))).toBe("ET107");
  });
});

describe("eligibility and results privileges (security review P1-3, P1-5)", () => {
  it("admin_rw writes no eligibility (42501), and public_rw reads no results table", async () => {
    const p = await program([[20]]);
    const pl = await player(p);
    for (const statement of [
      `UPDATE public.player_programs SET eligible = true WHERE player_id = '${pl}'`,
      `UPDATE public.player_programs SET first_paid_at = now() - interval '400 days' WHERE player_id = '${pl}'`,
      `INSERT INTO public.player_programs (player_id, program_id, first_paid_at, eligible) VALUES ('${pl}', gen_random_uuid(), now(), true)`,
      `DELETE FROM public.player_programs WHERE player_id = '${pl}'`,
    ]) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
    for (const statement of ["SELECT entries FROM public.leaderboard_snapshots", "SELECT player_id FROM public.winners"]) {
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
  });
});
