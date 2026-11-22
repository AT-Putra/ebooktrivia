// The seed and cleanup against the real schema (the migrated dev database), and the guard against a real
// app_settings table: the marker row is what makes the tool run, and a production-like database is refused.
import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import { assertLoadTarget, assertLoadtestLandingPage, assertWhatsAppOff, LoadGuardError } from "../src/guard.ts";
import { cleanup, newRunId, seedOrders, seedTrivia } from "../src/seed-lib.ts";

const url = inject("loadDbUrl");
const sql = postgres(url, { max: 4, onnotice: () => undefined });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const count = async (query: Promise<postgres.RowList<{ n: number }[]>>): Promise<number> => (await query)[0]?.n ?? -1;

describe("the guard against a real database", () => {
  it("accepts the marked dev database", async () => {
    await expect(assertLoadTarget(sql, url, { LOAD_TARGET_ENV: "dev" })).resolves.toBe("dev");
  });

  it("refuses it as staging (another marker), without the marker, and once Midtrans runs in production", async () => {
    await expect(assertLoadTarget(sql, url, { LOAD_TARGET_ENV: "staging" })).rejects.toThrow(/deployment\.environment/);
    await sql`UPDATE public.app_settings SET value = '"production"' WHERE key = 'midtrans.environment'`;
    try {
      await expect(assertLoadTarget(sql, url, { LOAD_TARGET_ENV: "dev" })).rejects.toBeInstanceOf(LoadGuardError);
    } finally {
      await sql`UPDATE public.app_settings SET value = '"sandbox"' WHERE key = 'midtrans.environment'`;
    }
    await sql`DELETE FROM public.app_settings WHERE key = 'deployment.environment'`;
    try {
      await expect(assertLoadTarget(sql, url, { LOAD_TARGET_ENV: "dev" })).rejects.toThrow(/no deployment\.environment row/);
    } finally {
      await sql`INSERT INTO public.app_settings (key, value) VALUES ('deployment.environment', '"dev"')`;
    }
  });
});

describe("seedTrivia and cleanup", () => {
  it("makes eligible players with one live link each, every set unlocked, and removes everything it made", async () => {
    const runId = newRunId();
    const links = await seedTrivia(sql, { runId, players: 6, sets: 4, questions: 3, timerSeconds: 20, points: 10 });
    expect(links.players).toHaveLength(6);
    expect(new Set(links.players.map((p) => p.phone)).size).toBe(6);
    expect(links.set_ids).toHaveLength(4);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.questions q JOIN public.trivia_sets s ON s.id = q.set_id WHERE s.program_id = ${links.program_id}`)).toBe(12);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.player_programs WHERE program_id = ${links.program_id} AND eligible`)).toBe(6);
    // The link in the file is the one in the database (hash of the token), unconsumed.
    const [first] = links.players;
    const hash = createHash("sha256").update(first?.token ?? "", "utf8").digest();
    expect(await count(sql`SELECT count(*)::int AS n FROM public.magic_links WHERE player_id = ${first?.player_id ?? ""} AND token_hash = ${hash} AND consumed_at IS NULL`)).toBe(1);
    // Every set is open: the LAST set starts (play_start_set refuses a locked one with ET142), and nothing was ever ordered or sent.
    const attempt = await sql<{ id: string }[]>`SELECT public.play_start_set(${first?.player_id ?? ""}, ${links.set_ids.at(-1) ?? ""}) AS id`;
    expect(attempt[0]?.id).toBeTruthy();
    await sql`SELECT public.play_current(${first?.player_id ?? ""}, ${attempt[0]?.id ?? ""}, '203.0.113.7'::inet, NULL)`;
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE program_id = ${links.program_id}`)).toBe(0);

    const report = await cleanup(sql, runId);
    expect(report.kind).toBe("trivia");
    expect(report.removed["players"]).toBe(6);
    expect(report.removed["set_attempts"]).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.players WHERE name LIKE ${`LT ${runId} #%`}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.programs WHERE slug = ${`lt-${runId}`}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.products WHERE title LIKE ${`LOADTEST ${runId}%`}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.magic_links WHERE player_id = ${first?.player_id ?? ""}`)).toBe(0);
  });

  it("leaves another run's data alone", async () => {
    const keep = await seedTrivia(sql, { runId: newRunId(), players: 2, sets: 1, questions: 1, timerSeconds: 20, points: 10 });
    const drop = newRunId();
    await seedTrivia(sql, { runId: drop, players: 2, sets: 1, questions: 1, timerSeconds: 20, points: 10 });
    await cleanup(sql, drop);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.player_programs WHERE program_id = ${keep.program_id}`)).toBe(2);
    await cleanup(sql, keep.run_id);
  });

  it("refuses to clean up a run that does not exist", async () => {
    await expect(cleanup(sql, "00000000")).rejects.toThrow(/nothing to clean up/);
  });

  // Review item 3: cleanup deletes only what seed.ts made.
  it("refuses a run id that is not 8 hex digits, and a program that merely carries the slug of a run", async () => {
    for (const bad of ["", "ABCDEF12", "abcdef1", "abcdef123", "abcdefg1", "lt-abcdef12", "x' OR '1'='1"]) {
      await expect(cleanup(sql, bad), bad).rejects.toThrow(/8 lower-case hex digits/);
    }
    // A real program (a real product) that happens to have the slug lt-<id>: it is not a load-test row, so nothing is deleted.
    const runId = newRunId();
    const [product] = await sql<{ id: string }[]>`INSERT INTO public.products (title, price_idr) VALUES ('Ebook Asli', 49000) RETURNING id`;
    await sql`
      INSERT INTO public.programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product?.id ?? ""}, ${`lt-${runId}`}, 'Program Asli', 'published', now() - interval '1 day', now() + interval '30 days', 30)`;
    await expect(cleanup(sql, runId)).rejects.toThrow(/not a load-test program/);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.programs WHERE slug = ${`lt-${runId}`}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.products WHERE id = ${product?.id ?? ""}`)).toBe(1);
  });
});

describe("the landing page guard of settle.ts", () => {
  it("accepts a load-test landing page and refuses an unknown one and a real one", async () => {
    const runId = newRunId();
    const config = await seedOrders(sql, { runId, lpHost: `lt-${runId}.example.test`, postbackUrl: "https://sink.example.test/postback", priceIdr: 10_000 });
    await expect(assertLoadtestLandingPage(sql, config.lp_key)).resolves.toBeUndefined();
    await expect(assertLoadtestLandingPage(sql, "lp_doesnotexist1")).rejects.toThrow(/no landing page/);
    await sql`UPDATE public.landing_pages SET name = 'Halaman Asli' WHERE id = ${config.landing_page_id}`;
    await expect(assertLoadtestLandingPage(sql, config.lp_key)).rejects.toThrow(/not a load-test landing page/);
  });
});

// Review item 2: an orders run is refused while WhatsApp could send to the (real-looking) synthetic numbers.
describe("assertWhatsAppOff against the real tables", () => {
  const setDelay = (seconds: number) => sql`UPDATE public.app_settings SET value = to_jsonb(${seconds}::int) WHERE key = 'delivery.wa_delay_seconds'`;

  it("refuses the default delay, accepts a day, and refuses an active WAHA session until it is made inactive", async () => {
    await setDelay(180);
    await expect(assertWhatsAppOff(sql)).rejects.toThrow(/wa_delay_seconds/);
    await setDelay(86_400);
    await expect(assertWhatsAppOff(sql)).resolves.toBeUndefined();
    const [server] = await sql<{ id: string }[]>`INSERT INTO public.waha_servers (name, base_url, base_url_host) VALUES ('Uji', 'https://waha.example.test', 'waha.example.test') RETURNING id`;
    const [session] = await sql<{ id: string }[]>`INSERT INTO public.waha_sessions (server_id, session_name) VALUES (${server?.id ?? ""}, 'uji') RETURNING id`;
    await expect(assertWhatsAppOff(sql)).rejects.toThrow(/WAHA session\(s\) are active/);
    await sql`UPDATE public.waha_sessions SET active = false WHERE id = ${session?.id ?? ""}`;
    await expect(assertWhatsAppOff(sql)).resolves.toBeUndefined();
    await setDelay(3599);
    await expect(assertWhatsAppOff(sql)).rejects.toThrow(/not at least 3600/);
    await setDelay(180);
  });
});

describe("seedOrders and cleanup", () => {
  it("makes an open landing page with an adnet and a published legal pair, and retires it with its unsent effects", async () => {
    const runId = newRunId();
    const config = await seedOrders(sql, { runId, lpHost: `lt-${runId}.example.test`, postbackUrl: "https://sink.example.test/postback", priceIdr: 10_000 });
    expect(config.lp_key).toMatch(/^lp_[0-9A-Za-z]{8,40}$/);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.landing_page_adnets WHERE landing_page_id = ${config.landing_page_id}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.legal_pages WHERE program_id = ${config.program_id} AND published_at IS NOT NULL`)).toBe(2);
    const [adnet] = await sql<{ mt: string; host: string }[]>`SELECT mt_url_template AS mt, endpoint_host AS host FROM public.adnets WHERE id = ${config.adnet_id}`;
    expect(adnet).toEqual({ mt: "https://sink.example.test/postback?event=mt&clickid={clickid}&txid={txid}&payout={payout}&status={status}", host: "sink.example.test" });

    // An order of the run (what the checkout would have made) with its unsent deliveries and a pending MT.
    const [order] = await sql<{ id: string }[]>`
      INSERT INTO public.orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at, adnet_id, clickid)
      SELECT ${`Pub${runId}${runId}${runId}`}, ${`ABCD${runId.slice(0, 4).toUpperCase().replace(/[IOLU]/g, "X")}`}, ${config.landing_page_id}, ${config.program_id}, p.product_id, 'Budi', '+6281200001111', 'budi@example.test',
             ${createHash("sha256").update(runId).digest()}, 10000, 'pending', now() + interval '1 hour', ${config.adnet_id}, 'click1'
        FROM public.programs p WHERE p.id = ${config.program_id}
      RETURNING id`;
    await sql`UPDATE public.orders SET status = 'paid', paid_at = now() WHERE id = ${order?.id ?? ""}`;
    await sql`INSERT INTO public.deliveries (order_id, channel) VALUES (${order?.id ?? ""}, 'email'), (${order?.id ?? ""}, 'whatsapp')`;
    const report = await cleanup(sql, runId);
    expect(report.kind).toBe("orders");
    expect(report.removed["landing_pages_deactivated"]).toBe(1);
    expect(report.removed["deliveries_cancelled"]).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.deliveries WHERE order_id = ${order?.id ?? ""} AND status = 'cancelled'`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM public.landing_pages WHERE id = ${config.landing_page_id} AND NOT active`)).toBe(1);
    // The order itself (a financial row) is kept.
    expect(await count(sql`SELECT count(*)::int AS n FROM public.orders WHERE id = ${order?.id ?? ""}`)).toBe(1);
  });

  it("registers the adnet's endpoint host the way the templates name it: URL.host, with a non-default port (the dry run's loopback sink)", async () => {
    const runId = newRunId();
    const config = await seedOrders(sql, { runId, lpHost: `lt-${runId}.example.test`, postbackUrl: "http://127.0.0.1:3412/postback", priceIdr: 10_000 });
    const [adnet] = await sql<{ host: string }[]>`SELECT endpoint_host AS host FROM public.adnets WHERE id = ${config.adnet_id}`;
    expect(adnet?.host).toBe("127.0.0.1:3412");
    await cleanup(sql, runId);
  });
});
