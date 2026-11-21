// US-029: the delivery report (per-number volume and failure rate, per-order status with the sender number, buyers masked) and the
// contest report (completion per set, the live and the frozen leaderboard, the winners export), as the admin_rw login. Figures are
// worked out by hand in the comments.
import { randomBytes } from "node:crypto";
import Papa from "papaparse";
import { beforeAll, describe, expect, it } from "vitest";
import { leaderboard, participation, programChoices } from "../src/lib/reports/contest-report.ts";
import { channelCounts, deliveryList, parseDeliveryFilters, perNumberStats } from "../src/lib/reports/delivery-source.ts";
import { WINNERS_CSV_HEADER, winnersCsv } from "../src/lib/reports/exports.ts";
import { newRuntime, root, suffix } from "./support.ts";

const rt = newRuntime();
type Id = { id: string };
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
const at = (day: string, hourWib: number): Date => new Date(Date.parse(`${day}T00:00:00Z`) + (hourWib - 7) * 3_600_000);
// Days of their own (2026-10-05 / 06): the report dataset of reports.int.test.ts owns 2026-11-18 .. 11-20, and a paid Organic order here would
// shift sixteen of its hand-computed figures whenever this file runs first.
const DAY1 = "2026-10-05";
const DAY2 = "2026-10-06";
const RANGE = { from: DAY1, to: DAY2 };

describe("the delivery report (AC-A6)", () => {
  const tag = suffix();
  const numbers: Record<"n1" | "n2" | "n3", string> = { n1: "", n2: "", n3: "" };
  const PHONES = { n1: "+6281111110001", n2: "+6281111110002", n3: "+6281111110003" } as const;
  const deliveries: Record<string, string> = {};

  async function paidOrder(programId: string, productId: string, lpId: string, day: string, hour: number): Promise<string> {
    const created = at(day, hour);
    return (
      await one(root<Id[]>`
        INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, created_at, paid_at)
        VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${lpId}, ${programId}, ${productId}, 'Budi Santoso', '+6281234500100', 'budi@example.invalid', ${randomBytes(32)}, 49000, 'paid',
                ${new Date(created.getTime() + 3_600_000)}, ${created}, ${created})
        RETURNING id`)
    ).id;
  }

  beforeAll(async () => {
    const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, 49000) RETURNING id`);
    const program = await one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`dlv-${tag}`}, 'Delivery', 'published', now() - interval '60 days', now() + interval '60 days', 30) RETURNING id`);
    const lp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program.id}) RETURNING id`);
    const server = await one(root<Id[]>`
      INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`waha-${tag}`}, ${`https://waha-${tag}.example.test`}, ${`waha-${tag}.example.test`}) RETURNING id`);
    for (const key of ["n1", "n2", "n3"] as const) {
      numbers[key] = (await one(root<Id[]>`INSERT INTO waha_sessions (server_id, session_name, phone) VALUES (${server.id}, ${`${key}-${tag}`}, ${PHONES[key]}) RETURNING id`)).id;
    }
    const delivery = async (name: string, channel: "whatsapp" | "email", status: string, hour: number, tried: string[], session: string | null, lastError: string | null = null, ack: string | null = null) => {
      const order = await paidOrder(program.id, product.id, lp.id, DAY1, hour);
      const created = at(DAY1, hour);
      deliveries[name] = (
        await one(root<Id[]>`
          INSERT INTO deliveries (order_id, channel, status, session_id, tried_session_ids, attempts, last_error, wa_ack, created_at, sent_at, lease_until)
          VALUES (${order}, ${channel}, ${status}, ${session}, ${tried}::uuid[], ${Math.max(1, tried.length)}, ${lastError}, ${ack}, ${created}, ${status === "sent" ? created : null},
                  ${status === "sending" ? new Date(Date.now() + 600_000) : null})
          RETURNING id`)
      ).id;
      return order;
    };
    const { n1, n2, n3 } = numbers;
    // WhatsApp. d1: sent from n1. d2: failed on n1, sent from n2. d3: failed on n1 and n2, failed on n3. d4: n1 timed out (unknown). d5: n2 is sending.
    const a = await delivery("d1", "whatsapp", "sent", 9, [n1], n1, null, "delivered");
    await delivery("d2", "whatsapp", "sent", 10, [n1, n2], n2);
    await delivery("d3", "whatsapp", "failed", 11, [n1, n2, n3], n3, "waha_error");
    await delivery("d4", "whatsapp", "unknown", 12, [n1], n1, "timeout");
    await delivery("d5", "whatsapp", "sending", 13, [n2], n2);
    // E-mail: no number.
    await root`
      INSERT INTO deliveries (order_id, channel, status, attempts, created_at, sent_at) VALUES (${a}, 'email', 'sent', 1, ${at(DAY1, 9)}, ${at(DAY1, 9)})`;
    const b = await paidOrder(program.id, product.id, lp.id, DAY2, 9);
    await root`INSERT INTO deliveries (order_id, channel, status, attempts, last_error, created_at) VALUES (${b}, 'email', 'failed', 4, 'smtp_refused', ${at(DAY2, 9)})`;
  });

  const mine = (rows: Awaited<ReturnType<typeof perNumberStats>>) => rows.filter((r) => Object.values(numbers).includes(r.sessionId));

  it("counts every attempt of a number: a number left after a failure has a failed attempt; failure rate = failed / (sent + failed + unknown)", async () => {
    const stats = mine(await perNumberStats(rt.sql, RANGE));
    const by = new Map(stats.map((s) => [s.phone, s] as const));
    // n1: d1 sent; d2 and d3 left it after a failure (failed x 2); d4 unknown -> sent 1, failed 2, unknown 1: volume 4, 2 / 4 = 50 %.
    expect(by.get(PHONES.n1)).toMatchObject({ sent: 1, failed: 2, unknown: 1, inFlight: 0, volume: 4, failureBps: 5000 });
    // n2: d2 sent; d3 left it after a failure; d5 still sending -> sent 1, failed 1, in flight 1: volume 2, 1 / 2 = 50 %.
    expect(by.get(PHONES.n2)).toMatchObject({ sent: 1, failed: 1, unknown: 0, inFlight: 1, volume: 2, failureBps: 5000 });
    // n3: only d3 reached it and it failed -> 100 %.
    expect(by.get(PHONES.n3)).toMatchObject({ sent: 0, failed: 1, unknown: 0, inFlight: 0, volume: 1, failureBps: 10_000 });
    // Busiest number first.
    expect(stats.map((s) => s.phone)).toEqual([PHONES.n1, PHONES.n2, PHONES.n3]);
  });

  it("has no failure rate for a number that made no attempt in the range", async () => {
    const stats = mine(await perNumberStats(rt.sql, { from: "2026-10-01", to: "2026-10-02" }));
    expect(stats.map((s) => [s.volume, s.failureBps])).toEqual([[0, null], [0, null], [0, null]]);
  });

  it("counts deliveries by channel: WhatsApp 5 (2 sent, 1 failed, 1 unknown, 1 pending), e-mail 2 (1 sent, 1 failed)", async () => {
    const counts = (await channelCounts(rt.sql, RANGE)).map((c) => [c.channel, c.total, c.sent, c.failed, c.unknown, c.pending]);
    expect(counts).toContainEqual(["whatsapp", 5, 2, 1, 1, 1]);
    expect(counts).toContainEqual(["email", 2, 1, 1, 0, 0]);
  });

  it("lists each delivery with its sender number and tries, buyers MASKED in SQL, and filters by channel, status and number", async () => {
    const all = await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: null }, 1);
    expect(all.count).toBe(7);
    expect(JSON.stringify(all.rows)).not.toContain("Budi");
    expect(JSON.stringify(all.rows)).not.toContain("Santoso");
    expect(JSON.stringify(all.rows)).not.toContain("+6281234500100");
    expect(JSON.stringify(all.rows)).not.toContain("budi@example.invalid");
    expect(all.rows[0]).toMatchObject({ buyerName: "B*** S***", buyerPhone: "****100" });
    const d2 = all.rows.find((r) => r.id === deliveries["d2"]);
    expect(d2).toMatchObject({ channel: "whatsapp", status: "sent", sender: PHONES.n2, attempts: 2, numbersTried: 2 });
    const d1 = all.rows.find((r) => r.id === deliveries["d1"]);
    expect(d1).toMatchObject({ sender: PHONES.n1, ack: "delivered" });
    expect(all.rows.find((r) => r.id === deliveries["d3"])).toMatchObject({ status: "failed", lastError: "waha_error", numbersTried: 3 });
    const email = await deliveryList(rt.sql, { ...RANGE, channel: "email", status: null, sessionId: null }, 1);
    expect(email.count).toBe(2);
    expect(email.rows.every((r) => r.sender === null)).toBe(true);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: "unknown", sessionId: null }, 1)).rows.map((r) => r.id)).toEqual([deliveries["d4"]]);
    // Every delivery that TRIED n3: only d3. Every one that tried n1: d1 d2 d3 d4.
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: numbers.n3 }, 1)).rows.map((r) => r.id)).toEqual([deliveries["d3"]]);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: numbers.n1 }, 1)).count).toBe(4);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: null }, 2)).rows).toEqual([]);
  });

  it("parses its filters strictly (a value that is not ours is an error and the default, never a query)", () => {
    const now = new Date("2026-11-20T09:00:00Z");
    expect(parseDeliveryFilters({ channel: "sms" }, now).error).toBe("A filter value is not valid.");
    expect(parseDeliveryFilters({ status: "done" }, now).error).toBe("A filter value is not valid.");
    expect(parseDeliveryFilters({ number: "1; DROP" }, now).error).toBe("A filter value is not valid.");
    expect(parseDeliveryFilters({ from: "x" }, now).filters).toMatchObject({ from: "2026-10-22", to: "2026-11-20" });
    expect(parseDeliveryFilters({ channel: "email", status: "failed", number: numbers.n1 }, now)).toEqual({
      filters: { from: "2026-10-22", to: "2026-11-20", channel: "email", status: "failed", sessionId: numbers.n1 },
      error: null,
    });
  });
});

describe("the contest report (AC-A9)", () => {
  const tag = suffix();
  let programId = "";
  let tierId = "";
  const ids: Record<string, string> = {};

  async function player(key: string, name: string, phone: string, eligible: boolean, firstPaid = new Date(Date.now() - 20 * 86_400_000)): Promise<void> {
    ids[key] = (await one(root<Id[]>`INSERT INTO players (phone, name, email) VALUES (${phone}, ${name}, ${`${key}@example.invalid`}) RETURNING id`)).id;
    await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${ids[key] ?? ""}, ${programId}, ${eligible ? firstPaid : null}, ${eligible})`;
  }

  beforeAll(async () => {
    const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, 49000) RETURNING id`);
    programId = (
      await one(root<Id[]>`
        INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
        VALUES (${product.id}, ${`ctr-${tag}`}, ${`Kontes ${tag}`}, 'published', now() - interval '40 days', now() + interval '40 days', 30) RETURNING id`)
    ).id;
    const set1 = (await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 1, 'Sejarah') RETURNING id`)).id;
    const set2 = (await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${programId}, 2, 'Sains') RETURNING id`)).id;
    await player("a", "Ani Wijaya", "+6281300000001", true);
    await player("b", "Budi Hartono", "+6281300000002", true, new Date("2026-10-20T00:00:00Z"));
    await player("c", "Citra Dewi", "+6281300000003", true);
    await player("e", "Eko Prasetyo", "+6281300000005", true, new Date("2026-10-19T00:00:00Z")); // paid before b
    await player("d", "Dedi Refund", "+6281300000004", false);
    const attempt = (key: string, setId: string, finished: boolean) =>
      root`INSERT INTO set_attempts (player_id, set_id, finished_at, score, total_ms) VALUES (${ids[key] ?? ""}, ${setId}, ${finished ? new Date("2026-11-10T03:00:00.000Z") : null}, 10, 1000)`;
    // Set 1: a b c e d started; a b e d finished (c did not). Set 2: a and d started and finished.
    for (const k of ["a", "b", "e", "d"]) await attempt(k, set1, true);
    await attempt("c", set1, false);
    for (const k of ["a", "d"]) await attempt(k, set2, true);
    const stats = (key: string, score: number, totalMs: number, sets: number, finishedAt: string | null) =>
      root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at) VALUES (${ids[key] ?? ""}, ${programId}, ${score}, ${totalMs}, ${sets}, ${finishedAt === null ? null : new Date(finishedAt)})`;
    await stats("a", 40, 50_000, 2, "2026-11-10T03:00:00.000Z");
    await stats("b", 20, 30_000, 1, "2026-11-10T03:00:00.000Z");
    await stats("e", 20, 30_000, 1, "2026-11-10T03:00:00.000Z");
    await stats("c", 20, 30_000, 0, null);
    await stats("d", 100, 10_000, 2, "2026-11-10T03:00:00.000Z");
    // Prize tiers are final once the results snapshot exists: this one goes first.
    tierId = (await one(root<Id[]>`INSERT INTO prize_tiers (program_id, rank_from, rank_to, name) VALUES (${programId}, 1, 2, 'Juara') RETURNING id`)).id;
  });

  it("lists the programs to choose from, newest first", async () => {
    expect((await programChoices(rt.sql)).some((p) => p.id === programId && p.status === "published")).toBe(true);
  });

  it("counts players and completion per set: 4 eligible players, 5 started, 2 finished every set; set 1 4 of 5 = 80 %, set 2 2 of 2 = 100 %", async () => {
    const p = await participation(rt.sql, programId);
    expect(p).toMatchObject({ eligiblePlayers: 4, playersStarted: 5, playersCompletedAll: 2 });
    expect(p.sets.map((s) => [s.position, s.title, s.started, s.completed, s.completionBps])).toEqual([
      [1, "Sejarah", 5, 4, 8000],
      [2, "Sains", 2, 2, 10_000],
    ]);
  });

  it("shows the LIVE leaderboard of eligible players only (the refunded player is out), ranked like the frozen one (ties broken by the earlier first payment), buyers masked in SQL", async () => {
    const board = await leaderboard(rt.sql, programId);
    expect(board).toMatchObject({ frozen: false, frozenAt: null, total: 4 });
    // a 40. b and e tie on score, time and finish (20 points, 30000 ms): the EARLIER FIRST PAYMENT wins, so e (paid 10-19) is 2nd and b (paid 10-20) 3rd, unique ranks;
    // c (20, 30000, unfinished) is last.
    expect(board.rows.map((r) => [r.rank, r.name, r.phone, r.score, r.totalMs])).toEqual([
      [1, "A*** W***", "****001", 40, 50_000],
      [2, "E*** P***", "****005", 20, 30_000],
      [3, "B*** H***", "****002", 20, 30_000],
      [4, "C*** D***", "****003", 20, 30_000],
    ]);
    expect(board.rows[3]?.finishedAt).toBeNull();
    const text = JSON.stringify(board);
    for (const raw of ["Ani", "Wijaya", "Budi", "Dedi", "+62813000000"]) expect(text).not.toContain(raw);
    expect(board.rows.some((r) => r.name.startsWith("D"))).toBe(false);
  });

  it("shows the FROZEN leaderboard once the results snapshot exists", async () => {
    await root`
      INSERT INTO leaderboard_snapshots (program_id, frozen_at, entries)
      VALUES (${programId}, '2026-11-12T00:00:00.000Z', ${root.json([
        { rank: 1, player_id: ids["a"] ?? "", score: 40, total_ms: 50_000, finished_at: "2026-11-10T03:00:00.000Z", sets_completed: 2, unplayed_ms: 0 },
        { rank: 2, player_id: ids["b"] ?? "", score: 20, total_ms: 30_000, finished_at: "2026-11-10T03:00:00.000Z", sets_completed: 1, unplayed_ms: 0 },
        { rank: 3, player_id: ids["c"] ?? "", score: 20, total_ms: 30_000, finished_at: null, sets_completed: 0, unplayed_ms: 0 },
      ])})`;
    const board = await leaderboard(rt.sql, programId);
    expect(board).toMatchObject({ frozen: true, total: 3 });
    expect(board.frozenAt?.toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(board.rows.map((r) => [r.rank, r.name, r.score, r.finishedAt?.toISOString() ?? null])).toEqual([
      [1, "A*** W***", 40, "2026-11-10T03:00:00.000Z"],
      [2, "B*** H***", 20, "2026-11-10T03:00:00.000Z"],
      [3, "C*** D***", 20, null],
    ]);
    expect((await leaderboard(rt.sql, programId, 2)).rows).toHaveLength(2);
  });

  it("has nothing for a program without play, and no rank for nobody", async () => {
    const other = await one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES ((SELECT product_id FROM programs WHERE id = ${programId}), ${`emp-${suffix()}`}, 'Kosong', 'draft', now(), now() + interval '10 days', 5) RETURNING id`);
    expect(await participation(rt.sql, other.id)).toEqual({ eligiblePlayers: 0, playersStarted: 0, playersCompletedAll: 0, sets: [] });
    expect(await leaderboard(rt.sql, other.id)).toEqual({ frozen: false, frozenAt: null, rows: [], total: 0 });
  });

  it("exports the winners with their contact and flags, neutralized, Excel-safe; the header alone before there are winners", async () => {
    const text = async (stream: ReadableStream<Uint8Array>) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await new Response(stream).arrayBuffer());
    expect(Papa.parse((await text(winnersCsv(rt.sql, programId))).replace(/^\uFEFF/, ""), { skipEmptyLines: true, delimiter: "," }).data).toEqual([[...WINNERS_CSV_HEADER]]);
    // A winner named like a formula (request.ts accepts = + - @ in a name).
    const snapshot = await one(root<Id[]>`SELECT id FROM leaderboard_snapshots WHERE program_id = ${programId}`);
    await root`UPDATE players SET name = '=HYPERLINK("http://evil.example","x")' WHERE id = ${ids["b"] ?? ""}`;
    await root`
      INSERT INTO winners (program_id, snapshot_id, prize_tier_id, player_id, rank) VALUES
        (${programId}, ${snapshot.id}, ${tierId}, ${ids["a"] ?? ""}, 1), (${programId}, ${snapshot.id}, ${tierId}, ${ids["b"] ?? ""}, 2)`;
    const raw = await text(winnersCsv(rt.sql, programId));
    expect(raw.startsWith("\uFEFF")).toBe(true);
    const rows = Papa.parse(raw.replace(/^\uFEFF/, ""), { skipEmptyLines: true, delimiter: "," }).data;
    // Paged by rank: the same file for any batch size (rank is an integer, a cursor that cannot lose precision).
    for (const batch of [1, 2, 3]) expect(await text(winnersCsv(rt.sql, programId, batch)), `batch ${String(batch)}`).toBe(raw);
    expect(rows[0]).toEqual([...WINNERS_CSV_HEADER]);
    expect(rows.slice(1).map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]])).toEqual([
      ["1", "Juara", "awaiting_confirmation", "Ani Wijaya", "'+6281300000001", "a@example.invalid"],
      ["2", "Juara", "awaiting_confirmation", `'=HYPERLINK("http://evil.example","x")`, "'+6281300000002", "b@example.invalid"],
    ]);
    for (const row of rows.slice(1)) for (const cell of row) expect(/^[=+\-@\t\r]/.test(cell), cell).toBe(false);
  });
});

describe("the live leaderboard ranks exactly like the frozen one (sql/contest.sql, Owner D4)", () => {
  it("players tied on score, time and finish: the earlier first payment, then the player id; the live order is the order the snapshot freezes", async () => {
    const DAYMS = 86_400_000;
    const graceEnd = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
    const salesEnd = new Date(graceEnd.getTime() - 2 * DAYMS);
    const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
    const program = await one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`tie-${suffix()}`}, 'Seri', 'published', ${new Date(salesEnd.getTime() - 30 * DAYMS)}, ${salesEnd}, 2) RETURNING id`);
    const set = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${program.id}, 1, 'Set') RETURNING id`);
    const questions: { id: string; right: string; wrong: string }[] = [];
    for (const position of [1, 2, 3]) {
      const q = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set.id}, ${position}, 'Q', 10, 20) RETURNING id`);
      const [right, wrong] = await root<Id[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${q.id}, 1, 'A', true), (${q.id}, 2, 'B', false) RETURNING id`;
      questions.push({ id: q.id, right: right?.id ?? "", wrong: wrong?.id ?? "" });
    }
    // Four players, the same plays (so the same score, answer time and finish); first payments: p0 and p2 at the same instant, p1 EARLIER, p3 later.
    const firstPaid = [new Date("2026-10-02T00:00:00Z"), new Date("2026-10-01T00:00:00Z"), new Date("2026-10-02T00:00:00Z"), new Date("2026-10-03T00:00:00Z")];
    const players: string[] = [];
    const base = graceEnd.getTime() - DAYMS;
    for (const [i, paid] of firstPaid.entries()) {
      const id = (await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${`+62813000909${String(i)}`}, ${`Seri ${String(i)}`}) RETURNING id`)).id;
      players.push(id);
      await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${program.id}, ${paid}, true)`;
      const attempt = await one(root<Id[]>`INSERT INTO set_attempts (player_id, set_id) VALUES (${id}, ${set.id}) RETURNING id`);
      for (const [j, q] of questions.entries()) {
        const served = new Date(base + j * 60_000);
        await root`
          INSERT INTO attempt_questions (attempt_id, question_id, position, permutation, served_at, deadline_at, answered_at, option_id, correct, points, elapsed_ms)
          VALUES (${attempt.id}, ${q.id}, ${j + 1}, ${[q.right, q.wrong]}::uuid[], ${served}, ${new Date(served.getTime() + 20_000)}, ${new Date(served.getTime() + 1000)}, ${q.right}, true, 10, 1000)`;
      }
      await root`INSERT INTO player_program_stats (player_id, program_id, score, total_ms, sets_completed, finished_at) VALUES (${id}, ${program.id}, 30, 3000, 1, ${new Date(base + 2 * 60_000 + 1000)})`;
    }
    const live = await leaderboard(rt.sql, program.id);
    expect(live.frozen).toBe(false);
    await root.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE worker_rw");
      await tx`SELECT public.create_leaderboard_snapshot(${program.id}::uuid)`;
    });
    const frozen = await leaderboard(rt.sql, program.id);
    expect(frozen.frozen).toBe(true);
    expect(frozen.rows).toHaveLength(4);
    const order = (rows: readonly { rank: number; ref: string }[]) => rows.map((r) => [r.rank, r.ref]);
    expect(order(live.rows)).toEqual(order(frozen.rows));
    expect(live.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    // p1 paid first: rank 1. p0 and p2 paid at the same instant: the smaller player id first. p3 paid last.
    const ref = (i: number) => (players[i] ?? "").slice(0, 8);
    const tied = [0, 2].sort((x, y) => ((players[x] ?? "") < (players[y] ?? "") ? -1 : 1));
    expect(live.rows.map((r) => r.ref)).toEqual([ref(1), ref(tied[0] ?? 0), ref(tied[1] ?? 0), ref(3)]);
  });
});
