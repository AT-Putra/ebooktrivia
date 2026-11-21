// The question flow and the leaderboard API on play.<DOMAIN> (US-027; plan M9.2-3). Same-origin JSON routes:
//
//   POST /api/v1/play/sets/start         {set_id}              200 {v:1, attempt_id}
//   POST /api/v1/play/attempts/current   {attempt_id}          200 {v:1, state:"question"|"finished"|"closed", ...}
//   POST /api/v1/play/attempts/answer    {answer_id, option_id} 200 {v:1, state:"answered", correct, correct_option_id, ...}
//   GET  /api/v1/play/leaderboard?program={id}                 200 {v:1, age_ms, top, me}
//
// Every route wraps these handlers in withPlayer (lib/play/handlers.ts: the exact Origin on every POST, the session,
// the rotated cookies on every answer; guards.test.ts), and each passes that id to the SECURITY DEFINER calls of
// sql/play.sql, which check every id of the request against it: another player's set, attempt or answer row, or a
// program the player has not paid for, is 403 `forbidden`, the same answer as an id that does not exist. The
// database is the clock (served_at, deadlines, answer times, the grace end); the app sends no time and reads none of
// the client's. Every answer is no-store.
// WRITE, THEN READ (security review HIGH-1, the rollback probe and its side channel; sql/play.sql): a write call
// returns nothing secret, and the secret is read by a later call in a statement (an autocommit transaction) of its
// own, which the database refuses inside a transaction that has written (ET147). A pick is ONE write that does not
// depend on correctness (play_answer), one scoring write of the committed pick (play_settle) and one read
// (play_reveal: the correct option and the explanation); the current question is served by one play_current and
// shown by the next one. Only the writes are retried once when PostgreSQL aborts them as a deadlock (40P01: a play
// row lock against an exclusive contest holder's).
//
// The leaderboard: the top N from the in-process 5 s cache (./leaderboard-cache.ts), the player's own standing
// fresh on every call; refreshes are rate-limited per player and per client network (Valkey; refused: 429).
import { createHash } from "node:crypto";
import { clientIp, throttleBucket } from "@ebooktrivia/edge";
import postgres from "postgres";
import { uaHash } from "../checkout/orders.ts";
import type { Sql } from "../db.ts";
import { readJsonBody } from "../http.ts";
import { hitRateLimits } from "../valkey.ts";
import { type PlayDeps, type PlayErrorCode, playError, playJson } from "./handlers.ts";
import { type TopCache, topCache } from "./leaderboard-cache.ts";
import { loadStanding, loadTop } from "./trivia-data.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 1024;

/** The leaderboard refresh budget ("Perbarui"): per player, and per client network (an IPv6 /64 or IPv4). */
export const LEADERBOARD_LIMITS = { perPlayer: 12, perIp: 120, windowMs: 60_000 } as const;
/**
 * The trivia pages' loads per player (security review LOW-2: each load reads the program, the grid and the
 * standing and raises the unlock floor): a reload every 2 seconds for a minute is still fine, a script is not.
 */
export const PAGE_LIMITS = { perPlayer: 30, windowMs: 60_000 } as const;

/** What a refusal of the play functions (sql/play.sql) and of the play guards (triggers.sql) answers. */
const REFUSALS: Readonly<Record<string, PlayErrorCode>> = {
  ET140: "forbidden",
  ET141: "forbidden",
  ET050: "forbidden",
  ET051: "validation",
  ET142: "locked",
  ET143: "empty_set",
  ET144: "already_answered",
  ET145: "not_served",
  ET109: "too_late",
  ET110: "closed",
};

const isPgCode = (error: unknown, code: string): boolean => error instanceof postgres.PostgresError && error.code === code;

/** Runs a play WRITE; a deadlock victim (40P01) runs once more. */
async function retryDeadlockOnce<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isPgCode(error, "40P01")) throw error;
    return call();
  }
}

/** The refusal's answer, or undefined for an error that is not a play refusal (then: 503, logged). */
function refusal(deps: Pick<PlayDeps, "log">, route: string, error: unknown): Response | undefined {
  if (!(error instanceof postgres.PostgresError)) return undefined;
  const code = REFUSALS[error.code];
  if (code === undefined) return undefined;
  deps.log("info", "play.refused", { route, reason: code, code: error.code });
  return playError(code);
}

/** A uuid field of the JSON body, or null. */
async function uuidFields<K extends string>(request: Request, keys: readonly K[]): Promise<Record<K, string> | null> {
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok || typeof body.value !== "object" || body.value === null) return null;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = (body.value as Record<string, unknown>)[key];
    if (typeof value !== "string" || !UUID.test(value)) return null;
    out[key] = value;
  }
  return out;
}

const device = (request: Request): { readonly ip: string | null; readonly ua: Buffer | null } => ({
  ip: clientIp(request.headers),
  ua: uaHash(request.headers.get("user-agent")),
});

type PlayCall = (sql: Sql, playerId: string, fields: Record<string, string>, request: Request) => Promise<Record<string, unknown>>;

/** The player's handler of a play route (the route wraps it in withPlayer). */
export type PlayerHandler = (deps: PlayDeps, request: Request, playerId: string) => Promise<Response>;

/** One play action: the body's ids, the play function calls, their answer (a refusal: its error). */
function playAction(route: string, keys: readonly string[], call: PlayCall): PlayerHandler {
  return async (deps, request, playerId) => {
    const fields = await uuidFields(request, keys);
    if (fields === null) return playError("validation", { fields: Object.fromEntries(keys.map((k) => [k, "invalid"])) });
    try {
      return playJson(200, { v: 1, ...(await call(deps.sql, playerId, fields, request)) });
    } catch (error) {
      const refused = refusal(deps, route, error);
      if (refused !== undefined) return refused;
      throw error;
    }
  };
}

export const handleStartSet = playAction("play.start", ["set_id"], async (sql, playerId, fields) => {
  const [row] = await retryDeadlockOnce(() => sql<{ id: string }[]>`SELECT public.play_start_set(${playerId}, ${fields["set_id"] ?? ""}) AS id`);
  return { attempt_id: row?.id ?? null };
});

const timedOut = (r: Readonly<Record<string, unknown>>): number => (typeof r["timed_out"] === "number" ? r["timed_out"] : 0);

/**
 * A call that served (or closed) answers {state:"served"}; the question comes from the next call, a transaction
 * of its own that writes nothing. Three calls at most (the second normally shows the question).
 */
export const handleCurrent = playAction("play.current", ["attempt_id"], async (sql, playerId, fields, request) => {
  const { ip, ua } = device(request);
  let closed = 0;
  for (let call = 0; call < 3; call++) {
    const [row] = await retryDeadlockOnce(
      () => sql<{ r: Record<string, unknown> }[]>`SELECT public.play_current(${playerId}, ${fields["attempt_id"] ?? ""}, ${ip}::inet, ${ua}) AS r`,
    );
    const r = row?.r ?? {};
    closed += timedOut(r);
    if (r["state"] !== "served") return { ...r, timed_out: closed };
  }
  throw new Error("play_current served three times in a row");
});

/**
 * Per pick, three statements, each its own transaction: the pick (play_answer, which writes only the pick), its
 * scoring once committed (play_settle), the read (play_reveal). An answer that finds the question already answered
 * (ET144: a retry after a failure past the pick, or a second tab) is the reveal of the player's own committed pick,
 * or 409 when that was a timeout (nothing to reveal).
 */
export const handleAnswer = playAction("play.answer", ["answer_id", "option_id"], async (sql, playerId, fields, request) => {
  const { ip, ua } = device(request);
  const answerId = fields["answer_id"] ?? "";
  const revealed = async (): Promise<Record<string, unknown>> => {
    await retryDeadlockOnce(() => sql`SELECT public.play_settle(${playerId}, ${answerId}) AS r`);
    const [row] = await sql<{ r: Record<string, unknown> }[]>`SELECT public.play_reveal(${playerId}, ${answerId}) AS r`;
    return { ...(row?.r ?? {}), state: "answered" };
  };
  try {
    await retryDeadlockOnce(() => sql`SELECT public.play_answer(${playerId}, ${answerId}, ${fields["option_id"] ?? ""}, ${ip}::inet, ${ua}) AS r`);
  } catch (error) {
    if (!isPgCode(error, "ET144")) throw error;
    try {
      return await revealed();
    } catch (reveal) {
      if (isPgCode(reveal, "ET148")) throw error;
      throw reveal;
    }
  }
  return revealed();
});

/** The rate-limit key part of a player (a hash label of its own, never the id itself). */
const playerKey = (playerId: string): string => createHash("sha256").update(`ebooktrivia/leaderboard-player/v1|${playerId}`).digest("hex").slice(0, 32);

export function leaderboardHandler(cache: TopCache = topCache): PlayerHandler {
  const route = "play.leaderboard";
  return async (deps, request, playerId) => {
    const programId = new URL(request.url).searchParams.get("program") ?? "";
    if (!UUID.test(programId)) return playError("validation", { fields: { program: "invalid" } });
    const limited = await hitRateLimits(deps.valkey, [
      { key: `play:lb:player:${playerKey(playerId)}`, limit: LEADERBOARD_LIMITS.perPlayer, windowMs: LEADERBOARD_LIMITS.windowMs },
      { key: `play:lb:ip:${throttleBucket(clientIp(request.headers))}`, limit: LEADERBOARD_LIMITS.perIp, windowMs: LEADERBOARD_LIMITS.windowMs },
    ]);
    if (!limited.allowed) {
      deps.log("warn", "play.refused", { route, reason: "rate_limited" });
      return playError("rate_limited", { retryAfterSeconds: limited.retryAfterSeconds });
    }
    let me;
    try {
      // First, and fresh: it is also the IDOR check (ET141 unless the player is eligible for the program).
      me = await loadStanding(deps.sql, playerId, programId);
    } catch (error) {
      const refused = refusal(deps, route, error);
      if (refused !== undefined) return refused;
      throw error;
    }
    const top = await cache.get(programId, () => loadTop(deps.sql, programId));
    return playJson(200, {
      v: 1,
      age_ms: Math.max(0, Date.now() - top.loadedAt),
      top: top.rows.map((r) => ({ rank: r.rank, name: r.name, score: r.score, total_ms: r.totalMs, finished: r.finished })),
      me: { rank: me.rank, name: me.name, score: me.score, total_ms: me.totalMs, sets_completed: me.setsCompleted, finished: me.finished, ranked: me.ranked },
    });
  };
}

export const handleLeaderboard = leaderboardHandler();

/** Counts one trivia page load of the player (PAGE_LIMITS); the page shows a short "slow down" note when refused. */
export const limitPageLoad = (valkey: PlayDeps["valkey"], playerId: string) =>
  hitRateLimits(valkey, [{ key: `play:page:player:${playerKey(playerId)}`, limit: PAGE_LIMITS.perPlayer, windowMs: PAGE_LIMITS.windowMs }]);
