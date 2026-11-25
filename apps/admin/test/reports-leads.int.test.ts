// The Leads Report (2026-11-25), as the admin_rw login: per WIB day of ONE program, leads / purchases / revenue with the rollups' own
// definitions, the active players (distinct players who started a set that day) and the WhatsApp ebook sends of the day's orders.
// Figures are worked out by hand in the comments; the program filter keeps the other files' data out.
import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { leadsByDay, leadsTotals, playRateBps, successRateBps } from "../src/lib/reports/leads.ts";
import { newRuntime, root, suffix } from "./support.ts";

const rt = newRuntime();
type Id = { id: string };
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
/** An instant at `hourWib` (may be fractional) on a WIB day. */
const at = (day: string, hourWib: number): Date => new Date(Date.parse(`${day}T00:00:00Z`) + (hourWib - 7) * 3_600_000);
// Days of their own, far from the other report files' days.
const DAY_A = "2026-09-14";
const DAY_B = "2026-09-15";
const DAY_C = "2026-09-16";

describe("the Leads Report", () => {
  const tag = suffix();
  let programId = "";
  let otherProgramId = "";

  beforeAll(async () => {
    const product = await one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, 49000) RETURNING id`);
    const program = async (slug: string): Promise<string> =>
      (
        await one(root<Id[]>`
          INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
          VALUES (${product.id}, ${`${slug}-${tag}`}, 'Leads', 'published', now() - interval '120 days', now() + interval '60 days', 30) RETURNING id`)
      ).id;
    programId = await program("leads");
    otherProgramId = await program("leads-other");
    const lp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${programId}) RETURNING id`);
    const otherLp = await one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP2', ${otherProgramId}) RETURNING id`);

    // The sets first: a program's sets are locked after its first paid order.
    const set = async (program: string, position: number): Promise<string> =>
      (await one(root<Id[]>`INSERT INTO trivia_sets (program_id, position, title) VALUES (${program}, ${position}, 'Set') RETURNING id`)).id;
    const set1 = await set(programId, 1);
    const set2 = await set(programId, 2);
    const otherSet = await set(otherProgramId, 1);
    const order = async (o: { at: Date; status: string; paid?: boolean; mo?: boolean; amount?: number; wa?: string; other?: boolean }): Promise<string> => {
      const created = o.at;
      // A delivery row exists only for a paid order (a database rule): the order is created paid, given its deliveries, then moved on.
      const initial = o.wa === undefined ? o.status : "paid";
      const { id } = await one(root<Id[]>`
        INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at,
                            created_at, paid_at, mo_outbox_id)
        VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${o.other === true ? otherLp.id : lp.id}, ${o.other === true ? otherProgramId : programId},
                ${product.id}, 'Budi Santoso', '+6281234500100', 'budi@example.invalid', ${randomBytes(32)}, ${o.amount ?? 49000}, ${initial},
                ${new Date(created.getTime() + 3_600_000)}, ${created}, ${o.paid === true ? created : null}, ${o.mo === true ? randomUUID() : null})
        RETURNING id`);
      if (o.wa !== undefined) {
        await root`INSERT INTO deliveries (order_id, channel, status, sent_at) VALUES (${id}, 'whatsapp', ${o.wa}, ${o.wa === "sent" ? created : null})`;
        // An e-mail delivery of the same order is not a WhatsApp send.
        await root`INSERT INTO deliveries (order_id, channel, status, sent_at) VALUES (${id}, 'email', 'sent', ${created})`;
        if (o.status !== initial) await root`UPDATE orders SET status = ${o.status}, refunded_at = ${o.status === "refunded" ? created : null} WHERE id = ${id}`;
      }
      return id;
    };
    // DAY_A: leads = 1 (paid) + 2 (payment page, then expired) + 3 (paid, then refunded) + 5 (paid) = 4; the expired order 4 never had a
    // payment page. Purchases = 1 and 5 (2), revenue 49 000 + 75 000. WhatsApp: 1 sent, 3 cancelled (not counted), 5 failed = 2.
    await order({ at: at(DAY_A, 9), status: "paid", paid: true, mo: true, wa: "sent" });
    await order({ at: at(DAY_A, 10), status: "expired", mo: true });
    await order({ at: at(DAY_A, 11), status: "refunded", paid: true, mo: true, wa: "cancelled" });
    await order({ at: at(DAY_A, 12), status: "expired" });
    await order({ at: at(DAY_A, 23.5), status: "paid", paid: true, amount: 75000, wa: "failed" });
    // DAY_B: 00:30 WIB is still DAY_A in UTC, and counts on DAY_B. One paid order with a send still waiting for the buyer's reply.
    await order({ at: at(DAY_B, 0.5), status: "paid", paid: true, mo: true, wa: "pending" });
    // Another program's paid order on DAY_A: never in this program's figures.
    await order({ at: at(DAY_A, 9), status: "paid", paid: true, mo: true, wa: "sent", other: true });

    const player = async (): Promise<string> =>
      (await one(root<Id[]>`INSERT INTO players (phone, name) VALUES (${`+62816${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`}, 'Pemain') RETURNING id`)).id;
    const [p1, p2, p3] = [await player(), await player(), await player()];
    const attempt = (playerId: string, setId: string, started: Date) => root`INSERT INTO set_attempts (player_id, set_id, started_at) VALUES (${playerId}, ${setId}, ${started})`;
    // DAY_A: p1 starts two sets (one active player), p3 plays only the other program. DAY_B: p2, and p1 at 23:59 WIB.
    await attempt(p1, set1, at(DAY_A, 8));
    await attempt(p1, set2, at(DAY_A, 20));
    await attempt(p3, otherSet, at(DAY_A, 9));
    await attempt(p2, set1, at(DAY_B, 10));
    await attempt(p3, set1, at(DAY_B, 23.98));
  });

  it("counts each WIB day of the program, newest first, with a row of zeros for a day without anything", async () => {
    const days = await leadsByDay(rt.sql, { from: DAY_A, to: DAY_C, programId });
    expect(days.map((d) => [d.day, d.leads, d.purchase, d.revenueIdr, d.active, d.waTotal, d.waSent, d.waFailed])).toEqual([
      [DAY_C, 0, 0, 0, 0, 0, 0, 0],
      [DAY_B, 1, 1, 49000, 2, 1, 0, 0],
      [DAY_A, 4, 2, 124000, 1, 2, 1, 1],
    ]);
  });

  it("adds the days up in the TOTAL row and takes the rates from the sums", async () => {
    const days = await leadsByDay(rt.sql, { from: DAY_A, to: DAY_C, programId });
    const total = leadsTotals(days);
    expect(total).toEqual({ leads: 5, purchase: 3, revenueIdr: 173000, active: 3, waTotal: 3, waSent: 1, waFailed: 1 });
    expect(successRateBps(total)).toBe(6000);
    expect(playRateBps(total)).toBe(6000);
    // No leads: no rate ("-" on the page).
    expect(successRateBps(days[0] ?? total)).toBeNull();
  });

  it("covers every program when none is chosen (this program's day is part of it)", async () => {
    const [all] = await leadsByDay(rt.sql, { from: DAY_A, to: DAY_A, programId: null });
    expect(all?.leads).toBeGreaterThanOrEqual(5);
    expect(all?.purchase).toBeGreaterThanOrEqual(3);
    expect(all?.active).toBeGreaterThanOrEqual(2);
  });
});
