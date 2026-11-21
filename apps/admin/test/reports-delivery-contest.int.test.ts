// US-029: the delivery report (per-number volume and failure rate from the send ledger, per-order status with the sender number, buyers masked, errors
// as codes only, the failed deliveries and their resend) and the contest report (completion per set, the live and the frozen leaderboard, the winners export), as the admin_rw login. Figures are
// worked out by hand in the comments.
import { randomBytes } from "node:crypto";
import { DELIVERED_WRONG_FILE } from "@ebooktrivia/core";
import Papa from "papaparse";
import { beforeAll, describe, expect, it } from "vitest";
import { leaderboard, participation, programChoices } from "../src/lib/reports/contest-report.ts";
import { attentionList, channelCounts, deliveryList, parseDeliveryFilters, perNumberStats } from "../src/lib/reports/delivery-source.ts";
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
  let ids = { programId: "", productId: "", lpId: "" };

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
    ids = { programId: program.id, productId: product.id, lpId: lp.id };
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
    // The send ledger (waha_sends) holds one row per send of a number, with how it ended: the figures per number are counted from it.
    const ledger = async (name: string, session: string, hour: number, outcome: "sent" | "failed" | "unknown" | "reserved") => {
      await root`
        INSERT INTO waha_sends (session_id, delivery_id, kind, outcome, send_at, created_at)
        VALUES (${session}, ${deliveries[name] ?? null}, 'reply', ${outcome}, ${at(DAY1, hour)}, ${at(DAY1, hour)})`;
    };
    const a = await delivery("d1", "whatsapp", "sent", 9, [n1], n1, null, "delivered");
    await ledger("d1", n1, 9, "sent");
    await delivery("d2", "whatsapp", "sent", 10, [n1, n2], n2);
    await ledger("d2", n1, 10, "failed");
    await ledger("d2", n2, 10, "sent");
    await delivery("d3", "whatsapp", "failed", 11, [n1, n2, n3], n3, "waha_error");
    await ledger("d3", n1, 11, "failed");
    await ledger("d3", n2, 11, "failed");
    await ledger("d3", n3, 11, "failed");
    await delivery("d4", "whatsapp", "unknown", 12, [n1], n1, "timeout");
    await ledger("d4", n1, 12, "unknown");
    await delivery("d5", "whatsapp", "sending", 13, [n2], n2);
    await ledger("d5", n2, 13, "reserved");
    // A send of the numbers that belongs to no delivery (a login code): it is in the number's volume all the same.
    await root`INSERT INTO waha_sends (session_id, kind, outcome, send_at, created_at) VALUES (${n3}, 'otp', 'sent', ${at(DAY1, 14)}, ${at(DAY1, 14)})`;
    // A claim that ended with nothing sent takes its row back, so it is in no figure: nothing to insert for it.
    // E-mail: no number.
    await root`
      INSERT INTO deliveries (order_id, channel, status, attempts, created_at, sent_at) VALUES (${a}, 'email', 'sent', 1, ${at(DAY1, 9)}, ${at(DAY1, 9)})`;
    const b = await paidOrder(program.id, product.id, lp.id, DAY2, 9);
    await root`INSERT INTO deliveries (order_id, channel, status, attempts, last_error, created_at) VALUES (${b}, 'email', 'failed', 4, 'smtp_refused', ${at(DAY2, 9)})`;
  });

  const mine = (rows: Awaited<ReturnType<typeof perNumberStats>>) => rows.filter((r) => Object.values(numbers).includes(r.sessionId));

  it("counts every send of a number from the ledger: a number left after a failure has a failed send; failure rate = failed / (sent + failed + unknown)", async () => {
    const stats = mine(await perNumberStats(rt.sql, RANGE));
    const by = new Map(stats.map((s) => [s.phone, s] as const));
    // n1: d1 sent; d2 and d3 left it after a failure (failed x 2); d4 unknown -> sent 1, failed 2, unknown 1: volume 4, 2 / 4 = 50 %.
    expect(by.get(PHONES.n1)).toMatchObject({ sent: 1, failed: 2, unknown: 1, inFlight: 0, volume: 4, failureBps: 5000 });
    // n2: d2 sent; d3 left it after a failure; d5 still sending -> sent 1, failed 1, in flight 1: volume 2, 1 / 2 = 50 %.
    expect(by.get(PHONES.n2)).toMatchObject({ sent: 1, failed: 1, unknown: 0, inFlight: 1, volume: 2, failureBps: 5000 });
    // n3: d3 reached it and it failed, and a login code (no delivery) went out -> sent 1, failed 1: volume 2, 50 %.
    expect(by.get(PHONES.n3)).toMatchObject({ sent: 1, failed: 1, unknown: 0, inFlight: 0, volume: 2, failureBps: 5000 });
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
    expect(all.rows.find((r) => r.id === deliveries["d3"])).toMatchObject({ status: "failed", errorCode: "waha_error", numbersTried: 3 });
    const email = await deliveryList(rt.sql, { ...RANGE, channel: "email", status: null, sessionId: null }, 1);
    expect(email.count).toBe(2);
    expect(email.rows.every((r) => r.sender === null)).toBe(true);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: "unknown", sessionId: null }, 1)).rows.map((r) => r.id)).toEqual([deliveries["d4"]]);
    // Every delivery with a send of n3 in the ledger: only d3. Every one with a send of n1: d1 d2 d3 d4.
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: numbers.n3 }, 1)).rows.map((r) => r.id)).toEqual([deliveries["d3"]]);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: numbers.n1 }, 1)).count).toBe(4);
    expect((await deliveryList(rt.sql, { ...RANGE, channel: null, status: null, sessionId: null }, 2)).rows).toEqual([]);
  });

  it("shows an error as a CODE only: a stored text (an address, a phone, a sentence) is never sent to the page", async () => {
    const order = await paidOrder(ids.programId, ids.productId, ids.lpId, DAY2, 10);
    const leaky = one(root<Id[]>`
      INSERT INTO deliveries (order_id, channel, status, attempts, last_error, created_at) VALUES (${order}, 'email', 'failed', 1, 'rejected: budi@example.invalid +6281234500100 mailbox full', ${at(DAY2, 10)}) RETURNING id`);
    const id = (await leaky).id;
    const list = await deliveryList(rt.sql, { ...RANGE, channel: "email", status: "failed", sessionId: null }, 1);
    expect(list.rows.find((r) => r.id === id)).toMatchObject({ errorCode: "other" });
    expect(JSON.stringify(list.rows)).not.toContain("mailbox");
    expect(JSON.stringify(list.rows)).not.toContain("budi@example.invalid");
    const attention = await attentionList(rt.sql, 200);
    expect(attention.rows.find((r) => r.id === id)).toMatchObject({ errorCode: "other", status: "failed" });
    expect(JSON.stringify(attention.rows)).not.toContain("mailbox");
    expect(JSON.stringify(attention.rows)).not.toContain("+6281234500100");
    // A code is shown as it is.
    const smtp = (await deliveryList(rt.sql, { ...RANGE, channel: "email", status: "failed", sessionId: null }, 1)).rows.find((r) => r.errorCode === "smtp_refused");
    expect(smtp).toBeDefined();
  });

  it("lists the failed and unknown deliveries of PAID orders for a resend, buyers masked, newest first; a delivery of a refunded order is not offered", async () => {
    const before = await attentionList(rt.sql, 200);
    const mineFailed = before.rows.filter((r) => [deliveries["d3"], deliveries["d4"]].includes(r.id));
    expect(mineFailed.map((r) => [r.id, r.status, r.errorCode])).toEqual(expect.arrayContaining([[deliveries["d3"], "failed", "waha_error"], [deliveries["d4"], "unknown", "timeout"]]));
    expect(before.failed).toBeGreaterThanOrEqual(2);
    expect(before.unknown).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(before.rows)).not.toContain("Budi");
    expect(JSON.stringify(before.rows)).not.toContain("budi@example.invalid");
    // The order is refunded: nothing is sent for it, so it is not offered.
    const refundedOrder = await paidOrder(ids.programId, ids.productId, ids.lpId, DAY2, 11);
    const refunded = (await one(root<Id[]>`INSERT INTO deliveries (order_id, channel, status, attempts, last_error, created_at) VALUES (${refundedOrder}, 'email', 'failed', 1, 'smtp_refused', ${at(DAY2, 11)}) RETURNING id`)).id;
    expect((await attentionList(rt.sql, 200)).rows.map((r) => r.id)).toContain(refunded);
    await root`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refundedOrder}`;
    expect((await attentionList(rt.sql, 200)).rows.map((r) => r.id)).not.toContain(refunded);
  });

  it("lists a WhatsApp file that arrived WRONG (sent + delivered_wrong_file) for a person to see: counted, masked, never offered for a resend, and not a plain sent delivery or a refunded order's", async () => {
    // The worker writes this code (US-005 R11: WAHA delivered a file of the wrong size); the report shows it and the row stays `sent` (final).
    expect(DELIVERED_WRONG_FILE).toBe("delivered_wrong_file");
    const before = await attentionList(rt.sql, 200);
    const sentWith = async (hour: number, lastError: string | null): Promise<{ order: string; id: string }> => {
      const order = await paidOrder(ids.programId, ids.productId, ids.lpId, DAY2, hour);
      const id = (
        await one(root<Id[]>`
          INSERT INTO deliveries (order_id, channel, status, attempts, last_error, created_at, sent_at)
          VALUES (${order}, 'whatsapp', 'sent', 1, ${lastError}, ${at(DAY2, hour)}, ${at(DAY2, hour)}) RETURNING id`)
      ).id;
      return { order, id };
    };
    const wrong = await sentWith(12, "delivered_wrong_file");
    const other = await sentWith(13, "waha_error");
    const refunded = await sentWith(14, "delivered_wrong_file");
    await root`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${refunded.order}`;
    const after = await attentionList(rt.sql, 200);
    const listed = after.rows.map((r) => r.id);
    expect(after.rows.find((r) => r.id === wrong.id)).toMatchObject({ status: "sent", errorCode: "delivered_wrong_file", channel: "whatsapp", buyerName: "B*** S***", buyerPhone: "****100" });
    // Only the wrong-file delivery of a PAID order is listed and counted: not a plain sent one (d1 / d2), not a sent one with another code, not a refunded order's.
    expect(listed).not.toContain(deliveries["d1"]);
    expect(listed).not.toContain(deliveries["d2"]);
    expect(listed).not.toContain(other.id);
    expect(listed).not.toContain(refunded.id);
    expect(after.wrongFile).toBe(before.wrongFile + 1);
    expect([after.failed, after.unknown]).toEqual([before.failed, before.unknown]);
    expect(JSON.stringify(after.rows)).not.toContain("Budi");
    expect(JSON.stringify(after.rows)).not.toContain("+6281234500100");
    // Display only: the report changes nothing, the delivery stays `sent`.
    expect((await one(root<{ status: string }[]>`SELECT status FROM deliveries WHERE id = ${wrong.id}`)).status).toBe("sent");
  });

  it("shows the state of the WhatsApp opener next to its delivery (Owner decision D7)", async () => {
    await root`INSERT INTO delivery_openers (delivery_id, status, attempts) VALUES (${deliveries["d1"] ?? ""}, 'sent', 1) ON CONFLICT DO NOTHING`;
    const list = await deliveryList(rt.sql, { ...RANGE, channel: "whatsapp", status: null, sessionId: null }, 1);
    expect(list.rows.find((r) => r.id === deliveries["d1"])?.opener).toBe("sent");
    expect(list.rows.find((r) => r.id === deliveries["d2"])?.opener).toBeNull();
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

  it("counts players and completion per set: 4 eligible players, 4 of them started, 1 finished every set (the refunded d counts in neither); set 1 4 of 5 = 80 %, set 2 2 of 2 = 100 %", async () => {
    const p = await participation(rt.sql, programId);
    expect(p).toMatchObject({ eligiblePlayers: 4, playersStarted: 4, playersCompletedAll: 1 });
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

// US-027 catch-up: the report on rows the real play flow wrote (sql/play.sql), not on hand-made stats.
describe("the contest report on real play rows (US-027)", () => {
  it("counts completion and ranks the live board with play_ranking: a player who never played is on it, charged every timer (D8)", async () => {
    const DEVICE = Buffer.alloc(32, 1);
    const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`);
    const program = await one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`real-${suffix()}`}, 'Main', 'published', now() - interval '10 days', now() + interval '10 days', 5) RETURNING id`);
    const set = await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${program.id}, 1, 'Set') RETURNING id`);
    const right = new Map<string, string>();
    const wrong = new Map<string, string>();
    for (const position of [1, 2]) {
      const q = await one(root<Id[]>`INSERT INTO questions (set_id, position, prompt, points, timer_seconds) VALUES (${set.id}, ${position}, 'Q', 10, 20) RETURNING id`);
      const [r, w] = await root<Id[]>`INSERT INTO question_options (question_id, position, label, is_correct) VALUES (${q.id}, 1, 'A', true), (${q.id}, 2, 'B', false) RETURNING id`;
      right.set(q.id, r?.id ?? "");
      wrong.set(q.id, w?.id ?? "");
    }
    const player = async (name: string, phone: string, eligible: boolean): Promise<string> => {
      const id = (await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${phone}, ${name}) RETURNING id`)).id;
      await root`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${id}, ${program.id}, ${eligible ? new Date(Date.now() - 86_400_000) : null}, ${eligible})`;
      return id;
    };
    // Each play call in a transaction of its own, as public_rw (what the public app does).
    const asPlayer = async <T>(statement: (tx: typeof root) => Promise<T>): Promise<T> =>
      root.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE public_rw");
        return statement(tx as unknown as typeof root);
      });
    const shown = async (playerId: string, attemptId: string): Promise<string> => {
      for (let call = 0; call < 3; call++) {
        const [row] = await asPlayer((tx) => tx<{ r: { state: string; answer_id: string } }[]>`SELECT public.play_current(${playerId}, ${attemptId}, '203.0.113.9', ${DEVICE}) AS r`);
        if (row !== undefined && row.r.state !== "served") return row.r.answer_id;
      }
      throw new Error("served three times");
    };
    const pick = async (playerId: string, answerId: string, correct: boolean): Promise<void> => {
      const q = (await one(root<{ question_id: string }[]>`SELECT question_id FROM attempt_questions WHERE id = ${answerId}`)).question_id;
      await asPlayer((tx) => tx`SELECT public.play_answer(${playerId}, ${answerId}, ${(correct ? right : wrong).get(q) ?? ""}, '203.0.113.9', ${DEVICE})`);
      await asPlayer((tx) => tx`SELECT public.play_settle(${playerId}, ${answerId})`);
    };
    const start = async (playerId: string): Promise<string> => (await one(asPlayer((tx) => tx<Id[]>`SELECT public.play_start_set(${playerId}, ${set.id}) AS id`))).id;

    // a answers both (right, wrong) and finishes; c answers the first right and stops; b never plays; r is refunded.
    const a = await player("Ayu Main", "+6281300007001", true);
    const c = await player("Cahya Main", "+6281300007003", true);
    await player("Bayu Main", "+6281300007002", true);
    await player("Rudi Refund", "+6281300007004", false);
    const attemptA = await start(a);
    await pick(a, await shown(a, attemptA), true);
    await pick(a, await shown(a, attemptA), false);
    const attemptC = await start(c);
    await pick(c, await shown(c, attemptC), true);

    const p = await participation(rt.sql, program.id);
    expect(p).toMatchObject({ eligiblePlayers: 3, playersStarted: 2, playersCompletedAll: 1 });
    expect(p.sets.map((s) => [s.started, s.completed])).toEqual([[2, 1]]);
    const board = await leaderboard(rt.sql, program.id);
    expect(board).toMatchObject({ frozen: false, total: 3 });
    // a and c tie on 10 points; c's unanswered second question costs its full 20 s, so a is first. b: 0 points, both timers (40 s).
    expect(board.rows.map((r) => [r.rank, r.name, r.score])).toEqual([
      [1, "A*** M***", 10],
      [2, "C*** M***", 10],
      [3, "B*** M***", 0],
    ]);
    expect(board.rows[1]?.totalMs).toBeGreaterThanOrEqual(20_000);
    expect(board.rows[2]?.totalMs).toBe(40_000);
    expect(board.rows[0]?.finishedAt).not.toBeNull();
    // THE ranking the players see (play_ranking), row for row.
    const ranking = await root<{ player_id: string; rank: number; score: number; total_ms: string }[]>`SELECT player_id, rank, score, total_ms FROM public.play_ranking(${program.id}) ORDER BY rank`;
    expect(board.rows.map((r) => [r.ref, r.rank, r.score, r.totalMs])).toEqual(ranking.map((r) => [r.player_id.slice(0, 8), r.rank, r.score, Number(r.total_ms)]));
  });
});
