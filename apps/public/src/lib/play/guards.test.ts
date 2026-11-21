// Structural guard of the player login (US-026). Fails when:
//   - anything mounts Better Auth's HTTP handler (the stock routes would become reachable: the R13 plaintext
//     send-otp, sign-in by password, password reset);
//   - a route under api/v1/play is not built with playRoute (the runtime + after() wiring), or is a GET that
//     is not the read-only session route (mutations are POST-only);
//   - a play route other than the login routes below does not go through withPlayer, or any play route reads
//     the session another way (resolvePlayer stays internal: withPlayer appends the rotation cookies to every
//     answer; readPlayer is for server components only);
//   - a play handler that changes state does not check the Origin first.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../../", import.meta.url));
const posix = (p: string) => p.split("\\").join("/");
const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .map((p) => posix(p))
  .filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith(".test.ts"));
const read = (rel: string) => readFileSync(join(srcDir, rel), "utf8");
const playRoutes = files.filter((f) => f.startsWith("app/api/v1/play/") && f.endsWith("/route.ts"));

/** The login's own routes (lib/play/handlers.ts manages their cookies itself). Every other play route is a player route. */
const LOGIN_ROUTES = [
  "app/api/v1/play/auth/logout/route.ts",
  "app/api/v1/play/auth/logout-all/route.ts",
  "app/api/v1/play/auth/magic-link/route.ts",
  "app/api/v1/play/auth/magic-link/resend/route.ts",
  "app/api/v1/play/auth/otp/route.ts",
  "app/api/v1/play/auth/otp/verify/route.ts",
  "app/api/v1/play/auth/session/route.ts",
  "app/api/v1/play/cap/challenge/route.ts",
  "app/api/v1/play/cap/redeem/route.ts",
];

/** What reads a session (or its cookie) other than through withPlayer. */
const SESSION_READER = /resolvePlayer|readPlayer|playerSession|getSession|chainStart|PLAY_SESSION_COOKIE|__Host-play_session|cookies\(\)|get\(\s*["']cookie["']\s*\)/;

describe("player login guards", () => {
  it("Better Auth's HTTP handler is mounted nowhere (the play routes call auth.api behind their own checks)", () => {
    for (const file of files) expect(read(file), file).not.toMatch(/toNextJsHandler|auth\.handler\b|\.handler\(\s*request/);
  });

  it("every play API route is a playRoute; only the session route answers GET", () => {
    for (const route of LOGIN_ROUTES) expect(playRoutes, route).toContain(route);
    for (const route of playRoutes) {
      const text = read(route);
      const exports = [...text.matchAll(/^export const (\w+) = (\w+)\(/gm)].map((m) => [m[1], m[2]]);
      const methods = exports.filter(([name]) => /^[A-Z]+$/.test(name ?? ""));
      expect(methods.length, route).toBeGreaterThanOrEqual(1);
      for (const [method, builder] of methods) {
        expect(builder, route).toBe("playRoute");
        if (LOGIN_ROUTES.includes(route)) expect(method, route).toBe(route.endsWith("/session/route.ts") ? "GET" : "POST");
      }
    }
  });

  it("every other play route reads the player through withPlayer only; resolvePlayer is not exported", () => {
    expect(read("lib/play/handlers.ts")).not.toMatch(/export (async )?function resolvePlayer/);
    for (const route of playRoutes) {
      const text = read(route);
      expect(text, route).not.toMatch(SESSION_READER);
      if (!LOGIN_ROUTES.includes(route)) expect(text, `${route} must wrap its work in withPlayer(deps, request, (playerId) => ...)`).toMatch(/withPlayer\(/);
    }
    // The guard itself: a route that reads the session directly, or a player route without withPlayer, fails.
    expect('export const GET = playRoute("x", (deps, request) => resolvePlayer(deps, request.headers));').toMatch(SESSION_READER);
    expect('const c = request.headers.get("cookie");').toMatch(SESSION_READER);
    expect('export const POST = playRoute("x", (deps, request) => handleAnswer(deps, request));').not.toMatch(/withPlayer\(/);
  });

  it("withPlayer refuses a non-GET request without the exact play Origin as its first statement (US-027's POSTs)", () => {
    const handlers = read("lib/play/handlers.ts");
    const body = handlers.slice(handlers.indexOf("export async function withPlayer("));
    const firstLine = body.split("\n")[1]?.trim();
    expect(firstLine).toBe('if (!SAFE_METHODS.has(request.method.toUpperCase()) && !sameOrigin(deps, request)) return playError("origin");');
    expect(handlers).toContain('const SAFE_METHODS = new Set(["GET", "HEAD"]);');
  });

  // US-027: the question flow and the leaderboard. Each route hands withPlayer's player id to its handler; the
  // handlers take only opaque ids from the client (never a player id or a time) and pass them to ONE play function.
  it("US-027's routes exist with their method, wrap their handler in withPlayer, and take no player id or time from the client", () => {
    const PLAYER_ROUTES: Record<string, { readonly method: string; readonly handler: string }> = {
      "app/api/v1/play/sets/start/route.ts": { method: "POST", handler: "handleStartSet" },
      "app/api/v1/play/attempts/current/route.ts": { method: "POST", handler: "handleCurrent" },
      "app/api/v1/play/attempts/answer/route.ts": { method: "POST", handler: "handleAnswer" },
      "app/api/v1/play/leaderboard/route.ts": { method: "GET", handler: "handleLeaderboard" },
    };
    for (const [route, { method, handler }] of Object.entries(PLAYER_ROUTES)) {
      expect(playRoutes, route).toContain(route);
      expect(read(route), route).toContain(`export const ${method} = playRoute(`);
      expect(read(route), route).toContain(`withPlayer(deps, request, (playerId) => ${handler}(deps, request, playerId))`);
    }
    const trivia = read("lib/play/trivia.ts");
    expect(trivia).not.toMatch(SESSION_READER);
    const bodyKeys = [...trivia.matchAll(/playAction\("[^"]+", \[([^\]]*)\]/g)].map((m) => m[1]);
    expect(bodyKeys).toEqual(['"set_id"', '"attempt_id"', '"answer_id", "option_id"']);
    // Every call passes the session's player id first, and no time at all: the writes, the settle and the reveal.
    expect(trivia.match(/public\.play_\w+\(\$\{playerId\}/g)).toEqual([
      "public.play_start_set(${playerId}",
      "public.play_current(${playerId}",
      "public.play_settle(${playerId}",
      "public.play_reveal(${playerId}",
      "public.play_answer(${playerId}",
    ]);
    expect(trivia).not.toMatch(/Date\.parse|new Date\(|timestamptz/);
  });

  it("every state-changing play handler checks the exact Origin before anything else", () => {
    const handlers = read("lib/play/handlers.ts");
    for (const name of ["handleOtpRequest", "handleOtpVerify", "handleMagicLink", "handleMagicLinkResend", "handleLogout", "handleLogoutAll", "handlePlayCap"]) {
      const body = handlers.slice(handlers.indexOf(`export async function ${name}(`));
      const firstStatements = body.slice(0, body.indexOf("try {"));
      expect(firstStatements, name).toContain('if (!sameOrigin(deps, request)) return playError("origin");');
    }
  });
});
