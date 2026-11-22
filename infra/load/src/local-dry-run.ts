// LOCAL dry run of both load tests at small scale, against the dev stack (infra/dev: PostgreSQL, Valkey, Mailpit, midtrans-stub), to
// prove that the scripts, the seed, the login, the Cap pool, the settlement and the AC-P8 verifier work end to end. Its numbers are
// LOCAL ONLY and never the AC result (that is staging, 4 vCPU / 8 GB, 500 VUs / 50 orders a minute).
//
//   node infra/load/src/local-dry-run.ts            (Git Bash on Windows or Linux; Docker running; asks the lead for "go" first)
//
// What it starts: a throwaway migrated database; the production build of apps/public (`next start`, port 3410, built first when there is no
// build); the real worker process (apps/worker/src/main.ts: payments, deliveries to Mailpit, conversions to a loopback sink on port 3412);
// k6 from the pinned Docker image through run.sh. It tears everything down and drops the database at the end.
// Ports: 3410 (public app) and 3412 (postback sink), both on 127.0.0.1.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_VALKEY_LIBRARY_CODE } from "@ebooktrivia/adapters/valkey-functions";
import { createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import { loadValkeyFunctions } from "@ebooktrivia/test-support/valkey";
import postgres from "postgres";
import { assertWhatsAppOff } from "./guard.ts";
import { pendingOrders, settleLoop } from "./settle.ts";
import { parseRunFile, verifyAcP8 } from "./verify-p8.ts";

const PUBLIC_PORT = 3410;
const SINK_PORT = 3412;
const DOMAIN = "ebooktrivia.example.test";
const STUB_URL = "http://127.0.0.1:53001";
const STUB_KEY = "SB-Mid-server-DEVONLY"; // DEV ONLY (infra/dev/compose.yaml)
const LP_HOST = "lt-dry.example.test";
const EMAIL_DOMAIN = "load.example.test";
const PLAYERS = 10;
const SETS = 5;
const QUESTIONS = 6;
const ORDERS_PER_MIN = 20;
const ORDERS_MINUTES = 2;

const here = fileURLToPath(new URL("./", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const publicDir = join(repo, "apps/public");
// The harness's OWN directory: it wipes only this (never infra/load/work itself, where an operator's links, cookies and tokens may be).
const workDir = join(repo, "infra/load/work/dry-run");
const log = (line: string): void => void process.stderr.write(`dry-run: ${line}\n`);

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

function bashRun(arg: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bash", [join(here, "..", "run.sh"), arg], { env: { ...baseEnv, WORK_DIR: workDir, ...env }, stdio: "inherit" });
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

const num = (v: unknown): number => Number(v ?? 0);

async function main(): Promise<void> {
  // SKIP_TRIVIA=1 repeats only the orders leg and keeps the trivia files of an earlier run.
  const skipTrivia = process.env["SKIP_TRIVIA"] === "1";
  if (skipTrivia) for (const old of ["data", "orders-config.json", "cap-pool.json", "results/orders-50pm-summary.json"]) rmSync(join(workDir, old), { recursive: true, force: true });
  else rmSync(workDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "data/deliverables"), { recursive: true });
  const db = await createTestDatabase("ebt_ldry", ["public_rw", "worker_rw"]);
  const dbName = new URL(db.url).pathname.slice(1);
  const sql = postgres(db.url, { max: 4, onnotice: () => undefined });
  const prefix = `ltdry${randomBytes(3).toString("hex")}`;
  let sink: ReturnType<typeof createServer> | undefined;
  const report: Record<string, unknown> = { scope: "LOCAL dry run only: small scale on the dev stack, never the AC result" };
  try {
    // --- the throwaway deployment
    await sql`INSERT INTO public.app_settings (key, value) VALUES ('deployment.environment', '"dev"')`;
    await sql.unsafe(`ALTER DATABASE ${dbName} SET track_functions = 'all'`);
    // WhatsApp is off for an orders run (seed.ts and settle.ts enforce it): no WAHA session exists in this database, and the proactive delay is a day.
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

    // --- the postback sink: counts every MO / MT call by txid (an independent check for duplicate MTs)
    const hits = new Map<string, number>();
    sink = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(SINK_PORT)}`);
      const key = `${url.searchParams.get("event") ?? "?"}|${url.searchParams.get("txid") ?? "?"}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      response.end("ok");
    }).listen(SINK_PORT, "127.0.0.1");

    // --- the apps
    // Always built (incremental: seconds when nothing changed): a build left over from before a rebase runs the OLD code (the review run of
    // 2026-11-22 answered 503 because its stale build still used EVAL, which the new Valkey ACL refuses). SKIP_BUILD=1 reuses the build.
    if (process.env["SKIP_BUILD"] !== "1" || !existsSync(join(publicDir, ".next/BUILD_ID"))) {
      log("building apps/public");
      const built = spawnSync("pnpm", ["--filter", "@ebooktrivia/public", "run", "build"], { cwd: repo, stdio: "inherit", shell: true });
      if (built.status !== 0) throw new Error("the public app did not build");
    }
    const valkey = { VALKEY_URL: "redis://127.0.0.1:56379" };
    // US-031: public may only FCALL its rate-limit function, so the library must be loaded BEFORE public starts (the worker also loads it at its
    // start and on every reconnect, as in production; this load is what e2e/support does, so public never answers 503 on a rate-limited route).
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
          PUBLIC_DEV_MIDTRANS_STUB_URL: STUB_URL,
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
          WORKER_DATA_DIR: join(workDir, "data"),
          WORKER_DEV_ALLOW_HTTP: "1",
          WORKER_DEV_ALLOW_LOOPBACK: "1",
          WORKER_DEV_ALLOW_PLAINTEXT_SMTP: "1",
          WORKER_DEV_MIDTRANS_STUB_URL: STUB_URL,
          WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        },
        stdio: ["ignore", openSync(join(workDir, "worker.log"), "a"), openSync(join(workDir, "worker.log"), "a")],
      }),
    );
    await waitFor("the public app", async () => (await fetch(`${publicOrigin}/login`)).status === 200, 90);
    await waitFor("the worker", async () => (await sql`SELECT 1 FROM heartbeats LIMIT 1`).length > 0, 60);
    log("stack up");

    const target = { LOAD_DATABASE_URL: db.url, LOAD_TARGET_ENV: "dev" };
    const k6Local = { BASE_URL: `http://host.docker.internal:${String(PUBLIC_PORT)}`, HOST_HEADER: `127.0.0.1:${String(PUBLIC_PORT)}` };

    let triviaCode = 0;
    if (!skipTrivia) {
      // --- trivia-500, at 10 VUs
      if ((await node("seed.ts", ["trivia", "--players", String(PLAYERS), "--sets", String(SETS), "--questions", String(QUESTIONS), "--out", join(workDir, "links.json")], target)) !== 0) throw new Error("seed trivia failed");
      if ((await node("login.ts", ["--play-origin", publicOrigin, "--links", join(workDir, "links.json"), "--out", join(workDir, "sessions.json")], {})) !== 0) throw new Error("login failed");
      const triviaStart = Date.now();
      triviaCode = await bashRun("trivia", { VUS: String(PLAYERS), RAMP_SECONDS: "10", HOLD_SECONDS: "60", THINK_MIN_MS: "1000", THINK_MAX_MS: "3000", PLAY_ORIGIN: publicOrigin, ...k6Local });
      report["trivia"] = { k6_exit_code: triviaCode, seconds: Math.round((Date.now() - triviaStart) / 1000), summary_file: "infra/load/work/results/trivia-500-summary.json" };
      await new Promise((r) => setTimeout(r, 3000));
      report["answer_path_functions"] = await sql`
        SELECT funcname, calls::int AS calls, round((total_time / calls)::numeric, 2)::float AS avg_ms
          FROM pg_stat_user_functions WHERE funcname LIKE 'play\\_%' AND calls > 0 ORDER BY funcname`;
      report["answer_path_static_statements"] = await sql`
        SELECT p.proname AS funcname, (SELECT count(*)::int FROM regexp_matches(p.prosrc, '^\\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|PERFORM|WITH)\\M', 'gim')) AS statements
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('play_answer', 'play_settle', 'play_reveal', 'play_current', 'play_start_set') ORDER BY 1`;
    }

    // --- orders-50pm, at 20 a minute for 2 minutes, settled through the stub's signed notifications
    if ((await node("seed.ts", ["orders", "--lp-host", LP_HOST, "--postback-url", `http://127.0.0.1:${String(SINK_PORT)}/postback`, "--out", join(workDir, "orders-config.json")], target)) !== 0) throw new Error("seed orders failed");
    const config = JSON.parse(readFileSync(join(workDir, "orders-config.json"), "utf8")) as { lp_key: string; run_id: string };
    const pdfId = randomUUID();
    writeFileSync(join(workDir, `data/deliverables/${pdfId}.pdf`), "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    await sql`INSERT INTO uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256) VALUES (${pdfId}, 'pdf', ${`deliverables/${pdfId}.pdf`}, 'ebook.pdf', 'application/pdf', 44, ${randomBytes(32)})`;
    await sql`UPDATE products SET pdf_upload_id = ${pdfId} WHERE title = ${`LOADTEST ${config.run_id} orders`}`;
    const settling = settleLoop({
      mode: "stub",
      pending: () => pendingOrders(sql, config.lp_key),
      beforeEachPoll: () => assertWhatsAppOff(sql),
      fetch: (url, init) => fetch(url, init),
      ratePerMinute: ORDERS_PER_MIN * 2,
      idleExitMs: 45_000,
      startTimeoutMs: 20 * 60_000,
      stubUrl: STUB_URL,
      notifyUrl: `http://host.docker.internal:${String(PUBLIC_PORT)}/api/v1/webhooks/midtrans`,
      log,
    });
    const ordersCode = await bashRun("orders", {
      API_ORIGIN: `https://api.${DOMAIN}`,
      EMAIL_DOMAIN,
      RATE_PER_MIN: String(ORDERS_PER_MIN),
      DURATION: `${String(ORDERS_MINUTES)}m`,
      CAP_BASE_URL: publicOrigin,
      CAP_THREADS: process.env["CAP_THREADS"] ?? "",
      ...k6Local,
    });
    report["orders"] = { k6_exit_code: ordersCode, settle: await settling };
    const summary = JSON.parse(readFileSync(join(workDir, "results/orders-50pm-summary.json"), "utf8")) as { metrics: Record<string, { count?: number; values?: { count?: number } }> };
    const created = num(summary.metrics["orders_created"]?.count ?? summary.metrics["orders_created"]?.values?.count);

    // --- the AC-P8 verifier, a duplicate check on the sink, and the PAID -> e-mail latency
    // The run's start time from the file run.sh wrote: the same mechanism procedure B uses so that a trial's orders do not count.
    const since = parseRunFile(readFileSync(join(workDir, "results/orders-50pm-run.json"), "utf8"));
    const verdict = await verifyAcP8(sql, { lpKey: config.lp_key, expectedOrders: created, since, waitSeconds: 180, requireEmailSent: true });
    report["ac_p8_verifier"] = verdict;
    const duplicates = [...hits.entries()].filter(([key, n]) => key.startsWith("mt|") && n > 1);
    const mtHits = [...hits.keys()].filter((key) => key.startsWith("mt|")).length;
    report["sink"] = { mt_txids_received: mtHits, mt_txids_received_twice: duplicates.length };
    const [latency] = await sql<Record<string, number>[]>`
      SELECT count(*)::int AS emails, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.sent_at - o.paid_at) * 1000))::numeric)::int AS p50_ms,
             round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM d.sent_at - o.paid_at) * 1000))::numeric)::int AS p95_ms,
             round(max(extract(epoch FROM d.sent_at - o.paid_at) * 1000)::numeric)::int AS max_ms
        FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN landing_pages lp ON lp.id = o.landing_page_id
       WHERE lp.lp_key = ${config.lp_key} AND d.channel = 'email' AND d.sent_at IS NOT NULL`;
    report["paid_to_email_ms"] = latency;
    report["ok"] = triviaCode === 0 && ordersCode === 0 && verdict.ok && duplicates.length === 0;

    // --- clean up what the tools made, through the tool itself
    await node("seed.ts", ["cleanup", "--run", config.run_id], target);
    if (!skipTrivia) {
      const links = JSON.parse(readFileSync(join(workDir, "links.json"), "utf8")) as { run_id: string };
      await node("seed.ts", ["cleanup", "--run", links.run_id], target);
    }
  } finally {
    for (const child of children) child.kill();
    sink?.close();
    await sql.end({ timeout: 5 });
    await db.drop();
    spawnSync("docker", ["exec", "ebooktrivia-dev-valkey-1", "sh", "-c", `valkey-cli --user worker --pass worker-devonly --no-auth-warning --scan --pattern '${prefix}:*' | xargs -r valkey-cli --user worker --pass worker-devonly --no-auth-warning unlink`], { stdio: "ignore" });
    await fetch(`http://127.0.0.1:58025/api/v1/search?query=${encodeURIComponent(`to:${EMAIL_DOMAIN}`)}`, { method: "DELETE" }).catch(() => undefined);
  }
  writeFileSync(join(workDir, "dry-run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report["ok"] === true ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : "dry run failed"}\n`);
  for (const child of children) child.kill();
  process.exit(1);
});
