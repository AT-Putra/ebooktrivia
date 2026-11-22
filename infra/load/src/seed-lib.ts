// What the load tests need in the database, created through plain INSERTs by a privileged login (a
// superuser or the migrator) on a STAGING or DEV database (guard.ts decides, the CLI calls it first):
//
//   trivia  a published program with `sets` sets of `questions` questions, `players` players that are
//           eligible for it (player_programs, as a paid order would leave them), unlocked on every set
//           (first_paid_at far enough back for the per-player schedule, AC-Q4), and one magic link per
//           player. NO order and NO delivery exists for them, so nothing can ever be sent to their numbers.
//           The SESSIONS are not made here: login.ts exchanges each link through the app's own login route.
//   orders  a landing page on an open program (Midtrans sandbox, no browser pixels, so no CAPI call), its
//           registered origin, a published terms + privacy pair, and one adnet whose MO and MT postback
//           templates point at the operator's sink. The load test creates the orders through the real checkout.
//
// Every row carries the run id (product title, program slug, player name, landing page name, adnet slug), which
// is how cleanup() finds them again. There is no test-only bypass: the app is not touched, and the session,
// order, payment and delivery rows are all made by the app's own code paths.
import { randomBytes, randomInt } from "node:crypto";
import { issueMagicLink } from "@ebooktrivia/core";
import { normalizeIdMobile } from "@ebooktrivia/core/phone";
import type postgres from "postgres";
import { RUN_ID } from "./guard.ts";

type Sql = postgres.Sql;

export const newRunId = (): string => randomBytes(4).toString("hex");

const first = <T>(rows: readonly T[]): T => {
  const [row] = rows;
  if (row === undefined) throw new Error("the statement returned no row");
  return row;
};

/** `count` distinct valid Indonesian mobile numbers (E.164) that no player has yet. */
async function freshPhones(sql: Sql, count: number): Promise<string[]> {
  const phones = new Set<string>();
  while (phones.size < count) {
    const candidate = `+62812${String(randomInt(10_000_000, 99_999_999))}`;
    if (normalizeIdMobile(candidate).ok) phones.add(candidate);
  }
  const taken = await sql<{ phone: string }[]>`SELECT phone FROM public.players WHERE phone IN ${sql([...phones])}`;
  for (const { phone } of taken) phones.delete(phone);
  return phones.size === count ? [...phones] : [...phones, ...(await freshPhones(sql, count - phones.size))];
}

export interface TriviaOptions {
  readonly runId: string;
  readonly players: number;
  readonly sets: number;
  readonly questions: number;
  readonly timerSeconds: number;
  readonly points: number;
}

export interface TriviaLinks {
  readonly kind: "trivia";
  readonly run_id: string;
  readonly program_id: string;
  readonly program_slug: string;
  readonly set_ids: string[];
  readonly questions_per_set: number;
  readonly timer_seconds: number;
  readonly players: { readonly player_id: string; readonly phone: string; readonly token: string }[];
}

export async function seedTrivia(sql: Sql, options: TriviaOptions): Promise<TriviaLinks> {
  const { runId } = options;
  const slug = `lt-${runId}`;
  const phones = await freshPhones(sql, options.players);
  return sql.begin(async (tx) => {
    const product = first(await tx<{ id: string }[]>`INSERT INTO public.products (title, price_idr) VALUES (${`LOADTEST ${runId} trivia`}, 10000) RETURNING id`);
    // Sales opened long ago and closing in 30 days, grace 30 days: play stays open for the whole run.
    const program = first(await tx<{ id: string }[]>`
      INSERT INTO public.programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days, default_points, default_timer_seconds, leaderboard_top_n)
      VALUES (${product.id}, ${slug}, ${`LOADTEST ${runId}`}, 'published', now() - make_interval(days => ${options.sets + 30}), now() + interval '30 days', 30,
              ${options.points}, ${options.timerSeconds}, 10)
      RETURNING id`);
    const setIds: string[] = [];
    for (let position = 1; position <= options.sets; position++) {
      const set = first(await tx<{ id: string }[]>`INSERT INTO public.trivia_sets (program_id, position, title) VALUES (${program.id}, ${position}, ${`Set ${String(position)}`}) RETURNING id`);
      setIds.push(set.id);
      for (let q = 1; q <= options.questions; q++) {
        const question = first(await tx<{ id: string }[]>`
          INSERT INTO public.questions (set_id, position, prompt, points, timer_seconds, explanation)
          VALUES (${set.id}, ${q}, ${`Pertanyaan ${String(position)}.${String(q)}`}, ${options.points}, ${options.timerSeconds}, 'Penjelasan uji beban.')
          RETURNING id`);
        await tx`
          INSERT INTO public.question_options (question_id, position, label, is_correct)
          VALUES (${question.id}, 1, 'Benar', true), (${question.id}, 2, 'Salah', false), (${question.id}, 3, 'Keliru', false), (${question.id}, 4, 'Bukan', false)`;
      }
    }
    const players: TriviaLinks["players"][number][] = [];
    for (const [index, phone] of phones.entries()) {
      const player = first(await tx<{ id: string }[]>`INSERT INTO public.players (phone, name) VALUES (${phone}, ${`LT ${runId} #${String(index + 1)}`}) RETURNING id`);
      // One set unlocks per day from the first paid order (AC-Q4, A >= S): paid `sets + 1` days ago, every set is open.
      await tx`
        INSERT INTO public.player_programs (player_id, program_id, first_paid_at, eligible)
        VALUES (${player.id}, ${program.id}, now() - make_interval(days => ${options.sets + 1}), true)`;
      const link = issueMagicLink({ channel: "whatsapp" });
      await tx`SELECT public.issue_magic_link(${player.id}, 'whatsapp', ${link.tokenHash})`;
      players.push({ player_id: player.id, phone, token: link.token });
    }
    return { kind: "trivia" as const, run_id: runId, program_id: program.id, program_slug: slug, set_ids: setIds, questions_per_set: options.questions, timer_seconds: options.timerSeconds, players };
  });
}

export interface OrdersOptions {
  readonly runId: string;
  /** The host registered for the landing page; the load test sends `Origin: https://<host>`. */
  readonly lpHost: string;
  /** Where the adnet's MO and MT postbacks go (the operator's sink), https unless the worker runs with the dev flags. */
  readonly postbackUrl: string;
  readonly priceIdr: number;
}

export interface OrdersConfig {
  readonly kind: "orders";
  readonly run_id: string;
  readonly program_id: string;
  readonly landing_page_id: string;
  readonly lp_key: string;
  readonly lp_host: string;
  readonly adnet_id: string;
  readonly adnet_slug: string;
  readonly clickid_param: string;
  readonly price_idr: number;
  readonly terms_version: number;
  readonly privacy_version: number;
}

export async function seedOrders(sql: Sql, options: OrdersOptions): Promise<OrdersConfig> {
  const { runId } = options;
  // The adnet's endpoint host is the template's URL.host (with a non-default port), the form the secret binding and the host check compare.
  const postback = new URL(options.postbackUrl);
  return sql.begin(async (tx) => {
    const product = first(await tx<{ id: string }[]>`INSERT INTO public.products (title, price_idr) VALUES (${`LOADTEST ${runId} orders`}, ${options.priceIdr}) RETURNING id`);
    const program = first(await tx<{ id: string }[]>`
      INSERT INTO public.programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`lt-${runId}`}, ${`LOADTEST ${runId}`}, 'published', now() - interval '1 day', now() + interval '60 days', 30) RETURNING id`);
    const lpKey = `lp_load${runId}${randomBytes(4).toString("hex")}`;
    const lp = first(await tx<{ id: string }[]>`
      INSERT INTO public.landing_pages (lp_key, name, program_id, pixels) VALUES (${lpKey}, ${`LOADTEST ${runId}`}, ${program.id}, '{}'::jsonb) RETURNING id`);
    await tx`INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${lp.id}, ${options.lpHost})`;
    for (const [kind, title] of [
      ["terms", "Syarat dan Ketentuan (uji beban)"],
      ["privacy", "Kebijakan Privasi (uji beban)"],
    ] as const) {
      const page = first(await tx<{ id: string }[]>`INSERT INTO public.legal_pages (program_id, kind, version, title, body) VALUES (${program.id}, ${kind}, 1, ${title}, 'Halaman uji beban.') RETURNING id`);
      await tx`UPDATE public.legal_pages SET published_at = now() WHERE id = ${page.id}`;
    }
    const mo = `${postback.origin}${postback.pathname}?event=mo&clickid={clickid}&txid={txid}`;
    const mt = `${postback.origin}${postback.pathname}?event=mt&clickid={clickid}&txid={txid}&payout={payout}&status={status}`;
    const adnet = first(await tx<{ id: string }[]>`
      INSERT INTO public.adnets (slug, name, clickid_param, mo_url_template, mt_url_template, payout_idr, endpoint_host)
      VALUES (${`lt-${runId}`}, ${`LOADTEST ${runId}`}, 'clickid', ${mo}, ${mt}, 1000, ${postback.host.toLowerCase()}) RETURNING id`);
    await tx`INSERT INTO public.landing_page_adnets (landing_page_id, adnet_id) VALUES (${lp.id}, ${adnet.id})`;
    return {
      kind: "orders" as const,
      run_id: runId,
      program_id: program.id,
      landing_page_id: lp.id,
      lp_key: lpKey,
      lp_host: options.lpHost,
      adnet_id: adnet.id,
      adnet_slug: `lt-${runId}`,
      clickid_param: "clickid",
      price_idr: options.priceIdr,
      terms_version: 1,
      privacy_version: 1,
    };
  });
}

export interface CleanupReport {
  readonly kind: "trivia" | "orders";
  readonly removed: Readonly<Record<string, number>>;
}

/**
 * Removes (trivia) or retires (orders) everything of a run.
 *
 * trivia: players, their attempts, stats, links, player_auth users and sessions, then the program, its sets and
 *   questions and the product: all of it is load-test data, so it is deleted.
 * orders: orders, payments, deliveries and conversions are FINANCIAL and DELIVERY rows (append-only, restrict keys):
 *   they are kept, and the run is made harmless instead. The landing page, the adnet and the product are
 *   deactivated (no new order, no postback), and every delivery not sent yet and every conversion not sent yet is
 *   cancelled or failed, so that nothing reaches a load-test buyer when the WhatsApp sessions are switched back on.
 */
export async function cleanup(sql: Sql, runId: string): Promise<CleanupReport> {
  // A run id is 8 lower-case hex digits and the rows are the ones seed.ts named: cleanup never deletes anything else, however the program was slugged.
  if (!RUN_ID.test(runId)) throw new Error(`a run id is 8 lower-case hex digits (got ${JSON.stringify(runId)})`);
  const slug = `lt-${runId}`;
  const [program] = await sql<{ id: string; product_id: string; title: string; name: string }[]>`
    SELECT p.id, p.product_id, pr.title, p.name FROM public.programs p JOIN public.products pr ON pr.id = p.product_id WHERE p.slug = ${slug}`;
  if (program === undefined) throw new Error(`no program ${slug}: nothing to clean up for run ${runId}`);
  if (program.name !== `LOADTEST ${runId}` || (program.title !== `LOADTEST ${runId} trivia` && program.title !== `LOADTEST ${runId} orders`)) {
    throw new Error(`program ${slug} is not a load-test program of run ${runId} (its name or its product is not LOADTEST ${runId}): refusing to delete it`);
  }
  // An orders run has a landing page (and maybe orders, which are never deleted); a trivia run has neither.
  const [ordersRun] = await sql<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM public.landing_pages WHERE program_id = ${program.id}) + (SELECT count(*) FROM public.orders WHERE program_id = ${program.id}))::int AS n`;
  if ((ordersRun?.n ?? 0) > 0) return retireOrders(sql, runId, program.id, program.product_id);
  return deleteTrivia(sql, runId, program.id, program.product_id);
}

async function deleteTrivia(sql: Sql, runId: string, programId: string, productId: string): Promise<CleanupReport> {
  const removed: Record<string, number> = {};
  await sql.begin(async (tx) => {
    const players = await tx<{ id: string; auth_user_id: string | null }[]>`
      SELECT p.id, p.auth_user_id FROM public.players p
       WHERE p.name LIKE ${`LT ${runId} #%`} AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.program_id = ${programId})`;
    const ids = players.map((p) => p.id);
    const authIds = players.flatMap((p) => (p.auth_user_id === null ? [] : [p.auth_user_id]));
    const count = (rows: { readonly count: number }): number => rows.count;
    if (ids.length > 0) {
      removed["attempt_questions"] = count(await tx`DELETE FROM public.attempt_questions WHERE attempt_id IN (SELECT id FROM public.set_attempts WHERE player_id IN ${tx(ids)})`);
      removed["set_attempts"] = count(await tx`DELETE FROM public.set_attempts WHERE player_id IN ${tx(ids)}`);
      removed["player_program_stats"] = count(await tx`DELETE FROM public.player_program_stats WHERE player_id IN ${tx(ids)}`);
      removed["player_programs"] = count(await tx`DELETE FROM public.player_programs WHERE player_id IN ${tx(ids)}`);
      removed["players"] = count(await tx`DELETE FROM public.players WHERE id IN ${tx(ids)}`);
    }
    if (authIds.length > 0) {
      removed["player_auth_users"] = count(await tx`DELETE FROM player_auth."user" WHERE id IN ${tx(authIds)}`);
    }
    removed["question_options"] = count(await tx`DELETE FROM public.question_options WHERE question_id IN (SELECT q.id FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id WHERE s.program_id = ${programId})`);
    removed["questions"] = count(await tx`DELETE FROM public.questions WHERE set_id IN (SELECT id FROM public.trivia_sets WHERE program_id = ${programId})`);
    removed["trivia_sets"] = count(await tx`DELETE FROM public.trivia_sets WHERE program_id = ${programId}`);
    removed["programs"] = count(await tx`DELETE FROM public.programs WHERE id = ${programId}`);
    removed["products"] = count(await tx`DELETE FROM public.products WHERE id = ${productId}`);
  });
  return { kind: "trivia", removed };
}

async function retireOrders(sql: Sql, runId: string, programId: string, productId: string): Promise<CleanupReport> {
  const removed: Record<string, number> = {};
  await sql.begin(async (tx) => {
    removed["landing_pages_deactivated"] = (await tx`UPDATE public.landing_pages SET active = false WHERE program_id = ${programId} AND active`).count;
    removed["adnets_deactivated"] = (await tx`UPDATE public.adnets SET active = false WHERE slug = ${`lt-${runId}`} AND active`).count;
    removed["products_deactivated"] = (await tx`UPDATE public.products SET active = false WHERE id = ${productId} AND active`).count;
    removed["deliveries_cancelled"] = (
      await tx`
        UPDATE public.deliveries SET status = 'cancelled', last_error = 'loadtest_cleanup', updated_at = now()
         WHERE status IN ('pending', 'unknown') AND order_id IN (SELECT id FROM public.orders WHERE program_id = ${programId})`
    ).count;
    removed["conversions_failed"] = (
      await tx`
        UPDATE public.conversion_events SET status = 'failed', failed_at = now(), last_error = 'loadtest_cleanup', updated_at = now()
         WHERE status = 'pending' AND order_id IN (SELECT id FROM public.orders WHERE program_id = ${programId})`
    ).count;
  });
  return { kind: "orders", removed };
}
