// US-028 admin side (lib/settings/contest.ts), as the admin_rw login: the results page data
// (winners in full, anti-cheat flags), the Owner's winner confirmation and the deadline extension,
// each through the database's function with the mutation scope's actor, request id and IP, the
// database's refusals turned into form messages.
import { describe, expect, it } from "vitest";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { CONTEST_ENDED, confirmWinners, extendDeadlines, getContestResults, listFlaggedPlayers, RESULTS_NOT_READY, WINNER_BLOCKED } from "../src/lib/settings/contest.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

type Id = { id: string };
const DAY = 86_400_000;
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

/** A published program whose grace ended `endedAgoMs` ago (negative: still running), one set of `questions` 20 s questions. */
async function program(endedAgoMs: number, questions = 3) {
  const graceEnd = new Date(Math.floor(Date.now() / 1000) * 1000 - endedAgoMs);
  const salesEnd = new Date(graceEnd.getTime() - 2 * DAY);
  const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
  const { id: programId } = await one(root<Id[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`res-${suffix()}`}, 'Hasil', 'published', ${new Date(salesEnd.getTime() - 30 * DAY)}, ${salesEnd}, 2) RETURNING id`);
  const { id: setId } = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Set') RETURNING id`);
  const qs: { id: string; right: string; wrong: string }[] = [];
  for (let i = 0; i < questions; i++) {
    const { id } = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${setId}, ${i + 1}, 'Q', 10, 20) RETURNING id`);
    const [right, wrong] = await root<Id[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${id}, 1, 'A', true), (${id}, 2, 'B', false) RETURNING id`;
    qs.push({ id, right: right?.id ?? "", wrong: wrong?.id ?? "" });
  }
  return { programId, setId, qs, graceEnd };
}

async function player(programId: string, name: string, phone: string): Promise<string> {
  const { id } = await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${phone}, ${name}) RETURNING id`);
  await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${programId}, now() - interval '20 days', true)`;
  return id;
}

const phone = (): string => `+62817${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;

/** One attempt: every question answered right after `elapsed[i]` ms, from `ip` / `ua`. */
async function play(p: Awaited<ReturnType<typeof program>>, playerId: string, elapsed: number[], device: { ip?: string; ua?: Buffer } = {}): Promise<string> {
  const { id: attemptId } = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${playerId}, ${p.setId}) RETURNING id`);
  const base = p.graceEnd.getTime() - DAY;
  for (const [i, ms] of elapsed.entries()) {
    const q = p.qs[i];
    if (q === undefined) throw new Error("no question");
    const served = new Date(base + i * 60_000);
    await root`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms, ip, ua_hash)
      VALUES (${attemptId}, ${q.id}, ${i + 1}, ${[q.right, q.wrong]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}, ${new Date(served.getTime() + ms)},
              ${q.right}, true, 10, ${ms}, ${device.ip ?? null}::inet, ${device.ua ?? null})`;
  }
  return attemptId;
}

/** A paid order of `playerId` in the program, with a payment and / or a raw notification of the given Midtrans status. */
async function order(programId: string, playerId: string, payment: string | null, notification: string | null = null): Promise<void> {
  const program = await one(root<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${programId}`);
  const lp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`);
  const publicId = `${suffix()}${suffix()}${suffix()}`;
  const orderCode = `${suffix()}${suffix()}`.toUpperCase();
  const o = await one(root<Id[]>`
    INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, player_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
    VALUES (${publicId}, ${orderCode}, ${lp.id}, ${programId}, ${program.product_id}, ${playerId}, 'Pembeli', ${phone()},
            'buyer@example.invalid', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, 'paid', now() + interval '1 hour')
    RETURNING id`);
  if (payment !== null) {
    await root`INSERT INTO payments (order_id, gateway_txn_id, transaction_status, gross_amount_idr) VALUES (${o.id}, ${`txn-${suffix()}${suffix()}`}, ${payment}, 49000)`;
  }
  if (notification !== null) {
    await root`INSERT INTO midtrans_attempts (order_id, n, midtrans_order_id, status) VALUES (${o.id}, 1, ${`${publicId}-1`}, 'created')`;
    await root`
      INSERT INTO payment_notifications (midtrans_order_id, transaction_status, status_code, signature, raw)
      VALUES (${`${publicId}-1`}, ${notification}, '200', ${suffix()}, '{}')`;
  }
}

const snapshot = (programId: string) =>
  root.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE worker_rw");
    await tx`SELECT public.create_leaderboard_snapshot(${programId}::uuid)`;
  });

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof InvalidInput) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("contest results (lib/settings/contest.ts)", () => {
  it("shows the winners in full with their flags; the Owner confirms them (audited with the request scope), Staff cannot", async () => {
    const rt = newRuntime();
    const owner = await createTestAdmin(rt, "owner");
    const staff = await createTestAdmin(rt, "staff");
    const p = await program(5 * 60_000);
    await root`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${p.programId}, 1, 2, 'Juara')`;
    const fast = await player(p.programId, "Rina Kilat", "+6281234500111");
    const slow = await player(p.programId, "Dodi Santai", "+6281234500222");
    await play(p, fast, [300, 400, 500]);
    await play(p, slow, [9000, 9000, 9000]);
    expect(await refusal(asAdmin(owner.userId, () => confirmWinners(rt.sql, p.programId)))).toBe(RESULTS_NOT_READY);
    await snapshot(p.programId);

    const results = await getContestResults(rt.sql, p.programId);
    expect(results?.status).toBe("awaiting_confirmation");
    expect(results?.snapshot?.ranked).toBe(2);
    // In full for the Owner and Staff (the Owner's decision of 2026-11-25).
    expect(results?.winners.map((w) => [w.rank, w.prizeName, w.name, w.phone, w.status, w.eligible])).toEqual([
      [1, "Juara", "Rina Kilat", "+6281234500111", "awaiting_confirmation", true],
      [2, "Juara", "Dodi Santai", "+6281234500222", "awaiting_confirmation", true],
    ]);
    expect(results?.winners[0]?.flags).toEqual(["fast_median"]);

    expect(await refusal(asAdmin(staff.userId, () => confirmWinners(rt.sql, p.programId)))).toMatch(/active Owner/);
    expect(await asAdmin(owner.userId, () => confirmWinners(rt.sql, p.programId), "198.51.100.20")).toEqual({ winners: 2 });
    const audit = await one(root<{ actor: string; ip: string; request: string | null }[]>`
      SELECT actor_admin_user_id AS actor, host(ip) AS ip, request_id AS request FROM audit_log WHERE action = 'contest.winners_confirm' AND entity_id = ${p.programId}`);
    expect(audit).toMatchObject({ actor: owner.userId, ip: "198.51.100.20" });
    expect(audit.request).toMatch(/^test-/);
    expect((await getContestResults(rt.sql, p.programId))?.winners.every((w) => w.status === "confirmed")).toBe(true);
    expect(await refusal(asAdmin(owner.userId, () => confirmWinners(rt.sql, p.programId)))).toBe(RESULTS_NOT_READY);
  });

  it("refuses to confirm while a winner has been refunded since the snapshot", async () => {
    const rt = newRuntime();
    const owner = await createTestAdmin(rt, "owner");
    const p = await program(5 * 60_000);
    await root`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${p.programId}, 1, 1, 'Juara')`;
    const winner = await player(p.programId, "Ani", phone());
    await snapshot(p.programId);
    await root`UPDATE player_programs SET eligible = false WHERE player_id = ${winner}`;
    expect((await getContestResults(rt.sql, p.programId))?.winners[0]?.eligible).toBe(false);
    expect(await refusal(asAdmin(owner.userId, () => confirmWinners(rt.sql, p.programId)))).toBe(WINNER_BLOCKED);
  });

  it("extends open questions for the Owner while the contest runs, and refuses once it has ended", async () => {
    const rt = newRuntime();
    const owner = await createTestAdmin(rt, "owner");
    const running = await program(-DAY);
    const pl = await player(running.programId, "Budi", phone());
    const { id: attemptId } = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${pl}, ${running.setId}) RETURNING id`);
    const q = running.qs[0];
    const served = new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000);
    await root`
      INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at)
      VALUES (${attemptId}, ${q?.id ?? ""}, 1, ${[q?.right ?? "", q?.wrong ?? ""]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)})`;
    expect((await getContestResults(rt.sql, running.programId))?.openQuestions).toBe(1);
    const input = { outageStartedAt: new Date(Date.now() - 20 * 60_000), outageEndedAt: new Date(), reason: "Server mati dua puluh menit." };
    expect(await asAdmin(owner.userId, () => extendDeadlines(rt.sql, running.programId, input))).toEqual({ questions: 1, players: 1 });
    const audit = await one(root<{ actor: string; changes: Record<string, unknown> }[]>`
      SELECT actor_admin_user_id AS actor, changes FROM audit_log WHERE action = 'contest.deadline_extension' AND entity_id = ${running.programId}`);
    expect(audit).toMatchObject({ actor: owner.userId, changes: { questions_extended: 1, granted_ms: 20_000, reason: "Server mati dua puluh menit." } });
    const ended = await program(30_000);
    expect(await refusal(asAdmin(owner.userId, () => extendDeadlines(rt.sql, ended.programId, input)))).toBe(CONTEST_ENDED);
    expect(await refusal(asAdmin(owner.userId, () => extendDeadlines(rt.sql, running.programId, { ...input, outageStartedAt: new Date(Date.now() - 61 * 60_000) })))).toMatch(/valid values/);
  });

  it("flags fast medians, identical on-time answer times on a set, and more than 3 players per IP or browser; nothing else, most flags first", async () => {
    const rt = newRuntime();
    const p = await program(-DAY, 3);
    const ua = Buffer.alloc(32, 7);
    const players: Record<string, string> = {};
    for (const name of ["fast", "twinA", "twinB", "ip1", "ip2", "ip3", "ip4", "ua1", "ua2", "ua3", "ua4", "clean", "lateA", "lateB", "both", "charged", "inbox"]) players[name] = await player(p.programId, `Pemain ${name}`, phone());
    const at = (name: string) => players[name] ?? "";
    await play(p, at("fast"), [100, 700, 5000]);
    await play(p, at("twinA"), [4321, 5432, 6543]);
    await play(p, at("twinB"), [4321, 5432, 6543]);
    for (const [i, name] of ["ip1", "ip2", "ip3", "ip4"].entries()) await play(p, at(name), [3000 + i, 4000 + i, 5000 + i], { ip: "203.0.113.50" });
    for (const [i, name] of ["ua1", "ua2", "ua3", "ua4"].entries()) await play(p, at(name), [6000 + i, 7000 + i, 8000 + i], { ua });
    await play(p, at("clean"), [2500, 3500, 4500], { ip: "203.0.113.51", ua: Buffer.alloc(32, 9) });
    // Late picks (charged the full 20 s timer) are identical for everyone who is late: no fingerprint.
    await play(p, at("lateA"), [20_000, 20_000, 20_000]);
    await play(p, at("lateB"), [20_000, 20_000, 20_000]);
    // Two flags: fast and on the shared IP (a fifth player there).
    await play(p, at("both"), [200, 300, 400], { ip: "203.0.113.50" });
    // US-021 security review P2-3: a chargeback, processed (payments) or still in the notification
    // inbox, flags its player, who may not have played at all; a settlement flags nobody.
    await order(p.programId, at("charged"), "chargeback");
    await order(p.programId, at("inbox"), null, "partial_chargeback");
    await order(p.programId, at("clean"), "settlement");
    const listed = await listFlaggedPlayers(rt.sql, p.programId);
    expect(listed.total).toBe(14);
    expect(listed.players[0]?.playerId).toBe(at("both"));
    expect(listed.players[0]?.flags).toEqual(["fast_median", "shared_ip"]);
    expect((await listFlaggedPlayers(rt.sql, p.programId, 3)).players).toHaveLength(3);
    expect((await listFlaggedPlayers(rt.sql, p.programId, 3)).total).toBe(14);
    const flagged = new Map(listed.players.map((f) => [f.playerId, f]));
    expect(flagged.get(at("fast"))?.flags).toEqual(["fast_median"]);
    expect(flagged.get(at("fast"))?.medianMs).toBe(700);
    expect(flagged.get(at("twinA"))?.flags).toEqual(["shared_fingerprint"]);
    expect(flagged.get(at("twinB"))?.flags).toEqual(["shared_fingerprint"]);
    for (const name of ["ip1", "ip4"]) expect(flagged.get(at(name))?.flags, name).toEqual(["shared_ip"]);
    for (const name of ["ua1", "ua4"]) expect(flagged.get(at(name))?.flags, name).toEqual(["shared_ua"]);
    expect(flagged.get(at("ip1"))?.ipPlayers).toBe(5);
    for (const name of ["clean", "lateA", "lateB"]) expect(flagged.has(at(name)), name).toBe(false);
    for (const name of ["charged", "inbox"]) expect(flagged.get(at(name))?.flags, name).toEqual(["chargeback"]);
    expect(flagged.size).toBe(14);
    for (const f of flagged.values()) expect(f.name).toMatch(/^Pemain /);
  });
});
