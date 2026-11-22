// k6 load test of AC-Q13: 500 concurrent players answering trivia, p95 answer-submit latency < 300 ms and errors < 0.1 %
// on the 4 vCPU / 8 GB VM. It is run from a SEPARATE machine against staging (infra/load/run.sh trivia); k6 exits
// non-zero (99) when a threshold below is missed.
//
// Every VU is one seeded player (seed.ts trivia + login.ts): it carries that player's REAL session cookie and plays through the
// real play API, the way the page does:
//   POST /api/v1/play/sets/start      {set_id}
//   POST /api/v1/play/attempts/current {attempt_id}            -> the question (opaque option ids), or finished
//   POST /api/v1/play/attempts/answer  {answer_id, option_id}  -> the pick, its scoring and the reveal   <-- measured: endpoint:answer
//   GET  /api/v1/play/leaderboard?program=...                   after each set, as the page refreshes it
// with a think time before every answer. A VU plays its sets in order and then idles until the test ends, so
// sets x questions x think time must cover ramp + hold (README, "Sizing"). One player = one attempt per set, so a VU
// cannot replay a set: size the seed, do not loop.
//
// ENV  SESSIONS_FILE (/work/sessions.json)  login.ts' output
//      VUS (500)  RAMP_SECONDS (60)  HOLD_SECONDS (300)  THINK_MIN_MS (1000)  THINK_MAX_MS (3000)
//      PLAY_ORIGIN   the play origin the app expects as Origin (default: the one in the sessions file)
//      BASE_URL      where to connect (default PLAY_ORIGIN); HOST_HEADER overrides Host (local dry runs only)
// Single load generator: every VU shares one client IP, so the per-network leaderboard refresh budget (120 a minute) answers
// 429 to most refreshes. Those are EXPECTED (counted in leaderboard_rate_limited) and do not count as errors; the answer
// path has no per-IP limit.
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { between } from "./lib.js";

const FILE = __ENV.SESSIONS_FILE || "/work/sessions.json";
const VUS = Number(__ENV.VUS || 500);
const RAMP_SECONDS = Number(__ENV.RAMP_SECONDS || 60);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 300);
const THINK_MIN_MS = Number(__ENV.THINK_MIN_MS || 1000);
const THINK_MAX_MS = Number(__ENV.THINK_MAX_MS || 3000);

const sessions = new SharedArray("sessions", () => JSON.parse(open(FILE)).sessions);
const meta = new SharedArray("meta", () => {
  const doc = JSON.parse(open(FILE));
  return [{ play_origin: doc.play_origin, program_id: doc.program_id, set_ids: doc.set_ids, timer_seconds: doc.timer_seconds }];
});
const PLAY_ORIGIN = __ENV.PLAY_ORIGIN || meta[0].play_origin;
const BASE_URL = (__ENV.BASE_URL || PLAY_ORIGIN).replace(/\/+$/, "");
const SESSION_COOKIE = "__Host-play_session";

const answerDuration = new Trend("answer_duration", true);
const answersTotal = new Counter("answers_total");
const answersCorrect = new Counter("answers_correct");
const questionsServed = new Counter("questions_served");
const setsFinished = new Counter("sets_finished");
const leaderboardRateLimited = new Counter("leaderboard_rate_limited");
const playersIdle = new Counter("players_idle_iterations");

export const options = {
  scenarios: {
    players: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: `${RAMP_SECONDS}s`, target: VUS },
        { duration: `${HOLD_SECONDS}s`, target: VUS },
        { duration: "20s", target: 0 },
      ],
      gracefulRampDown: "30s",
      gracefulStop: "30s",
    },
  },
  thresholds: {
    // AC-Q13: p95 of the answer submit under 300 ms ...
    "http_req_duration{endpoint:answer}": ["p(95)<300"],
    // ... and errors under 0.1 % (HTTP failures: the expected 429 of the leaderboard excluded by its responseCallback), overall and on the answer path.
    http_req_failed: ["rate<0.001"],
    "http_req_failed{endpoint:answer}": ["rate<0.001"],
    // Every check (a 200, a question or the finished state, an answered state) must hold.
    checks: ["rate>0.999"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  noConnectionReuse: false,
};

export function setup() {
  if (sessions.length < VUS) throw new Error(`${VUS} VUs need ${VUS} seeded sessions; ${FILE} has ${sessions.length}`);
  if (THINK_MAX_MS > (meta[0].timer_seconds - 3) * 1000) throw new Error("THINK_MAX_MS must leave 3 s of the question timer for the answer to arrive");
  return {};
}

// Per VU (module state of a VU instance): the session cookie it holds, and the next set to play. An iteration that fails
// early resumes at the same set (starting a set again returns the same attempt), and a VU that played every set only idles.
const state = { cookie: null, nextSet: 0 };

export default function () {
  const me = sessions[exec.vu.idInTest - 1];
  if (!me) return;
  if (state.cookie === null) state.cookie = me.cookie;

  const call = (method, path, body, endpoint, extra) => {
    const headers = { Accept: "application/json", Origin: PLAY_ORIGIN, Cookie: state.cookie };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
    const res = http.request(method, `${BASE_URL}${path}`, body === null ? null : JSON.stringify(body), { headers, tags: { endpoint }, ...extra });
    // The app rotates a session older than a day: follow the cookie it hands back.
    const rotated = res.cookies[SESSION_COOKIE];
    if (rotated && rotated.length > 0) state.cookie = `${SESSION_COOKIE}=${rotated[0].value}`;
    return res;
  };

  while (state.nextSet < meta[0].set_ids.length) {
    const setId = meta[0].set_ids[state.nextSet];
    const start = call("POST", "/api/v1/play/sets/start", { set_id: setId }, "start");
    if (!check(start, { "start 200": (r) => r.status === 200 })) return;
    const attemptId = start.json("attempt_id");

    for (;;) {
      const current = call("POST", "/api/v1/play/attempts/current", { attempt_id: attemptId }, "current");
      if (!check(current, { "current 200": (r) => r.status === 200 })) return;
      const shown = current.json();
      if (shown.state !== "question") {
        setsFinished.add(1);
        break;
      }
      questionsServed.add(1);
      sleep(between(THINK_MIN_MS, THINK_MAX_MS, Math.random()) / 1000);
      const option = shown.options[between(0, shown.options.length - 1, Math.random())];
      const answer = call("POST", "/api/v1/play/attempts/answer", { answer_id: shown.answer_id, option_id: option.id }, "answer");
      answerDuration.add(answer.timings.duration);
      answersTotal.add(1);
      if (check(answer, { "answer 200": (r) => r.status === 200, "answered": (r) => r.json("state") === "answered" }) && answer.json("correct") === true) answersCorrect.add(1);
    }

    const board = call("GET", `/api/v1/play/leaderboard?program=${meta[0].program_id}`, null, "leaderboard", { responseCallback: http.expectedStatuses(200, 429) });
    if (board.status === 429) leaderboardRateLimited.add(1);
    else check(board, { "leaderboard 200": (r) => r.status === 200 });
    state.nextSet++;
  }

  // Every set is played (one attempt per player and set): stay quiet until the test ends instead of hammering finished attempts.
  playersIdle.add(1);
  sleep(15);
}
