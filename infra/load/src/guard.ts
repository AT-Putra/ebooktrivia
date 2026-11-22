// The safety guard of every tool that WRITES to a database (seed, cleanup, settle). Load tests need
// players, sessions, orders and a landing page in the target database; a production database must never
// receive them. The tools therefore refuse to run unless ALL of these hold:
//
//   1. LOAD_TARGET_ENV is exactly `staging` or `dev` (an explicit statement of intent, no default);
//   2. the database URL names ONE plain TCP host: no `host` or `hostaddr` query parameter (postgres.js
//      honours `?host=` over the URL's own host, so `postgres://u@127.0.0.1/db?host=prod` would connect to
//      prod), no list of hosts, no socket path; and the targets postgres.js RESOLVED (sql.options.host and
//      sql.options.path) are checked again, not only the text of the URL;
//   3. that host is a loopback address (a dev database, or an SSH tunnel to staging) or is listed in
//      LOAD_ALLOWED_DB_HOSTS (comma separated). THIS IS NOT A STAGING-VS-PRODUCTION SEPARATOR: the pinned
//      address of the database container (10.89.51.2) is the same on staging and on production. It only
//      stops a typo from reaching an arbitrary host; the separator is the next point;
//   4. the database itself says it is not production (THE REAL GUARD):
//        - app_settings `midtrans.environment` is "sandbox" (production flips it to "production" at go-live,
//          docs/go-live.md), and
//        - app_settings `deployment.environment` equals LOAD_TARGET_ENV. This row is written once by the
//          operator on a staging or dev database (docs/go-live.md "Staging marker") and must never exist on
//          production, so a production database fails here even before its Midtrans switch.
//
// Every failed condition is reported at once, so the operator sees the whole picture.
import type postgres from "postgres";

export type LoadTargetEnv = "staging" | "dev";

export class LoadGuardError extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`refusing to touch this database (not marked staging or dev):\n- ${reasons.join("\n- ")}`);
    this.name = "LoadGuardError";
    this.reasons = reasons;
  }
}

export interface GuardEnv {
  readonly LOAD_TARGET_ENV?: string | undefined;
  readonly LOAD_ALLOWED_DB_HOSTS?: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** The host of a postgres URL, lower case, without IPv6 brackets; "" when the URL has none (a socket path) or is not a URL. */
export function databaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return "";
  }
}

const allowedHosts = (env: GuardEnv): string[] =>
  (env.LOAD_ALLOWED_DB_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");

/** Why one resolved host is refused ("" when it is fine): loopback, or listed. */
function hostProblem(host: string, env: GuardEnv): string {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "") return "the database URL has no host (a socket path is not accepted)";
  if (normalized.startsWith("/") || normalized.includes(",")) return `database host '${host}' is a socket path or a list of hosts`;
  if (!LOOPBACK.has(normalized) && !allowedHosts(env).includes(normalized)) return `database host '${host}' is neither loopback nor in LOAD_ALLOWED_DB_HOSTS`;
  return "";
}

/** The checks that need no database: the explicit environment, the shape of the URL and the host. Returns the problems found (empty = fine). */
export function checkEnvironment(databaseUrl: string, env: GuardEnv): string[] {
  const problems: string[] = [];
  if (env.LOAD_TARGET_ENV !== "staging" && env.LOAD_TARGET_ENV !== "dev") problems.push("LOAD_TARGET_ENV must be exactly 'staging' or 'dev'");
  let url: URL | undefined;
  try {
    url = new URL(databaseUrl);
  } catch {
    url = undefined;
  }
  if (url !== undefined) {
    // postgres.js takes `host` / `hostaddr` from the query string and lets them override the URL's host.
    for (const key of url.searchParams.keys()) {
      if (/^(host|hostaddr)$/i.test(key)) problems.push(`the database URL carries a '${key}' query parameter (it would override the host that was checked)`);
    }
    // A list of hosts (`h1,h2`) sits in the authority; the WHATWG parser keeps the comma in the host name.
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(databaseUrl)?.[1] ?? "";
    if (authority.slice(authority.lastIndexOf("@") + 1).includes(",")) problems.push("the database URL lists more than one host");
  }
  const host = databaseHost(databaseUrl);
  const problem = hostProblem(host, env);
  if (problem !== "") problems.push(problem);
  return problems;
}

/**
 * The targets postgres.js RESOLVED from the URL (`sql.options`: `host` is a list, `path` a socket path or false): each must pass the
 * same host rule, and no socket path may be set. `undefined` (a test double without options) checks nothing.
 */
export function checkResolved(options: unknown, env: GuardEnv): string[] {
  if (typeof options !== "object" || options === null) return [];
  const { host, path } = options as { host?: unknown; path?: unknown };
  const problems: string[] = [];
  const hosts = Array.isArray(host) ? host : host === undefined || host === null ? [] : [host];
  if (hosts.length > 1) problems.push("postgres.js resolved more than one host");
  for (const h of hosts) {
    const problem = typeof h === "string" ? hostProblem(h, env) : "postgres.js resolved a host that is not a string";
    if (problem !== "") problems.push(`resolved target: ${problem}`);
  }
  if (typeof path === "string" && path !== "") problems.push("postgres.js resolved a unix socket path");
  return problems;
}

/** The checks on the database's own markers. `settings` maps app_settings keys to their JSON values. */
export function checkMarkers(settings: ReadonlyMap<string, unknown>, targetEnv: string | undefined): string[] {
  const problems: string[] = [];
  const midtrans = settings.get("midtrans.environment");
  if (midtrans !== "sandbox") problems.push(`app_settings midtrans.environment is ${JSON.stringify(midtrans ?? null)}, not "sandbox"`);
  const marker = settings.get("deployment.environment");
  if (marker === undefined) problems.push("app_settings has no deployment.environment row (the staging marker, docs/go-live.md)");
  else if (marker !== targetEnv) problems.push(`app_settings deployment.environment is ${JSON.stringify(marker)}, not ${JSON.stringify(targetEnv ?? null)}`);
  return problems;
}

/** Throws a LoadGuardError unless the target is explicitly staging or dev. Returns the environment. */
export async function assertLoadTarget(sql: postgres.Sql, databaseUrl: string, env: GuardEnv): Promise<LoadTargetEnv> {
  const problems = [...checkEnvironment(databaseUrl, env), ...checkResolved((sql as unknown as { options?: unknown }).options, env)];
  if (problems.length > 0) throw new LoadGuardError(problems);
  const rows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM public.app_settings WHERE key IN ('midtrans.environment', 'deployment.environment')`;
  const markers = checkMarkers(new Map(rows.map((r) => [r.key, r.value])), env.LOAD_TARGET_ENV);
  if (markers.length > 0) throw new LoadGuardError(markers);
  return env.LOAD_TARGET_ENV as LoadTargetEnv;
}

/**
 * WhatsApp must be OFF for a run that creates orders (item 2 of the review): the seeded buyers have real-looking +62812 numbers, and a
 * stranger must never get a message. Refused unless no WAHA session is active AND the proactive delay is at least one hour.
 */
export const WA_OFF_MIN_DELAY_SECONDS = 3600;

export function checkWhatsAppOff(activeSessions: number, delaySeconds: unknown): string[] {
  const problems: string[] = [];
  if (activeSessions > 0) problems.push(`${String(activeSessions)} WAHA session(s) are active: set every session inactive for the run (README, "Before the orders run")`);
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds) || delaySeconds < WA_OFF_MIN_DELAY_SECONDS) {
    problems.push(`app_settings delivery.wa_delay_seconds is ${JSON.stringify(delaySeconds ?? null)}, not at least ${String(WA_OFF_MIN_DELAY_SECONDS)}`);
  }
  return problems;
}

export async function assertWhatsAppOff(sql: postgres.Sql): Promise<void> {
  const [sessions] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.waha_sessions WHERE active`;
  const [delay] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = 'delivery.wa_delay_seconds'`;
  const problems = checkWhatsAppOff(sessions?.n ?? 0, delay?.value);
  if (problems.length > 0) throw new LoadGuardError(problems);
}

/** A run id as seed.ts makes it (8 hex digits): the only shape cleanup accepts. */
export const RUN_ID = /^[0-9a-f]{8}$/;

/** The name seed.ts gives a load-test landing page, program and product (`LOADTEST <run id>`, the product with a suffix). */
export const LOADTEST_NAME = /^LOADTEST [0-9a-f]{8}$/;

/** settle.ts acts on a landing page only when seed.ts made it: its name is `LOADTEST <run id>`. */
export async function assertLoadtestLandingPage(sql: postgres.Sql, lpKey: string): Promise<void> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM public.landing_pages WHERE lp_key = ${lpKey}`;
  if (row === undefined) throw new LoadGuardError([`no landing page ${lpKey}`]);
  if (!LOADTEST_NAME.test(row.name)) throw new LoadGuardError([`landing page ${lpKey} is not a load-test landing page (its name is not "LOADTEST <run id>")`]);
}
