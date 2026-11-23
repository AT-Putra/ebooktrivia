// LOCAL end-to-end run of the demo tools at small scale, against the dev stack (infra/dev: PostgreSQL, Valkey, Mailpit), to prove that
// `seed.ts demo`, `demo-play.ts` and `seed.ts cleanup` work through the REAL public app (login route, play API, Better Auth sessions) and that
// the real worker, running all the while, finds nothing to send. Like local-dry-run.ts, whose stack set-up it follows.
//
//   node infra/load/src/local-demo-run.ts            (Git Bash on Windows or Linux; Docker running; asks the lead for "go" first)
//
// It starts a throwaway migrated database, the production build of apps/public (`next start`, port 3410, built first; SKIP_BUILD=1 reuses the
// build) and the real worker process; makes a program (4 sets of 3 questions, sales open 3 days); runs the three tools as their CLIs; prints
// the leaderboard and what the worker and Mailpit saw; and tears everything down. Ports: 3410 on 127.0.0.1.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_VALKEY_LIBRARY_CODE } from "@ebooktrivia/adapters/valkey-functions";
import { createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import { loadValkeyFunctions } from "@ebooktrivia/test-support/valkey";
import postgres from "postgres";
import { parseDemoFile } from "./demo-plan.ts";
import { createDemoFixture } from "./demo-fixture.ts";

const PUBLIC_PORT = 3410;
const DOMAIN = "ebooktrivia.example.test";
const STUB_KEY = "SB-Mid-server-DEVONLY"; // DEV ONLY (infra/dev/compose.yaml)
const BUYERS = Number(process.env["DEMO_BUYERS"] ?? 3);

const here = fileURLToPath(new URL("./", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const publicDir = join(repo, "apps/public");
const workDir = join(repo, "infra/load/work/demo-run");
const log = (line: string): void => void process.stderr.write(`demo-run: ${line}\n`);

const children: ChildProcess[] = [];
const baseEnv = { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", TEMP: process.env["TEMP"] ?? "", TMP: process.env["TMP"] ?? "" };

function node(script: string, args: readonly string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, script), ...args], { env: { ...baseEnv, ...env }, stdio: "inherit" });
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

async function waitFor(what: string, probe: () => Promise<boolean>, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!(await probe().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`${what} did not become ready`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const db = await createTestDatabase("ebt_ldemo", ["public_rw", "worker_rw"]);
  const sql = postgres(db.url, { max: 4, onnotice: () => undefined });
  const prefix = `ltdemo${randomBytes(3).toString("hex")}`;
  const report: Record<string, unknown> = { scope: "LOCAL end-to-end run of the demo tools on the dev stack, small scale" };
  try {
    // --- the throwaway deployment (as a staging database is prepared: the marker, WhatsApp off)
    await sql`INSERT INTO public.app_settings (key, value) VALUES ('deployment.environment', '"dev"')`;
    await sql`UPDATE public.app_settings SET value = to_jsonb(${86_400}::int) WHERE key = 'delivery.wa_delay_seconds'`;
    const payment = generateScopeKeyPair();
    const messaging = generateScopeKeyPair();
    const conversions = generateScopeKeyPair();
    const sealed = createSecretSealer({ payment: payment.publicKey }).sealSecret({ scope: "payment", name: SECRET_NAMES.midtransServerKey("sandbox"), adnetId: null, boundHost: null, plaintext: STUB_KEY });
    await sql`
      INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
    await sql`DELETE FROM smtp_settings`;
    await sql`INSERT INTO smtp_settings (host, port, security, from_address, from_name) VALUES ('127.0.0.1', 51025, 'starttls', 'noreply@example.test', 'Toko Uji')`;
    // The program the Owner would have made in the console, before its first sale.
    const program = await createDemoFixture(sql, { sets: 4, questions: 3, salesStartDaysAgo: 3, pixel: true });

    // --- the apps
    if (process.env["SKIP_BUILD"] !== "1" || !existsSync(join(publicDir, ".next/BUILD_ID"))) {
      log("building apps/public");
      const built = spawnSync("pnpm", ["--filter", "@ebooktrivia/public", "run", "build"], { cwd: repo, stdio: "inherit", shell: true });
      if (built.status !== 0) throw new Error("the public app did not build");
    }
    const valkey = { VALKEY_URL: "redis://127.0.0.1:56379" };
    await loadValkeyFunctions({ url: valkey.VALKEY_URL, username: "worker", password: "worker-devonly" }, PUBLIC_VALKEY_LIBRARY_CODE); // DEV ONLY
    const publicOrigin = `http://127.0.0.1:${String(PUBLIC_PORT)}`;
    const nextBin = createRequire(`${publicDir}/package.json`).resolve("next/dist/bin/next");
    children.push(
      spawn(process.execPath, [nextBin, "start", "-p", String(PUBLIC_PORT)], {
        cwd: publicDir,
        env: {
          ...baseEnv,
          NODE_ENV: "test",
          DOMAIN,
          DATABASE_URL_PUBLIC: db.logins.public_rw ?? "",
          ...valkey,
          VALKEY_USERNAME: "public",
          VALKEY_PASSWORD: "public-devonly", // DEV ONLY
          CAPTCHA_HMAC_KEY: randomBytes(32).toString("hex"),
          SECRETS_PAYMENT_PRIVATE_KEY: payment.privateKey.toString("base64url"),
          SECRETS_MESSAGING_PUBLIC_KEY: messaging.publicKey.toString("base64url"),
          PLAYER_AUTH_SECRETS: `1:${randomBytes(32).toString("hex")}`,
          PLAYER_OTP_PEPPER: randomBytes(32).toString("hex"),
          PUBLIC_DEV_PLAY_ORIGIN: publicOrigin,
        },
        stdio: ["ignore", openSync(join(workDir, "public.log"), "a"), openSync(join(workDir, "public.log"), "a")],
      }),
    );
    children.push(
      spawn(process.execPath, [join(repo, "apps/worker/src/main.ts"), "--role=worker"], {
        cwd: join(repo, "apps/worker"),
        env: {
          ...baseEnv,
          NODE_ENV: "test",
          DOMAIN,
          DATABASE_URL_WORKER: db.logins.worker_rw ?? "",
          ...valkey,
          VALKEY_USERNAME: "worker",
          VALKEY_PASSWORD: "worker-devonly", // DEV ONLY
          BULLMQ_PREFIX: prefix,
          SECRETS_PAYMENT_PRIVATE_KEY: payment.privateKey.toString("base64url"),
          SECRETS_MESSAGING_PRIVATE_KEY: messaging.privateKey.toString("base64url"),
          SECRETS_CONVERSIONS_PRIVATE_KEY: conversions.privateKey.toString("base64url"),
          WORKER_DATA_DIR: workDir,
          WORKER_DEV_ALLOW_HTTP: "1",
          WORKER_DEV_ALLOW_LOOPBACK: "1",
          WORKER_DEV_ALLOW_PLAINTEXT_SMTP: "1",
          WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        },
        stdio: ["ignore", openSync(join(workDir, "worker.log"), "a"), openSync(join(workDir, "worker.log"), "a")],
      }),
    );
    await waitFor("the public app", async () => (await fetch(`${publicOrigin}/login`)).status === 200, 120);
    await waitFor("the worker", async () => (await sql`SELECT 1 FROM heartbeats LIMIT 1`).length > 0, 60);
    log("stack up");

    // --- the three tools, as their CLIs
    const target = { LOAD_DATABASE_URL: db.url, LOAD_TARGET_ENV: "dev" };
    const demoFile = join(workDir, "demo.json");
    const seedCode = await node("seed.ts", ["demo", "--program-slug", program.slug, "--buyers", String(BUYERS), "--seed", "2026", "--accept-program-lock", "--out", demoFile], target);
    if (seedCode !== 0) throw new Error("seed demo failed");
    const planned = parseDemoFile(readFileSync(demoFile, "utf8"));
    // DEMO_FORCE_TIMEOUTS=1: buyer 1 leaves every question of its one set to run out its timer, to see the server close them as timeouts (about 3 x 22 s of real time).
    const demo =
      process.env["DEMO_FORCE_TIMEOUTS"] === "1"
        ? { ...planned, buyers: planned.buyers.map((b, i) => (i === 0 ? { ...b, plan: { ...b.plan, timeout_rate: 1, sets_to_play: 1, abandon_last_set: false } } : b)) }
        : planned;
    writeFileSync(demoFile, `${JSON.stringify(demo)}\n`);
    const started = Date.now();
    const playCode = await node("demo-play.ts", ["--base", publicOrigin, "--in", demoFile, "--concurrency", "3", "--speed", "60"], {});
    report["demo_play"] = { exit_code: playCode, seconds: Math.round((Date.now() - started) / 1000) };
    // Let the worker's sweeps run once more over the committed rows before looking.
    await new Promise((r) => setTimeout(r, 4000));

    // --- what the database and the worker say now
    report["plan"] = demo.buyers.map((b) => ({ label: b.label, ...b.plan }));
    report["leaderboard"] = await sql`
      SELECT r.rank, pl.name, r.score, r.total_ms, r.sets_completed, to_char(pp.first_paid_at, 'YYYY-MM-DD') AS paid_day
        FROM public.play_ranking(${demo.program_id}) r JOIN public.players pl ON pl.id = r.player_id
        JOIN public.player_programs pp ON pp.player_id = r.player_id AND pp.program_id = ${demo.program_id} ORDER BY r.rank`;
    report["attempts"] = await sql`
      SELECT pl.email, count(*)::int AS sets_started, count(a.finished_at)::int AS sets_finished, coalesce(sum(a.score), 0)::int AS score
        FROM public.set_attempts a JOIN public.players pl ON pl.id = a.player_id WHERE pl.email LIKE ${`demo-${demo.run_id}-%`} GROUP BY pl.email ORDER BY pl.email`;
    report["answers"] = await sql`
      SELECT count(*) FILTER (WHERE aq.option_id IS NOT NULL)::int AS answered, count(*) FILTER (WHERE aq.correct)::int AS correct,
             count(*) FILTER (WHERE aq.option_id IS NULL AND aq.answered_at IS NOT NULL)::int AS timed_out, count(*) FILTER (WHERE aq.answered_at IS NULL)::int AS unanswered
        FROM public.attempt_questions aq JOIN public.set_attempts a ON a.id = aq.attempt_id JOIN public.players pl ON pl.id = a.player_id WHERE pl.email LIKE ${`demo-${demo.run_id}-%`}`;
    report["sessions_made_by_the_app"] = await sql`SELECT count(*)::int AS sessions FROM player_auth.session s JOIN player_auth."user" u ON u.id = s."userId" JOIN public.players pl ON pl.auth_user_id = u.id WHERE pl.email LIKE ${`demo-${demo.run_id}-%`}`;
    report["nothing_sendable"] = await sql`
      SELECT (SELECT count(*)::int FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id WHERE o.buyer_email LIKE ${`demo-${demo.run_id}-%`} AND d.status <> 'cancelled') AS deliveries_not_cancelled,
             (SELECT count(*)::int FROM public.deliveries d JOIN public.orders o ON o.id = d.order_id WHERE o.buyer_email LIKE ${`demo-${demo.run_id}-%`} AND d.attempts > 0) AS deliveries_attempted,
             (SELECT count(*)::int FROM public.conversion_events c JOIN public.orders o ON o.id = c.order_id WHERE o.buyer_email LIKE ${`demo-${demo.run_id}-%`}) AS conversion_rows,
             (SELECT count(*)::int FROM public.waha_sends) AS waha_sends, (SELECT count(*)::int FROM public.alerts) AS alerts_after_the_run`;
    const mail = await fetch(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent("to:example.com")}`)
      .then(async (r) => ((await r.json()) as { messages_count?: number }).messages_count ?? -1)
      .catch(() => -1);
    report["mailpit_messages_to_example_com"] = mail;

    // --- cleanup, as the CLI, then every table again
    const cleanupCode = await node("seed.ts", ["cleanup", "--run", demo.run_id], target);
    const like = `demo-${demo.run_id}-%`;
    report["cleanup"] = {
      exit_code: cleanupCode,
      left_after_cleanup: (
        await sql`
        SELECT (SELECT count(*)::int FROM public.orders WHERE buyer_email LIKE ${like}) AS orders,
               (SELECT count(*)::int FROM public.payments WHERE gateway_txn_id LIKE ${like}) AS payments,
               (SELECT count(*)::int FROM public.players WHERE email LIKE ${like}) AS players,
               (SELECT count(*)::int FROM public.player_programs WHERE program_id = ${demo.program_id}) AS player_programs,
               (SELECT count(*)::int FROM public.set_attempts a JOIN public.trivia_sets s ON s.id = a.set_id WHERE s.program_id = ${demo.program_id}) AS set_attempts,
               (SELECT count(*)::int FROM public.player_program_stats WHERE program_id = ${demo.program_id}) AS stats,
               (SELECT count(*)::int FROM player_auth.session) AS auth_sessions, (SELECT count(*)::int FROM player_auth."user") AS auth_users,
               (SELECT count(*)::int FROM public.magic_links) AS magic_links, (SELECT count(*)::int FROM public.play_ranking(${demo.program_id})) AS leaderboard_rows`
      )[0],
    };
    await sql`SELECT public.refresh_report_rollups()`;
    report["sales_report_rows_after_cleanup"] = (await sql`SELECT coalesce(sum(orders), 0)::int AS orders FROM public.report_orders_daily WHERE program_id = ${demo.program_id}`)[0];
    report["ok"] = playCode === 0 && cleanupCode === 0;
  } finally {
    for (const child of children) child.kill();
    await sql.end({ timeout: 5 });
    await db.drop();
    spawnSync("docker", ["exec", "ebooktrivia-dev-valkey-1", "sh", "-c", `valkey-cli --user worker --pass worker-devonly --no-auth-warning --scan --pattern '${prefix}:*' | xargs -r valkey-cli --user worker --pass worker-devonly --no-auth-warning unlink`], { stdio: "ignore" });
  }
  writeFileSync(join(workDir, "demo-run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report["ok"] === true ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : "demo run failed"}\n`);
  for (const child of children) child.kill();
  process.exit(1);
});
