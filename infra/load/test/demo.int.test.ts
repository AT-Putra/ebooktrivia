// `seed.ts demo` and its cleanup against the real schema and the REAL worker code: the demo buyers are PAID through order_paid_effects,
// nothing of them can be sent, queried at Midtrans or put in the Owner's review queue, and cleanup (as the superuser, the migrate login
// of the staging procedure) removes every row of the run. The database is the test's own (not the shared one of the other files), so the
// worker's reconciliation sees no foreign order and the WhatsApp settings can be set freely.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HttpFetch, type HttpResponse, MIDTRANS_ENDPOINTS } from "@ebooktrivia/adapters";
import { buyerKey, newOrderCode, newPublicId } from "@ebooktrivia/core";
import { createTestDatabase, type TestDatabase } from "@ebooktrivia/test-support/database";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertStuckReviews } from "../../../apps/worker/src/owner-decisions.ts";
import { createOwnerRequeryConsumer } from "../../../apps/worker/src/owner-requery.ts";
import { type MidtransSource, ORDER_PAID_TOPIC } from "../../../apps/worker/src/payments.ts";
import { reconcile } from "../../../apps/worker/src/reconciliation.ts";
import { relayOnce } from "../../../apps/worker/src/relay.ts";
import { createLogger } from "../../../apps/worker/src/log.ts";
import { expireOrders, failStaleSnapCreates, type SweepDeps, sweepDueConversions, sweepDueDeliveries, sweepOutbox } from "../../../apps/worker/src/sweepers.ts";
import { createDemoFixture, type DemoFixture } from "../src/demo-fixture.ts";
import { cleanupDemo, cleanupRun, DEMO_CANCELLED, seedDemo, seedDemoToFile } from "../src/demo-lib.ts";
import { parseDemoFile } from "../src/demo-plan.ts";
import { LoadGuardError } from "../src/guard.ts";
import { newRunId } from "../src/seed-lib.ts";

let db: TestDatabase;
let sql: postgres.Sql;
beforeAll(async () => {
  db = await createTestDatabase("ebt_demo", []);
  // The superuser URL: the login the staging procedure runs these tools with (the migrator, a superuser, README "Procedure on staging").
  sql = postgres(db.url, { max: 4, onnotice: () => undefined });
  // The WhatsApp-off state the guard demands: no WAHA session exists in a fresh database; the proactive delay is a day.
  await sql`UPDATE public.app_settings SET value = to_jsonb(${86_400}::int) WHERE key = 'delivery.wa_delay_seconds'`;
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await db.drop();
});

const PRICE = 49_000;
const SETS = 12;

type Fixture = DemoFixture;
const fixture = (options: { sets?: number; pixel?: boolean } = {}): Promise<Fixture> => createDemoFixture(sql, { ...options, sets: options.sets ?? SETS, priceIdr: PRICE });

/** An order of a REAL buyer (not a demo one) made PAID the way a settlement does, through order_paid_effects, with its deliveries and conversions left pending. */
async function realPaidOrder(f: Fixture, tag: string, attempt = false): Promise<{ id: string; publicId: string }> {
  const phone = `+62812${tag}`;
  const email = `asli-${tag}@example.net`;
  const publicId = newPublicId();
  const [order] = await sql<{ id: string }[]>`
    INSERT INTO public.orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
    SELECT ${publicId}, ${newOrderCode()}, ${f.landing_page_id}, p.id, p.product_id, 'Pembeli Asli', ${phone}, ${email}, ${buyerKey({ phone, name: "Pembeli Asli", email })}, ${PRICE}, 'pending', now() + interval '1 hour'
      FROM public.programs p WHERE p.id = ${f.program_id}
    RETURNING id`;
  const id = order?.id ?? "";
  if (attempt) await sql`INSERT INTO public.midtrans_attempts (order_id, n, midtrans_order_id, status) VALUES (${id}, 1, ${`${publicId}-1`}, 'created')`;
  await sql`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${id}`;
  await sql`SELECT public.order_paid_effects(${id}, now(), 180000)`;
  return { id, publicId };
}

const demoRows = (runId: string) => sql<{ id: string; player_id: string; paid_at: Date; created_at: Date; status: string }[]>`
  SELECT id, player_id, paid_at, created_at, status::text AS status FROM public.orders WHERE buyer_email ~ ${`^demo-${runId}-[0-9]{2,3}@example\\.com$`} ORDER BY paid_at`;
const count = async (query: Promise<postgres.RowList<{ n: number }[]>>): Promise<number> => (await query)[0]?.n ?? -1;
const seedOptions = (f: Fixture, over: Partial<Parameters<typeof seedDemo>[1]> = {}): Parameters<typeof seedDemo>[1] => ({ runId: newRunId(), programSlug: f.slug, buyers: 12, seed: 7, acceptProgramLock: true, ...over });

describe("seedDemo: the buyers are PAID through the same SQL a settlement runs", () => {
  it("makes N eligible players with PAID orders, payments, one login link each, and different numbers of open sets", async () => {
    const f = await fixture({ pixel: true });
    const options = seedOptions(f);
    const { file, summary } = await seedDemo(sql, options);
    expect(file).toMatchObject({ kind: "demo", run_id: options.runId, seed: 7, program_slug: f.slug, program_id: f.program_id });
    expect(file.buyers).toHaveLength(12);
    expect(file.set_ids).toHaveLength(SETS);
    expect(file.correct_option_ids).toHaveLength(SETS * 2);
    expect(summary).toMatchObject({ buyers: 12, program_was_locked: false });

    const orders = await demoRows(options.runId);
    expect(orders).toHaveLength(12);
    for (const o of orders) {
      expect(o.status).toBe("paid");
      expect(o.created_at.getTime()).toBeLessThanOrEqual(o.paid_at.getTime());
    }
    const [bounds] = await sql<{ start: Date; end: Date; locked: Date | null }[]>`SELECT sales_start_at AS start, sales_end_at AS "end", locked_at AS locked FROM public.programs WHERE id = ${f.program_id}`;
    for (const o of orders) {
      expect(o.paid_at.getTime()).toBeGreaterThanOrEqual(bounds?.start.getTime() ?? Number.POSITIVE_INFINITY);
      expect(o.paid_at.getTime()).toBeLessThan(Date.now() - 14 * 60_000);
    }
    // The first PAID order locked the program (the one lasting effect of a demo run on the program itself).
    expect(bounds?.locked).not.toBeNull();

    // The order: product price, the program's landing page, no adnet and no click id (so no postback can ever be due), organic.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE program_id = ${f.program_id} AND amount_idr = ${PRICE} AND landing_page_id = ${f.landing_page_id} AND adnet_id IS NULL AND clickid IS NULL`)).toBe(12);
    // The payments ledger: a settled transaction marked with the run, with a method the fee table knows.
    const payments = await sql<{ gateway_txn_id: string; payment_type: string; transaction_status: string; gross: string; same_instant: boolean }[]>`
      SELECT p.gateway_txn_id, p.payment_type, p.transaction_status, p.gross_amount_idr::text AS gross, p.settled_at = o.paid_at AS same_instant
        FROM public.payments p JOIN public.orders o ON o.id = p.order_id WHERE o.program_id = ${f.program_id}`;
    expect(payments).toHaveLength(12);
    for (const p of payments) {
      expect(p.gateway_txn_id).toMatch(new RegExp(`^demo-${options.runId}-\\d\\d$`));
      expect(["qris", "gopay", "bank_transfer", "shopeepay", "credit_card"]).toContain(p.payment_type);
      expect(["settlement", "capture"]).toContain(p.transaction_status);
      expect(p.gross).toBe(String(PRICE));
      expect(p.same_instant).toBe(true);
    }

    // order_paid_effects ran: each buyer is its own player, linked to the order, eligible, first_paid_at = the order's paid_at.
    const players = await sql<{ email: string; eligible: boolean; same: boolean; phone: string }[]>`
      SELECT pl.email, pp.eligible, pp.first_paid_at = o.paid_at AS same, pl.phone
        FROM public.orders o JOIN public.players pl ON pl.id = o.player_id JOIN public.player_programs pp ON pp.player_id = pl.id AND pp.program_id = o.program_id
       WHERE o.program_id = ${f.program_id}`;
    expect(players).toHaveLength(12);
    for (const p of players) {
      expect(p.email).toMatch(new RegExp(`^demo-${options.runId}-\\d\\d@example\\.com$`));
      expect(p.eligible).toBe(true);
      expect(p.same).toBe(true);
      expect(p.phone).toMatch(/^\+62812\d{8}$/);
    }
    // One live magic link per player, and the file's token is the one in the database.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.magic_links m JOIN public.orders o ON o.player_id = m.player_id WHERE o.program_id = ${f.program_id} AND m.consumed_at IS NULL`)).toBe(12);
    const first = file.buyers[0];
    const hash = createHash("sha256").update(first?.token ?? "", "utf8").digest();
    expect(await count(sql`SELECT count(*)::int AS n FROM public.magic_links WHERE token_hash = ${hash} AND consumed_at IS NULL`)).toBe(1);

    // The sets open for each buyer follow the schedule (core unlockedCount = the SQL copy): the early buyers have them all, the late ones few.
    const unlocked = await sql<{ n: number }[]>`
      SELECT public.play_unlocked_count(p.sales_end_at, p.grace_days, ${SETS}, pp.first_paid_at, now(), 0, 0) AS n
        FROM public.player_programs pp JOIN public.programs p ON p.id = pp.program_id WHERE pp.program_id = ${f.program_id} ORDER BY pp.first_paid_at`;
    expect(unlocked[0]?.n).toBe(SETS);
    expect(unlocked.at(-1)?.n ?? SETS).toBeLessThan(SETS);
    for (const buyer of file.buyers) expect(buyer.plan.sets_to_play).toBeLessThanOrEqual(unlocked[buyer.index - 1]?.n ?? 0);
    // The play flow accepts a buyer end to end: start the first set, serve and show its first question.
    const player = orders[0]?.player_id ?? "";
    const [attempt] = await sql<{ id: string }[]>`SELECT public.play_start_set(${player}, ${file.set_ids[0] ?? ""}) AS id`;
    await sql`SELECT public.play_current(${player}, ${attempt?.id ?? ""}, '203.0.113.7'::inet, NULL)`;
    const [shown] = await sql<{ r: { state: string; options: unknown[] } }[]>`SELECT public.play_current(${player}, ${attempt?.id ?? ""}, '203.0.113.7'::inet, NULL) AS r`;
    expect(shown?.r.state).toBe("question");
    expect(shown?.r.options).toHaveLength(4);

    await cleanupRun(sql, options.runId);
  });

  it("does not change the paid dates, the plan or the names when the same seed is used on the same program and moment", async () => {
    const f = await fixture();
    const now = new Date();
    const a = await seedDemo(sql, seedOptions(f, { buyers: 5, now }));
    await cleanupRun(sql, a.file.run_id);
    const b = await seedDemo(sql, seedOptions(f, { buyers: 5, now }));
    expect(b.file.buyers.map((x) => x.plan)).toEqual(a.file.buyers.map((x) => x.plan));
    expect(b.summary.paid_from).toEqual(a.summary.paid_from);
    expect(b.file.correct_option_ids).toEqual(a.file.correct_option_ids);
    await cleanupRun(sql, b.file.run_id);
  });
});

describe("seedDemo: the guards", () => {
  const countOrders = (f: Fixture) => count(sql`SELECT count(*)::int AS n FROM public.orders WHERE program_id = ${f.program_id}`);

  it("refuses while a WAHA session is active, or the proactive delay is short, and writes nothing", async () => {
    const f = await fixture();
    const [server] = await sql<{ id: string }[]>`INSERT INTO public.waha_servers (name, base_url, base_url_host) VALUES ('Uji', 'https://waha.example.test', 'waha.example.test') RETURNING id`;
    const [session] = await sql<{ id: string }[]>`INSERT INTO public.waha_sessions (server_id, session_name) VALUES (${server?.id ?? ""}, 'demo-uji') RETURNING id`;
    try {
      const refused = seedDemo(sql, seedOptions(f));
      await expect(refused).rejects.toBeInstanceOf(LoadGuardError);
      await expect(refused).rejects.toThrow(/WAHA session\(s\) are active/);
      expect(await countOrders(f)).toBe(0);
    } finally {
      await sql`UPDATE public.waha_sessions SET active = false WHERE id = ${session?.id ?? ""}`;
    }
    await sql`UPDATE public.app_settings SET value = to_jsonb(${180}::int) WHERE key = 'delivery.wa_delay_seconds'`;
    try {
      await expect(seedDemo(sql, seedOptions(f))).rejects.toThrow(/wa_delay_seconds/);
      expect(await countOrders(f)).toBe(0);
    } finally {
      await sql`UPDATE public.app_settings SET value = to_jsonb(${86_400}::int) WHERE key = 'delivery.wa_delay_seconds'`;
    }
  });

  it("refuses an unknown slug, a program that is not published, sales that have just begun, and (without --accept-program-lock) a program that is not locked yet", async () => {
    const f = await fixture();
    await expect(seedDemo(sql, seedOptions(f, { programSlug: "no-such-program" }))).rejects.toThrow(/no program with the slug/);
    await expect(seedDemo(sql, seedOptions(f, { acceptProgramLock: false }))).rejects.toThrow(/locks it for good/);
    await sql`UPDATE public.programs SET status = 'draft' WHERE id = ${f.program_id}`;
    await expect(seedDemo(sql, seedOptions(f))).rejects.toThrow(/draft, not published/);
    await sql`UPDATE public.programs SET status = 'published', sales_start_at = now() - interval '30 minutes' WHERE id = ${f.program_id}`;
    await expect(seedDemo(sql, seedOptions(f))).rejects.toThrow(/shorter than an hour/);
    expect(await countOrders(f)).toBe(0);
  });

  it("refuses a program without an active landing page, and one whose sets have no question", async () => {
    const f = await fixture();
    await sql`UPDATE public.landing_pages SET active = false WHERE id = ${f.landing_page_id}`;
    await expect(seedDemo(sql, seedOptions(f))).rejects.toThrow(/no active landing page/);
    const noSets = await fixture({ sets: 0 });
    await expect(seedDemo(sql, seedOptions(noSets))).rejects.toThrow(/no trivia set/);
    const hollow = await fixture({ sets: 2 });
    await sql`DELETE FROM public.question_options WHERE question_id IN (SELECT q.id FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id WHERE s.program_id = ${hollow.program_id} AND s.position = 2)`;
    await sql`DELETE FROM public.questions WHERE set_id IN (SELECT id FROM public.trivia_sets WHERE program_id = ${hollow.program_id} AND position = 2)`;
    await expect(seedDemo(sql, seedOptions(hollow))).rejects.toThrow(/1 set\(s\) of the program have no question/);
    expect(await countOrders(f)).toBe(0);
    expect(await countOrders(hollow)).toBe(0);
  });

  it("is atomic: when a later buyer cannot be made, no buyer, payment, player or link is left", async () => {
    const f = await fixture();
    // A trigger that refuses the third paid order of any program: the first two buyers are made inside the transaction, the third fails it.
    await sql.unsafe(`
      CREATE FUNCTION public.demo_test_block() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'paid' AND (SELECT count(*) FROM public.orders WHERE program_id = NEW.program_id AND status = 'paid') >= 2 THEN RAISE EXCEPTION 'demo_test_block'; END IF;
        RETURN NEW;
      END $$`);
    await sql.unsafe("CREATE TRIGGER demo_test_block BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.demo_test_block()");
    try {
      await expect(seedDemo(sql, seedOptions(f, { buyers: 3 }))).rejects.toThrow(/demo_test_block/);
    } finally {
      await sql.unsafe("DROP TRIGGER demo_test_block ON public.orders");
      await sql.unsafe("DROP FUNCTION public.demo_test_block()");
    }
    expect(await countOrders(f)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.payments p JOIN public.orders o ON o.id = p.order_id WHERE o.program_id = ${f.program_id}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.players WHERE email ~ '^demo-[0-9a-f]{8}-'`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.player_programs WHERE program_id = ${f.program_id}`)).toBe(0);
    // And the program was not locked by the rolled-back orders.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.programs WHERE id = ${f.program_id} AND locked_at IS NULL`)).toBe(1);
  });

  it("refuses a program whose grace period ends within 2 days (the worker writes the immutable snapshot by itself after it), and reports the grace end of one that fits", async () => {
    const f = await fixture();
    // Sales ended 29 days ago, 30 grace days: the grace period ends tomorrow.
    await sql`UPDATE public.programs SET sales_end_at = now() - interval '29 days' WHERE id = ${f.program_id}`;
    await expect(seedDemo(sql, seedOptions(f))).rejects.toThrow(/less than 2 days from now: after it the worker writes the results snapshot and the winners by itself/);
    expect(await countOrders(f)).toBe(0);
    // Sales end in 2 days, 30 grace days: it fits, and the seed says when to clean up by (sales end + grace days).
    await sql`UPDATE public.programs SET sales_end_at = now() + interval '2 days' WHERE id = ${f.program_id}`;
    const { file, summary } = await seedDemo(sql, seedOptions(f, { buyers: 2 }));
    const [bounds] = await sql<{ grace_end: Date }[]>`SELECT sales_end_at + make_interval(days => grace_days) AS grace_end FROM public.programs WHERE id = ${f.program_id}`;
    expect(summary.grace_end).toEqual(bounds?.grace_end);
    await cleanupRun(sql, file.run_id);
  });
});

describe("the output file (seedDemoToFile): the run never exists without its login links in the operator's hands", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "demo-int-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const leftovers = async (f: Fixture): Promise<number[]> => [
    await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE program_id = ${f.program_id}`),
    await count(sql`SELECT count(*)::int AS n FROM public.payments p JOIN public.orders o ON o.id = p.order_id WHERE o.program_id = ${f.program_id}`),
    await count(sql`SELECT count(*)::int AS n FROM public.player_programs WHERE program_id = ${f.program_id}`),
    await count(sql`SELECT count(*)::int AS n FROM public.magic_links m JOIN public.players p ON p.id = m.player_id WHERE p.email ~ '^demo-[0-9a-f]{8}-'`),
    await count(sql`SELECT count(*)::int AS n FROM public.programs WHERE id = ${f.program_id} AND locked_at IS NOT NULL`),
  ];

  it("rolls the whole run back when the file cannot be written: no order, payment, player, link, and no lock on the program", async () => {
    const f = await fixture();
    await expect(
      seedDemo(sql, {
        ...seedOptions(f),
        persist: () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(await leftovers(f)).toEqual([0, 0, 0, 0, 0]);
  });

  it("writes the file inside the transaction (0600, complete, its links the ones in the database) and prints nothing to lose", async () => {
    const f = await fixture();
    const out = join(dir, "ok.json");
    const options = seedOptions(f, { buyers: 4 });
    const { file } = await seedDemoToFile(sql, options, out);
    const written = parseDemoFile(await readFile(out, "utf8"));
    expect(written).toEqual(file);
    expect(written.run_id).toBe(options.runId);
    const hash = createHash("sha256").update(written.buyers[0]?.token ?? "", "utf8").digest();
    expect(await count(sql`SELECT count(*)::int AS n FROM public.magic_links WHERE token_hash = ${hash} AND consumed_at IS NULL`)).toBe(1);
    // No name, e-mail or phone number is in it.
    expect(await readFile(out, "utf8")).not.toMatch(/example\.com|\+62812/);
    if (process.platform !== "win32") expect((await stat(out)).mode & 0o777).toBe(0o600);
    await cleanupRun(sql, options.runId);
  });

  it("never overwrites an existing file, and removes the file it made when the seed is refused", async () => {
    const f = await fixture();
    const existing = join(dir, "existing.json");
    await writeFile(existing, "keep me");
    await expect(seedDemoToFile(sql, seedOptions(f), existing)).rejects.toThrow(/EEXIST/);
    expect(await readFile(existing, "utf8")).toBe("keep me");
    expect(await leftovers(f)).toEqual([0, 0, 0, 0, 0]);

    const refused = join(dir, "refused.json");
    await sql`UPDATE public.programs SET status = 'draft' WHERE id = ${f.program_id}`;
    await expect(seedDemoToFile(sql, seedOptions(f), refused)).rejects.toThrow(/not published/);
    await expect(stat(refused)).rejects.toThrow(/ENOENT/);
  });
});

describe("what a demo buyer can trigger: nothing is sent, nothing is queried at Midtrans, nothing is in the review queue", () => {
  it("leaves every delivery cancelled, no conversion row and no unprocessed order.paid row, and the worker's own sweepers enqueue none of it", async () => {
    // The landing page has a Meta pixel (a PAID order would get a conversion row) and an adnet (the orders carry no click id).
    const f = await fixture({ pixel: true });
    const control = await fixture({ sets: 0, pixel: true });
    const options = seedOptions(f);
    const { summary } = await seedDemo(sql, options);
    expect(summary).toMatchObject({ deliveries_cancelled: 24, conversions_removed: 12 });
    const orders = await demoRows(options.runId);
    const ids = orders.map((o) => o.id);

    const deliveries = await sql<{ status: string; last_error: string | null }[]>`SELECT status::text AS status, last_error FROM public.deliveries WHERE order_id = ANY(${ids}::uuid[])`;
    expect(deliveries).toHaveLength(24);
    for (const d of deliveries) expect(d).toEqual({ status: "cancelled", last_error: DEMO_CANCELLED });
    expect(await count(sql`SELECT count(*)::int AS n FROM public.conversion_events WHERE order_id = ANY(${ids}::uuid[])`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.outbox WHERE dedupe_key = ANY(${ids.map((id) => `order.paid:${id}`)}::text[]) AND processed_at IS NOT NULL AND relayed_at IS NOT NULL`)).toBe(12);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.outbox WHERE processed_at IS NULL AND payload ->> 'order_id' = ANY(${ids}::text[])`)).toBe(0);

    // A control: an order of a real buyer, paid the same way and left as the worker would find it, IS picked up by the same sweepers (so the check can fail).
    const real = await realPaidOrder(control, "10000001");
    const jobs: { queue: string; id: string }[] = [];
    const queue = (name: string): NonNullable<SweepDeps["deliveryQueue"]> =>
      ({
        name,
        getJobState: () => Promise.resolve("unknown"),
        remove: () => Promise.resolve(1),
        addBulk: (list: { data: { id: string } }[]) => {
          for (const job of list) jobs.push({ queue: name, id: job.data.id });
          return Promise.resolve([]);
        },
      }) as unknown as NonNullable<SweepDeps["deliveryQueue"]>;
    const log = createLogger({ level: "silent", role: "worker" });
    // Make everything of the control due now (its WhatsApp row waits a day by the delay setting; its e-mail row and its Meta MT row are due).
    await sql`UPDATE public.deliveries SET not_before = now() - interval '1 minute' WHERE order_id = ${real.id}`;
    const deliveryQueue = queue("delivery");
    const conversionQueue = queue("conversion");
    await sweepDueDeliveries({ sql, log, deliveryQueue });
    await sweepDueConversions({ sql, log, conversionQueue });
    await relayOnce({ sql, queues: new Map([[ORDER_PAID_TOPIC, queue(ORDER_PAID_TOPIC)]]), batchSize: 100, failpoint: () => undefined });
    await sweepOutbox({ sql, log, outboxQueues: new Map([[ORDER_PAID_TOPIC, queue(ORDER_PAID_TOPIC)]]), outboxStaleMs: 0 });
    const [controlRows] = await sql<{ deliveries: string[]; conversions: string[]; outbox: string[] }[]>`
      SELECT (SELECT coalesce(array_agg(id::text), '{}') FROM public.deliveries WHERE order_id = ${real.id}) AS deliveries,
             (SELECT coalesce(array_agg(id::text), '{}') FROM public.conversion_events WHERE order_id = ${real.id}) AS conversions,
             (SELECT coalesce(array_agg(id::text), '{}') FROM public.outbox WHERE dedupe_key = ${`order.paid:${real.id}`}) AS outbox`;
    const queued = new Set(jobs.map((j) => j.id));
    expect(controlRows?.deliveries.some((id) => queued.has(id))).toBe(true);
    expect(controlRows?.conversions.some((id) => queued.has(id))).toBe(true);
    expect(controlRows?.outbox.some((id) => queued.has(id))).toBe(true);
    // And not one job names a demo order's delivery, conversion or outbox row.
    const demoSides = await sql<{ id: string }[]>`
      SELECT id::text FROM public.deliveries WHERE order_id = ANY(${ids}::uuid[])
      UNION ALL SELECT id::text FROM public.conversion_events WHERE order_id = ANY(${ids}::uuid[])
      UNION ALL SELECT id::text FROM public.outbox WHERE dedupe_key = ANY(${ids.map((id) => `order.paid:${id}`)}::text[])`;
    expect(demoSides).toHaveLength(24 + 12);
    for (const { id } of demoSides) expect(queued.has(id), id).toBe(false);

    await cleanupRun(sql, options.runId);
  });

  it("is never re-queried or reconciled at Midtrans, never expired, never put in review: the paths that look at orders skip it", async () => {
    const f = await fixture();
    const control = await fixture({ sets: 0 });
    const options = seedOptions(f, { buyers: 8 });
    await seedDemo(sql, options);
    const ids = (await demoRows(options.runId)).map((o) => o.id);
    // A control order WITH a Midtrans attempt, which the nightly reconciliation must pick up (so the test can fail).
    const real = await realPaidOrder(control, "10000002", true);

    // No attempt: the key that every Midtrans query (re-query of a notification, nightly reconciliation, the Owner's re-query) starts from.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.midtrans_attempts WHERE order_id = ANY(${ids}::uuid[])`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.payment_notifications WHERE midtrans_order_id IN (SELECT public_id FROM public.orders WHERE id = ANY(${ids}::uuid[]))`)).toBe(0);

    const asked: string[] = [];
    const notFound: HttpResponse = { status: 404, json: () => Promise.resolve({ status_code: "404", status_message: "Transaction doesn't exist." }), text: () => Promise.resolve("{}") };
    const fetch: HttpFetch = (url) => {
      asked.push(url);
      return Promise.resolve(notFound);
    };
    const midtrans: MidtransSource = () => Promise.resolve({ serverKey: "SB-Mid-server-DEMOINT0123456789", ...MIDTRANS_ENDPOINTS.sandbox, fetch });
    const log = createLogger({ level: "silent", role: "worker" });
    const [run] = await sql<{ id: string }[]>`INSERT INTO public.payment_reconciliation_runs (run_date) VALUES (current_date) RETURNING id`;
    const summary = await reconcile({ sql, midtrans, log, waDelayMs: 180_000 }, { id: run?.id ?? "", runDate: new Date().toISOString().slice(0, 10) });
    // Exactly the control order was reconciled: one attempt re-queried, and only its Midtrans id was asked about.
    expect(summary).toMatchObject({ orders: 1, attemptsChecked: 1 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(real.publicId);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.payment_reconciliation_findings WHERE order_id = ANY(${ids}::uuid[])`)).toBe(0);

    // The Owner's "re-query now" only acts on an order in review: for a demo order it is a no-op that asks Midtrans nothing.
    const requery = createOwnerRequeryConsumer({ sql, midtrans, log, waDelayMs: 180_000 });
    for (const orderId of ids) {
      const outcome = await requery.perform({ id: "00000000-0000-4000-8000-000000000000", topic: "payment.requery", payload: { order_id: orderId }, sealed: null, attempts: 1, deferrals: 0 }, new AbortController().signal);
      expect(outcome).toBeUndefined();
    }
    expect(asked).toHaveLength(1);

    // The sweeps that move orders: expiry (pending only), the Snap-create sweep (pending only), the stuck-review alert (review only).
    await sql`UPDATE public.orders SET expires_at = now() - interval '1 day' WHERE id = ANY(${ids}::uuid[])`;
    expect(await expireOrders(sql)).toBe(0);
    expect(await failStaleSnapCreates(sql, 0)).toBe(0);
    expect(await alertStuckReviews(sql, new Date(Date.now() + 365 * 24 * 3_600_000))).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE id = ANY(${ids}::uuid[]) AND status = 'paid'`)).toBe(8);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.alerts WHERE payload ->> 'order_id' = ANY(${ids}::text[])`)).toBe(0);

    await cleanupRun(sql, options.runId);
  });

  it("never lands in the Owner's review queue: no order in review, no decision, no alert, no finding", async () => {
    const f = await fixture();
    const options = seedOptions(f, { buyers: 6 });
    await seedDemo(sql, options);
    const ids = (await demoRows(options.runId)).map((o) => o.id);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE id = ANY(${ids}::uuid[]) AND (status = 'review' OR review_since IS NOT NULL)`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.order_owner_decisions WHERE order_id = ANY(${ids}::uuid[])`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.alerts WHERE payload ->> 'order_id' = ANY(${ids}::text[])`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.audit_log WHERE entity_type = 'order' AND entity_id = ANY(${ids}::text[])`)).toBe(0);
    await cleanupRun(sql, options.runId);
  });
});

describe("cleanup: every demo row is removed, as the migrate superuser, and nothing else is touched", () => {
  const tables = async (runId: string, ids: readonly string[], playerIds: readonly string[]): Promise<Record<string, number>> => {
    const n = async (query: Promise<postgres.RowList<{ n: number }[]>>): Promise<number> => count(query);
    return {
      orders: await n(sql`SELECT count(*)::int AS n FROM public.orders WHERE buyer_email ~ ${`^demo-${runId}-`}`),
      payments: await n(sql`SELECT count(*)::int AS n FROM public.payments WHERE gateway_txn_id LIKE ${`demo-${runId}-%`}`),
      deliveries: await n(sql`SELECT count(*)::int AS n FROM public.deliveries WHERE order_id = ANY(${ids}::uuid[])`),
      outbox: await n(sql`SELECT count(*)::int AS n FROM public.outbox WHERE dedupe_key = ANY(${ids.map((id) => `order.paid:${id}`)}::text[])`),
      players: await n(sql`SELECT count(*)::int AS n FROM public.players WHERE email ~ ${`^demo-${runId}-`}`),
      player_programs: await n(sql`SELECT count(*)::int AS n FROM public.player_programs WHERE player_id = ANY(${playerIds}::uuid[])`),
      player_program_stats: await n(sql`SELECT count(*)::int AS n FROM public.player_program_stats WHERE player_id = ANY(${playerIds}::uuid[])`),
      set_attempts: await n(sql`SELECT count(*)::int AS n FROM public.set_attempts WHERE player_id = ANY(${playerIds}::uuid[])`),
      attempt_questions: await n(sql`SELECT count(*)::int AS n FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id WHERE a.player_id = ANY(${playerIds}::uuid[])`),
      magic_links: await n(sql`SELECT count(*)::int AS n FROM public.magic_links WHERE player_id = ANY(${playerIds}::uuid[])`),
      auth_users: await n(sql`SELECT count(*)::int AS n FROM player_auth."user" WHERE email LIKE ${`demo-${runId}-%`}`),
      auth_sessions: await n(sql`SELECT count(*)::int AS n FROM player_auth.session s JOIN player_auth."user" u ON u.id = s."userId" WHERE u.email LIKE ${`demo-${runId}-%`}`),
    };
  };

  it("deletes the orders, payments, deliveries, outbox rows, players, eligibility, attempts, answers, links and login sessions of the run, and keeps a real buyer's rows", async () => {
    const f = await fixture({ pixel: true });
    const options = seedOptions(f);
    const { file } = await seedDemo(sql, options);
    const real = await realPaidOrder(f, "10000003");
    const orders = await demoRows(options.runId);
    const ids = orders.map((o) => o.id);
    const playerIds = orders.map((o) => o.player_id);

    // Play: the first buyer answers a question (attempt, answer rows, the reveal watch), the second gets a login session as the app's login makes one.
    const player = playerIds[0] ?? "";
    const [attempt] = await sql<{ id: string }[]>`SELECT public.play_start_set(${player}, ${file.set_ids[0] ?? ""}) AS id`;
    await sql`SELECT public.play_current(${player}, ${attempt?.id ?? ""}, '203.0.113.7'::inet, NULL)`;
    const [shown] = await sql<{ r: { answer_id: string; options: { id: string }[] } }[]>`SELECT public.play_current(${player}, ${attempt?.id ?? ""}, '203.0.113.7'::inet, NULL) AS r`;
    await sql`SELECT public.play_answer(${player}, ${shown?.r.answer_id ?? ""}, ${shown?.r.options[0]?.id ?? ""}, '203.0.113.7'::inet, NULL)`;
    await sql`SELECT public.play_settle(${player}, ${shown?.r.answer_id ?? ""})`;
    await sql`SELECT public.play_reveal(${player}, ${shown?.r.answer_id ?? ""})`;
    const authId = `auth-${options.runId}`;
    await sql`INSERT INTO player_auth."user" (id, name, email, "emailVerified") VALUES (${authId}, 'Budi', ${`demo-${options.runId}-01@example.com`}, true)`;
    await sql`INSERT INTO player_auth.session (id, "expiresAt", token, "updatedAt", "userId") VALUES (${`sess-${options.runId}`}, now() + interval '1 day', ${`tok-${options.runId}`}, now(), ${authId})`;
    await sql`UPDATE public.players SET auth_user_id = ${authId} WHERE id = ${playerIds[1] ?? ""}`;

    const before = await tables(options.runId, ids, playerIds);
    expect(before).toMatchObject({ orders: 12, payments: 12, deliveries: 24, outbox: 12, players: 12, player_programs: 12, magic_links: 12, auth_users: 1, auth_sessions: 1, set_attempts: 1 });
    expect(before["attempt_questions"]).toBe(2);
    // The Sales report and the leaderboard show the demo buyers before cleanup.
    await sql`SELECT public.refresh_report_rollups()`;
    const sales = () => sql<{ orders: number; revenue: string }[]>`SELECT coalesce(sum(orders), 0)::int AS orders, coalesce(sum(revenue_idr), 0)::text AS revenue FROM public.report_orders_daily WHERE program_id = ${f.program_id}`;
    expect((await sales())[0]).toEqual({ orders: 13, revenue: String(13 * PRICE) });
    expect(await count(sql`SELECT count(*)::int AS n FROM public.play_ranking(${f.program_id})`)).toBe(13);

    const report = await cleanupRun(sql, options.runId);
    expect(report.kind).toBe("demo");
    expect(report.removed).toMatchObject({ orders: 12, payments: 12, deliveries: 24, outbox: 12, players: 12, player_programs: 12, set_attempts: 1, attempt_questions: 2, player_auth_users: 1, conversion_events: 0 });

    // Every row of the run is gone, including what the play and the login made.
    expect(Object.values(await tables(options.runId, ids, playerIds)).every((v) => v === 0)).toBe(true);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.answer_reveals WHERE answer_id = ${shown?.r.answer_id ?? ""}`)).toBe(0);
    // The leaderboard and the reports no longer show the demo buyers (the rollup refreshes every 5 minutes; a delete forces a full rebuild).
    expect(await count(sql`SELECT count(*)::int AS n FROM public.play_ranking(${f.program_id})`)).toBe(1);
    await sql`SELECT public.refresh_report_rollups()`;
    expect((await sales())[0]).toEqual({ orders: 1, revenue: String(PRICE) });
    // What is not the run's is untouched: the real buyer's order, payment-less as it is, its deliveries and its player; the program, the landing page, the product, the sets.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE id = ${real.id} AND status = 'paid'`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.deliveries WHERE order_id = ${real.id} AND status = 'pending'`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.trivia_sets WHERE program_id = ${f.program_id}`)).toBe(SETS);
    // What stays: the lock the first paid order put on the program (never cleared).
    expect(await count(sql`SELECT count(*)::int AS n FROM public.programs WHERE id = ${f.program_id} AND locked_at IS NOT NULL`)).toBe(1);
    // A second cleanup has nothing to remove.
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/nothing to clean up/);
  });

  it("still cleans up a load-test run the old way, refuses a run that is not 8 hex digits, and one that never existed", async () => {
    await expect(cleanupDemo(sql, "00000000")).resolves.toBeNull();
    await expect(cleanupRun(sql, "00000000")).rejects.toThrow(/nothing to clean up/);
    await expect(cleanupRun(sql, "x' OR '1'='1")).rejects.toThrow(/8 lower-case hex digits/);
    const f = await fixture({ sets: 0 });
    await expect(cleanupRun(sql, f.runId)).resolves.toMatchObject({ kind: "orders" });
  });

  it("refuses, deleting nothing, when a demo player has an order that is not of the run, or the contest's results snapshot exists", async () => {
    const f = await fixture();
    const options = seedOptions(f, { buyers: 4 });
    await seedDemo(sql, options);
    const orders = await demoRows(options.runId);
    const stranger = await realPaidOrder(f, "10000004");
    await sql`UPDATE public.orders SET player_id = ${orders[0]?.player_id ?? ""} WHERE id = ${stranger.id}`;
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/not of this run/);
    expect((await demoRows(options.runId)).length).toBe(4);
    await sql`UPDATE public.orders SET player_id = NULL WHERE id = ${stranger.id}`;

    await sql`INSERT INTO public.leaderboard_snapshots (program_id, frozen_at, entries) VALUES (${f.program_id}, now(), '[]'::jsonb)`;
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/results snapshot/);
    expect((await demoRows(options.runId)).length).toBe(4);
  });

  it("removes only the run it is given: another run of the same program is left whole", async () => {
    const f = await fixture();
    const a = seedOptions(f, { buyers: 5 });
    const b = seedOptions(f, { buyers: 4, seed: 8 });
    await seedDemo(sql, a);
    await seedDemo(sql, b);
    await realPaidOrder(f, "10000005");
    const ofRun = async (runId: string) => ({
      orders: (await demoRows(runId)).length,
      payments: await count(sql`SELECT count(*)::int AS n FROM public.payments WHERE gateway_txn_id LIKE ${`demo-${runId}-%`}`),
      deliveries: await count(sql`SELECT count(*)::int AS n FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id WHERE o.buyer_email ~ ${`^demo-${runId}-`}`),
      links: await count(sql`SELECT count(*)::int AS n FROM public.magic_links m JOIN public.players p ON p.id = m.player_id WHERE p.email ~ ${`^demo-${runId}-`}`),
      players: await count(sql`SELECT count(*)::int AS n FROM public.players WHERE email ~ ${`^demo-${runId}-`}`),
    });
    expect(await ofRun(b.runId)).toEqual({ orders: 4, payments: 4, deliveries: 8, links: 4, players: 4 });

    const report = await cleanupRun(sql, a.runId);
    expect(report.removed).toMatchObject({ orders: 5, payments: 5, deliveries: 10, players: 5, player_programs: 5 });
    expect(await ofRun(a.runId)).toEqual({ orders: 0, payments: 0, deliveries: 0, links: 0, players: 0 });
    // B and the real buyer are whole, and the leaderboard still ranks them (4 + 1).
    expect(await ofRun(b.runId)).toEqual({ orders: 4, payments: 4, deliveries: 8, links: 4, players: 4 });
    expect(await count(sql`SELECT count(*)::int AS n FROM public.play_ranking(${f.program_id})`)).toBe(5);
    await expect(cleanupRun(sql, b.runId)).resolves.toMatchObject({ kind: "demo" });
    expect(await count(sql`SELECT count(*)::int AS n FROM public.play_ranking(${f.program_id})`)).toBe(1);
  });

  it("matches an order only by its e-mail AND its demo payment AND no Midtrans attempt: anything else is refused, deleting nothing", async () => {
    const f = await fixture();
    const options = seedOptions(f, { buyers: 3 });
    await seedDemo(sql, options);
    const [first] = await demoRows(options.runId);
    const label = `demo-${options.runId}-01`;
    await sql`UPDATE public.payments SET gateway_txn_id = 'not-a-demo-id' WHERE order_id = ${first?.id ?? ""}`;
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/is not a demo order/);
    await sql`UPDATE public.payments SET gateway_txn_id = ${label} WHERE order_id = ${first?.id ?? ""}`;

    const [pub] = await sql<{ public_id: string }[]>`SELECT public_id FROM public.orders WHERE id = ${first?.id ?? ""}`;
    await sql`INSERT INTO public.midtrans_attempts (order_id, n, midtrans_order_id, status) VALUES (${first?.id ?? ""}, 1, ${`${pub?.public_id ?? ""}-1`}, 'created')`;
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/is not a demo order/);
    expect((await demoRows(options.runId)).length).toBe(3);
    await sql`DELETE FROM public.midtrans_attempts WHERE order_id = ${first?.id ?? ""}`;

    await expect(cleanupRun(sql, options.runId)).resolves.toMatchObject({ kind: "demo", removed: { orders: 3 } });
  });

  it("refuses, deleting nothing and naming the table, over a row a restrict key or an append-only rule keeps (a reconciliation finding)", async () => {
    const f = await fixture();
    const options = seedOptions(f, { buyers: 3 });
    await seedDemo(sql, options);
    const [first] = await demoRows(options.runId);
    const [run] = await sql<{ id: string }[]>`INSERT INTO public.payment_reconciliation_runs (run_date) VALUES (date '2020-01-01') RETURNING id`;
    await sql`INSERT INTO public.payment_reconciliation_findings (run_id, order_id, kind, order_status) VALUES (${run?.id ?? ""}, ${first?.id ?? ""}, 'paid_not_settled', 'paid')`;
    await expect(cleanupRun(sql, options.runId)).rejects.toThrow(/refusing to delete anything: .*payment_reconciliation_findings 1 \(a reconciliation finding of a demo order\)/);
    expect((await demoRows(options.runId)).length).toBe(3);
    await sql`DELETE FROM public.payment_reconciliation_findings WHERE run_id = ${run?.id ?? ""}`;
    await expect(cleanupRun(sql, options.runId)).resolves.toMatchObject({ kind: "demo" });
  });
});
