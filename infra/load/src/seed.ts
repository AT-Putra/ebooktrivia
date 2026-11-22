// The seed tool of the load tests (README: infra/load). It writes into a STAGING or DEV database only: guard.ts refuses
// every other target before anything is read or written.
//
//   LOAD_DATABASE_URL=postgres://... LOAD_TARGET_ENV=staging [LOAD_ALLOWED_DB_HOSTS=<db host>] \
//   node infra/load/src/seed.ts trivia  --players 500 --sets 10 --questions 10 [--timer 20] [--points 10] --out links.json
//   node infra/load/src/seed.ts orders  --lp-host <host to register for the landing page> --postback-url <https sink> [--price 10000] --out orders-config.json
//   node infra/load/src/seed.ts cleanup --run <run id>
//
// The URL is read from the environment, never from an argument (a command line ends up in the shell history and `ps`).
// The files it writes hold login tokens (links.json) and are created 0600; delete them with the run.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { assertLoadTarget, assertWhatsAppOff, LoadGuardError, RUN_ID } from "./guard.ts";
import { cleanup, newRunId, seedOrders, seedTrivia } from "./seed-lib.ts";

const USAGE = `usage: seed.ts trivia --players N --sets N --questions N [--timer 20] [--points 10] --out <file>
       seed.ts orders --lp-host <host> --postback-url <https url> [--price 10000] --out <file>
       seed.ts cleanup --run <run id>
env:   LOAD_DATABASE_URL, LOAD_TARGET_ENV=staging|dev, LOAD_ALLOWED_DB_HOSTS (a non-loopback database host)`;

const integer = (name: string, raw: string | undefined, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${String(min)} to ${String(max)}`);
  return value;
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
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
  if (databaseUrl === undefined || (command !== "trivia" && command !== "orders" && command !== "cleanup")) throw new Error(USAGE);
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
  try {
    const target = await assertLoadTarget(sql, databaseUrl, process.env);
    process.stderr.write(`target accepted: ${target} database\n`);
    if (command === "trivia") {
      if (values.out === undefined) throw new Error(USAGE);
      const links = await seedTrivia(sql, {
        runId: newRunId(),
        players: integer("players", values.players, 1, 5000),
        sets: integer("sets", values.sets, 1, 100),
        questions: integer("questions", values.questions, 1, 100),
        timerSeconds: integer("timer", values.timer, 5, 600),
        points: integer("points", values.points, 0, 1000),
      });
      await writeFile(values.out, `${JSON.stringify(links)}\n`, { mode: 0o600 });
      process.stderr.write(`run ${links.run_id}: program ${links.program_slug}, ${String(links.players.length)} players, ${String(links.set_ids.length)} sets; links in ${values.out}\n`);
    } else if (command === "orders") {
      if (values.out === undefined || values["lp-host"] === undefined || values["postback-url"] === undefined) throw new Error(USAGE);
      // The buyers of an orders run have real-looking numbers: nothing is created unless WhatsApp is off (no active session, a delay of an hour or more).
      await assertWhatsAppOff(sql);
      const config = await seedOrders(sql, { runId: newRunId(), lpHost: values["lp-host"].toLowerCase(), postbackUrl: values["postback-url"], priceIdr: integer("price", values.price, 1000, 10_000_000) });
      await writeFile(values.out, `${JSON.stringify(config)}\n`, { mode: 0o600 });
      process.stderr.write(`run ${config.run_id}: landing page ${config.lp_key} on ${config.lp_host}, adnet ${config.adnet_slug}; config in ${values.out}\n`);
    } else {
      if (values.run === undefined || !RUN_ID.test(values.run)) throw new Error(`${USAGE}\n(--run is the 8 hex digit run id that seed.ts printed)`);
      const report = await cleanup(sql, values.run);
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
