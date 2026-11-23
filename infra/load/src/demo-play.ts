// Plays the demo buyers of `seed.ts demo` through the REAL play API, from the operator's machine: for each buyer it logs in with the buyer's
// magic link (POST /api/v1/play/auth/magic-link, exactly as login.ts and the confirm page do, so Better Auth makes the session), then plays
// the planned sets in order: start, current, answer, as the page does. Nothing is written to a database from here.
//
//   node infra/load/src/demo-play.ts --base https://play.<DOMAIN> --in demo.json [--concurrency 10] [--speed 1]
//
// Time is REAL: the server measures every answer from the instant it served the question, so a buyer waits its think time (2 to 12 s at
// speed 1, a range of its own per buyer) before answering. --speed divides the think times (speed 5: 2 to 12 s becomes 0.4 to 2.4 s). The
// wait is never longer than the question's remaining time minus 3 s, so an answer always lands inside the timer. A question that is
// meant to time out is left alone for its whole timer plus the server's 1.5 s grace: that wait is real whatever the speed.
//
// Per buyer, from the plan in the file (deterministic: the same file plays the same way):
//   skill          the chance an answer is the correct one; the correct option of every question is in the file (`correct_option_ids`),
//                  matched against the opaque option ids the server shows
//   timeout_rate   the chance a question runs out its timer unanswered (the server closes it as a timeout)
//   abandon        the last planned set is left half played: the buyer stops after a share of its questions. The system allows
//                  resuming (starting the set again returns the same attempt), so this is how a real player who left looks
//
// The login route is rate limited per client network: otp.ip_cap x otp.max_attempts logins per otp.ip_window_seconds (50 an hour at the
// defaults, so 30 buyers need nothing raised; README "Demo data on staging"). A 429 is waited out (Retry-After), here and on every call.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { positiveNumber } from "./args.ts";
import { abandonAfter, type DemoFile, estimateSeconds, formatDuration, mulberry32, parseDemoFile } from "./demo-plan.ts";
import { type LoginFetch, loginAll } from "./login.ts";

const SESSION_COOKIE = "__Host-play_session";
/** The wait after a question's deadline before it counts as closed by the server: its 1.5 s grace plus a margin for the clocks. */
const TIMEOUT_EXTRA_MS = 2000;
/** An answer is sent at least this long before the deadline. */
const ANSWER_MARGIN_MS = 3000;

export interface PlayResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null; getSetCookie(): string[] };
  /** A body that is not read (a 429 or a 5xx that is retried) is cancelled, so the connection is not held. */
  readonly body?: { cancel(): Promise<void> } | null;
  json(): Promise<unknown>;
}

export interface PlayFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<PlayResponse>;
}

export interface PlayDeps {
  /** The play origin, without a trailing slash (it is also the Origin header the app checks). */
  readonly base: string;
  readonly fetch: PlayFetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly speed: number;
  readonly log?: (line: string) => void;
}

export interface BuyerResult {
  readonly label: string;
  loggedIn: boolean;
  sets_started: number;
  sets_finished: number;
  sets_left_half: number;
  answers: number;
  correct: number;
  timeouts: number;
  errors: number;
  /** Questions whose options were not in the file's answer key (the program was edited after the seed): answered at random. */
  unknown_questions: number;
  messages: string[];
  cookie: string | undefined;
}

type Shown =
  | { readonly state: "question"; readonly answer_id: string; readonly position: number; readonly total: number; readonly remaining_ms: number; readonly options: readonly string[]; readonly timed_out: number }
  | { readonly state: "finished" | "closed"; readonly timed_out: number }
  | { readonly state: "other"; readonly timed_out: number };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function parseShown(body: Record<string, unknown>): Shown {
  const timedOut = num(body["timed_out"]);
  if (body["state"] === "finished" || body["state"] === "closed") return { state: body["state"], timed_out: timedOut };
  if (body["state"] !== "question" || typeof body["answer_id"] !== "string" || !Array.isArray(body["options"])) return { state: "other", timed_out: timedOut };
  const options = (body["options"] as unknown[]).flatMap((o) => (isObject(o) && typeof o["id"] === "string" ? [o["id"]] : []));
  return { state: "question", answer_id: body["answer_id"], position: num(body["position"], 1), total: num(body["total"], 1), remaining_ms: num(body["remaining_ms"]), options, timed_out: timedOut };
}

/** One buyer: log in, then play the planned sets in order. Never throws: what went wrong is counted and described in the result. */
export async function playBuyer(deps: PlayDeps, file: DemoFile, correct: ReadonlySet<string>, buyer: DemoFile["buyers"][number]): Promise<BuyerResult> {
  const result: BuyerResult = { label: buyer.label, loggedIn: false, sets_started: 0, sets_finished: 0, sets_left_half: 0, answers: 0, correct: 0, timeouts: 0, errors: 0, unknown_questions: 0, messages: [], cookie: undefined };
  const problem = (message: string): void => {
    result.errors++;
    if (result.messages.length < 5) result.messages.push(message);
  };
  const { plan } = buyer;
  const rng = mulberry32(plan.play_seed);
  let cookie = "";
  try {
    const [session] = await loginAll({ playOrigin: deps.base, tokens: [buyer.token], concurrency: 1, fetch: ((url, init) => deps.fetch(url, init)) satisfies LoginFetch, sleep: deps.sleep });
    if (session === undefined) throw new Error("no session");
    cookie = session.cookie;
  } catch (error) {
    problem(`login: ${error instanceof Error ? error.message : "failed"}`);
    return result;
  }
  result.loggedIn = true;

  /** One POST of the play API: a 429 is waited out, a 5xx or a network error tried again; the rotated session cookie is kept. */
  const post = async (path: string, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
    for (let attempt = 1; ; attempt++) {
      let response: PlayResponse | undefined;
      try {
        response = await deps.fetch(`${deps.base}${path}`, {
          method: "POST",
          headers: { origin: deps.base, "content-type": "application/json", accept: "application/json", cookie },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt >= 4) throw error;
        await deps.sleep(2000 * attempt);
        continue;
      }
      const rotated = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
      if (rotated !== undefined) cookie = rotated;
      if (response.status === 429 && attempt <= 20) {
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = Number(response.headers.get("retry-after") ?? "5");
        await deps.sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 60) : 5) * 1000);
        continue;
      }
      if (response.status >= 500 && attempt < 4) {
        await response.body?.cancel().catch(() => undefined);
        await deps.sleep(2000 * attempt);
        continue;
      }
      const json: unknown = await response.json().catch(() => ({}));
      return { status: response.status, body: isObject(json) ? json : {} };
    }
  };

  const setIds = file.set_ids.slice(0, plan.sets_to_play);
  try {
    for (const [s, setId] of setIds.entries()) {
      const started = await post("/api/v1/play/sets/start", { set_id: setId });
      const attemptId = started.body["attempt_id"];
      if (started.status !== 200 || typeof attemptId !== "string") {
        problem(`start set ${String(s + 1)}: HTTP ${String(started.status)} ${typeof started.body["error"] === "string" ? started.body["error"] : ""}`.trim());
        break;
      }
      result.sets_started++;
      // A set left half played: the buyer stops after this many questions, decided BEFORE asking for the next one (asking serves it, and starts its timer).
      const questions = file.questions_per_set[s] ?? 0;
      const stopAfter = plan.abandon_last_set && s === setIds.length - 1 && questions > 1 ? abandonAfter(questions, plan.abandon_fraction) : Number.POSITIVE_INFINITY;
      let handled = 0;
      let failedAnswers = 0;
      for (let guard = 0; guard < 2000; guard++) {
        if (handled >= stopAfter) {
          result.sets_left_half++;
          break;
        }
        const current = await post("/api/v1/play/attempts/current", { attempt_id: attemptId });
        if (current.status !== 200) {
          problem(`current: HTTP ${String(current.status)}`);
          break;
        }
        const shown = parseShown(current.body);
        result.timeouts += shown.timed_out;
        if (shown.state === "finished") {
          result.sets_finished++;
          break;
        }
        if (shown.state !== "question") break;
        // A set resumed after an earlier stop: the position of the question tells how far it had got.
        if (shown.position - 1 >= stopAfter) {
          result.sets_left_half++;
          break;
        }
        // The same four draws for every question, whatever is decided, so the sequence of a buyer never shifts.
        const [rollTimeout, rollThink, rollCorrect, rollPick] = [rng(), rng(), rng(), rng()] as [number, number, number, number];
        if (rollTimeout < plan.timeout_rate) {
          await deps.sleep(shown.remaining_ms + TIMEOUT_EXTRA_MS);
          handled++;
          continue;
        }
        const think = (plan.think_min_ms + rollThink * (plan.think_max_ms - plan.think_min_ms)) / deps.speed;
        await deps.sleep(Math.max(0, Math.min(think, shown.remaining_ms - ANSWER_MARGIN_MS)));
        const right = shown.options.find((id) => correct.has(id));
        const wrong = shown.options.filter((id) => id !== right);
        if (right === undefined) result.unknown_questions++;
        const pool = right !== undefined && (rollCorrect < plan.skill || wrong.length === 0) ? [right] : right === undefined ? shown.options : wrong;
        const optionId = pool[Math.floor(rollPick * pool.length)];
        if (optionId === undefined) {
          problem("a question was shown without options");
          break;
        }
        const answered = await post("/api/v1/play/attempts/answer", { answer_id: shown.answer_id, option_id: optionId });
        if (answered.status !== 200) {
          problem(`answer: HTTP ${String(answered.status)} ${typeof answered.body["error"] === "string" ? answered.body["error"] : ""}`.trim());
          // The next `current` shows where the attempt really is (an answer that failed may still have been recorded); three failures in a row end the set.
          if (++failedAnswers >= 3) break;
          continue;
        }
        failedAnswers = 0;
        handled++;
        result.answers++;
        if (answered.body["correct"] === true) result.correct++;
      }
    }
  } catch (error) {
    problem(`stopped: ${error instanceof Error ? error.message : "failed"}`);
  }
  result.cookie = cookie;
  return result;
}

export interface DemoPlaySummary {
  readonly buyers: number;
  readonly logged_in: number;
  readonly sets_started: number;
  readonly sets_finished: number;
  readonly sets_left_half: number;
  readonly answers: number;
  readonly correct: number;
  readonly timeouts: number;
  readonly errors: number;
  readonly unknown_questions: number;
  readonly seconds: number;
  readonly leaderboard: readonly string[];
}

/** Plays every buyer of the file, `concurrency` at a time, then reads the leaderboard once as the first buyer who logged in. */
export async function runDemoPlay(deps: PlayDeps, file: DemoFile, concurrency: number): Promise<{ readonly summary: DemoPlaySummary; readonly results: readonly BuyerResult[] }> {
  const started = Date.now();
  const correct = new Set(file.correct_option_ids);
  const results: (BuyerResult | undefined)[] = Array.from({ length: file.buyers.length });
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < file.buyers.length) {
      const index = next++;
      const buyer = file.buyers[index];
      if (buyer === undefined) continue;
      const result = await playBuyer(deps, file, correct, buyer);
      results[index] = result;
      deps.log?.(
        `${buyer.label}: ${result.loggedIn ? "logged in" : "NOT logged in"}, ${String(result.sets_finished)} of ${String(result.sets_started)} sets finished (${String(result.sets_left_half)} left half), ` +
          `${String(result.answers)} answers (${String(result.correct)} correct), ${String(result.timeouts)} timeouts, ${String(result.errors)} errors${result.messages.length > 0 ? `: ${result.messages.join("; ")}` : ""}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, file.buyers.length) }, lane));
  const done = results.filter((r): r is BuyerResult => r !== undefined);
  const total = (pick: (r: BuyerResult) => number): number => done.reduce((sum, r) => sum + pick(r), 0);
  const cookie = done.find((r) => r.cookie !== undefined)?.cookie;
  const leaderboard: string[] = [];
  if (cookie !== undefined) {
    try {
      const response = await deps.fetch(`${deps.base}/api/v1/play/leaderboard?program=${file.program_id}`, { method: "GET", headers: { origin: deps.base, accept: "application/json", cookie } });
      const body: unknown = await response.json();
      const top = isObject(body) && Array.isArray(body["top"]) ? (body["top"] as unknown[]) : [];
      for (const row of top.slice(0, 5)) {
        if (isObject(row)) leaderboard.push(`#${String(num(row["rank"]))} ${typeof row["name"] === "string" ? row["name"] : "?"}: ${String(num(row["score"]))} points`);
      }
    } catch {
      // The board is a courtesy of the summary; the run itself is over.
    }
  }
  return {
    results: done,
    summary: {
      buyers: file.buyers.length,
      logged_in: done.filter((r) => r.loggedIn).length,
      sets_started: total((r) => r.sets_started),
      sets_finished: total((r) => r.sets_finished),
      sets_left_half: total((r) => r.sets_left_half),
      answers: total((r) => r.answers),
      correct: total((r) => r.correct),
      timeouts: total((r) => r.timeouts),
      errors: total((r) => r.errors),
      unknown_questions: total((r) => r.unknown_questions),
      seconds: Math.round((Date.now() - started) / 1000),
      leaderboard,
    },
  };
}

export const LOOPBACK_BASE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const FETCH_TIMEOUT_MS = 30_000;
/** Against a real origin the run never goes faster than this: a rehearsal on loopback may. */
export const MAX_SPEED = 20;
export const MAX_CONCURRENCY = 30;

/** Why a speed or a concurrency is refused for this origin (empty = fine). */
export function runLimitProblems(base: string, concurrency: number, speed: number): string[] {
  if (LOOPBACK_BASE.test(base)) return [];
  const problems: string[] = [];
  if (speed > MAX_SPEED) problems.push(`--speed ${String(speed)} is above ${String(MAX_SPEED)}, the most a real origin is driven at (only a loopback --base may go faster)`);
  if (concurrency > MAX_CONCURRENCY) problems.push(`--concurrency ${String(concurrency)} is above ${String(MAX_CONCURRENCY)}, the most a real origin is driven at (only a loopback --base may go higher)`);
  return problems;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: "string" }, in: { type: "string" }, concurrency: { type: "string", default: "10" }, speed: { type: "string", default: "1" } } });
  const usage = "usage: demo-play.ts --base <https://play.DOMAIN> --in <demo.json> [--concurrency 10] [--speed 1]";
  if (values.base === undefined || values.in === undefined) throw new Error(usage);
  const base = values.base.replace(/\/+$/, "");
  // Real players log in over https; plain http is for the local dev stack only.
  if (!/^https:\/\/[^/]+$/.test(base) && !LOOPBACK_BASE.test(base)) throw new Error("--base is the play origin: https://play.<DOMAIN> (http only for 127.0.0.1 or localhost)");
  const concurrency = positiveNumber("concurrency", values.concurrency, { integer: true });
  const speed = positiveNumber("speed", values.speed);
  const tooFast = runLimitProblems(base, concurrency, speed);
  if (tooFast.length > 0) throw new Error(tooFast.join("\n"));
  const file = parseDemoFile(await readFile(values.in, "utf8"));
  const estimate = estimateSeconds(
    file.buyers.map((b) => b.plan),
    file.questions_per_set,
  );
  const log = (line: string): void => void process.stderr.write(`${line}\n`);
  log(
    `demo run ${file.run_id}: ${String(file.buyers.length)} buyers, ${String(estimate.sets)} sets, ${String(estimate.answers)} answers planned; ` +
      `about ${formatDuration(estimate.seconds / Math.min(concurrency, file.buyers.length) / speed)} at speed ${String(speed)} with ${String(concurrency)} buyers at a time (a timeout adds its whole timer)`,
  );
  const { summary } = await runDemoPlay(
    // Every call gives up after 30 s (a hung connection must not hold a buyer for ever).
    { base, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), speed, log },
    file,
    concurrency,
  );
  log(
    `summary: ${String(summary.logged_in)} of ${String(summary.buyers)} buyers logged in; ${String(summary.sets_started)} sets played (${String(summary.sets_finished)} finished, ${String(summary.sets_left_half)} left half); ` +
      `${String(summary.answers)} answers (${String(summary.correct)} correct); ${String(summary.timeouts)} timeouts; ${String(summary.errors)} errors; ${String(summary.unknown_questions)} questions outside the answer key; ${String(summary.seconds)} s`,
  );
  if (summary.leaderboard.length > 0) log(`leaderboard top:\n  ${summary.leaderboard.join("\n  ")}`);
  process.exitCode = summary.errors > 0 || summary.logged_in < summary.buyers ? 1 : 0;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "demo-play failed"}\n`);
    process.exit(1);
  });
}
