// Turns the magic links of seed.ts (trivia) into REAL player sessions: for each player, POST the token to the app's own
// login route (POST /api/v1/play/auth/magic-link, exact play Origin), exactly as the confirm page does, and keep the
// `__Host-play_session` cookie the app sets. The app creates the session through Better Auth (player_auth tables, the
// signed cookie, the rotation chain), so there is no bypass and no secret is needed here.
//
//   node infra/load/src/login.ts --play-origin https://play.<DOMAIN> --links links.json --out sessions.json [--concurrency 4]
//
// The route is rate limited per client network: otp.ip_cap x otp.max_attempts logins per otp.ip_window_seconds (docs: README,
// "Limits for the run"). A 429 is waited out (Retry-After) and retried, so a run under the default limits still finishes,
// only slowly. A magic link lives 72 hours: log in within that time of seeding.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { positiveNumber } from "./args.ts";
import type { TriviaLinks } from "./seed-lib.ts";

export interface Session {
  readonly cookie: string;
}

export interface LoginFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; headers: { get(name: string): string | null; getSetCookie(): string[] }; body?: { cancel(): Promise<void> } | null }>;
}

export interface LoginOptions {
  readonly playOrigin: string;
  readonly tokens: readonly string[];
  readonly concurrency: number;
  readonly fetch: LoginFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (done: number, total: number) => void;
}

const SESSION_COOKIE = "__Host-play_session";

export async function loginAll(options: LoginOptions): Promise<Session[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sessions: (Session | undefined)[] = Array.from({ length: options.tokens.length });
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < options.tokens.length) {
      const index = next++;
      for (let attempt = 0; ; attempt++) {
        const response = await options.fetch(`${options.playOrigin}/api/v1/play/auth/magic-link`, {
          method: "POST",
          headers: { origin: options.playOrigin, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ channel: "whatsapp", token: options.tokens[index] }),
        });
        // The body is never read: cancelling it frees the connection (a 429 that is retried, a refusal, and the answer of a login that worked).
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429 && attempt < 200) {
          const retryAfter = Number(response.headers.get("retry-after") ?? "30");
          await sleep((Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 900) : 30) * 1000);
          continue;
        }
        if (response.status !== 200) throw new Error(`login ${String(index + 1)} was refused (HTTP ${String(response.status)}); is the link older than 72 hours, or the Origin not the play origin?`);
        const pair = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
        if (pair === undefined) throw new Error(`login ${String(index + 1)} set no ${SESSION_COOKIE} cookie`);
        sessions[index] = { cookie: pair };
        options.onProgress?.(index + 1, options.tokens.length);
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.tokens.length) }, lane));
  return sessions.filter((s): s is Session => s !== undefined);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "play-origin": { type: "string" }, links: { type: "string" }, out: { type: "string" }, concurrency: { type: "string", default: "4" } },
  });
  const { "play-origin": playOrigin, links, out } = values;
  if (playOrigin === undefined || links === undefined || out === undefined) throw new Error("usage: login.ts --play-origin <https://play.DOMAIN> --links <links.json> --out <sessions.json> [--concurrency 4]");
  const doc = JSON.parse(await readFile(links, "utf8")) as TriviaLinks;
  const sessions = await loginAll({
    playOrigin: playOrigin.replace(/\/+$/, ""),
    tokens: doc.players.map((p) => p.token),
    concurrency: positiveNumber("concurrency", values.concurrency, { integer: true }),
    fetch: (url, init) => fetch(url, init),
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) process.stderr.write(`login: ${String(done)}/${String(total)}\n`);
    },
  });
  const file = {
    run_id: doc.run_id,
    play_origin: playOrigin.replace(/\/+$/, ""),
    program_id: doc.program_id,
    program_slug: doc.program_slug,
    set_ids: doc.set_ids,
    questions_per_set: doc.questions_per_set,
    timer_seconds: doc.timer_seconds,
    logged_in_at: new Date().toISOString(),
    sessions,
  };
  await writeFile(out, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  process.stderr.write(`login: wrote ${String(sessions.length)} sessions to ${out}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "login failed"}\n`);
    process.exit(1);
  });
}
