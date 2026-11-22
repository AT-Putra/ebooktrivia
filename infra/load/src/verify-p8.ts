// The post-run proof of AC-P8: "50 orders/min sustained for 10 min with no lost orders, duplicate MTs, or
// delivery-job loss", as the RECONCILIATION IDENTITY over the orders of the load-test landing page. It reads the
// database only (a read-only login is enough) and exits 1 when any identity breaks.
//
//   node infra/load/src/verify-p8.ts --lp-key lp_... [--expected-orders N | --k6-summary orders-50pm-summary.json]
//        [--run-file orders-50pm-run.json | --since <ISO time>] [--wait-seconds 300] [--require-email-sent] [--out report.json]
//   env: LOAD_DATABASE_URL (a read-only login is enough; no guard is needed for reading)
//
// ONLY THE ORDERS OF THE RUN COUNT: the landing page may hold the orders of an earlier trial (the 5-order settlement trial of the
// README). run.sh writes the run's start time to orders-50pm-run.json; --run-file (or --since) restricts every identity to the
// orders created from then on, so the trial's orders can neither break identity 1 nor hide a loss.
//
// The identities (O = the orders of the run; PAID = those with status paid):
//   1. no lost order        k6's count of orders created (the checkout's HTTP 200 with deduped:false, counter orders_created)  ==  |O with a Snap redirect URL|
//                            (and no pending order has been without a URL for more than 2 minutes)
//   2. MO exactly once      every order with a URL has its MO outbox row (orders.mo_outbox_id); every attributed one
//                            (adnet + click id) has exactly one s2s MO conversion row
//   3. no lost delivery     every PAID order has its e-mail and its WhatsApp delivery row, exactly one each (unique key),
//                            and its order.paid outbox row; no delivery is stuck in `sending` past its lease
//   4. MT per adnet         for every adnet: the s2s MT rows (sent + failed) == the PAID orders with a click id
//                            of that adnet, and no MT row exists for an unpaid order (AC-T4)
//   5. no duplicate MT      no (order, sink, kind) twice (the unique key), and no MT row whose postback was answered 2xx
//                            more than once (conversion_attempts)
//   6. drained              after the wait, nothing of the run is still pending or sending: MO and MT rows are sent or
//                            failed, the e-mail deliveries are terminal, the outbox rows of the run are processed
//                            (WhatsApp deliveries may be pending: they wait for their delay or their session)
//   7. no stranger messaged no WhatsApp delivery of the run is `sent` (WhatsApp is off for the run; the buyers' numbers are synthetic)
//   --require-email-sent also demands every PAID order's e-mail to be `sent` (not merely terminal).
//   While WhatsApp is off, only the e-mail jobs are proven processed: the WhatsApp rows are checked to EXIST (identity 3), not to be worked.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { positiveNumber } from "./args.ts";

type Sql = postgres.Sql;

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface Report {
  readonly ok: boolean;
  readonly lp_key: string;
  readonly generated_at: string;
  readonly numbers: Readonly<Record<string, number | string>>;
  readonly per_adnet: readonly { readonly adnet: string; readonly paid_with_clickid: number; readonly mt_sent: number; readonly mt_failed: number; readonly mt_open: number }[];
  readonly checks: readonly Check[];
}

export interface VerifyOptions {
  readonly lpKey: string;
  readonly expectedOrders?: number | undefined;
  readonly since?: Date | undefined;
  readonly waitSeconds?: number | undefined;
  readonly requireEmailSent?: boolean | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
}

const num = (rows: readonly Record<string, unknown>[], key: string): number => Number(rows[0]?.[key] ?? 0);

/** What of the run is still waiting for the worker: MO / MT rows, e-mail deliveries and outbox rows not terminal. */
async function openWork(sql: Sql, lpId: string, since: Date): Promise<number> {
  const rows = await sql<{ open: number }[]>`
    WITH o AS (SELECT id, mo_outbox_id FROM public.orders WHERE landing_page_id = ${lpId} AND created_at >= ${since})
    SELECT (
      (SELECT count(*) FROM public.conversion_events c JOIN o ON o.id = c.order_id WHERE c.status IN ('pending', 'sending'))
      + (SELECT count(*) FROM public.deliveries d JOIN o ON o.id = d.order_id WHERE d.channel = 'email' AND d.status IN ('pending', 'sending'))
      + (SELECT count(*) FROM public.outbox x WHERE x.processed_at IS NULL
           AND (x.id IN (SELECT mo_outbox_id FROM o WHERE mo_outbox_id IS NOT NULL)
                OR x.dedupe_key IN (SELECT 'order.paid:' || id::text FROM o)))
    )::int AS open`;
  return num(rows, "open");
}

export async function verifyAcP8(sql: Sql, options: VerifyOptions): Promise<Report> {
  const [lp] = await sql<{ id: string }[]>`SELECT id FROM public.landing_pages WHERE lp_key = ${options.lpKey}`;
  if (lp === undefined) throw new Error(`no landing page ${options.lpKey}`);
  const since = options.since ?? new Date(0);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.waitSeconds ?? 0) * 1000;
  while ((await openWork(sql, lp.id, since)) > 0 && Date.now() < deadline) await sleep(5000);

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const numbers: Record<string, number | string> = {};

  const [orders] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE snap_redirect_url IS NOT NULL)::int AS with_url,
           count(*) FILTER (WHERE status = 'paid')::int AS paid,
           count(*) FILTER (WHERE status = 'pending' AND snap_redirect_url IS NULL AND created_at < now() - interval '2 minutes')::int AS stuck_no_url,
           count(*) FILTER (WHERE snap_redirect_url IS NOT NULL AND mo_outbox_id IS NULL)::int AS url_without_mo,
           count(*) FILTER (WHERE snap_redirect_url IS NOT NULL AND adnet_id IS NOT NULL AND coalesce(clickid, '') <> '')::int AS attributed
      FROM public.orders WHERE landing_page_id = ${lp.id} AND created_at >= ${since}`;
  const o = orders ?? {};
  Object.assign(numbers, { orders_total: o["total"] ?? 0, orders_with_redirect_url: o["with_url"] ?? 0, orders_paid: o["paid"] ?? 0, orders_attributed: o["attributed"] ?? 0 });

  // 1. no lost order
  if (options.expectedOrders === undefined) add("1 no lost order", true, `not compared with k6 (pass --expected-orders or --k6-summary); ${String(o["with_url"])} orders have a Snap URL`);
  else add("1 no lost order", options.expectedOrders === o["with_url"], `k6 made ${String(options.expectedOrders)} new orders (HTTP 200, deduped false); the database has ${String(o["with_url"])} orders with a Snap URL`);
  add("1b no order stuck without a URL", o["stuck_no_url"] === 0, `${String(o["stuck_no_url"])} pending orders without a Snap URL for over 2 minutes`);

  // 2. MO exactly once
  add("2 every order with a URL has its MO outbox row", o["url_without_mo"] === 0, `${String(o["url_without_mo"])} orders with a URL and no mo_outbox_id`);
  const [mo] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS rows, count(DISTINCT c.order_id)::int AS orders
      FROM public.conversion_events c JOIN public.orders o ON o.id = c.order_id
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND c.kind = 'mo' AND c.sink = 's2s'`;
  add("2b exactly one s2s MO row per attributed order", mo?.["rows"] === o["attributed"] && mo?.["orders"] === o["attributed"], `${String(mo?.["rows"])} MO rows over ${String(mo?.["orders"])} orders, ${String(o["attributed"])} attributed orders`);

  // 3. no lost delivery job
  const [paid] = await sql<Record<string, number>[]>`
    SELECT count(*) FILTER (WHERE e.n = 1)::int AS email_rows, count(*) FILTER (WHERE w.n = 1)::int AS wa_rows,
           count(*) FILTER (WHERE x.n = 1)::int AS outbox_rows, count(*)::int AS paid
      FROM public.orders o
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM public.deliveries d WHERE d.order_id = o.id AND d.channel = 'email') e ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM public.deliveries d WHERE d.order_id = o.id AND d.channel = 'whatsapp') w ON true
      LEFT JOIN LATERAL (SELECT count(*) AS n FROM public.outbox x WHERE x.dedupe_key = 'order.paid:' || o.id::text) x ON true
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND o.status = 'paid'`;
  add("3 every PAID order has its e-mail delivery row", paid?.["email_rows"] === paid?.["paid"], `${String(paid?.["email_rows"])} of ${String(paid?.["paid"])} PAID orders`);
  add("3b every PAID order has its WhatsApp delivery row", paid?.["wa_rows"] === paid?.["paid"], `${String(paid?.["wa_rows"])} of ${String(paid?.["paid"])} PAID orders`);
  add("3c every PAID order has its order.paid outbox row", paid?.["outbox_rows"] === paid?.["paid"], `${String(paid?.["outbox_rows"])} of ${String(paid?.["paid"])} PAID orders`);
  const [stuck] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS n FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND d.status = 'sending' AND d.lease_until < now() - interval '5 minutes'`;
  add("3d no delivery stuck in sending", stuck?.["n"] === 0, `${String(stuck?.["n"])} deliveries in sending with a lease expired for over 5 minutes`);

  // 4. MT per adnet, 5. no duplicate MT
  const perAdnet = await sql<{ adnet: string; paid_with_clickid: number; mt_sent: number; mt_failed: number; mt_open: number }[]>`
    SELECT a.slug AS adnet,
           (SELECT count(*)::int FROM public.orders o WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND o.status = 'paid' AND o.adnet_id = a.id AND coalesce(o.clickid, '') <> '') AS paid_with_clickid,
           count(*) FILTER (WHERE c.status = 'sent')::int AS mt_sent,
           count(*) FILTER (WHERE c.status = 'failed')::int AS mt_failed,
           count(*) FILTER (WHERE c.status IN ('pending', 'sending'))::int AS mt_open
      FROM public.adnets a
      JOIN public.landing_page_adnets l ON l.adnet_id = a.id AND l.landing_page_id = ${lp.id}
      LEFT JOIN public.conversion_events c ON c.adnet_id = a.id AND c.kind = 'mt' AND c.sink = 's2s'
           AND c.order_id IN (SELECT id FROM public.orders WHERE landing_page_id = ${lp.id} AND created_at >= ${since})
     GROUP BY a.id, a.slug ORDER BY a.slug`;
  for (const a of perAdnet) {
    add(`4 MT (sent + failed) = PAID orders with a click id, adnet ${a.adnet}`, a.mt_sent + a.mt_failed === a.paid_with_clickid, `${String(a.mt_sent)} sent + ${String(a.mt_failed)} failed vs ${String(a.paid_with_clickid)} PAID with a click id (${String(a.mt_open)} still open)`);
  }
  if (perAdnet.length === 0) add("4 MT per adnet", false, "the landing page has no adnet");
  const [unpaidMt] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS n FROM public.conversion_events c JOIN public.orders o ON o.id = c.order_id
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND c.kind = 'mt' AND o.status <> 'paid' AND c.status <> 'failed'`;
  add("4b no live MT row for an unpaid order (AC-T4)", unpaidMt?.["n"] === 0, `${String(unpaidMt?.["n"])} such rows`);
  const [dupes] = await sql<Record<string, number>[]>`
    SELECT (SELECT count(*)::int FROM (SELECT c.order_id, c.sink, c.kind FROM public.conversion_events c JOIN public.orders o ON o.id = c.order_id
                                        WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} GROUP BY 1, 2, 3 HAVING count(*) > 1) d) AS duplicate_rows,
           (SELECT count(*)::int FROM (SELECT c.id FROM public.conversion_events c JOIN public.orders o ON o.id = c.order_id
                                        JOIN public.conversion_attempts t ON t.conversion_event_id = c.id
                                       WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND c.kind = 'mt' AND t.http_status BETWEEN 200 AND 299
                                       GROUP BY c.id HAVING count(*) > 1) d) AS fired_twice`;
  add("5 no duplicate MT row", dupes?.["duplicate_rows"] === 0, `${String(dupes?.["duplicate_rows"])} (order, sink, kind) keys twice`);
  add("5b no MT postback answered 2xx twice", dupes?.["fired_twice"] === 0, `${String(dupes?.["fired_twice"])} MT rows with more than one 2xx attempt`);

  // 6. drained
  const open = await openWork(sql, lp.id, since);
  add("6 drained: nothing of the run is pending or sending", open === 0, `${String(open)} conversion rows, e-mail deliveries or outbox rows still open`);
  const [emailStates] = await sql<Record<string, number>[]>`
    SELECT count(*) FILTER (WHERE d.status = 'sent')::int AS sent, count(*) FILTER (WHERE d.status <> 'sent')::int AS not_sent
      FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND o.status = 'paid' AND d.channel = 'email'`;
  numbers["email_sent"] = emailStates?.["sent"] ?? 0;
  numbers["email_not_sent"] = emailStates?.["not_sent"] ?? 0;
  if (options.requireEmailSent === true) add("6b every PAID order's e-mail is sent", emailStates?.["not_sent"] === 0, `${String(emailStates?.["sent"])} sent, ${String(emailStates?.["not_sent"])} not`);

  // 7. no stranger messaged: WhatsApp is off for the run, and the buyers' numbers are synthetic
  const [waSent] = await sql<Record<string, number>[]>`
    SELECT count(*)::int AS n FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id
     WHERE o.landing_page_id = ${lp.id} AND o.created_at >= ${since} AND d.channel = 'whatsapp' AND d.status = 'sent'`;
  add("7 no WhatsApp delivery of the run was sent (a stranger must never be messaged)", waSent?.["n"] === 0, `${String(waSent?.["n"])} WhatsApp deliveries are sent`);

  return { ok: checks.every((c) => c.ok), lp_key: options.lpKey, generated_at: new Date().toISOString(), numbers, per_adnet: perAdnet, checks };
}

/** The start of a run from run.sh's orders-50pm-run.json (`{"started_at": "<ISO time>", ...}`); throws on anything else. */
export function parseRunFile(text: string): Date {
  const doc = JSON.parse(text) as { started_at?: unknown };
  const started = typeof doc.started_at === "string" ? new Date(doc.started_at) : undefined;
  if (started === undefined || Number.isNaN(started.getTime())) throw new Error("the run file has no valid started_at");
  return started;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "lp-key": { type: "string" },
      "expected-orders": { type: "string" },
      "k6-summary": { type: "string" },
      "run-file": { type: "string" },
      since: { type: "string" },
      "wait-seconds": { type: "string", default: "0" },
      "require-email-sent": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const databaseUrl = process.env["LOAD_DATABASE_URL"];
  if (values["lp-key"] === undefined || databaseUrl === undefined) throw new Error("usage: LOAD_DATABASE_URL=... verify-p8.ts --lp-key <lp_...> [--expected-orders N | --k6-summary file] [--run-file file | --since ISO] [--wait-seconds N] [--require-email-sent] [--out file]");
  let expected = values["expected-orders"] === undefined ? undefined : positiveNumber("expected-orders", values["expected-orders"], { integer: true });
  if (values["k6-summary"] !== undefined) {
    // k6 --summary-export (run.sh): the counter orders_created is a flat metric { count, rate }; the newer machine-readable shape nests it in `values`.
    const summary = JSON.parse(await readFile(values["k6-summary"], "utf8")) as { metrics?: Record<string, { values?: { count?: number }; count?: number }> };
    const metric = summary.metrics?.["orders_created"];
    expected = metric?.values?.count ?? metric?.count;
    if (expected === undefined) throw new Error(`${values["k6-summary"]} has no orders_created counter`);
  }
  // The run's own orders only (README, procedure B): without a start time, a trial run's orders on the same landing page would be counted.
  const since = values.since !== undefined ? new Date(values.since) : values["run-file"] === undefined ? undefined : parseRunFile(await readFile(values["run-file"], "utf8"));
  if (since !== undefined && Number.isNaN(since.getTime())) throw new Error("--since is not a valid time");
  if (expected !== undefined && since === undefined) throw new Error("comparing with k6's order count needs the run's start: pass --run-file orders-50pm-run.json (run.sh writes it) or --since <ISO time>");
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    const report = await verifyAcP8(sql, {
      lpKey: values["lp-key"],
      expectedOrders: expected,
      since,
      waitSeconds: Number(values["wait-seconds"]) === 0 ? 0 : positiveNumber("wait-seconds", values["wait-seconds"]),
      requireEmailSent: values["require-email-sent"],
    });
    for (const c of report.checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}\n`);
    process.stdout.write(`${report.ok ? "AC-P8 reconciliation identity HOLDS" : "AC-P8 reconciliation identity BROKEN"} (${JSON.stringify(report.numbers)})\n`);
    if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "verify-p8 failed"}\n`);
    process.exit(2);
  });
}
