// US-029: the report metrics and the rollup (sql/reports.sql), and who may touch them. Hand-computed
// figures: every expected number below is worked out in a comment from the fixture, not read back from the SQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { runMigrations } from "../src/migrate.ts";
import { asRole, first, sql, sqlState, suffix } from "./db.ts";
import { createLandingPage, createProgram, orderRow } from "./fixtures.ts";

type Id = { id: string };

/** The WIB day D (UTC+7) at 10:00 WIB, as an instant. */
const at = (day: string, hourWib = 10): Date => new Date(Date.parse(`${day}T00:00:00Z`) + (hourWib - 7) * 3_600_000);

interface Base {
  readonly landingPageId: string;
  readonly programId: string;
  readonly productId: string;
}
let base: Base;
let adnetA = "";
let adnetB = "";
let savedFees: unknown;

beforeAll(async () => {
  const { productId, programId } = await createProgram();
  base = { landingPageId: await createLandingPage(programId), programId, productId };
  adnetA = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param, payout_idr) VALUES (${`aa-${suffix()}`}, 'Alpha Ads', 'cid', 5000) RETURNING id`).id;
  adnetB = first(await sql<Id[]>`INSERT INTO adnets (slug, name, clickid_param, payout_idr) VALUES (${`bb-${suffix()}`}, 'Beta Media', 'cid', 7500) RETURNING id`).id;
  savedFees = first(await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'midtrans.fees'`).value;
});
afterAll(async () => {
  await sql`UPDATE app_settings SET value = ${sql.json(savedFees as Parameters<typeof sql.json>[0])} WHERE key = 'midtrans.fees'`;
});

const setFees = (fees: unknown) => sql`UPDATE app_settings SET value = ${sql.json(fees as Parameters<typeof sql.json>[0])} WHERE key = 'midtrans.fees'`;
const refresh = async (now?: Date, windowDays = 120) =>
  first(await sql<{ r: { refreshed: boolean; order_rows: number; visit_rows: number; full: boolean } }[]>`SELECT public.refresh_report_rollups(${now ?? new Date()}, ${windowDays}::integer) AS r`).r;

interface ConversionSpec {
  readonly status: string;
  readonly counted?: boolean;
  readonly payout?: number | null;
}

interface OrderOpts {
  readonly status?: string;
  readonly day?: string;
  readonly hourWib?: number;
  readonly adnet?: string | null;
  readonly clickid?: string | null;
  readonly utm?: string | null;
  readonly amount?: number;
  readonly paymentType?: string | null;
  readonly mo?: boolean;
  /** The S2S MT row (the order is paid when it is inserted, as the MT guard ET080 requires) and the reversal row that follows a refund. */
  readonly mt?: ConversionSpec;
  readonly reversal?: ConversionSpec;
}

/** An order of `base` as the migrator would leave it: one that is refunded or in review was paid first (paid_at), and its MT came while it was. */
async function mkOrder(o: OrderOpts = {}, on: Base = base): Promise<string> {
  const status = o.status ?? "paid";
  const everPaid = ["paid", "refunded", "review"].includes(status);
  const row = { ...orderRow({ ...on, status: "pending" }), status: everPaid ? "paid" : status, amount_idr: o.amount ?? 49000 };
  const created = at(o.day ?? "2026-11-18", o.hourWib ?? 10);
  const order = first(
    await sql<Id[]>`
      INSERT INTO orders ${sql({
        ...row,
        created_at: created,
        paid_at: everPaid ? created : null,
        adnet_id: o.adnet ?? null,
        clickid: o.clickid ?? null,
        utm_campaign: o.utm ?? null,
        mo_outbox_id: o.mo === true ? crypto.randomUUID() : null,
      })} RETURNING id`,
  );
  if (o.paymentType !== undefined && o.paymentType !== null) {
    await sql`
      INSERT INTO payments (order_id, gateway_txn_id, payment_type, transaction_status, gross_amount_idr, settled_at)
      VALUES (${order.id}, ${`tx-${suffix()}${suffix()}`}, ${o.paymentType}, 'settlement', ${o.amount ?? 49000}, ${created})`;
  }
  const conversion = (kind: "mt" | "reversal", spec: ConversionSpec) => sql`
    INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, maybe_counted, reported_payout_idr)
    VALUES (${order.id}, 's2s', ${kind}, ${spec.status}, ${o.adnet ?? null}, ${order.id}, gen_random_uuid(), ${spec.counted ?? false}, ${spec.payout ?? null})`;
  if (o.mt !== undefined) await conversion("mt", o.mt);
  if (o.reversal !== undefined) await conversion("reversal", o.reversal);
  if (everPaid && status !== "paid") await sql`UPDATE orders SET status = ${status} WHERE id = ${order.id}`;
  return order.id;
}

const rowsOf = (programId = base.programId) =>
  sql<
    {
      day: string;
      adnet_id: string | null;
      utm_campaign: string;
      status: string;
      orders: number;
      mo: number;
      mt: number;
      amount_idr: string;
      revenue_idr: string;
      fee_idr: string;
      fee_missing: number;
      payout_idr: string;
    }[]
  >`SELECT day::text, adnet_id, utm_campaign, status::text AS status, orders, mo, mt, amount_idr::text, revenue_idr::text, fee_idr::text, fee_missing, payout_idr::text
      FROM report_orders_daily WHERE program_id = ${programId} ORDER BY day, status, adnet_id NULLS FIRST, utm_campaign`;

describe("the WIB day and the source of an order", () => {
  it("wib_day is the calendar day at UTC+7: 16:59:59.999 UTC is still the day, 17:00 UTC is the next", async () => {
    const days = await sql<{ a: string; b: string; c: string }[]>`
      SELECT public.wib_day('2026-11-19T16:59:59.999Z'::timestamptz)::text AS a, public.wib_day('2026-11-19T17:00:00Z'::timestamptz)::text AS b,
             public.wib_day('2026-12-31T20:00:00Z'::timestamptz)::text AS c`;
    expect(days[0]).toEqual({ a: "2026-11-19", b: "2026-11-20", c: "2027-01-01" });
  });

  it("order_source_adnet keeps the adnet only with a click id (AC-T8), and the label is order_source_label's", async () => {
    const r = first(
      await sql<{ none: string | null; empty: string | null; kept: string | null; lbl_organic: string; lbl_adnet: string }[]>`
        SELECT public.order_source_adnet(${adnetA}, NULL)::text AS none, public.order_source_adnet(${adnetA}, '')::text AS empty,
               public.order_source_adnet(${adnetA}, 'c1')::text AS kept, public.report_source_label(NULL) AS lbl_organic, public.report_source_label(${adnetA}) AS lbl_adnet`,
    );
    expect(r).toEqual({ none: null, empty: null, kept: adnetA, lbl_organic: "Organic", lbl_adnet: "Alpha Ads" });
  });
});

describe("the gateway fee: flat + ceil(amount * bps / 10000), whole rupiah", () => {
  it.each([
    // [amount, flat, bps, expected]: the percentage is rounded UP to the next whole rupiah.
    [49000, 0, 70, 343], // 49000 * 0.0070 = 343 exactly
    [49000, 0, 200, 980], // 49000 * 0.0200 = 980 exactly
    [49000, 2000, 290, 3421], // 2000 + 49000 * 0.0290 = 2000 + 1421 exactly
    [99000, 0, 70, 693], // 99000 * 0.0070 = 693 exactly
    [10001, 0, 70, 71], // 70.007 -> 71 (never understated)
    [1, 0, 1, 1], // 0.0001 -> 1
    [100, 0, 0, 0],
    [0, 4000, 0, 4000], // flat only
    [49000, 4400, 0, 4400],
    [9_000_000_000_000_000, 0, 10_000, 9_000_000_000_000_000], // 100 %, no overflow
  ])("gateway_fee_idr(%d, %d, %d) = %d", async (amount, flat, bps, expected) => {
    const row = first(await sql<{ fee: string }[]>`SELECT public.gateway_fee_idr(${amount}::bigint, ${flat}::bigint, ${bps}::integer)::text AS fee`);
    expect(row.fee).toBe(String(expected));
  });

  it("maps a stored Midtrans payment_type to the Snap method codes that carry its fee", async () => {
    const rows = await sql<{ t: string | null; codes: string[] }[]>`
      SELECT t, public.midtrans_method_codes(t) AS codes FROM unnest(ARRAY['qris', 'bank_transfer', 'cstore', 'gopay', 'credit_card', 'echannel', NULL]::text[]) AS t`;
    const byType = new Map(rows.map((r) => [r.t, r.codes]));
    expect(byType.get("qris")).toEqual(["other_qris"]);
    expect(byType.get("bank_transfer")).toEqual(["bca_va", "bni_va", "bri_va", "permata_va", "cimb_va", "other_va"]);
    expect(byType.get("cstore")).toEqual(["indomaret"]);
    expect(byType.get("gopay")).toEqual(["gopay"]);
    expect(byType.get("credit_card")).toEqual(["credit_card"]);
    expect(byType.get("echannel")).toEqual(["echannel"]);
    expect(byType.get(null)).toEqual([]);
  });
});

describe("refresh_report_rollups: the per-order metrics, grouped", () => {
  it("counts MO, MT, revenue, gateway fee and CPA per day, source, campaign and status; hand-computed", async () => {
    await setFees({
      other_qris: { flat_idr: 0, percent_bps: 70 },
      gopay: { flat_idr: 0, percent_bps: 200 },
      bca_va: { flat_idr: 4000, percent_bps: 0 },
      bni_va: { flat_idr: 4400, percent_bps: 0 },
      credit_card: { flat_idr: 2000, percent_bps: 290 },
    });
    const D1 = "2026-11-18";
    const D2 = "2026-11-19";
    // D1 / adnet A / "promo-a" / paid: o1 (qris, fee 343, MT sent payout 5000), o2 (gopay, fee 980, MT failed and not counted: payout 0)
    await mkOrder({ day: D1, adnet: adnetA, clickid: "c1", utm: "Promo-A", paymentType: "qris", mt: { status: "sent", counted: true, payout: 5000 } });
    await mkOrder({ day: D1, adnet: adnetA, clickid: "c2", utm: " promo-a ", paymentType: "gopay", mt: { status: "failed", counted: false, payout: 5000 } });
    // D1 / A / promo-a / refunded: o3 (qris fee 343: the gateway keeps it; MT sent 5000, the reversal acknowledged: CPA 0)
    await mkOrder({
      status: "refunded", day: D1, adnet: adnetA, clickid: "c3", utm: "promo-a", paymentType: "qris",
      mt: { status: "sent", counted: true, payout: 5000 }, reversal: { status: "sent" },
    });
    // D2 / B / promo-b / paid: o4 (bank_transfer: the dearest VA fee 4400, MT sent 7500); refunded: o5 (qris 343, no reversal row: CPA 7500 stays)
    await mkOrder({ day: D2, adnet: adnetB, clickid: "c4", utm: "promo-b", paymentType: "bank_transfer", mt: { status: "sent", counted: true, payout: 7500 } });
    await mkOrder({ status: "refunded", day: D2, adnet: adnetB, clickid: "c5", utm: "promo-b", paymentType: "qris", mt: { status: "sent", counted: true, payout: 7500 } });
    // D2 / Organic / no campaign: o6 paid by card (fee 2000 + 1421 = 3421); o7 has an adnet but NO click id (Organic), paid in a store
    // (cstore -> indomaret, not configured: fee 0 and fee_missing 1)
    await mkOrder({ day: D2, paymentType: "credit_card" });
    await mkOrder({ day: D2, adnet: adnetA, clickid: null, paymentType: "cstore" });
    // D3 (WIB): 2026-11-19 20:30 UTC is 03:30 WIB on 11-20. Pending (MO, not MT), expired (MO), snap_create_failed (no MO), review (paid before).
    const D3 = "2026-11-20";
    await mkOrder({ status: "pending", day: D3, hourWib: 3, adnet: adnetA, clickid: "c8", utm: "promo-a", mo: true });
    await mkOrder({ status: "expired", day: D3, hourWib: 4, adnet: adnetA, clickid: "c9", utm: "promo-a", mo: true });
    await mkOrder({ status: "snap_create_failed", day: D3, hourWib: 5 });
    await mkOrder({ status: "review", day: D3, hourWib: 6, adnet: adnetA, clickid: "c11", utm: "promo-a", paymentType: "gopay", mt: { status: "sent", counted: true, payout: 5000 } });
    // An MT whose attempt timed out: failed, but the sink may have counted it (maybe_counted): its payout is owed until proven otherwise.
    await mkOrder({ day: D3, hourWib: 7, adnet: adnetA, clickid: "c12", utm: "promo-c", paymentType: "qris", mt: { status: "failed", counted: true, payout: 5000 } });
    // A reversal that has not been acknowledged (pending) takes nothing back.
    await mkOrder({
      status: "refunded", day: D3, hourWib: 8, adnet: adnetA, clickid: "c13", utm: "promo-c", paymentType: "qris",
      mt: { status: "sent", counted: true, payout: 5000 }, reversal: { status: "pending" },
    });

    const result = await refresh(at("2026-11-20", 12));
    expect(result.refreshed).toBe(true);
    const rows = await rowsOf();
    const pick = (day: string, status: string, adnet: string | null, utm: string) => {
      const row = rows.find((r) => r.day === day && r.status === status && r.adnet_id === adnet && r.utm_campaign === utm);
      if (row === undefined) throw new Error(`no group ${day} ${status} ${String(adnet)} ${utm}`);
      return row;
    };
    // D1 A promo-a paid: o1 + o2. orders 2, mo 2, mt 2, amount 98000, revenue 98000, fee 343 + 980 = 1323, payout 5000 + 0.
    expect(pick(D1, "paid", adnetA, "promo-a")).toMatchObject({ orders: 2, mo: 2, mt: 2, amount_idr: "98000", revenue_idr: "98000", fee_idr: "1323", fee_missing: 0, payout_idr: "5000" });
    // D1 A promo-a refunded: o3. Not revenue, the fee stands, the reversal was acknowledged.
    expect(pick(D1, "refunded", adnetA, "promo-a")).toMatchObject({ orders: 1, mo: 1, mt: 0, amount_idr: "49000", revenue_idr: "0", fee_idr: "343", payout_idr: "0" });
    // D2 B promo-b paid: o4 (4400, payout 7500); refunded: o5 (343, payout 7500: no reversal was ever acknowledged).
    expect(pick(D2, "paid", adnetB, "promo-b")).toMatchObject({ orders: 1, mt: 1, revenue_idr: "49000", fee_idr: "4400", payout_idr: "7500" });
    expect(pick(D2, "refunded", adnetB, "promo-b")).toMatchObject({ revenue_idr: "0", fee_idr: "343", payout_idr: "7500" });
    // D2 Organic: o6 (card, 3421) and o7 (adnet without a click id, store method not configured) are ONE group: 2 orders, revenue 98000.
    expect(pick(D2, "paid", null, "")).toMatchObject({ orders: 2, mo: 2, mt: 2, revenue_idr: "98000", fee_idr: "3421", fee_missing: 1, payout_idr: "0" });
    // D3 (the WIB day of 20:30 UTC): pending and expired have an MO and no MT, snap_create_failed no MO; the order in review is no revenue but pays its fee (980) and CPA (5000).
    expect(pick(D3, "pending", adnetA, "promo-a")).toMatchObject({ orders: 1, mo: 1, mt: 0, revenue_idr: "0", fee_idr: "0", fee_missing: 0 });
    expect(pick(D3, "expired", adnetA, "promo-a")).toMatchObject({ orders: 1, mo: 1, mt: 0 });
    expect(pick(D3, "snap_create_failed", null, "")).toMatchObject({ orders: 1, mo: 0, mt: 0, amount_idr: "49000", revenue_idr: "0" });
    expect(pick(D3, "review", adnetA, "promo-a")).toMatchObject({ orders: 1, mo: 1, mt: 0, revenue_idr: "0", fee_idr: "980", payout_idr: "5000" });
    // D3 promo-c: o12 paid (qris 343, failed-but-counted MT: 5000), o13 refunded (343, the reversal still pending: 5000).
    expect(pick(D3, "paid", adnetA, "promo-c")).toMatchObject({ orders: 1, revenue_idr: "49000", fee_idr: "343", payout_idr: "5000" });
    expect(pick(D3, "refunded", adnetA, "promo-c")).toMatchObject({ revenue_idr: "0", fee_idr: "343", payout_idr: "5000" });
    // Totals of the program: 13 orders; revenue o1 + o2 + o4 + o6 + o7 + o12 = 6 x 49000.
    expect(rows.reduce((n, r) => n + r.orders, 0)).toBe(13);
    expect(rows.reduce((n, r) => n + Number(r.revenue_idr), 0)).toBe(6 * 49000);
  });

  it("is idempotent: a second refresh leaves exactly the same rows, and the CHECKs hold (mt <= mo <= orders)", async () => {
    const before = await rowsOf();
    await refresh(at("2026-11-20", 13));
    expect(await rowsOf()).toEqual(before);
    expect(first(await sql<{ n: string }[]>`SELECT count(*) AS n FROM report_orders_daily WHERE NOT (mt <= mo AND mo <= orders)`).n).toBe("0");
  });

  it("ignores a malformed midtrans.fees entry instead of failing: the order counts as fee_missing", async () => {
    await setFees({ other_qris: { flat_idr: "x", percent_bps: 70 }, gopay: { flat_idr: 0, percent_bps: 20000 }, bca_va: [1, 2], credit_card: 5 });
    await refresh(at("2026-11-20", 14));
    const paid = (await rowsOf()).filter((r) => r.status === "paid");
    expect(paid.reduce((n, r) => n + Number(r.fee_idr), 0)).toBe(0);
    expect(paid.reduce((n, r) => n + r.fee_missing, 0)).toBe(6);
    await setFees("not an object");
    await refresh(at("2026-11-20", 14));
    expect((await rowsOf()).filter((r) => r.status === "paid").reduce((n, r) => n + r.fee_missing, 0)).toBe(6);
  });

  it("rebuilds everything on the first run (no state) and says so", async () => {
    await sql`DELETE FROM report_rollup_state`;
    const run = await refresh(at("2026-11-20", 12));
    expect(run.full).toBe(true);
    expect(run.order_rows).toBeGreaterThan(0);
  });

  it("refuses a window that is not 1 to 3650 days", async () => {
    for (const days of [0, -1, 3651]) expect(await sqlState(refresh(at("2026-11-20", 12), days)), String(days)).toBe("22023");
  });

  it("records when it ran (the 'as of' time of the reports)", async () => {
    const state = first(await sql<{ as_of: Date; visits_through_day: string; duration_ms: number }[]>`SELECT as_of, visits_through_day::text, duration_ms FROM report_rollup_state`);
    expect(Math.abs(Date.now() - state.as_of.getTime())).toBeLessThan(60_000);
    expect(state.visits_through_day).toBe("2026-11-20");
    expect(state.duration_ms).toBeGreaterThanOrEqual(0);
    expect(first(await sql<{ n: string }[]>`SELECT count(*) AS n FROM report_rollup_state`).n).toBe("1");
  });
});

describe("bounded refresh: the trailing window and the days touched since the last run; older days are frozen", () => {
  const NOW = at("2026-11-20", 12);
  const FEES_A = { other_qris: { flat_idr: 0, percent_bps: 70 }, gopay: { flat_idr: 0, percent_bps: 200 } };
  let solo: Base;
  const ids: Record<string, string> = {};

  /** Rows of one WIB day of the shop: the physical row versions (xmin) say whether the day was rewritten, the figures what it holds. */
  const dayRows = (day: string) =>
    sql<{ x: string; status: string; revenue: string; fee: string; payout: string }[]>`
      SELECT xmin::text AS x, status::text AS status, revenue_idr::text AS revenue, fee_idr::text AS fee, payout_idr::text AS payout
        FROM report_orders_daily WHERE program_id = ${solo.programId} AND day = ${day}::date ORDER BY status`;
  const versions = async (days: readonly string[]) => Object.fromEntries(await Promise.all(days.map(async (d) => [d, (await dayRows(d)).map((r) => r.x).join(",")] as const)));
  /** Old rows: updated long before the last refresh, so only a real change touches their day. */
  const age = async (orderIds: readonly (string | undefined)[]) => {
    const list = orderIds.filter((x): x is string => x !== undefined);
    await sql`UPDATE orders SET updated_at = now() - interval '2 hours' WHERE id = ANY(${list}::uuid[])`;
    await sql`UPDATE payments SET updated_at = now() - interval '2 hours' WHERE order_id = ANY(${list}::uuid[])`;
    await sql`UPDATE conversion_events SET updated_at = now() - interval '2 hours' WHERE order_id = ANY(${list}::uuid[])`;
  };
  const OLD = ["2026-06-01", "2026-06-02", "2026-06-03"] as const;

  beforeAll(async () => {
    const { productId, programId } = await createProgram();
    solo = { landingPageId: await createLandingPage(programId), programId, productId };
    // Three old orders on three days far outside a 30-day window, one recent order inside it.
    ids["a"] = await mkOrder({ day: OLD[0], adnet: adnetA, clickid: "o1", paymentType: "qris", mt: { status: "sent", counted: true, payout: 5000 } }, solo);
    ids["b"] = await mkOrder({ day: OLD[1], adnet: adnetA, clickid: "o2", paymentType: "qris", mt: { status: "failed", counted: true, payout: 5000 } }, solo);
    ids["c"] = await mkOrder({ day: OLD[2], paymentType: "qris" }, solo);
    ids["recent"] = await mkOrder({ day: "2026-11-19", paymentType: "qris" }, solo);
    await age(Object.values(ids));
    await setFees(FEES_A);
    expect((await refresh(NOW, 30)).full).toBe(true); // the fee setting changed: everything is priced again
  });

  it("freezes an old day nothing touched: it is not read and not rewritten; a day in the window is rebuilt every run", async () => {
    const before = await versions([...OLD, "2026-11-19"]);
    const run = await refresh(NOW, 30);
    expect(run.full).toBe(false);
    const after = await versions([...OLD, "2026-11-19"]);
    for (const day of OLD) expect(after[day], day).toBe(before[day]);
    expect(after["2026-11-19"]).not.toBe(before["2026-11-19"]);
    // The figures of the frozen days are still there: a1 = qris 0.70 % of 49000 = 343, CPA 5000.
    expect((await dayRows(OLD[0]))[0]).toMatchObject({ status: "paid", revenue: "49000", fee: "343", payout: "5000" });
  });

  it("picks up a change to an old order (a refund), rewriting that day only", async () => {
    const before = await versions(OLD);
    await sql`UPDATE orders SET status = 'refunded', refunded_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = ${ids["a"] ?? ""}`;
    expect((await refresh(NOW, 30)).full).toBe(false);
    const after = await versions(OLD);
    expect(after[OLD[0]]).not.toBe(before[OLD[0]]);
    expect(after[OLD[1]]).toBe(before[OLD[1]]);
    expect(after[OLD[2]]).toBe(before[OLD[2]]);
    // Refunded: no revenue, the fee stays, the MT may have counted and no reversal was acknowledged, so the payout stays.
    expect((await dayRows(OLD[0]))[0]).toMatchObject({ status: "refunded", revenue: "0", fee: "343", payout: "5000" });
  });

  it("picks up a change to an old order's conversion (the payout it reported) and to its payment (the method, so the fee)", async () => {
    await age([ids["a"], ids["b"], ids["c"]]); // out of the touch margin again
    await refresh(NOW, 30);
    const before = await versions(OLD);
    await sql`UPDATE conversion_events SET reported_payout_idr = 6000, updated_at = clock_timestamp() WHERE order_id = ${ids["b"] ?? ""} AND kind = 'mt'`;
    await sql`UPDATE payments SET payment_type = 'gopay', updated_at = clock_timestamp() WHERE order_id = ${ids["c"] ?? ""}`;
    await refresh(NOW, 30);
    const after = await versions(OLD);
    expect(after[OLD[0]]).toBe(before[OLD[0]]);
    expect(after[OLD[1]]).not.toBe(before[OLD[1]]);
    expect(after[OLD[2]]).not.toBe(before[OLD[2]]);
    expect((await dayRows(OLD[1]))[0]).toMatchObject({ payout: "6000" });
    // gopay: 2.00 % of 49000 = 980 (it was qris 343).
    expect((await dayRows(OLD[2]))[0]).toMatchObject({ fee: "980" });
  });

  it("rebuilds every day when the gateway fee setting changed, since it re-prices all of them", async () => {
    await age([ids["a"], ids["b"], ids["c"]]);
    await refresh(NOW, 30);
    const before = await versions(OLD);
    await setFees({ ...FEES_A, other_qris: { flat_idr: 1000, percent_bps: 70 } });
    expect((await refresh(NOW, 30)).full).toBe(true);
    const after = await versions(OLD);
    for (const day of OLD) expect(after[day], day).not.toBe(before[day]);
    // a: refunded, qris now 1000 + 343.
    expect((await dayRows(OLD[0]))[0]).toMatchObject({ fee: "1343" });
    await setFees(FEES_A);
    await refresh(NOW, 30);
  });

  it("stays idempotent and equals a full rebuild: the bounded rows are exactly what a refresh of everything would write", async () => {
    const snapshot = () =>
      sql<{ day: string; status: string; orders: number; revenue: string; fee: string; payout: string; missing: number }[]>`
        SELECT day::text, status::text AS status, orders, revenue_idr::text AS revenue, fee_idr::text AS fee, payout_idr::text AS payout, fee_missing AS missing
          FROM report_orders_daily WHERE program_id = ${solo.programId} ORDER BY day, status`;
    await refresh(NOW, 30);
    const bounded = await snapshot();
    expect(bounded).toHaveLength(4);
    await sql`DELETE FROM report_rollup_state`;
    expect((await refresh(NOW, 30)).full).toBe(true);
    expect(await snapshot()).toEqual(bounded);
  });
});

describe("frozen days cannot miss a change: the updated_at guard, deletes, and every migrate", () => {
  const NOW = at("2026-11-20", 12);
  const OLD = ["2026-05-01", "2026-05-02"] as const;
  let solo: Base;
  const ids: Record<string, string> = {};
  const revenueOf = async (day: string) =>
    first(await sql<{ revenue: string; orders: string }[]>`
      SELECT coalesce(sum(revenue_idr), 0)::text AS revenue, coalesce(sum(orders), 0)::text AS orders FROM report_orders_daily WHERE program_id = ${solo.programId} AND day = ${day}::date`);
  const age = (list: string[]) => sql`
    UPDATE orders SET updated_at = now() - interval '2 hours' WHERE id = ANY(${list}::uuid[])`;

  beforeAll(async () => {
    const { productId, programId } = await createProgram();
    solo = { landingPageId: await createLandingPage(programId), programId, productId };
    ids["a"] = await mkOrder({ day: OLD[0], paymentType: "qris" }, solo);
    ids["b"] = await mkOrder({ day: OLD[1], paymentType: "qris" }, solo);
    await age([ids["a"], ids["b"]]);
    await refresh(NOW, 30);
    await refresh(NOW, 30);
  });

  it("stamps updated_at when a writer changes a column a report reads and forgets to bump it; the old day is then picked up", async () => {
    expect((await revenueOf(OLD[0])).revenue).toBe("49000");
    const before = first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM orders WHERE id = ${ids["a"] ?? ""}`).u;
    await sql`UPDATE orders SET status = 'refunded', refunded_at = clock_timestamp() WHERE id = ${ids["a"] ?? ""}`; // no updated_at in the SET list
    const after = first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM orders WHERE id = ${ids["a"] ?? ""}`).u;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(Math.abs(Date.now() - after.getTime())).toBeLessThan(60_000);
    expect((await refresh(NOW, 30)).full).toBe(false);
    expect((await revenueOf(OLD[0])).revenue).toBe("0"); // the refund is in the frozen day
    expect((await revenueOf(OLD[1])).revenue).toBe("49000");
  });

  it("does not stamp it for a column no report reads (a claim is not a change of the order), and keeps a value the writer set", async () => {
    const before = first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM orders WHERE id = ${ids["b"] ?? ""}`).u;
    await sql`UPDATE orders SET browser_mt_fired_at = clock_timestamp() WHERE id = ${ids["b"] ?? ""}`;
    expect(first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM orders WHERE id = ${ids["b"] ?? ""}`).u).toEqual(before);
    const chosen = new Date("2026-05-02T01:02:03.456Z");
    await sql`UPDATE orders SET status = 'refunded', refunded_at = clock_timestamp(), updated_at = ${chosen} WHERE id = ${ids["b"] ?? ""}`;
    expect(first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM orders WHERE id = ${ids["b"] ?? ""}`).u).toEqual(chosen);
    await sql`UPDATE orders SET status = 'paid' WHERE id = ${ids["b"] ?? ""}`; // back: not refunded for the next tests
    await sql`UPDATE orders SET updated_at = now() - interval '2 hours' WHERE id = ${ids["b"] ?? ""}`;
    await refresh(NOW, 30);
  });

  it("also stamps a payment and a conversion row that changed a column a report reads", async () => {
    const pay = first(await sql<{ id: string; u: Date }[]>`SELECT id, updated_at AS u FROM payments WHERE order_id = ${ids["b"] ?? ""}`);
    await sql`UPDATE payments SET payment_type = 'gopay' WHERE id = ${pay.id}`;
    expect(first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM payments WHERE id = ${pay.id}`).u.getTime()).toBeGreaterThan(pay.u.getTime());
    await sql`UPDATE payments SET gateway_txn_id = ${`tx-${suffix()}${suffix()}`} WHERE id = ${pay.id}`; // not a report column
    const quiet = first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM payments WHERE id = ${pay.id}`).u;
    await sql`UPDATE payments SET raw = '{"x": 1}'::jsonb WHERE id = ${pay.id}`;
    expect(first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM payments WHERE id = ${pay.id}`).u).toEqual(quiet);
    const mt = first(await sql<{ id: string }[]>`
      INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, maybe_counted, reported_payout_idr)
      VALUES (${ids["b"] ?? ""}, 's2s', 'mt', 'sent', ${adnetA}, ${ids["b"] ?? ""}, gen_random_uuid(), true, 5000) RETURNING id`);
    await sql`UPDATE conversion_events SET updated_at = now() - interval '2 hours' WHERE id = ${mt.id}`;
    const old = first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM conversion_events WHERE id = ${mt.id}`).u;
    await sql`UPDATE conversion_events SET reported_payout_idr = 6000 WHERE id = ${mt.id}`;
    expect(first(await sql<{ u: Date }[]>`SELECT updated_at AS u FROM conversion_events WHERE id = ${mt.id}`).u.getTime()).toBeGreaterThan(old.getTime());
  });

  it("fires after every other BEFORE UPDATE trigger of its table (alphabetical order: it sees their final NEW) and in every session_replication_role mode", async () => {
    for (const table of ["orders", "payments", "conversion_events"]) {
      const rows = await sql<{ tgname: string; tgenabled: string }[]>`
        SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger
         WHERE tgrelid = ${`public.${table}`}::regclass AND NOT tgisinternal AND (tgtype & 2) = 2 AND (tgtype & 16) = 16 ORDER BY tgname COLLATE "C"`;
      expect(rows.at(-1)?.tgname, table).toBe("report_touch_updated_at");
      expect(rows.every((r) => r.tgenabled === "A"), table).toBe(true);
    }
  });

  it("makes the next refresh a full rebuild when a row of orders, payments or conversion_events was deleted", async () => {
    await refresh(NOW, 30);
    expect((await refresh(NOW, 30)).full).toBe(false);
    const stray = await mkOrder({ day: OLD[0], adnet: adnetA, clickid: "stray", paymentType: "qris", mt: { status: "sent", counted: true, payout: 5000 } }, solo);
    await age([stray]);
    expect((await refresh(NOW, 30)).full).toBe(false);
    await sql`DELETE FROM conversion_events WHERE order_id = ${stray}`;
    expect(first(await sql<{ fees: unknown }[]>`SELECT fees FROM report_rollup_state`).fees).toBeNull();
    expect((await refresh(NOW, 30)).full).toBe(true);
    for (const statement of [`DELETE FROM payments WHERE order_id = '${stray}'`, `DELETE FROM orders WHERE id = '${stray}'`]) {
      expect((await refresh(NOW, 30)).full, statement).toBe(false);
      await sql.unsafe(statement);
      expect(first(await sql<{ fees: unknown }[]>`SELECT fees FROM report_rollup_state`).fees, statement).toBeNull();
      expect((await refresh(NOW, 30)).full, statement).toBe(true);
    }
    expect((await revenueOf(OLD[0])).orders).toBe("1"); // the stray order is gone from the frozen day after the full rebuild
  });

  it("keeps a full-rebuild request that committed while a refresh was running: the refresh's final write must not erase it", async () => {
    const day = "2026-11-19";
    await mkOrder({ day, paymentType: "qris" }, solo); // a row of the window, so the running refresh has one to delete
    await refresh(NOW, 30);
    expect((await refresh(NOW, 30)).full).toBe(false);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A transaction holds the window's rollup row, so the refresh below blocks at its DELETE, AFTER it has read the state.
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM report_orders_daily WHERE program_id = ${solo.programId} AND day = ${day}::date FOR UPDATE`;
      locked();
      await held;
    });
    await holding;
    const running = refresh(NOW, 30);
    for (let i = 0; ; i++) {
      const waiting = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%refresh_report_rollups%' AND pid <> pg_backend_pid()`;
      if ((waiting[0]?.n ?? 0) > 0) break;
      if (i > 200) throw new Error("the refresh never reached its DELETE");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // From another session, a delete (or a migrate) asks for a full rebuild and commits while the refresh is running.
    await sql`UPDATE report_rollup_state SET fees = 'null'::jsonb`;
    release();
    await holder;
    expect((await running).refreshed).toBe(true);
    expect(first(await sql<{ fees: unknown }[]>`SELECT fees FROM report_rollup_state`).fees).toBeNull(); // still asked for
    expect((await refresh(NOW, 30)).full).toBe(true);
    expect((await refresh(NOW, 30)).full).toBe(false); // and answered once
  });

  it("forces one full rebuild after every migrate (a definition may have changed)", async () => {
    await refresh(NOW, 30);
    expect((await refresh(NOW, 30)).full).toBe(false);
    await runMigrations(inject("dbUrl"));
    expect(first(await sql<{ fees: unknown }[]>`SELECT fees FROM report_rollup_state`).fees).toBeNull();
    expect((await refresh(NOW, 30)).full).toBe(true);
    expect((await refresh(NOW, 30)).full).toBe(false);
  }, 120_000);

  it("sets idle_in_transaction_session_timeout = 10 min as the database default (a row or advisory lock held by a stuck transaction is released)", async () => {
    expect(first(await sql<{ v: string }[]>`SELECT current_setting('idle_in_transaction_session_timeout') AS v`).v).toBe("10min");
    expect(await asRole("worker_rw", async (tx) => first(await tx<{ v: string }[]>`SELECT current_setting('idle_in_transaction_session_timeout') AS v`).v)).toBe("10min");
  });
});

describe("visits: incremental, WIB days, the same source rule", () => {
  it("rebuilds the day before the last refresh and what follows, and leaves older days frozen", async () => {
    const lp = await createLandingPage(base.programId);
    const visit = (day: string, hourWib: number, o: { adnet?: string | null; clickid?: string | null } = {}) =>
      sql`INSERT INTO visits (landing_page_id, occurred_at, adnet_id, clickid) VALUES (${lp}, ${at(day, hourWib)}, ${o.adnet ?? null}, ${o.clickid ?? null})`;
    const days = () => sql<{ day: string; adnet_id: string | null; visits: number }[]>`SELECT day::text, adnet_id, visits FROM report_visits_daily WHERE landing_page_id = ${lp} ORDER BY day, adnet_id NULLS FIRST`;
    // The refresh of the previous test left visits_through_day = 2026-11-20: it rebuilds from 11-19 on.
    await visit("2026-11-15", 10, { adnet: adnetA, clickid: "x" }); // old: frozen (the first refresh built everything, this one is newer than it)
    await visit("2026-11-19", 23, { adnet: adnetA, clickid: "x" }); // 23:00 WIB, rebuilt
    await visit("2026-11-19", 23, { adnet: adnetA, clickid: null }); // an adnet without a click id: Organic
    await visit("2026-11-20", 1); // 01:00 WIB on 11-20 (18:00 UTC on 11-19), Organic
    await visit("2026-11-20", 2, { adnet: adnetB, clickid: "y" });
    await refresh(at("2026-11-20", 15));
    expect(await days()).toEqual([
      { day: "2026-11-19", adnet_id: null, visits: 1 },
      { day: "2026-11-19", adnet_id: adnetA, visits: 1 },
      { day: "2026-11-20", adnet_id: null, visits: 1 },
      { day: "2026-11-20", adnet_id: adnetB, visits: 1 },
    ]);
    // A moment later: a new visit shows, the frozen day stays out.
    await visit("2026-11-20", 16, { adnet: adnetB, clickid: "z" });
    await refresh(at("2026-11-20", 16));
    expect((await days()).find((d) => d.day === "2026-11-20" && d.adnet_id === adnetB)?.visits).toBe(2);
    expect((await days()).some((d) => d.day === "2026-11-15")).toBe(false);
    // The first ever run (no state) builds every day.
    await sql`DELETE FROM report_rollup_state`;
    await refresh(at("2026-11-20", 17));
    expect((await days()).some((d) => d.day === "2026-11-15")).toBe(true);
  });
});

describe("concurrency: one refresh at a time, nothing counted twice", () => {
  it("a second refresh while one is running returns refreshed = false and changes nothing; the lock goes with the transaction", async () => {
    const before = await rowsOf();
    expect(before.length).toBeGreaterThan(0);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = sql.begin(async (tx) => {
      const r = await tx<{ r: { refreshed: boolean } }[]>`SELECT public.refresh_report_rollups() AS r`;
      entered();
      await held;
      return r[0]?.r.refreshed;
    });
    await inside;
    const second = await refresh();
    expect(second.refreshed).toBe(false);
    release();
    expect(await running).toBe(true);
    expect(await rowsOf()).toEqual(before);
    // Both at once, many times: whoever wins, the table never holds a group twice (UNIQUE) nor a doubled figure.
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh()));
    expect(results.some((r) => r.refreshed)).toBe(true);
    expect(await rowsOf()).toEqual(before);
  });
});

describe("who may touch the rollups", () => {
  it("worker_rw refreshes them; admin_rw only reads them; public_rw and internal_rw see nothing", async () => {
    const asWorker = await asRole("worker_rw", (tx) => tx<{ r: { refreshed: boolean } }[]>`SELECT public.refresh_report_rollups() AS r`);
    expect(asWorker[0]?.r.refreshed).toBe(true);
    // The daily tables are rebuilt by delete and insert of whole days: the worker cannot UPDATE them in place, nor DELETE the one-row state.
    for (const statement of ["UPDATE public.report_orders_daily SET revenue_idr = 0", "UPDATE public.report_visits_daily SET visits = 0", "DELETE FROM public.report_rollup_state"]) {
      expect(await sqlState(asRole("worker_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
    expect((await asRole("admin_rw", (tx) => tx<{ n: string }[]>`SELECT count(*) AS n FROM public.report_orders_daily`))[0]?.n).not.toBeUndefined();
    await asRole("admin_rw", (tx) => tx`SELECT * FROM public.report_visits_daily LIMIT 1`);
    await asRole("admin_rw", (tx) => tx`SELECT * FROM public.report_rollup_state`);
    const forgery = [
      "INSERT INTO public.report_rollup_state (id, as_of, duration_ms, order_rows, visit_rows) VALUES (true, now(), 0, 0, 0) ON CONFLICT (id) DO NOTHING",
      "UPDATE public.report_orders_daily SET revenue_idr = revenue_idr + 1",
      "DELETE FROM public.report_orders_daily",
      "DELETE FROM public.report_visits_daily",
      "UPDATE public.report_rollup_state SET as_of = now()",
    ];
    for (const statement of forgery) {
      expect(await sqlState(asRole("admin_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
      expect(await sqlState(asRole("public_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
      expect(await sqlState(asRole("internal_rw", (tx) => tx.unsafe(statement))), statement).toBe("42501");
    }
    for (const role of ["public_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT * FROM public.report_orders_daily`)), role).toBe("42501");
    }
    // Nobody but the worker may run the refresh (PUBLIC has no EXECUTE either).
    for (const role of ["admin_rw", "public_rw", "internal_rw"] as const) {
      expect(await sqlState(asRole(role, (tx) => tx`SELECT public.refresh_report_rollups()`)), role).toBe("42501");
    }
  });

  it("gives the console the label and masking functions, and the workers nothing they do not need", async () => {
    const [labels] = await asRole("admin_rw", (tx) => tx<{ l: string; n: string; p: string }[]>`SELECT public.report_source_label(NULL) AS l, public.mask_name('Budi Santoso') AS n, public.mask_phone('+6281234567890') AS p`);
    expect(labels?.l).toBe("Organic");
    expect(labels?.n).not.toContain("Santoso");
    expect(labels?.p).not.toContain("81234567890");
    expect(await sqlState(asRole("worker_rw", (tx) => tx`SELECT public.mask_name('Budi')`))).toBe("42501");
    expect(await sqlState(asRole("public_rw", (tx) => tx`SELECT public.report_source_label(NULL)`))).toBe("42501");
  });
});
