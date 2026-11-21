// US-030 fixtures: a contest whose grace has ended, ranked players, the real results snapshot (worker_rw) and the Owner's
// confirmation (admin_rw), so fulfilment, re-award and erasure tests start from rows the real functions wrote.
import { asRole, first, sql, suffix, uniquePhone } from "./db.ts";

type Id = { id: string };
const DAY = 86_400_000;
/** Whole milliseconds. */
const ms = (t: number): Date => new Date(Math.floor(t));

export interface Contest {
  readonly programId: string;
  readonly setId: string;
  readonly questionId: string;
  readonly right: string;
  readonly graceEnd: Date;
}

/** A published program whose grace ended `endedAgoMs` ago (negative: still running), one set of one 20 s question. */
export async function contest(endedAgoMs = 2 * 60_000): Promise<Contest> {
  const product = first(await sql<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const graceEnd = ms(Date.now() - endedAgoMs);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const { id: programId } = first(
    await sql<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`prize-${suffix()}`}, 'Kontes', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2)
      RETURNING id`,
  );
  const { id: setId } = first(await sql<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Set') RETURNING id`);
  const { id: questionId } = first(
    await sql<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${setId}, 1, 'Q', 10, 20) RETURNING id`,
  );
  const [right] = await sql<Id[]>`
    INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${questionId}, 1, 'A', true), (${questionId}, 2, 'B', false) RETURNING id`;
  return { programId, setId, questionId, right: right?.id ?? "", graceEnd };
}

export const tier = (programId: string, from: number, to: number): Promise<string> =>
  sql<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name, value_idr) VALUES (${programId}, ${from}, ${to}, ${`Hadiah ${String(from)}`}, 100000) RETURNING id`.then(
    (r) => first(r).id,
  );

/** An eligible player who answered the question right after `elapsedMs` (smaller = better rank). */
export async function rankedPlayer(c: Contest, elapsedMs: number, opts: { name?: string; phone?: string; email?: string } = {}): Promise<{ id: string; phone: string }> {
  const phone = opts.phone ?? uniquePhone();
  const { id } = first(await sql<Id[]>`INSERT INTO players (phone, name, email) VALUES (${phone}, ${opts.name ?? "Pemain Uji"}, ${opts.email ?? null}) RETURNING id`);
  await sql`
    INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible)
    VALUES (${id}, ${c.programId}, ${ms(c.graceEnd.getTime() - 20 * DAY)}, true)`;
  const { id: attemptId } = first(await sql<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${id}, ${c.setId}) RETURNING id`);
  const served = ms(c.graceEnd.getTime() - DAY);
  await sql`
    INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id)
    VALUES (${attemptId}, ${c.questionId}, 1, ${[c.right]}::uuid[], ${served}, ${ms(served.getTime() + 20_000)}, ${ms(served.getTime() + elapsedMs)}, ${c.right})`;
  return { id, phone };
}

export const snapshot = (programId: string) =>
  asRole("worker_rw", async (tx) => first(await tx<{ summary: Record<string, unknown> }[]>`SELECT public.create_leaderboard_snapshot(${programId}::uuid) AS summary`).summary);

let owner = "";
let staff = "";
/** An active Owner and a Staff admin (admin_auth user + profile), made once per test file. */
export async function admins(): Promise<{ owner: string; staff: string }> {
  if (owner === "") {
    for (const role of ["owner", "staff"] as const) {
      const id = `${role}-${suffix()}`;
      await sql`INSERT INTO admin_auth."user" (id, name, email, "emailVerified") VALUES (${id}, ${role}, ${`${id}@example.test`}, true)`;
      await sql`INSERT INTO admin_profiles (auth_user_id, role, display_name) VALUES (${id}, ${role}, ${role})`;
      if (role === "owner") owner = id;
      else staff = id;
    }
  }
  return { owner, staff };
}

export async function confirm(programId: string): Promise<Record<string, unknown>> {
  const { owner: actor } = await admins();
  return asRole("admin_rw", async (tx) =>
    first(await tx<{ summary: Record<string, unknown> }[]>`SELECT public.confirm_program_winners(${programId}::uuid, ${actor}, 'req-c', '198.51.100.7'::inet) AS summary`).summary,
  );
}

export interface WinnerRow {
  readonly id: string;
  readonly player_id: string;
  readonly rank: number;
  readonly status: string;
  readonly prize_tier_id: string;
  readonly replaces_winner_id: string | null;
  readonly fulfillment_id: string | null;
  readonly fulfillment: string | null;
}

export const winnersOf = (programId: string): Promise<WinnerRow[]> =>
  sql<WinnerRow[]>`
    SELECT w.id, w.player_id, w.rank, w.status::text AS status, w.prize_tier_id, w.replaces_winner_id, f.id AS fulfillment_id, f.status::text AS fulfillment
      FROM winners w LEFT JOIN fulfillments f ON f.winner_id = w.id
     WHERE w.program_id = ${programId} ORDER BY w.created_at, w.rank`;

/** A finalized contest: `players` ranked players (rank i+1 answered after (i+1) s), tiers 1-1 and 2-2, snapshot and confirmation. */
export async function finalized(players = 5): Promise<{ c: Contest; players: { id: string; phone: string }[]; gold: string; silver: string }> {
  const c = await contest();
  const gold = await tier(c.programId, 1, 1);
  const silver = await tier(c.programId, 2, 2);
  const ranked = [];
  for (let i = 0; i < players; i++) ranked.push(await rankedPlayer(c, (i + 1) * 1000));
  await snapshot(c.programId);
  await confirm(c.programId);
  return { c, players: ranked, gold, silver };
}
