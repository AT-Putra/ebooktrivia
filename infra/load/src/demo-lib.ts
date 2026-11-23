// Demo data for a STAGING or DEV database (README: "Demo data on staging"): fake PAID buyers of an EXISTING published program, so that
// the leaderboard, the Sales and Contest reports and the prize screens have something to show, and the removal of all of it again.
// Like seed-lib.ts it runs as a privileged login (the migrator or a superuser) after guard.ts has accepted the target, and the app is
// not touched: no test-only code path, the orders become PAID through the same SQL a real settlement runs.
//
// What one buyer gets (all of it in ONE transaction, so a refusal leaves nothing behind):
//   1. an order of the program's product at its price, created `pending` on the program's first active landing page, dated a few minutes
//      before the payment (created_at is what the reports group by), with a buyer on `demo-<run>-<NN>@example.com` (reserved domain);
//   2. a payments row, the ledger of a settled Midtrans transaction: `gateway_txn_id` = `demo-<run>-<NN>` (marks the run, cannot be a real
//      Midtrans id), a payment method (qris, gopay, ...) so that the fee of the Owner's midtrans.fees applies, the amount and paid date;
//   3. the order moved to `paid` with a back-dated paid_at, then public.order_paid_effects(order, paid_at): the SAME function the worker's
//      payment code and the Owner's "mark paid" call. It makes the player (name, phone, e-mail), the player_programs row
//      (eligible, first_paid_at = the earliest paid_at: this is what unlocks sets one a day), the deliveries, the conversion rows
//      and the `order.paid` outbox row;
//   4. then it is made INERT for every sender, still in the same transaction (nothing is visible to the worker before COMMIT):
//      the e-mail and WhatsApp deliveries are cancelled (last_error `demo_seed`; payments revives only rows cancelled as
//      `order_not_paid`), the conversion rows (only a pixel of the landing page can make one: the orders carry no adnet and no
//      click id) are deleted before any worker can claim them, and the `order.paid` outbox row is marked processed;
//   5. one magic link per player, with the app's own issue_magic_link.
// No midtrans_attempts row is made: the nightly reconciliation and the payment re-query paths only look at orders that have one, so no
// Midtrans query is ever made for a demo order (a 404 there would be a critical alert). An order is never put in `review` and no
// owner decision is written, so none is ever in the Owner's review queue. No audit_log row is written (it is append-only: it could
// not be removed afterwards).
import { open, rm } from "node:fs/promises";
import { buyerKey, issueMagicLink, newOrderCode, newPublicId } from "@ebooktrivia/core";
import type postgres from "postgres";
import { type BuyerPlan, checkDemoProgram, type DemoFile, type DemoProgramFacts, demoEmail, demoLabel, estimateSeconds, graceEnd, paidDateProblem, planDemoBuyers } from "./demo-plan.ts";
import { assertWhatsAppOff, RUN_ID } from "./guard.ts";
import { type CleanupReport, cleanup, first, freshPhones } from "./seed-lib.ts";

type Sql = postgres.Sql;

/** The WhatsApp delay fallback order_paid_effects takes (core WA_PROACTIVE_DELAY_MS, the worker's default); the setting wins while it exists. */
const WA_DELAY_FALLBACK_MS = 180_000;
/** `last_error` of a delivery this tool cancelled. */
export const DEMO_CANCELLED = "demo_seed";

export interface DemoOptions {
  readonly runId: string;
  readonly programSlug: string;
  readonly buyers: number;
  readonly seed: number;
  readonly acceptProgramLock: boolean;
  /** Default: the database's clock (`SELECT now()`), so the plan agrees with the dates the database compares them to. */
  readonly now?: Date;
  /**
   * Called inside the transaction, once every buyer is made and checked, with the file the simulator plays from. If it throws, the
   * transaction rolls back: the run is never committed without its login links in the operator's hands (seedDemoToFile).
   */
  readonly persist?: (file: DemoFile) => Promise<void>;
}

export interface DemoSeed {
  readonly file: DemoFile;
  readonly summary: {
    readonly buyers: number;
    readonly paid_from: Date;
    readonly paid_to: Date;
    /** The end of the program's grace period: the worker writes the immutable results snapshot after it, so clean up before. */
    readonly grace_end: Date;
    readonly sets_planned: number;
    readonly answers_planned: number;
    readonly estimated_seconds_at_speed_1: number;
    readonly deliveries_cancelled: number;
    readonly conversions_removed: number;
    readonly program_was_locked: boolean;
  };
}

interface ProgramRow {
  id: string;
  product_id: string;
  slug: string;
  status: string;
  sales_start_at: Date;
  sales_end_at: Date;
  grace_days: number;
  locked_at: Date | null;
  price_idr: string;
  product_active: boolean;
}

async function loadProgram(sql: Sql, slug: string) {
  const [program] = await sql<ProgramRow[]>`
    SELECT p.id, p.product_id, p.slug, p.status::text AS status, p.sales_start_at, p.sales_end_at, p.grace_days, p.locked_at, pr.price_idr::text AS price_idr, pr.active AS product_active
      FROM public.programs p JOIN public.products pr ON pr.id = p.product_id WHERE p.slug = ${slug}`;
  if (program === undefined) throw new Error(`no program with the slug ${slug}`);
  const sets = await sql<{ id: string; questions: number }[]>`
    SELECT s.id, count(q.id)::int AS questions FROM public.trivia_sets s LEFT JOIN public.questions q ON q.set_id = s.id
     WHERE s.program_id = ${program.id} GROUP BY s.id, s.position ORDER BY s.position`;
  const landingPages = await sql<{ id: string }[]>`SELECT id FROM public.landing_pages WHERE program_id = ${program.id} AND active ORDER BY created_at, id`;
  const correct = await sql<{ id: string }[]>`
    SELECT o.id FROM public.question_options o JOIN public.questions q ON q.id = o.question_id JOIN public.trivia_sets s ON s.id = q.set_id
     WHERE s.program_id = ${program.id} AND o.is_correct ORDER BY o.id`;
  const facts: DemoProgramFacts = {
    slug: program.slug,
    status: program.status,
    productActive: program.product_active,
    salesStartAt: program.sales_start_at,
    salesEndAt: program.sales_end_at,
    graceDays: program.grace_days,
    lockedAt: program.locked_at,
    setCount: sets.length,
    emptySets: sets.filter((s) => s.questions === 0).length,
    activeLandingPages: landingPages.length,
  };
  return { program, sets, landingPageId: landingPages[0]?.id, correctOptionIds: correct.map((c) => c.id), facts };
}

/**
 * Makes `buyers` PAID fake buyers of the program and returns the file the simulator plays from. Refuses (before anything is written)
 * unless WhatsApp is off (no active WAHA session, a proactive delay of an hour or more), the program fits (demo-plan.ts checkDemoProgram)
 * and every paid date of the plan is inside the program's sales window up to now.
 */
export async function seedDemo(sql: Sql, options: DemoOptions): Promise<DemoSeed> {
  const now = options.now ?? (await sql<{ now: Date }[]>`SELECT now() AS now`)[0]?.now ?? new Date();
  // The buyers carry real-looking phone numbers, so nothing may be able to send to them (the same check as the orders run).
  await assertWhatsAppOff(sql);
  const { program, sets, landingPageId, correctOptionIds, facts } = await loadProgram(sql, options.programSlug);
  const problems = checkDemoProgram(facts, now, options.acceptProgramLock);
  if (problems.length > 0 || landingPageId === undefined) throw new Error(`refusing to put demo buyers in program ${options.programSlug}:\n- ${problems.join("\n- ")}`);

  const plans = planDemoBuyers({ seed: options.seed, buyers: options.buyers, sales_start_at: program.sales_start_at, sales_end_at: program.sales_end_at, grace_days: program.grace_days, set_count: sets.length, now });
  const phones = await freshPhones(sql, plans.length);
  const questionsPerSet = sets.map((s) => s.questions);
  const price = Number(program.price_idr);
  let deliveriesCancelled = 0;
  let conversionsRemoved = 0;

  const file = await sql.begin(async (tx): Promise<DemoFile> => {
    // The program's window as it is NOW (a share lock: nobody edits it while the dates are checked), and every date against it.
    const [window] = await tx<{ sales_start_at: Date; sales_end_at: Date }[]>`SELECT sales_start_at, sales_end_at FROM public.programs WHERE id = ${program.id} FOR SHARE`;
    if (window === undefined) throw new Error("the program disappeared");
    const buyers: DemoFile["buyers"] = [];
    const orderIds: string[] = [];
    for (const [i, plan] of plans.entries()) {
      const problem = paidDateProblem(plan.paid_at, window.sales_start_at, window.sales_end_at, now);
      if (problem !== "") throw new Error(`refusing: ${problem}`);
      const phone = phones[i] ?? "";
      const label = demoLabel(options.runId, plan.index, plans.length);
      const email = demoEmail(options.runId, plan.index, plans.length);
      const created = new Date(Math.max(window.sales_start_at.getTime(), plan.paid_at.getTime() - (2 + (plan.play_seed % 8)) * 60_000));
      const order = first(
        await tx<{ id: string }[]>`
          INSERT INTO public.orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, created_at)
          VALUES (${newPublicId()}, ${newOrderCode()}, ${landingPageId}, ${program.id}, ${program.product_id}, ${plan.name}, ${phone}, ${email}, ${buyerKey({ phone, name: plan.name, email })}, ${price}, 'pending',
                  ${new Date(created.getTime() + 3_600_000)}, ${created})
          RETURNING id`,
      );
      orderIds.push(order.id);
      const raw = JSON.stringify({ demo: true, run_id: options.runId, status_code: "200", gross_amount: `${String(price)}.00`, payment_type: plan.payment_type, transaction_time: plan.paid_at.toISOString() });
      await tx`
        INSERT INTO public.payments (order_id, gateway_txn_id, payment_type, transaction_status, fraud_status, gross_amount_idr, currency, settled_at, raw, created_at)
        VALUES (${order.id}, ${label}, ${plan.payment_type}, ${plan.payment_type === "credit_card" ? "capture" : "settlement"}, 'accept', ${price}, 'IDR', ${plan.paid_at}, ${raw}::text::jsonb, ${plan.paid_at})`;
      await tx`UPDATE public.orders SET status = 'paid', paid_at = ${plan.paid_at} WHERE id = ${order.id} AND status = 'pending'`;
      const effects = first(await tx<{ r: { player_id: string; eligible: boolean } }[]>`SELECT public.order_paid_effects(${order.id}, ${plan.paid_at}, ${WA_DELAY_FALLBACK_MS}) AS r`).r;
      // order_paid_effects keeps the profile of a player that already has the phone; the run's players must be its own.
      const [owner] = await tx<{ email: string | null }[]>`SELECT email FROM public.players WHERE id = ${effects.player_id}`;
      if (owner?.email !== email || !effects.eligible) throw new Error(`buyer ${label} did not become its own eligible player (the phone belongs to an existing player?)`);
      const link = issueMagicLink({ channel: "whatsapp" });
      await tx`SELECT public.issue_magic_link(${effects.player_id}, 'whatsapp', ${link.tokenHash})`;
      buyers.push({ index: plan.index, label, token: link.token, plan: playPlan(plan) });
    }

    // Inert for every sender, before COMMIT makes any of it visible: the deliveries cancelled, the conversion rows (a pixel of the landing
    // page can make one) deleted, the order.paid jobs marked processed.
    deliveriesCancelled = (await tx`UPDATE public.deliveries SET status = 'cancelled', last_error = ${DEMO_CANCELLED}, updated_at = now() WHERE order_id = ANY(${orderIds}::uuid[]) AND status = 'pending'`).count;
    conversionsRemoved = (await tx`DELETE FROM public.conversion_events WHERE order_id = ANY(${orderIds}::uuid[])`).count;
    await tx`UPDATE public.outbox SET relayed_at = now(), processed_at = now() WHERE dedupe_key = ANY(${orderIds.map((id) => `order.paid:${id}`)}::text[]) AND processed_at IS NULL`;
    // Nothing of the run may be on a send path: a delivery that is not cancelled, a conversion row, an unprocessed order.paid row.
    const [sendable] = await tx<{ n: number }[]>`
      SELECT ((SELECT count(*) FROM public.deliveries WHERE order_id = ANY(${orderIds}::uuid[]) AND status <> 'cancelled')
            + (SELECT count(*) FROM public.conversion_events WHERE order_id = ANY(${orderIds}::uuid[]))
            + (SELECT count(*) FROM public.outbox WHERE dedupe_key = ANY(${orderIds.map((id) => `order.paid:${id}`)}::text[]) AND processed_at IS NULL))::int AS n`;
    if ((sendable?.n ?? -1) !== 0) throw new Error("a demo order still has something a worker could send: nothing was written");

    const made: DemoFile = {
      kind: "demo",
      run_id: options.runId,
      seed: options.seed,
      planned_at: now.toISOString(),
      program_id: program.id,
      program_slug: program.slug,
      set_ids: sets.map((s) => s.id),
      questions_per_set: questionsPerSet,
      correct_option_ids: correctOptionIds,
      buyers,
    };
    // The login links reach the operator before the run exists for anyone else: a failure here rolls everything back.
    await options.persist?.(made);
    return made;
  });

  const estimate = estimateSeconds(plans, questionsPerSet);
  return {
    file,
    summary: {
      buyers: plans.length,
      paid_from: plans[0]?.paid_at ?? now,
      paid_to: plans.at(-1)?.paid_at ?? now,
      grace_end: graceEnd(program.sales_end_at, program.grace_days),
      sets_planned: estimate.sets,
      answers_planned: estimate.answers,
      estimated_seconds_at_speed_1: estimate.seconds,
      deliveries_cancelled: deliveriesCancelled,
      conversions_removed: conversionsRemoved,
      program_was_locked: facts.lockedAt !== null,
    },
  };
}

/**
 * seedDemo with the output file: created first, `wx` (never over an existing file) and 0600 (it holds one-time login links), written
 * INSIDE the seed's transaction, so a write that fails rolls the run back instead of leaving buyers whose links and run id nobody has.
 * Any failure removes the file again (empty, or holding links of a run that does not exist).
 */
export async function seedDemoToFile(sql: Sql, options: DemoOptions, out: string): Promise<DemoSeed> {
  const handle = await open(out, "wx", 0o600);
  try {
    return await seedDemo(sql, {
      ...options,
      persist: async (file) => {
        await handle.writeFile(`${JSON.stringify(file)}\n`);
        await handle.close();
      },
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(out, { force: true });
    throw error;
  }
}

const playPlan = (plan: BuyerPlan): DemoFile["buyers"][number]["plan"] => ({
  sets_to_play: plan.sets_to_play,
  skill: plan.skill,
  think_min_ms: plan.think_min_ms,
  think_max_ms: plan.think_max_ms,
  timeout_rate: plan.timeout_rate,
  abandon_last_set: plan.abandon_last_set,
  abandon_fraction: plan.abandon_fraction,
  play_seed: plan.play_seed,
});

/** What cleanupDemo refuses over, by table: rows that a restrict key or an append-only rule would keep. */
const KEPT_BY_RULES: Readonly<Record<string, string>> = {
  deadline_extensions: "the append-only deadline extension ledger",
  deletion_requests: "a privacy deletion request of a demo player",
  consents: "a consent record of a demo order",
  payment_reconciliation_findings: "a reconciliation finding of a demo order",
  order_owner_decisions: "the Owner's decision ledger, append-only",
  winners: "a contest winner",
  leaderboard_snapshots: "the program's results snapshot, immutable (the worker writes it by itself after the grace end)",
};

/**
 * Removes everything of a demo run, or returns null when the run made no demo buyer (the caller then tries the load-test cleanup).
 *
 * Every row is DELETED, in an order the keys allow: the order.paid outbox rows, the conversion attempts and rows, the deliveries, the
 * payments, the orders (the report rollups notice a delete: triggers.sql report_mark_full_rebuild, so the Sales figures drop at the
 * next 5-minute refresh), then the play data (answers, attempts, stats, eligibility, magic links) and the players with their
 * player_auth users (their sessions go with them). Nothing is retired instead, because no trigger refuses these deletes for a login
 * that owns the tables.
 *
 * What stays, and why: programs.locked_at of the program (the first paid order locked it, and the lock is never cleared). Nothing else.
 *
 * What is matched: an order only when ALL hold: its e-mail is `demo-<run>-NN@example.com`, it has a payment whose gateway_txn_id is
 * exactly that `demo-<run>-NN`, and it has no midtrans_attempts row. An order that fits the e-mail but not the rest is not ours: refused.
 *
 * Refused, with NOTHING deleted, when a row exists that the restrict keys or the append-only rules would keep, and that the run could
 * leave behind: a deadline extension, a deletion request, a consent, a reconciliation finding or an Owner decision of a demo order or
 * player, a winner, or the program's results snapshot (immutable: the worker writes it by itself after the grace end, with the demo
 * players in it). Run it before the grace end.
 */
export async function cleanupDemo(sql: Sql, runId: string): Promise<CleanupReport | null> {
  if (!RUN_ID.test(runId)) throw new Error(`a run id is 8 lower-case hex digits (got ${JSON.stringify(runId)})`);
  // Only what seedDemo wrote: its reserved-domain e-mail, nothing else is ever matched.
  const pattern = `^demo-${runId}-[0-9]{2,3}@example\\.com$`;
  const removed: Record<string, number> = {};
  const found = await sql.begin(async (tx) => {
    const orders = await tx<{ id: string; program_id: string; demo_payment: boolean; foreign_payment: boolean; attempt: boolean }[]>`
      SELECT o.id, o.program_id,
             EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id AND p.gateway_txn_id = substring(o.buyer_email FROM '^(.+)@')) AS demo_payment,
             EXISTS (SELECT 1 FROM public.payments p WHERE p.order_id = o.id AND p.gateway_txn_id <> substring(o.buyer_email FROM '^(.+)@')) AS foreign_payment,
             EXISTS (SELECT 1 FROM public.midtrans_attempts a WHERE a.order_id = o.id) AS attempt
        FROM public.orders o WHERE o.buyer_email ~ ${pattern}`;
    const players = await tx<{ id: string; auth_user_id: string | null }[]>`SELECT id, auth_user_id FROM public.players WHERE email ~ ${pattern}`;
    if (orders.length === 0 && players.length === 0) return false;
    if (orders.some((o) => !o.demo_payment || o.foreign_payment || o.attempt)) {
      throw new Error("an order with a demo e-mail is not a demo order (it has no demo payment, another payment, or a Midtrans attempt): refusing to delete anything");
    }
    const orderIds = orders.map((o) => o.id);
    const playerIds = players.map((p) => p.id);
    const authIds = players.flatMap((p) => (p.auth_user_id === null ? [] : [p.auth_user_id]));
    const programIds = [...new Set(orders.map((o) => o.program_id))];
    const [others] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.orders WHERE player_id = ANY(${playerIds}::uuid[]) AND NOT (id = ANY(${orderIds}::uuid[]))`;
    if ((others?.n ?? 0) > 0) throw new Error("a demo player has an order that is not of this run: refusing to delete anything");
    const [kept] = await tx<Record<string, number>[]>`
      SELECT (SELECT count(*)::int FROM public.deadline_extensions de JOIN public.attempt_questions aq ON aq.id = de.attempt_question_id JOIN public.set_attempts a ON a.id = aq.attempt_id WHERE a.player_id = ANY(${playerIds}::uuid[])) AS deadline_extensions,
             (SELECT count(*)::int FROM public.deletion_requests WHERE player_id = ANY(${playerIds}::uuid[])) AS deletion_requests,
             (SELECT count(*)::int FROM public.consents WHERE order_id = ANY(${orderIds}::uuid[])) AS consents,
             (SELECT count(*)::int FROM public.payment_reconciliation_findings WHERE order_id = ANY(${orderIds}::uuid[])) AS payment_reconciliation_findings,
             (SELECT count(*)::int FROM public.order_owner_decisions WHERE order_id = ANY(${orderIds}::uuid[])) AS order_owner_decisions,
             (SELECT count(*)::int FROM public.winners WHERE player_id = ANY(${playerIds}::uuid[])) AS winners,
             (SELECT count(*)::int FROM public.leaderboard_snapshots WHERE program_id = ANY(${programIds}::uuid[])) AS leaderboard_snapshots`;
    const blocking = Object.entries(kept ?? {}).filter(([, n]) => n > 0);
    if (blocking.length > 0) {
      throw new Error(`refusing to delete anything: rows that a restrict key or an append-only rule keeps exist for this run: ${blocking.map(([table, n]) => `${table} ${String(n)} (${KEPT_BY_RULES[table] ?? "kept"})`).join("; ")}`);
    }
    const count = (rows: { readonly count: number }): number => rows.count;
    removed["outbox"] = count(await tx`DELETE FROM public.outbox WHERE dedupe_key = ANY(${orderIds.map((id) => `order.paid:${id}`)}::text[])`);
    removed["conversion_attempts"] = count(await tx`DELETE FROM public.conversion_attempts WHERE conversion_event_id IN (SELECT id FROM public.conversion_events WHERE order_id = ANY(${orderIds}::uuid[]))`);
    removed["conversion_events"] = count(await tx`DELETE FROM public.conversion_events WHERE order_id = ANY(${orderIds}::uuid[])`);
    removed["deliveries"] = count(await tx`DELETE FROM public.deliveries WHERE order_id = ANY(${orderIds}::uuid[])`);
    removed["payments"] = count(await tx`DELETE FROM public.payments WHERE order_id = ANY(${orderIds}::uuid[])`);
    removed["orders"] = count(await tx`DELETE FROM public.orders WHERE id = ANY(${orderIds}::uuid[])`);
    removed["attempt_questions"] = count(await tx`DELETE FROM public.attempt_questions WHERE attempt_id IN (SELECT id FROM public.set_attempts WHERE player_id = ANY(${playerIds}::uuid[]))`);
    removed["set_attempts"] = count(await tx`DELETE FROM public.set_attempts WHERE player_id = ANY(${playerIds}::uuid[])`);
    removed["player_program_stats"] = count(await tx`DELETE FROM public.player_program_stats WHERE player_id = ANY(${playerIds}::uuid[])`);
    removed["player_programs"] = count(await tx`DELETE FROM public.player_programs WHERE player_id = ANY(${playerIds}::uuid[])`);
    removed["players"] = count(await tx`DELETE FROM public.players WHERE id = ANY(${playerIds}::uuid[])`);
    if (authIds.length > 0) removed["player_auth_users"] = count(await tx`DELETE FROM player_auth."user" WHERE id = ANY(${authIds}::text[])`);
    return true;
  });
  return found ? { kind: "demo", removed } : null;
}

/** `seed.ts cleanup --run <id>`: a demo run, else a load-test run (seed-lib.ts cleanup). */
export async function cleanupRun(sql: Sql, runId: string): Promise<CleanupReport> {
  return (await cleanupDemo(sql, runId)) ?? cleanup(sql, runId);
}
