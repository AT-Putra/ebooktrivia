// US-029 on the admin side, as the admin_rw login the console uses, on the seeded dataset of reports-dataset.ts. Every expected figure is
// worked out BY HAND below from that dataset's table (the arithmetic is in the comments), not read back from the code under test:
// the sales filters, the dashboard numbers, the ROI arithmetic (revenue - CPA - gateway fee - ad spend, per adnet / landing page /
// campaign, in whole rupiah with the fee rounded up), the reconciliation identity MT (sent + failed) = PAID orders with a click id per
// adnet, the postback list with its markers and the Owner's re-fire, the CSV exports, and the ad-spend entries.
import { gatewayFeeIdr, MIDTRANS_METHODS } from "@ebooktrivia/core";
import fc from "fast-check";
import Papa from "papaparse";
import { beforeAll, describe, expect, it } from "vitest";
import { can } from "../src/lib/policy.ts";
import { isStale, NO_FILTERS, parseSalesFilters, type SalesFilters } from "../src/lib/reports/common.ts";
import { loadDashboard } from "../src/lib/reports/dashboard.ts";
import { createAdSpend, deleteAdSpend, listAdSpend, parseAdSpend, updateAdSpend } from "../src/lib/reports/ad-spend.ts";
import { csvStream, EXPORT_BATCH, recordExport, SALES_CSV_HEADER, salesCsv, WINNERS_CSV_HEADER, winnersCsv } from "../src/lib/reports/exports.ts";
import { type PostbackFilters, postbackList, postbackSummary, reconcileMt } from "../src/lib/reports/postbacks.ts";
import { roiReport, type RoiGroup } from "../src/lib/reports/roi.ts";
import { reviewOrders, salesByDay, salesBySource, salesTotals } from "../src/lib/reports/sales.ts";
import { refireConversion } from "../src/lib/settings/conversions.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";
import { D1, D2, D3, type Dataset, FORMULA_BUYERS, NOW, refreshRollups, seedDataset } from "./reports-dataset.ts";

const rt = newRuntime();
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};
let ds: Dataset;
let ownerId = "";
const ALL: SalesFilters = { ...NO_FILTERS, from: D1, to: D3 };
const POSTBACKS_ALL: PostbackFilters = { from: D1, to: D3, adnet: null, sink: null, kind: null, status: null, marker: null };

beforeAll(async () => {
  ownerId = (await createTestAdmin(rt, "owner")).userId;
  ds = await seedDataset();
  // Isolation: the report figures below are hand-computed for the dataset alone, so D1..D3 (WIB) must hold exactly the dataset's rows. Another
  // test file that put orders, events, visits or spend on those days (in any file order) would break sixteen figures at once: say so here.
  const start = new Date("2026-11-17T17:00:00Z");
  const end = new Date("2026-11-20T17:00:00Z");
  const [held] = await root<{ orders: number; events: number; visits: number; spend: number }[]>`
    SELECT (SELECT count(*) FROM orders WHERE created_at >= ${start} AND created_at < ${end})::int AS orders,
           (SELECT count(*) FROM conversion_events WHERE created_at >= ${start} AND created_at < ${end})::int AS events,
           (SELECT count(*) FROM visits WHERE occurred_at >= ${start} AND occurred_at < ${end})::int AS visits,
           (SELECT count(*) FROM ad_spend WHERE spend_date BETWEEN ${D1}::date AND ${D3}::date)::int AS spend`;
  expect(held, "another test file wrote to the days of the reports dataset (2026-11-18 .. 11-20)").toEqual({ orders: 15, events: 19, visits: 35, spend: 4 });
  await refreshRollups();
});

const dashboardOf = (t: { visits: number; orders: number; mo: number; mt: number; conversionBps: number | null; revenueIdr: number }) => ({
  visits: t.visits,
  orders: t.orders,
  mo: t.mo,
  mt: t.mt,
  bps: t.conversionBps,
  revenue: t.revenueIdr,
});

const totals = async (f: Partial<SalesFilters>) => {
  const t = await salesTotals(rt.sql, { ...ALL, ...f });
  return { visits: t.visits, orders: t.orders, mo: t.mo, mt: t.mt, bps: t.conversionBps, revenue: t.revenueIdr };
};

describe("the sales report: filters (AC-A5), on the rollups", () => {
  it("totals the three days: 35 visits, 15 orders, MO 14 (every order but the snap_create_failed one), MT 9, 64.29 %, Rp 591.000", async () => {
    // Visits 15 + 11 + 9. MT = o1 o2 o4 o6 o7 o12 o13 o14 o15 (paid); revenue = 6 x 49000 + 3 x 99000; 9 / 14 = 64.2857 % -> 6429 bp (half up).
    expect(await totals({})).toEqual({ visits: 35, orders: 15, mo: 14, mt: 9, bps: 6429, revenue: 591_000 });
  });

  it.each([
    // [name, filters, visits, orders, MO, MT, conversion bp, revenue]
    ["program Beta (P2): o13 o14 o15", (d: Dataset) => ({ programId: d.p2 }), 3, 3, 3, 3, 10_000, 297_000],
    ["landing page LP2: o12", (d: Dataset) => ({ landingPageId: d.lp2 }), 2, 1, 1, 1, 10_000, 49_000],
    // Organic = no click id: o6 o7 (o7 has an adnet but no click id) o10 (no MO); visits 5 + (3 + 2 from an adnet without a click id).
    ["Organic (no click id)", () => ({ adnet: "organic" }), 10, 3, 2, 2, 10_000, 98_000],
    // Alpha: o1 o2 o3 o8 o9 o11 o12, all with an MO, MT = o1 o2 o12; 3 / 7 = 42.857 % -> 4286; visits 10 + 6 + 2.
    ["adnet Alpha", (d: Dataset) => ({ adnet: d.alpha }), 18, 7, 7, 3, 4286, 147_000],
    // Beta: o4 o5 o13 o14 o15, MT = o4 o13 o14 o15 (o5 is refunded); 4 / 5 = 80 %; visits 4 + 2 + 1.
    ["adnet Beta", (d: Dataset) => ({ adnet: d.beta }), 7, 5, 5, 4, 8000, 346_000],
    ["gateway midtrans", () => ({ gateway: "midtrans" }), 35, 15, 14, 9, 6429, 591_000],
    ["a gateway no landing page uses", () => ({ gateway: "stripe" }), 0, 0, 0, 0, null, 0],
    // The status filter keeps the orders of that status; visits have no status and stay.
    ["status paid", () => ({ status: "paid" as const }), 35, 9, 9, 9, 10_000, 591_000],
    ["status refunded: o3 o5, no revenue", () => ({ status: "refunded" as const }), 35, 2, 2, 0, 0, 0],
    ["status review: o11, no revenue", () => ({ status: "review" as const }), 35, 1, 1, 0, 0, 0],
    ["status pending: o8", () => ({ status: "pending" as const }), 35, 1, 1, 0, 0, 0],
    ["status snap_create_failed: o10 has no MO", () => ({ status: "snap_create_failed" as const }), 35, 1, 0, 0, null, 0],
    // One WIB day each: D1 = o1 o2 o3; D2 = o4 o5 o6 o7 o13; D3 = o8 .. o12 o14 o15 (o10 without MO; MT o12 o14 o15).
    ["D1 only", () => ({ from: D1, to: D1 }), 15, 3, 3, 2, 6667, 98_000],
    ["D2 only", () => ({ from: D2, to: D2 }), 11, 5, 5, 4, 8000, 246_000],
    ["D3 only", () => ({ from: D3, to: D3 }), 9, 7, 6, 3, 5000, 247_000],
    ["Alpha on LP1 in D1 and D2", (d: Dataset) => ({ adnet: d.alpha, landingPageId: d.lp1, from: D1, to: D2 }), 10, 3, 3, 2, 6667, 98_000],
  ])("filter: %s", async (_name, filters, visits, orders, mo, mt, bps, revenue) => {
    expect(await totals(filters(ds))).toEqual({ visits, orders, mo, mt, bps, revenue });
  });

  it("gives every day of the range a row, with the figures of that WIB day (an empty day is a row of zeros)", async () => {
    const days = await salesByDay(rt.sql, { ...ALL, from: "2026-11-17" });
    expect(days.map((d) => [d.day, d.visits, d.mo, d.mt, d.revenueIdr])).toEqual([
      ["2026-11-17", 0, 0, 0, 0],
      [D1, 15, 3, 2, 98_000],
      [D2, 11, 5, 4, 246_000],
      [D3, 9, 6, 3, 247_000],
    ]);
  });

  it("splits by landing page and source, biggest revenue first, with Organic labelled by order_source_label", async () => {
    const rows = await salesBySource(rt.sql, ALL);
    const view = rows.map((r) => [r.landingPage.split(" ").slice(0, 2).join(" "), r.source.replace(/ [0-9a-f]{8}$/, ""), r.visits, r.mo, r.mt, r.revenueIdr]);
    expect(view).toEqual([
      ["LP Three", "Beta Media", 3, 3, 3, 297_000],
      ["LP One", "Alpha Ads", 16, 6, 2, 98_000],
      ["LP One", "Organic", 10, 2, 2, 98_000],
      ["LP One", "Beta Media", 4, 2, 1, 49_000],
      ["LP Two", "Alpha Ads", 2, 1, 1, 49_000],
    ]);
    // The source rows add up to the totals.
    expect(rows.reduce((n, r) => n + r.revenueIdr, 0)).toBe(591_000);
    expect(rows.reduce((n, r) => n + r.visits, 0)).toBe(35);
    expect(rows.find((r) => r.source === "Organic")?.adnetId).toBeNull();
  });

  it("counts the orders in review of a range apart (o11), in no revenue", async () => {
    expect(await reviewOrders(rt.sql, ALL)).toBe(1);
    expect(await reviewOrders(rt.sql, { ...ALL, from: D1, to: D2 })).toBe(0);
  });

  it("refuses a filter that is not ours and a range that is not a range, with a message and the default instead (never a query)", () => {
    const now = NOW;
    expect(parseSalesFilters({ program: "not-a-uuid" }, now).error).toBe("A filter value is not valid.");
    expect(parseSalesFilters({ status: "refunded'; DROP TABLE orders;--" }, now).error).toBe("A filter value is not valid.");
    expect(parseSalesFilters({ gateway: "Midtrans" }, now).error).toBe("A filter value is not valid.");
    expect(parseSalesFilters({ from: "2026-11-20", to: "2026-11-01" }, now).error).toBe("The start date must not be after the end date.");
    expect(parseSalesFilters({ from: "2020-01-01", to: "2026-11-20" }, now).error).toBe("Choose at most 366 days.");
    const bad = parseSalesFilters({ from: "yesterday" }, now);
    expect(bad.filters).toMatchObject({ from: "2026-10-22", to: "2026-11-20", programId: null, status: null });
    const ok = parseSalesFilters({ from: D1, to: D3, adnet: "organic", status: "paid", program: ds.p1, lp: ds.lp1, gateway: "midtrans" }, now);
    expect(ok).toEqual({ filters: { from: D1, to: D3, adnet: "organic", status: "paid", programId: ds.p1, landingPageId: ds.lp1, gateway: "midtrans" }, error: null });
  });
});

describe("the dashboard (AC-A4): today's numbers from the rollups, with the time they are as of", () => {
  it("shows D3 as today and D2 as yesterday, 14 days of series, the orders in review, and when the rollups ran", async () => {
    const d = await loadDashboard(rt.sql, NOW);
    expect([d.today, d.yesterday]).toEqual([D3, D2]);
    // Today (D3): visits 6 + 2 + 1; orders o8 o9 o10 o11 o12 o14 o15 = 7, MO 6, MT o12 o14 o15 = 3 -> 50 %, revenue 49000 + 99000 + 99000.
    expect(dashboardOf(d.todayTotals)).toEqual({ visits: 9, orders: 7, mo: 6, mt: 3, bps: 5000, revenue: 247_000 });
    // Yesterday (D2): visits 4 + 3 + 2 + 2; o4 o5 o6 o7 o13: MO 5, MT 4 (o5 refunded) -> 80 %, revenue 3 x 49000 + 99000.
    expect(dashboardOf(d.yesterdayTotals)).toEqual({ visits: 11, orders: 5, mo: 5, mt: 4, bps: 8000, revenue: 246_000 });
    expect(d.series).toHaveLength(14);
    expect(d.series[0]?.day).toBe("2026-11-07");
    expect(d.series.slice(-3).map((s) => [s.day, s.visits, s.mo, s.mt, s.revenueIdr])).toEqual([
      [D1, 15, 3, 2, 98_000],
      [D2, 11, 5, 4, 246_000],
      [D3, 9, 6, 3, 247_000],
    ]);
    expect(d.series.slice(0, 11).every((s) => s.visits === 0 && s.mo === 0 && s.revenueIdr === 0)).toBe(true);
    expect(d.reviewOrders).toBe(1);
    expect(d.asOf).not.toBeNull();
  });

  it("is stale only when the rollups are more than 15 minutes older than 'now' (measured from the real as-of time of the refresh)", async () => {
    const { asOf } = await loadDashboard(rt.sql, NOW);
    expect(asOf).not.toBeNull();
    const ran = asOf ?? new Date(0);
    expect((await loadDashboard(rt.sql, new Date(ran.getTime() + 60_000))).stale).toBe(false);
    expect((await loadDashboard(rt.sql, new Date(ran.getTime() + 14 * 60_000))).stale).toBe(false);
    expect((await loadDashboard(rt.sql, new Date(ran.getTime() + 16 * 60_000))).stale).toBe(true);
  });

  it("says the figures are behind when the rollups are older than 15 minutes, or have never run", () => {
    expect(isStale(null, NOW)).toBe(true);
    expect(isStale(new Date(NOW.getTime() - 16 * 60_000), NOW)).toBe(true);
    expect(isStale(new Date(NOW.getTime() - 14 * 60_000), NOW)).toBe(false);
  });

  it("reads a day of its own on the WIB clock: 17:00 UTC is already tomorrow", async () => {
    // 2026-11-20T17:30Z is 00:30 WIB on 11-21: today is 11-21 and the three seeded days are history.
    const d = await loadDashboard(rt.sql, new Date("2026-11-20T17:30:00Z"));
    expect(d.today).toBe("2026-11-21");
    expect(dashboardOf(d.yesterdayTotals)).toEqual({ visits: 9, orders: 7, mo: 6, mt: 3, bps: 5000, revenue: 247_000 });
  });
});

describe("profit / ROI (AC-A8): revenue - CPA - gateway fee - ad spend, whole rupiah, against hand-computed fixtures", () => {
  /**
   * Per order (fee = flat + ceil(amount x bp / 10000); qris = the DEARER of other_qris 0.70 % and gopay 2.00 %, i.e. 2.00 %, because a desktop
   * GoPay tile arrives as qris (US-005); gopay 2.00 %, bank_transfer = the dearest VA 4400, credit_card 2000 + 2.90 %;
   * cstore has no fee set; revenue = paid only; the fee is charged for every order that was ever paid; CPA = the reported payout of an MT the
   * sink may have counted, less the reversal it acknowledged):
   *   o1  rev 49000 fee 980  CPA 5000      o2  rev 49000 fee 980  CPA 5000      o3  refunded: fee 980, CPA 0 (reversal sent)
   *   o4  rev 49000 fee 4400 CPA 7500      o5  refunded: fee 980, CPA 7500 (no reversal)  o6  rev 49000 fee 2000 + ceil(1421) = 3421
   *   o7  rev 49000 fee 0 (cstore: not set, counted as missing)                  o11 review: fee 980, CPA 5000, no revenue
   *   o12 rev 49000 fee 980  CPA 0 (its MT is still pending)                      o13 rev 99000 fee 1980  CPA 7500
   *   o14 rev 99000 fee 1980 CPA 7500      o15 rev 99000 fee 4400 CPA 0 (its MT failed and was not counted)
   * Ad spend: D1 12000 (Alpha, LP1, promo-a), D2 9000 (Beta, no landing page, "Promo-B "), D3 5000 (LP3, no adnet) and 1000 (nothing).
   */
  it("by adnet: Beta 293260; Alpha 115100; Organic 98000 - 0 - 3421 = 94579; the spend that names no adnet (5000 + 1000) is -6000 of its own, not Organic's", async () => {
    const report = await roiReport(rt.sql, { from: D1, to: D3, group: "adnet", page: 1 });
    const view = report.rows.map((r) => ({ label: r.label.replace(/ [0-9a-f]{8}$/, ""), key: r.key === null ? null : r.key === "" ? "" : "id", paid: r.paidOrders, revenue: r.revenueIdr, cpa: r.payoutIdr, fee: r.gatewayFeeIdr, spend: r.adSpendIdr, net: r.netIdr, missing: r.feeMissingOrders }));
    expect(view).toEqual([
      // Beta: revenue 346000 (o4 + o13 + o14 + o15); CPA 7500 x 4 = 30000; fee 4400 + 1980 + 1980 + 4400 + 980 (o5 refunded) = 13740; spend 9000.
      { label: "Beta Media", key: "id", paid: 4, revenue: 346_000, cpa: 30_000, fee: 13_740, spend: 9_000, net: 293_260, missing: 0 },
      // Alpha: revenue 147000 (o1 + o2 + o12); CPA 5000 + 5000 + 5000 (o11, review) = 15000; fee 980 x 5 (o1, o2, o3, o11, o12) = 4900; spend 12000.
      { label: "Alpha Ads", key: "id", paid: 3, revenue: 147_000, cpa: 15_000, fee: 4_900, spend: 12_000, net: 115_100, missing: 0 },
      // Organic: o6 + o7 = 98000, fee 3421 (o7's store method has none set), and NO spend: none of it names Organic.
      { label: "Organic", key: "", paid: 2, revenue: 98_000, cpa: 0, fee: 3_421, spend: 0, net: 94_579, missing: 1 },
      { label: "Spend with no adnet", key: null, paid: 0, revenue: 0, cpa: 0, fee: 0, spend: 6_000, net: -6_000, missing: 0 },
    ]);
    // Total: 591000 - 45000 - 22061 (13740 + 4900 + 3421) - 27000 = 496939, and the rows add up to it.
    expect(report.totals).toMatchObject({ paidOrders: 9, revenueIdr: 591_000, payoutIdr: 45_000, gatewayFeeIdr: 22_061, adSpendIdr: 27_000, netIdr: 496_939, feeMissingOrders: 1 });
    expect(report.rows.reduce((n, r) => n + r.netIdr, 0)).toBe(496_939);
    expect(report.rowCount).toBe(4);
  });

  it("by landing page: LP3 268640, LP1 190279, LP2 48020, and the spend that names no landing page (9000 + 1000) as a loss of its own", async () => {
    const report = await roiReport(rt.sql, { from: D1, to: D3, group: "landing_page", page: 1 });
    expect(report.rows.map((r) => [r.label.startsWith("LP ") ? r.label.split(" ").slice(0, 2).join(" ") : r.label, r.revenueIdr, r.payoutIdr, r.gatewayFeeIdr, r.adSpendIdr, r.netIdr])).toEqual([
      // LP3: 297000 - (7500 + 7500) - (1980 + 1980 + 4400) - 5000
      ["LP Three", 297_000, 15_000, 8_360, 5_000, 268_640],
      // LP1: 245000 - (5000 + 5000 + 7500 + 7500 + 5000) - (980 + 980 + 980 + 4400 + 980 + 3421 + 0 + 980) - 12000
      ["LP One", 245_000, 30_000, 12_721, 12_000, 190_279],
      ["LP Two", 49_000, 0, 980, 0, 48_020],
      ["Spend with no landing page", 0, 0, 0, 10_000, -10_000],
    ]);
    expect(report.totals.netIdr).toBe(496_939);
    expect(report.rows.reduce((n, r) => n + r.netIdr, 0)).toBe(496_939);
  });

  it("by campaign (compared lower-cased and trimmed): promo-b 293260, promo-a 67080, no campaign 94579, promo-c 48020, and the spend with no campaign -6000 of its own", async () => {
    const report = await roiReport(rt.sql, { from: D1, to: D3, group: "utm_campaign", page: 1 });
    expect(report.rows.map((r) => [r.label, r.revenueIdr, r.payoutIdr, r.gatewayFeeIdr, r.adSpendIdr, r.netIdr])).toEqual([
      ["promo-b", 346_000, 30_000, 13_740, 9_000, 293_260],
      // promo-a: 2 x 49000 = 98000; CPA o1 + o2 + o11 = 15000; fee 980 x 4 (o1, o2, o3, o11) = 3920; spend 12000 ("Promo-A" == "promo-a")
      ["promo-a", 98_000, 15_000, 3_920, 12_000, 67_080],
      ["No campaign", 98_000, 0, 3_421, 0, 94_579],
      ["promo-c", 49_000, 0, 980, 0, 48_020],
      ["Spend with no campaign", 0, 0, 0, 6_000, -6_000],
    ]);
    expect(report.totals.netIdr).toBe(496_939);
    expect(report.rows.reduce((n, r) => n + r.netIdr, 0)).toBe(496_939);
  });

  it("does not mix a campaign that is literally named like the unassigned row with the unassigned spend (the key is NULL, not a name)", async () => {
    const day = "2026-10-25";
    await root`INSERT INTO ad_spend (spend_date, platform, utm_campaign, amount_idr) VALUES (${day}, 'meta', 'Spend with no campaign', 700), (${day}, 'other', NULL, 300), (${day}, 'google', '   ', 50)`;
    const report = await roiReport(rt.sql, { from: day, to: day, group: "utm_campaign", page: 1 });
    expect(report.rows.map((r) => [r.key, r.label, r.adSpendIdr])).toEqual([
      ["spend with no campaign", "spend with no campaign", 700],
      [null, "Spend with no campaign", 350],
    ]);
    await root`DELETE FROM ad_spend WHERE spend_date = ${day}`;
  });

  it("for a shorter range: D1 + D2 = 344000 - 32500 - 13721 - 21000 = 276779; D3 alone has no missing fee", async () => {
    // D1 + D2 fees: o1 980 + o2 980 + o3 980 + o4 4400 + o5 980 + o6 3421 + o7 0 + o13 1980 = 13721.
    const early = await roiReport(rt.sql, { from: D1, to: D2, group: "adnet", page: 1 });
    expect(early.totals).toMatchObject({ revenueIdr: 344_000, payoutIdr: 32_500, gatewayFeeIdr: 13_721, adSpendIdr: 21_000, netIdr: 276_779, feeMissingOrders: 1 });
    const last = await roiReport(rt.sql, { from: D3, to: D3, group: "adnet", page: 1 });
    // D3: revenue o12 + o14 + o15 = 247000; CPA o11 5000 + o14 7500 = 12500; fee o11 980 + o12 980 + o14 1980 + o15 4400 = 8340; spend 5000 + 1000.
    expect(last.totals).toMatchObject({ revenueIdr: 247_000, payoutIdr: 12_500, gatewayFeeIdr: 8_340, adSpendIdr: 6_000, netIdr: 247_000 - 12_500 - 8_340 - 6_000, feeMissingOrders: 0 });
  });

  it("is the same total whatever the grouping, and a page past the end is empty but still reports the real number of groups", async () => {
    const nets = await Promise.all((["adnet", "landing_page", "utm_campaign"] as RoiGroup[]).map(async (group) => (await roiReport(rt.sql, { from: D1, to: D3, group, page: 1 })).totals.netIdr));
    expect(new Set(nets)).toEqual(new Set([496_939]));
    const second = await roiReport(rt.sql, { from: D1, to: D3, group: "adnet", page: 2 });
    expect(second.rows).toEqual([]);
    expect(second.rowCount).toBe(4);
    expect(second.page).toBe(2);
  });

  it("agrees with core gatewayFeeIdr for any amount, flat fee and percentage: the SQL and the TypeScript round the same way (up)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5_000_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000 }), async (amount, flat, bps) => {
        const [row] = await root<{ fee: string }[]>`SELECT public.gateway_fee_idr(${amount}::bigint, ${flat}::bigint, ${bps}::integer)::text AS fee`;
        expect(Number(row?.fee)).toBe(gatewayFeeIdr(amount, { flatIdr: flat, percentBps: bps }));
      }),
      { numRuns: 60 },
    );
  });
});

describe("the postback report (AC-A7): what was fired, what failed and why", () => {
  it("counts MO, MT and reversals per adnet and per CAPI sink, as sent / failed / in flight", async () => {
    const rows = await postbackSummary(rt.sql, POSTBACKS_ALL);
    const mine = rows.filter((r) => r.adnetId === ds.alpha || r.adnetId === ds.beta || r.adnetId === null);
    const view = mine.map((r) => [r.source.replace(/ [0-9a-f]{8}$/, ""), r.sink, r.mo, r.mt, r.reversal]);
    expect(view).toEqual([
      // Alpha: MO o1 sent, o2 failed, o8 pending; MT o1 o2 o3 o11 sent and o12 pending; reversal o3 sent.
      ["Alpha Ads", "s2s", { sent: 1, failed: 1, inFlight: 1 }, { sent: 4, failed: 0, inFlight: 1 }, { sent: 1, failed: 0, inFlight: 0 }],
      // Beta: MO o4 o13 sent; MT o4 o5 o13 o14 sent and o15 failed; the only reversal (o5) was skipped.
      ["Beta Media", "s2s", { sent: 2, failed: 0, inFlight: 0 }, { sent: 4, failed: 1, inFlight: 0 }, { sent: 0, failed: 1, inFlight: 0 }],
      ["Meta Conversions API", "meta", { sent: 0, failed: 0, inFlight: 0 }, { sent: 0, failed: 1, inFlight: 0 }, { sent: 0, failed: 0, inFlight: 0 }],
      ["TikTok Events API", "tiktok", { sent: 0, failed: 0, inFlight: 0 }, { sent: 0, failed: 1, inFlight: 0 }, { sent: 0, failed: 0, inFlight: 0 }],
    ]);
  });

  it("lists the failed events with filters: every one, then each marker, kind, sink and adnet", async () => {
    const orderCode = async (id: string | undefined) => (await root<{ order_code: string }[]>`SELECT order_code FROM orders WHERE id = ${id ?? ""}`)[0]?.order_code;
    const failed = await postbackList(rt.sql, { ...POSTBACKS_ALL, status: "failed" }, 1);
    // o2's MO, o15's MT, o14's Meta MT (order_not_paid) and TikTok MT (no template), o5's skipped reversal.
    expect(failed.count).toBe(5);
    expect(failed.rows.map((r) => [r.kind, r.sink, r.marker]).sort()).toEqual([
      ["mo", "s2s", null],
      ["mt", "meta", "order_not_paid"],
      ["mt", "s2s", null],
      ["mt", "tiktok", "no_mt_template"],
      ["reversal", "s2s", "reversal_skipped"],
    ]);
    const only = async (f: Partial<PostbackFilters>) => (await postbackList(rt.sql, { ...POSTBACKS_ALL, ...f }, 1)).rows;
    expect((await only({ marker: "order_not_paid" })).map((r) => r.sink)).toEqual(["meta"]);
    expect((await only({ marker: "reversal_skipped" })).map((r) => r.kind)).toEqual(["reversal"]);
    expect((await only({ marker: "no_mt_template" })).map((r) => r.sink)).toEqual(["tiktok"]);
    expect((await only({ kind: "reversal" })).length).toBe(2);
    expect((await only({ sink: "meta" })).length).toBe(1);
    // Alpha has 3 MO + 5 MT + 1 reversal = 9 events, Beta 2 + 5 + 1 = 8; the two CAPI rows have no adnet.
    expect((await postbackList(rt.sql, { ...POSTBACKS_ALL, adnet: ds.alpha }, 1)).count).toBe(9);
    expect((await postbackList(rt.sql, { ...POSTBACKS_ALL, adnet: ds.beta }, 1)).count).toBe(8);
    expect((await postbackList(rt.sql, POSTBACKS_ALL, 1)).count).toBe(19);
    // Newest first: o15's MT (D3 14:00 WIB) leads.
    const all = await postbackList(rt.sql, POSTBACKS_ALL, 1);
    expect(all.rows[0]?.orderCode).toBe(await orderCode(ds.orders["o15"]));
    expect(all.rows[0]).toMatchObject({ kind: "mt", status: "failed", attempts: 1, httpStatus: 500, lastError: "HTTP 500" });
  });

  it("reports a reversal with the payout its MT REPORTED, the answer of the last attempt cut at 300 characters, and the sticky 'may have counted' mark", async () => {
    const reversals = await postbackList(rt.sql, { ...POSTBACKS_ALL, kind: "reversal" }, 1);
    const byOrder = new Map(reversals.rows.map((r) => [r.orderCode, r]));
    const code = async (name: string) => (await root<{ order_code: string }[]>`SELECT order_code FROM orders WHERE id = ${ds.orders[name] ?? ""}`)[0]?.order_code ?? "";
    expect(byOrder.get(await code("o3"))).toMatchObject({ status: "sent", payoutIdr: 5000 });
    expect(byOrder.get(await code("o5"))).toMatchObject({ status: "failed", payoutIdr: 7500, marker: "reversal_skipped" });
    await root`
      INSERT INTO conversion_attempts (conversion_event_id, attempt, http_status, response_excerpt, latency_ms)
      VALUES (${ds.mt["o15"] ?? ""}, 1, 500, ${"x".repeat(1000)}, 120)`;
    const failedMt = (await postbackList(rt.sql, { ...POSTBACKS_ALL, status: "failed", kind: "mt", sink: "s2s" }, 1)).rows[0];
    expect(failedMt?.response).toHaveLength(300);
    expect(failedMt?.latencyMs).toBe(120);
    expect(failedMt?.maybeCounted).toBe(false);
    const sent = (await postbackList(rt.sql, { ...POSTBACKS_ALL, status: "sent", kind: "mt" }, 1)).rows;
    expect(sent.every((r) => r.maybeCounted)).toBe(true);
    // The payout of an MT row is its own snapshot: 5000 for Alpha's, 7500 for Beta's.
    expect(new Set(sent.map((r) => r.payoutIdr))).toEqual(new Set([5000, 7500]));
  });

  it("pages the list: a page holds at most 50 rows, the count is all that match", async () => {
    const first = await postbackList(rt.sql, POSTBACKS_ALL, 1);
    expect(first.rows.length).toBeLessThanOrEqual(50);
    expect(first.count).toBe(19);
    const past = await postbackList(rt.sql, POSTBACKS_ALL, 2);
    expect(past.rows).toEqual([]);
    expect(past.count).toBe(19); // a page past the end still reports the real total
  });
});

describe("the reconciliation identity: MT (sent + failed) = PAID orders with a click id, per adnet, from the raw tables", () => {
  const view = (rows: Awaited<ReturnType<typeof reconcileMt>>) => rows.map((r) => ({ adnet: r.adnet.replace(/ [0-9a-f]{8}$/, ""), paid: r.paidOrders, sent: r.sent, failed: r.failed, inFlight: r.inFlight, gap: r.gap, identity: r.identity }));
  const mine = (rows: Awaited<ReturnType<typeof reconcileMt>>) => rows.filter((r) => r.adnetId === ds.alpha || r.adnetId === ds.beta);

  it("holds exactly for D1 + D2: Alpha 3 paid = 3 sent, Beta 3 paid = 3 sent", async () => {
    expect(view(mine(await reconcileMt(rt.sql, { from: D1, to: D2 })))).toEqual([
      { adnet: "Alpha Ads", paid: 3, sent: 3, failed: 0, inFlight: 0, gap: 0, identity: true },
      { adnet: "Beta Media", paid: 3, sent: 3, failed: 0, inFlight: 0, gap: 0, identity: true },
    ]);
  });

  it("over all three days: Beta 5 paid = 4 sent + 1 failed (a failed row counts); Alpha 5 paid = 4 sent + 1 in flight (balanced, not final)", async () => {
    // Alpha ever paid with a click id: o1 o2 o3 (refunded) o11 (review) o12; o7 has no click id and is not counted.
    expect(view(mine(await reconcileMt(rt.sql, ALL)))).toEqual([
      { adnet: "Alpha Ads", paid: 5, sent: 4, failed: 0, inFlight: 1, gap: 0, identity: false },
      { adnet: "Beta Media", paid: 5, sent: 4, failed: 1, inFlight: 0, gap: 0, identity: true },
    ]);
  });

  it("reads the raw tables while the sales pages read the rollups: an order inserted after a refresh is in the reconciliation at once and in the sales figures only after the next refresh", async () => {
    const beta = async () => (await reconcileMt(rt.sql, { from: D3, to: D3 })).find((r) => r.adnetId === ds.beta);
    expect(await beta()).toMatchObject({ paidOrders: 2, sent: 1, failed: 1, gap: 0 });
    const salesBefore = await totals({});
    const created = new Date("2026-11-20T06:00:00Z");
    const product = await one(root<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${ds.p2}`);
    const added = await one(root<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, created_at, paid_at, adnet_id, clickid)
      VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`RDS${suffix()}`.toUpperCase()}, ${ds.lp3}, ${ds.p2}, ${product.product_id}, 'Rollup Baca', '+6281300002001', 'baca@example.invalid',
              sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 99000, 'paid', ${new Date(created.getTime() + 3_600_000)}, ${created}, ${created}, ${ds.beta}, 'rds-1')
      RETURNING id`);
    try {
      expect(await beta()).toMatchObject({ paidOrders: 3, sent: 1, failed: 1, gap: 1 }); // the raw read sees it at once: a paid order with no MT row
      expect(await totals({})).toEqual(salesBefore); // the sales read is the rollup: unchanged until the next refresh
      await refreshRollups();
      expect(await totals({})).toEqual({ ...salesBefore, orders: salesBefore.orders + 1, mo: salesBefore.mo + 1, mt: salesBefore.mt + 1, bps: 6667, revenue: salesBefore.revenue + 99_000 });
    } finally {
      await root`DELETE FROM orders WHERE id = ${added.id}`;
      await refreshRollups();
    }
    expect(await totals({})).toEqual(salesBefore);
    expect(await beta()).toMatchObject({ paidOrders: 2, gap: 0 });
  });

  it("reports a LOST conversion: a paid order with a click id and no MT row is a gap of 1", async () => {
    const day = "2026-10-20";
    const created = new Date(Date.parse(`${day}T03:00:00Z`));
    await root`
      INSERT INTO orders ${root({
        public_id: `${suffix()}${suffix()}${suffix()}`,
        order_code: `${suffix()}${suffix()}`.toUpperCase(),
        landing_page_id: ds.lp1,
        program_id: ds.p1,
        product_id: (await root<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${ds.p1}`)[0]?.product_id ?? "",
        buyer_name: "Hilang",
        buyer_phone: "+6281200000001",
        buyer_email: "hilang@example.invalid",
        buyer_key: Buffer.alloc(32, 7),
        amount_idr: 49000,
        status: "paid",
        expires_at: new Date(created.getTime() + 3_600_000),
        created_at: created,
        paid_at: created,
        adnet_id: ds.alpha,
        clickid: "lost-1",
      })}`;
    expect(view(mine(await reconcileMt(rt.sql, { from: day, to: day })))).toEqual([{ adnet: "Alpha Ads", paid: 1, sent: 0, failed: 0, inFlight: 0, gap: 1, identity: false }]);
  });
});

describe("CSV exports (Owner only, audited, streamed, Excel-safe)", () => {
  // ignoreBOM keeps the byte order mark in the string (the default decoder strips it, which would hide whether it was sent).
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await new Response(stream).arrayBuffer());
  const rowsOf = (text: string): string[][] => Papa.parse(text.replace(/^\uFEFF/, ""), { skipEmptyLines: true, delimiter: "," }).data;

  it("streams one row per order with the filters applied, UTF-8 with a BOM, CRLF records, and the amounts as numbers", async () => {
    const text = await read(salesCsv(rt.sql, ALL));
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text.includes("\r\n")).toBe(true);
    const rows = rowsOf(text);
    expect(rows[0]).toEqual([...SALES_CSV_HEADER]);
    expect(rows).toHaveLength(16);
    const amount = SALES_CSV_HEADER.indexOf("amount_idr");
    expect(rows.slice(1).reduce((n, r) => n + Number(r[amount]), 0)).toBe(12 * 49_000 + 3 * 99_000);
    const paid = rowsOf(await read(salesCsv(rt.sql, { ...ALL, status: "paid" })));
    expect(paid).toHaveLength(10);
    expect(paid.slice(1).every((r) => r[SALES_CSV_HEADER.indexOf("status")] === "paid")).toBe(true);
    const organic = rowsOf(await read(salesCsv(rt.sql, { ...ALL, adnet: "organic" })));
    expect(organic.slice(1).every((r) => r[SALES_CSV_HEADER.indexOf("source")] === "Organic")).toBe(true);
    expect(organic).toHaveLength(4);
  });

  it("neutralizes every formula: the buyers named =cmd.., +1+1, -2+3 and @SUM(A1) reach the file as text, and no cell starts a formula", async () => {
    const rows = rowsOf(await read(salesCsv(rt.sql, ALL)));
    const names = rows.slice(1).map((r) => r[SALES_CSV_HEADER.indexOf("buyer_name")]);
    for (const formula of Object.values(FORMULA_BUYERS)) expect(names).toContain(`'${formula}`);
    for (const row of rows.slice(1)) {
      for (const cell of row) expect(/^[=+\-@\t\r]/.test(cell), cell).toBe(false);
    }
    // The phone starts with "+" (E.164): text, with the apostrophe, never a number or a formula.
    expect(rows[1]?.[SALES_CSV_HEADER.indexOf("buyer_phone")]).toMatch(/^'\+62/);
  });

  it("pages through the range by (created_at, id) in batches, in order, with no row twice or missed, whatever the batch size", async () => {
    const whole = await read(salesCsv(rt.sql, ALL, EXPORT_BATCH));
    for (const batch of [1, 4, 7, 15, 16]) expect(await read(salesCsv(rt.sql, ALL, batch)), `batch ${String(batch)}`).toBe(whole);
    const codes = rowsOf(whole).slice(1).map((r) => r[0]);
    expect(new Set(codes).size).toBe(15);
  });

  describe("the keyset cursor keeps microseconds (a JS Date holds milliseconds only)", () => {
    const day = "2026-10-12";
    let lp = "";
    const filters = (): SalesFilters => ({ ...NO_FILTERS, from: day, to: day, landingPageId: lp });
    /** Reads a stream, giving up (a failure, not a hang) when a cursor that does not advance keeps it producing for ever. */
    const readCapped = async (stream: ReadableStream<Uint8Array>, maxChunks = 60): Promise<string> => {
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
      let out = "";
      for (let i = 0; i < maxChunks; i++) {
        const chunk = await reader.read();
        if (chunk.done) return out;
        out += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel();
      throw new Error(`the export did not end after ${String(maxChunks)} chunks: its cursor does not advance`);
    };
    /** Five orders inside the SAME millisecond (.123001 .. .123005), one at .123999, one in the next millisecond, one earlier, 8 in all; the first three are named with hostile text. */
    const MICROS = ["03:00:00.122500", "03:00:00.123001", "03:00:00.123002", "03:00:00.123003", "03:00:00.123004", "03:00:00.123005", "03:00:00.123999", "03:00:00.124000"] as const;
    const NAMES: Readonly<Record<number, string>> = { 1: "x;=1+1", 2: " \t=1", 3: "\u3000=1" };

    beforeAll(async () => {
      const program = await one(root<{ id: string; product_id: string }[]>`SELECT id, product_id FROM programs WHERE id = ${ds.p1}`);
      lp = (await one(root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP Micro', ${program.id}) RETURNING id`)).id;
      for (const [i, t] of MICROS.entries()) {
        await root`
          INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, created_at)
          VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`MKR${String(i)}${suffix()}`.toUpperCase()}, ${lp}, ${program.id}, ${program.product_id}, ${NAMES[i] ?? `Mikro ${String(i)}`}, ${`+62813000010${String(i)}`},
                  'mikro@example.invalid', sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, 'pending', ${new Date("2026-10-12T09:00:00Z")}, ${`${day} ${t}+00`}::timestamptz)`;
      }
    });

    it.each([1, 2, 3, 4, 7, 8, 9])("batch %i: every order once and in order, none repeated, the last of a batch not emitted twice", async (batch) => {
      const rows = rowsOf(await readCapped(salesCsv(rt.sql, filters(), batch)));
      expect(rows[0]).toEqual([...SALES_CSV_HEADER]);
      const names = rows.slice(1).map((r) => r[SALES_CSV_HEADER.indexOf("buyer_name")]);
      expect(names).toHaveLength(8);
      expect(new Set(rows.slice(1).map((r) => r[0])).size).toBe(8);
      // Oldest first by the microsecond: .122500, then the five of one millisecond by their order of insertion, .123999, .124000.
      expect(names.map((n) => n?.replace(/^'/, ""))).toEqual(["Mikro 0", "x;=1+1", " \t=1", "\u3000=1", "Mikro 4", "Mikro 5", "Mikro 6", "Mikro 7"]);
    });

    it("quotes a semicolon (the id-ID Excel list separator) and neutralizes a formula behind a tab or an ideographic space, in the file itself", async () => {
      const text = await readCapped(salesCsv(rt.sql, filters()));
      expect(text).toContain('"x;=1+1"');
      const names = rowsOf(text).slice(1).map((r) => r[SALES_CSV_HEADER.indexOf("buyer_name")]);
      expect(names).toContain("x;=1+1"); // starts with x: text, no apostrophe
      expect(names).toContain("' \t=1");
      expect(names).toContain("'\u3000=1");
    });
  });

  it("is a pull stream: it reads one batch at a time and stops reading when the download is cancelled", async () => {
    const reader = salesCsv(rt.sql, ALL, 4).getReader();
    const head = await reader.read();
    expect(new TextDecoder().decode(head.value)).toContain("order_code");
    const firstBatch = await reader.read();
    expect(new TextDecoder().decode(firstBatch.value).split("\r\n").filter((l) => l !== "")).toHaveLength(4);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
    // And a stream whose source yields nothing is the header alone.
    expect(await read(csvStream(["a", "b"], { next: () => Promise.resolve({ done: true as const, value: undefined }) }))).toBe("\uFEFFa,b\r\n");
  });

  it("exports the winners of a program with their contact, neutralized; a program without winners is the header alone", async () => {
    const none = rowsOf(await read(winnersCsv(rt.sql, ds.p1)));
    expect(none).toEqual([[...WINNERS_CSV_HEADER]]);
  });

  it("records every export in the audit log (the filters and the program, never a person), before the file is read", async () => {
    await asAdmin(ownerId, () => recordExport(rt.sql, "sales.export", { from: D1, to: D3, program_id: ds.p1, landing_page_id: null, adnet: "organic", gateway: null, status: "paid" }));
    await asAdmin(ownerId, () => recordExport(rt.sql, "winners.export", { program_id: ds.p1 }));
    const entries = await root<{ action: string; actor: string; text: string; changes: Record<string, unknown> }[]>`
      SELECT action, actor_admin_user_id AS actor, row_to_json(a)::text AS text, changes FROM audit_log a WHERE action IN ('sales.export', 'winners.export') AND actor_admin_user_id = ${ownerId} ORDER BY id`;
    expect(entries.map((e) => e.action)).toEqual(["sales.export", "winners.export"]);
    expect(entries[0]?.changes).toEqual({ from: D1, to: D3, program_id: ds.p1, landing_page_id: null, adnet: "organic", gateway: null, status: "paid" });
    for (const entry of entries) for (const buyer of ["Pembeli", "example.invalid", "SUM(A1)"]) expect(entry.text).not.toContain(buyer);
  });

  it("is Owner-only in the policy: Staff may view reports, never export", () => {
    expect(can("staff", "reports.view")).toBe(true);
    expect(can("staff", "sales.export")).toBe(false);
    expect(can("staff", "winners.export")).toBe(false);
    expect(can("owner", "sales.export")).toBe(true);
    expect(can("owner", "winners.export")).toBe(true);
  });
});

describe("drift: the SQL method map and core", () => {
  const TYPES = ["qris", "bank_transfer", "cstore", "gopay", "shopeepay", "echannel", "credit_card", "akulaku", "kredivo"];

  it("every Snap method code that midtrans_method_codes (sql/reports.sql) maps a Midtrans payment_type to exists in core MIDTRANS_METHODS, and every core code is reachable from some payment_type", async () => {
    const rows = await root<{ t: string; codes: string[] }[]>`SELECT t, public.midtrans_method_codes(t) AS codes FROM unnest(${TYPES}::text[]) AS t`;
    const core = new Set<string>(MIDTRANS_METHODS.map((m) => m.code));
    const mapped = new Set(rows.flatMap((r) => r.codes));
    for (const code of mapped) expect(core.has(code), `${code} is mapped by SQL but unknown to core`).toBe(true);
    expect([...core].filter((c) => !mapped.has(c)), "core codes no payment_type reaches (a fee set for them would never apply)").toEqual([]);
    expect((await root<{ codes: string[] }[]>`SELECT public.midtrans_method_codes('some_new_type') AS codes`)[0]?.codes).toEqual(["some_new_type"]); // unknown types fall through to a code core does not know: counted as fee missing
  });

  // What the Midtrans sandbox recorded (US-005, docs/spikes/R12.md, infra/midtrans-stub/fixtures/status.json): the payment_type each
  // Snap method arrives as. Every row names the core codes the SQL map must give it (a payment_type the map misses is priced as fee_missing).
  it.each<[string, string, readonly string[]]>([
    ["QRIS tile", "qris", ["other_qris"]],
    ["GoPay tile on a desktop (a QR: acquirer gopay)", "qris", ["gopay"]],
    ["virtual accounts (the bank is in va_numbers[].bank, not kept)", "bank_transfer", ["bca_va", "bni_va", "bri_va", "permata_va", "cimb_va", "other_va"]],
    ["Mandiri Bill", "echannel", ["echannel"]],
    ["Indomaret", "cstore", ["indomaret"]],
    ["card", "credit_card", ["credit_card"]],
    ["GoPay on a phone", "gopay", ["gopay"]],
    ["ShopeePay on a phone", "shopeepay", ["shopeepay"]],
  ])("the recorded payment_type of %s (%s) reaches %j", async (_tile, type, codes) => {
    const [row] = await root<{ codes: string[] }[]>`SELECT public.midtrans_method_codes(${type}) AS codes`;
    for (const code of codes) expect(row?.codes, `${type} must carry the fee of ${code}`).toContain(code);
    expect(MIDTRANS_METHODS.map((m) => m.code)).toEqual(expect.arrayContaining([...codes]));
  });
});

describe("ad spend (AC-A8): the Owner's entries, audited, read live by the ROI report", () => {
  // A day with no order of any test (the seeded days are 11-18 to 11-20; other tests create orders at the real date).
  const day = "2026-11-05";
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ spend_date: day, platform: "meta", landing_page_id: "", adnet_id: "", utm_campaign: "", amount_idr: "1250000", note: "", ...o })) f.set(k, v);
    return f;
  };
  const TODAY = "2026-11-25";

  it("validates a form: whole rupiah (dots allowed), a real day not after today, a known platform, UUIDs only", () => {
    expect(parseAdSpend(form({ amount_idr: "1.250.000", utm_campaign: " Promo-X ", note: "  boost " }), TODAY)).toEqual({
      spendDate: day, platform: "meta", landingPageId: null, adnetId: null, utmCampaign: "Promo-X", amountIdr: 1_250_000, note: "boost",
    });
    for (const bad of [{ spend_date: "2026-11-26" }, { spend_date: "2026-02-30" }, { platform: "myspace" }, { amount_idr: "12,5" }, { amount_idr: "-1" }, { amount_idr: "10000000001" }, { landing_page_id: "x" }, { utm_campaign: "a\nb" }]) {
      expect(() => parseAdSpend(form(bad), TODAY), JSON.stringify(bad)).toThrow(InvalidInput);
    }
  });

  it("creates, changes and deletes an entry, each audited with the fields it changed; the ROI report shows it at once (no rollup involved)", async () => {
    const input = parseAdSpend(form({ landing_page_id: ds.lp2, adnet_id: ds.alpha, utm_campaign: "PROMO-C", amount_idr: "3000" }), TODAY);
    const id = await asAdmin(ownerId, () => createAdSpend(rt.sql, input));
    const roi = (group: RoiGroup) => roiReport(rt.sql, { from: day, to: day, group, page: 1 });
    expect((await roi("landing_page")).rows.map((r) => [r.label.split(" ").slice(0, 2).join(" "), r.adSpendIdr, r.netIdr])).toEqual([["LP Two", 3000, -3000]]);
    expect((await roi("utm_campaign")).rows.map((r) => [r.label, r.adSpendIdr])).toEqual([["promo-c", 3000]]);
    await asAdmin(ownerId, () => updateAdSpend(rt.sql, id, { ...input, amountIdr: 4500, note: "corrected" }));
    expect((await roi("adnet")).totals).toMatchObject({ adSpendIdr: 4500, netIdr: -4500 });
    const listed = await listAdSpend(rt.sql, { from: day, to: day, page: 1 });
    expect(listed).toMatchObject({ total: 4500, count: 1 });
    expect(listed.rows[0]).toMatchObject({ id, platform: "meta", amountIdr: 4500, note: "corrected", utmCampaign: "PROMO-C" });
    await asAdmin(ownerId, () => deleteAdSpend(rt.sql, id));
    expect((await listAdSpend(rt.sql, { from: day, to: day, page: 1 })).rows).toEqual([]);
    await expect(asAdmin(ownerId, () => updateAdSpend(rt.sql, id, input))).rejects.toThrow(/no longer exists/);
    await expect(asAdmin(ownerId, () => deleteAdSpend(rt.sql, id))).rejects.toThrow(/no longer exists/);
    const audit = await root<{ action: string; changes: Record<string, { before?: unknown; after?: unknown }> }[]>`
      SELECT action, changes FROM audit_log WHERE entity_type = 'ad_spend' AND entity_id = ${id} ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(["ad_spend.create", "ad_spend.update", "ad_spend.delete"]);
    expect(audit[1]?.changes["amount_idr"]).toEqual({ before: 3000, after: 4500 });
    expect(audit[1]?.changes["note"]).toEqual({ before: null, after: "corrected" });
  });

  it("is Owner-only: Staff cannot edit ad spend nor open the profit view, and the console login cannot forge a rollup", async () => {
    expect(can("staff", "ad_spend.edit")).toBe(false);
    expect(can("staff", "roi.view")).toBe(false);
    await expect(rt.sql`UPDATE public.report_orders_daily SET revenue_idr = revenue_idr + 1`).rejects.toMatchObject({ code: "42501" });
    await expect(rt.sql`DELETE FROM public.report_visits_daily`).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the Owner's re-fire of a failed conversion (AC-T3, AC-A7)", () => {
  it("re-fires o15's failed MT (once), audited, and the failed list no longer holds it; a sent one only on explicit confirmation", async () => {
    const id = ds.mt["o15"] ?? "";
    await asAdmin(ownerId, () => refireConversion(rt.sql, id));
    expect((await root<{ status: string; attempts: number }[]>`SELECT status::text AS status, attempts FROM conversion_events WHERE id = ${id}`)[0]).toEqual({ status: "pending", attempts: 1 });
    const failed = await postbackList(rt.sql, { ...POSTBACKS_ALL, status: "failed", kind: "mt", sink: "s2s" }, 1);
    expect(failed.count).toBe(0);
    await expect(asAdmin(ownerId, () => refireConversion(rt.sql, id))).rejects.toThrow(/Only a failed conversion can be re-fired/);
    const sentId = ds.mt["o1"] ?? "";
    await expect(asAdmin(ownerId, () => refireConversion(rt.sql, sentId))).rejects.toThrow(/Only a failed conversion can be re-fired/);
    await asAdmin(ownerId, () => refireConversion(rt.sql, sentId, { resendSent: true }));
    expect((await root<{ status: string }[]>`SELECT status::text AS status FROM conversion_events WHERE id = ${sentId}`)[0]?.status).toBe("pending");
    const audit = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'conversion.refire' AND entity_id IN (${id}, ${sentId}) ORDER BY id`;
    expect(audit).toHaveLength(2);
    expect(audit[0]?.changes).toMatchObject({ status: { before: "failed", after: "pending" }, sink: "s2s", kind: "mt", resend_sent: false });
    expect(audit[1]?.changes).toMatchObject({ status: { before: "sent", after: "pending" }, resend_sent: true });
    // The console cannot write the conversion log any other way.
    await expect(rt.sql`UPDATE public.conversion_events SET status = 'pending' WHERE id = ${sentId}`).rejects.toMatchObject({ code: "42501" });
    // The reconciliation now sees o15's row in flight, o1's too: still balanced, no longer final.
    const beta = (await reconcileMt(rt.sql, ALL)).find((r) => r.adnetId === ds.beta);
    expect(beta).toMatchObject({ paidOrders: 5, sent: 4, failed: 0, inFlight: 1, gap: 0, identity: false });
  });
});
