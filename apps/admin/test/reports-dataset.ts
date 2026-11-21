// The seeded dataset of the report tests (US-029): three WIB days (2026-11-18 .. 11-20), two programs, three landing pages, two
// adnets, fifteen orders in every state the reports tell apart, visits, the conversion log and the Owner's ad spend. Inserted as the
// superuser (it bypasses grants, not triggers). Every figure the tests expect is worked out by hand in reports.int.test.ts from the
// table below, never read back from the code under test.
//
//   order  LP   day  source          campaign  status              amount  method         S2S MT (payout reported)      reversal
//   o1     LP1  D1   Alpha Ads       promo-a   paid                49000   qris           sent (5000)
//   o2     LP1  D1   Alpha Ads       promo-a   paid                49000   gopay          sent (5000)
//   o3     LP1  D1   Alpha Ads       promo-a   refunded            49000   qris           sent (5000)                   sent
//   o4     LP1  D2   Beta Media      promo-b   paid                49000   bank_transfer  sent (7500)
//   o5     LP1  D2   Beta Media      promo-b   refunded            49000   qris           sent (7500)                   none (Beta has no template)
//   o6     LP1  D2   Organic         -         paid                49000   credit_card    -
//   o7     LP1  D2   Organic (Alpha  -         paid                49000   cstore         -                             (no click id: no S2S)
//                    adnet, no click id)
//   o8     LP1  D3   Alpha Ads       promo-a   pending (MO only)   49000   -              -
//   o9     LP1  D3   Alpha Ads       promo-a   expired (MO only)   49000   -              -
//   o10    LP1  D3   Organic         -         snap_create_failed  49000   -              -                             (no MO)
//   o11    LP1  D3   Alpha Ads       promo-a   review              49000   gopay          sent (5000)
//   o12    LP2  D3   Alpha Ads       promo-c   paid                49000   qris           pending (in flight)
//   o13    LP3  D2   Beta Media      promo-b   paid                99000   qris           sent (7500)
//   o14    LP3  D3   Beta Media      promo-b   paid                99000   gopay          sent (7500)
//   o15    LP3  D3   Beta Media      promo-b   paid                99000   bank_transfer  failed (7500, not counted)
//
// (The buyers of o1..o4 are named like formulas, FORMULA_BUYERS below, for the CSV tests.)
// The conversion log also holds: MO rows (s2s) of o1 (sent), o2 (failed), o8 (pending), o4 and o13 (sent); a failed Meta MT of o14 marked
// order_not_paid; a failed TikTok MT of o14 marked "no MT template"; a failed reversal of o5 marked "skipped".
//
// Gateway fees (midtrans.fees): other_qris 0 + 0.70 %, gopay 0 + 2.00 %, bca_va 4000, bni_va 4400, credit_card 2000 + 2.90 %.
// A qris payment reads BOTH other_qris and gopay and takes the dearer (a desktop GoPay tile arrives as qris, US-005): 2.00 % here.
import { randomBytes } from "node:crypto";
import { EFFECT_CANCELLED, NO_MT_TEMPLATE, REVERSAL_SKIPPED } from "@ebooktrivia/core";
import { root, suffix } from "./support.ts";

export const D1 = "2026-11-18";
export const D2 = "2026-11-19";
export const D3 = "2026-11-20";
/** 16:00 WIB on D3: "today" of the dashboard. */
export const NOW = new Date("2026-11-20T09:00:00Z");

const at = (day: string, hourWib: number): Date => new Date(Date.parse(`${day}T00:00:00Z`) + (hourWib - 7) * 3_600_000);
type Id = { id: string };
const one = async <T>(rows: Promise<readonly T[]>): Promise<T> => {
  const [row] = await rows;
  if (row === undefined) throw new Error("no row");
  return row;
};

export interface Dataset {
  readonly p1: string;
  readonly p2: string;
  readonly lp1: string;
  readonly lp2: string;
  readonly lp3: string;
  readonly alpha: string;
  readonly beta: string;
  /** order name (o1 .. o15) -> order id. */
  readonly orders: Readonly<Record<string, string>>;
  /** order name -> its S2S MT conversion event id. */
  readonly mt: Readonly<Record<string, string>>;
}

interface Spec {
  readonly name: string;
  readonly lp: "lp1" | "lp2" | "lp3";
  readonly day: string;
  readonly hour: number;
  readonly adnet: "alpha" | "beta" | null;
  readonly clickid: string | null;
  readonly utm: string | null;
  readonly status: string;
  readonly amount: number;
  readonly method: string | null;
  readonly mo: boolean;
  readonly mt?: { readonly status: string; readonly counted: boolean; readonly payout: number };
  readonly reversal?: string;
  readonly buyer?: string;
}

const SPECS: readonly Spec[] = [
  { name: "o1", lp: "lp1", day: D1, hour: 10, adnet: "alpha", clickid: "c1", utm: "Promo-A", status: "paid", amount: 49000, method: "qris", mo: true, mt: { status: "sent", counted: true, payout: 5000 } },
  { name: "o2", lp: "lp1", day: D1, hour: 11, adnet: "alpha", clickid: "c2", utm: "promo-a", status: "paid", amount: 49000, method: "gopay", mo: true, mt: { status: "sent", counted: true, payout: 5000 } },
  { name: "o3", lp: "lp1", day: D1, hour: 12, adnet: "alpha", clickid: "c3", utm: "promo-a", status: "refunded", amount: 49000, method: "qris", mo: true, mt: { status: "sent", counted: true, payout: 5000 }, reversal: "sent" },
  { name: "o4", lp: "lp1", day: D2, hour: 9, adnet: "beta", clickid: "c4", utm: "promo-b", status: "paid", amount: 49000, method: "bank_transfer", mo: true, mt: { status: "sent", counted: true, payout: 7500 } },
  { name: "o5", lp: "lp1", day: D2, hour: 10, adnet: "beta", clickid: "c5", utm: "promo-b", status: "refunded", amount: 49000, method: "qris", mo: true, mt: { status: "sent", counted: true, payout: 7500 } },
  { name: "o6", lp: "lp1", day: D2, hour: 11, adnet: null, clickid: null, utm: null, status: "paid", amount: 49000, method: "credit_card", mo: true },
  { name: "o7", lp: "lp1", day: D2, hour: 12, adnet: "alpha", clickid: null, utm: null, status: "paid", amount: 49000, method: "cstore", mo: true },
  { name: "o8", lp: "lp1", day: D3, hour: 8, adnet: "alpha", clickid: "c8", utm: "promo-a", status: "pending", amount: 49000, method: null, mo: true },
  { name: "o9", lp: "lp1", day: D3, hour: 9, adnet: "alpha", clickid: "c9", utm: "promo-a", status: "expired", amount: 49000, method: null, mo: true },
  { name: "o10", lp: "lp1", day: D3, hour: 10, adnet: null, clickid: null, utm: null, status: "snap_create_failed", amount: 49000, method: null, mo: false },
  { name: "o11", lp: "lp1", day: D3, hour: 11, adnet: "alpha", clickid: "c11", utm: "promo-a", status: "review", amount: 49000, method: "gopay", mo: true, mt: { status: "sent", counted: true, payout: 5000 } },
  { name: "o12", lp: "lp2", day: D3, hour: 12, adnet: "alpha", clickid: "c12", utm: "promo-c", status: "paid", amount: 49000, method: "qris", mo: true, mt: { status: "pending", counted: false, payout: 5000 } },
  { name: "o13", lp: "lp3", day: D2, hour: 13, adnet: "beta", clickid: "c13", utm: "promo-b", status: "paid", amount: 99000, method: "qris", mo: true, mt: { status: "sent", counted: true, payout: 7500 } },
  { name: "o14", lp: "lp3", day: D3, hour: 13, adnet: "beta", clickid: "c14", utm: "promo-b", status: "paid", amount: 99000, method: "gopay", mo: true, mt: { status: "sent", counted: true, payout: 7500 } },
  { name: "o15", lp: "lp3", day: D3, hour: 14, adnet: "beta", clickid: "c15", utm: "promo-b", status: "paid", amount: 99000, method: "bank_transfer", mo: true, mt: { status: "failed", counted: false, payout: 7500 } },
];

/** The buyers of o1..o4 are named like spreadsheet formulas (request.ts accepts them in a name): the CSV tests need them neutralized. */
export const FORMULA_BUYERS: Readonly<Record<string, string>> = { o1: "=cmd|' /C calc'!A0", o2: "+1+1", o3: "-2+3", o4: "@SUM(A1)" };

/** Visits: [lp, day, adnet or null, click id or null, how many]. An adnet without a click id is Organic (AC-T8). */
const VISITS: readonly (readonly ["lp1" | "lp2" | "lp3", string, "alpha" | "beta" | null, string | null, number])[] = [
  ["lp1", D1, "alpha", "x", 10],
  ["lp1", D1, null, null, 5],
  ["lp1", D2, "beta", "x", 4],
  ["lp1", D2, null, null, 3],
  ["lp1", D2, "alpha", null, 2],
  ["lp3", D2, "beta", "x", 2],
  ["lp1", D3, "alpha", "x", 6],
  ["lp2", D3, "alpha", "x", 2],
  ["lp3", D3, "beta", "x", 1],
];

export async function seedDataset(): Promise<Dataset> {
  await root`
    INSERT INTO app_settings (key, value) VALUES ('midtrans.fees', ${root.json({
      other_qris: { flat_idr: 0, percent_bps: 70 },
      gopay: { flat_idr: 0, percent_bps: 200 },
      bca_va: { flat_idr: 4000, percent_bps: 0 },
      bni_va: { flat_idr: 4400, percent_bps: 0 },
      credit_card: { flat_idr: 2000, percent_bps: 290 },
    })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const tag = suffix();
  const product = async (price: number) => one(root<Id[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, ${price}) RETURNING id`);
  const program = async (productId: string, name: string) =>
    one(root<Id[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${productId}, ${`${name.toLowerCase().replace(/\W+/g, "-")}-${tag}`}, ${name}, 'published', now() - interval '60 days', now() + interval '60 days', 30) RETURNING id`);
  const lp = async (programId: string, name: string) =>
    one(root<Id[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, ${name}, ${programId}) RETURNING id`);
  const adnet = async (name: string, payout: number, reversal: boolean) =>
    one(root<Id[]>`
      INSERT INTO adnets (slug, name, clickid_param, payout_idr, mt_url_template, reversal_url_template)
      VALUES (${`${name.toLowerCase().replace(/\W+/g, "-")}-${tag}`}, ${name}, 'cid', ${payout}, 'https://postback.example.test/mt?c={clickid}', ${reversal ? "https://postback.example.test/rev?c={clickid}" : null}) RETURNING id`);

  const p1 = (await program((await product(49000)).id, `Alpha ${tag}`)).id;
  const p2 = (await program((await product(99000)).id, `Beta ${tag}`)).id;
  const ids = { lp1: (await lp(p1, `LP One ${tag}`)).id, lp2: (await lp(p1, `LP Two ${tag}`)).id, lp3: (await lp(p2, `LP Three ${tag}`)).id };
  const adnets = { alpha: (await adnet(`Alpha Ads ${tag}`, 5000, true)).id, beta: (await adnet(`Beta Media ${tag}`, 7500, false)).id };
  const programs = { lp1: p1, lp2: p1, lp3: p2 };
  const products = { [p1]: (await one(root<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${p1}`)).product_id, [p2]: (await one(root<{ product_id: string }[]>`SELECT product_id FROM programs WHERE id = ${p2}`)).product_id };

  const orders: Record<string, string> = {};
  const mt: Record<string, string> = {};
  for (const s of SPECS) {
    const programId = programs[s.lp];
    const productId = products[programId] ?? "";
    const created = at(s.day, s.hour);
    const everPaid = ["paid", "refunded", "review"].includes(s.status);
    const order = await one(root<Id[]>`
      INSERT INTO orders ${root({
        public_id: `${suffix()}${suffix()}${suffix()}`,
        order_code: `${suffix()}${suffix()}`.toUpperCase(),
        landing_page_id: ids[s.lp],
        program_id: programId,
        product_id: productId,
        buyer_name: s.buyer ?? FORMULA_BUYERS[s.name] ?? `Pembeli ${s.name}`,
        buyer_phone: `+62812${String(10_000_000 + Number(s.name.slice(1)) * 7919).slice(0, 8)}`,
        buyer_email: `${s.name}@example.invalid`,
        buyer_key: randomBytes(32),
        amount_idr: s.amount,
        status: everPaid ? "paid" : s.status,
        expires_at: new Date(created.getTime() + 3_600_000),
        created_at: created,
        paid_at: everPaid ? created : null,
        adnet_id: s.adnet === null ? null : adnets[s.adnet],
        clickid: s.clickid,
        utm_campaign: s.utm,
        mo_outbox_id: s.mo && !everPaid ? crypto.randomUUID() : null,
      })} RETURNING id`);
    orders[s.name] = order.id;
    if (s.method !== null) {
      await root`
        INSERT INTO payments (order_id, gateway_txn_id, payment_type, transaction_status, gross_amount_idr, settled_at)
        VALUES (${order.id}, ${`tx-${suffix()}${suffix()}`}, ${s.method}, 'settlement', ${s.amount}, ${created})`;
    }
    if (s.mt !== undefined && s.adnet !== null) {
      mt[s.name] = (
        await one(root<Id[]>`
          INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, maybe_counted, reported_payout_idr, attempts, sent_at, failed_at, last_error, last_http_status, created_at)
          VALUES (${order.id}, 's2s', 'mt', ${s.mt.status}, ${adnets[s.adnet]}, ${order.id}, gen_random_uuid(), ${s.amount}, ${s.mt.counted}, ${s.mt.payout}, ${s.mt.status === "pending" ? 0 : 1},
                  ${s.mt.status === "sent" ? created : null}, ${s.mt.status === "failed" ? created : null}, ${s.mt.status === "failed" ? "HTTP 500" : null}, ${s.mt.status === "failed" ? 500 : s.mt.status === "sent" ? 200 : null}, ${created})
          RETURNING id`)
      ).id;
    }
    if (s.reversal !== undefined && s.adnet !== null) {
      await root`
        INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, attempts, sent_at, created_at)
        VALUES (${order.id}, 's2s', 'reversal', ${s.reversal}, ${adnets[s.adnet]}, ${order.id}, gen_random_uuid(), ${s.amount}, 1, ${created}, ${created})`;
    }
    if (everPaid && s.status !== "paid") await root`UPDATE orders SET status = ${s.status} WHERE id = ${order.id}`;
  }

  // The rest of the conversion log: MO rows of some orders, and the rows that carry a marker (core EFFECT_CANCELLED, REVERSAL_SKIPPED, NO_MT_TEMPLATE).
  const extra = async (name: string, sink: string, kind: string, status: string, adnet: "alpha" | "beta" | null, lastError: string | null, http: number | null) => {
    const spec = SPECS.find((x) => x.name === name);
    if (spec === undefined) throw new Error(`no order ${name}`);
    const created = at(spec.day, spec.hour);
    await root`
      INSERT INTO conversion_events (order_id, sink, kind, status, adnet_id, txid, event_id, value_idr, attempts, sent_at, failed_at, last_error, last_http_status, created_at)
      VALUES (${orders[name] ?? ""}, ${sink}, ${kind}, ${status}, ${adnet === null ? null : adnets[adnet]}, ${orders[name] ?? ""}, gen_random_uuid(), ${spec.amount}, ${status === "pending" ? 0 : 1},
              ${status === "sent" ? created : null}, ${status === "failed" ? created : null}, ${lastError}, ${http}, ${created})`;
  };
  await extra("o1", "s2s", "mo", "sent", "alpha", null, 200);
  await extra("o2", "s2s", "mo", "failed", "alpha", "HTTP 500", 500);
  await extra("o8", "s2s", "mo", "pending", "alpha", null, null);
  await extra("o4", "s2s", "mo", "sent", "beta", null, 200);
  await extra("o13", "s2s", "mo", "sent", "beta", null, 200);
  await extra("o14", "meta", "mt", "failed", null, EFFECT_CANCELLED, null);
  await extra("o14", "tiktok", "mt", "failed", null, NO_MT_TEMPLATE, null);
  await extra("o5", "s2s", "reversal", "failed", "beta", REVERSAL_SKIPPED, null);

  for (const [lpName, day, adnetName, clickid, count] of VISITS) {
    await root`
      INSERT INTO visits (landing_page_id, occurred_at, adnet_id, clickid)
      SELECT ${ids[lpName]}, ${at(day, 15)}, ${adnetName === null ? null : adnets[adnetName]}, ${clickid} FROM generate_series(1, ${count}::int)`;
  }

  const spend = [
    { date: D1, platform: "meta", lp: ids.lp1, adnet: adnets.alpha, utm: "Promo-A", amount: 12_000 },
    { date: D2, platform: "tiktok", lp: null, adnet: adnets.beta, utm: "Promo-B ", amount: 9_000 },
    { date: D3, platform: "google", lp: ids.lp3, adnet: null, utm: null, amount: 5_000 },
    { date: D3, platform: "other", lp: null, adnet: null, utm: null, amount: 1_000 },
  ];
  for (const s of spend) {
    await root`INSERT INTO ad_spend (spend_date, platform, landing_page_id, adnet_id, utm_campaign, amount_idr) VALUES (${s.date}, ${s.platform}, ${s.lp}, ${s.adnet}, ${s.utm}, ${s.amount})`;
  }
  return { p1, p2, lp1: ids.lp1, lp2: ids.lp2, lp3: ids.lp3, alpha: adnets.alpha, beta: adnets.beta, orders, mt };
}

/** Runs the refresh as the superuser at `now` (the worker's own path is tested in apps/worker). */
export async function refreshRollups(now: Date = NOW): Promise<void> {
  await root`SELECT public.refresh_report_rollups(${now})`;
}
