// The seed tool of the load tests (README: infra/load). It writes into a STAGING or DEV database only: guard.ts refuses
// every other target before anything is read or written.
//
//   LOAD_DATABASE_URL=postgres://... LOAD_TARGET_ENV=staging [LOAD_ALLOWED_DB_HOSTS=<db host>] \
//   node infra/load/src/seed.ts trivia  --players 500 --sets 10 --questions 10 [--timer 20] [--points 10] --out links.json
//   node infra/load/src/seed.ts orders  --lp-host <host to register for the landing page> --postback-url <https sink> [--price 10000] --out orders-config.json
//   node infra/load/src/seed.ts demo    --program-slug <slug of an existing published program> [--buyers 30] [--seed N] [--accept-program-lock] --out demo.json
//   node infra/load/src/seed.ts cleanup --run <run id>
//
// The URL is read from the environment, never from an argument (a command line ends up in the shell history and `ps`).
// The files it writes hold login tokens (links.json, demo.json) and are created 0600; delete them with the run.
import { randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { demoArgs, wholeNumber } from "./args.ts";
import { cleanupRun, seedDemoToFile } from "./demo-lib.ts";
import { formatDuration } from "./demo-plan.ts";
import { assertLoadTarget, assertWhatsAppOff, LoadGuardError, RUN_ID } from "./guard.ts";
import { newRunId, seedOrders, seedTrivia } from "./seed-lib.ts";

const USAGE = `usage: seed.ts trivia --players N --sets N --questions N [--timer 20] [--points 10] --out <file>
       seed.ts orders --lp-host <host> --postback-url <https url> [--price 10000] --out <file>
       seed.ts demo --program-slug <slug> [--buyers 30] [--seed N] [--accept-program-lock] --out <file>
       seed.ts cleanup --run <run id>
env:   LOAD_DATABASE_URL, LOAD_TARGET_ENV=staging|dev, LOAD_ALLOWED_DB_HOSTS (a non-loopback database host)`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      "program-slug": { type: "string" },
      buyers: { type: "string" },
      seed: { type: "string" },
      "accept-program-lock": { type: "boolean" },
      players: { type: "string" },
      sets: { type: "string" },
      questions: { type: "string" },
      timer: { type: "string", default: "20" },
      points: { type: "string", default: "10" },
      "lp-host": { type: "string" },
      "postback-url": { type: "string" },
      price: { type: "string", default: "10000" },
      out: { type: "string" },
      run: { type: "string" },
    },
  });
  const databaseUrl = process.env["LOAD_DATABASE_URL"];
  if (databaseUrl === undefined || (command !== "trivia" && command !== "orders" && command !== "demo" && command !== "cleanup")) throw new Error(USAGE);
  // A typo in a flag stops the tool before it connects.
  const demo = command === "demo" ? demoArgs(values) : undefined;
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    const target = await assertLoadTarget(sql, databaseUrl, process.env);
    process.stderr.write(`target accepted: ${target} database\n`);
    if (command === "trivia") {
      if (values.out === undefined) throw new Error(USAGE);
      const links = await seedTrivia(sql, {
        runId: newRunId(),
        players: wholeNumber("players", values.players, 1, 5000),
        sets: wholeNumber("sets", values.sets, 1, 100),
        questions: wholeNumber("questions", values.questions, 1, 100),
        timerSeconds: wholeNumber("timer", values.timer, 5, 600),
        points: wholeNumber("points", values.points, 0, 1000),
      });
      await writeFile(values.out, `${JSON.stringify(links)}\n`, { mode: 0o600 });
      process.stderr.write(`run ${links.run_id}: program ${links.program_slug}, ${String(links.players.length)} players, ${String(links.set_ids.length)} sets; links in ${values.out}\n`);
    } else if (command === "orders") {
      if (values.out === undefined || values["lp-host"] === undefined || values["postback-url"] === undefined) throw new Error(USAGE);
      // The buyers of an orders run have real-looking numbers: nothing is created unless WhatsApp is off (no active session, a delay of an hour or more).
      await assertWhatsAppOff(sql);
      const config = await seedOrders(sql, { runId: newRunId(), lpHost: values["lp-host"].toLowerCase(), postbackUrl: values["postback-url"], priceIdr: wholeNumber("price", values.price, 1000, 10_000_000) });
      await writeFile(values.out, `${JSON.stringify(config)}\n`, { mode: 0o600 });
      process.stderr.write(`run ${config.run_id}: landing page ${config.lp_key} on ${config.lp_host}, adnet ${config.adnet_slug}; config in ${values.out}\n`);
    } else if (demo !== undefined) {
      const seed = demo.seed ?? randomInt(0, 2 ** 31);
      // The run id is printed as soon as it is drawn: if anything later goes wrong, it is what the recovery cleanup needs (README).
      const runId = newRunId();
      process.stderr.write(`run ${runId} (seed ${String(seed)}): seeding ${String(demo.buyers)} buyers into ${demo.programSlug}\n`);
      // seedDemoToFile creates the output file first (never over an existing one, 0600), checks that WhatsApp is off (no active WAHA session, a delay of an
      // hour or more) and that the program fits, writes the file INSIDE the transaction (a failed write rolls the run back), and removes it again on any failure.
      const { file, summary } = await seedDemoToFile(sql, { runId, programSlug: demo.programSlug, buyers: demo.buyers, seed, acceptProgramLock: demo.acceptProgramLock }, demo.out);
      process.stderr.write(
        `run ${file.run_id}: ${String(summary.buyers)} PAID buyers in program ${file.program_slug}, paid ${summary.paid_from.toISOString()} to ${summary.paid_to.toISOString()}\n` +
          `CLEAN UP BEFORE ${summary.grace_end.toISOString()}, the end of the program's grace period: the worker then writes the immutable results snapshot and winners by itself, and the demo buyers could no longer be removed\n` +
          `plan: ${String(summary.sets_planned)} sets, ${String(summary.answers_planned)} answers, ${formatDuration(summary.estimated_seconds_at_speed_1)} if one buyer played after another at speed 1 (demo-play.ts plays several at once)\n` +
          `nothing can be sent: ${String(summary.deliveries_cancelled)} deliveries cancelled, ${String(summary.conversions_removed)} conversion rows removed; ${summary.program_was_locked ? "the program was already locked" : "the program is now LOCKED for good"}\n` +
          `login links and the answer key in ${demo.out}: keep it on this machine and delete it after the run\n`,
      );
    } else {
      if (values.run === undefined || !RUN_ID.test(values.run)) throw new Error(`${USAGE}\n(--run is the 8 hex digit run id that seed.ts printed)`);
      const report = await cleanupRun(sql, values.run);
      process.stderr.write(`cleanup of run ${values.run} (${report.kind}): ${JSON.stringify(report.removed)}\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof LoadGuardError ? error.message : error instanceof Error ? error.message : "seed failed"}\n`);
  process.exit(error instanceof LoadGuardError ? 3 : 1);
});
