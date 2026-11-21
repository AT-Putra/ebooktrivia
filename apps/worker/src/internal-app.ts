// HTTP app of the internal process (Hono). Two routes, everything else 404:
//
//   GET  /caddy/ask?domain=<host>   Caddy on-demand TLS: 200 when the normalized host is in the
//                                   in-memory served-hosts set (src/domains.ts), 404 when not, 400
//                                   for input that is not a plain DNS name. No DB access per request.
//   POST /hooks/glitchtip/:token    sha256(token) compared in constant time with the configured
//                                   hash; a wrong token is 404 (the route is not revealed). Body at
//                                   most 64 KB, counted while streaming (413); a JSON object is
//                                   required (400); a fixed per-minute budget (429); one alerts row
//                                   per call (204), 503 when it cannot be stored. No outbound calls.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { type AlertRow, alertFromGlitchtip, readLimitedBody } from "./glitchtip.ts";
// The subpath only: the internal process must not load the rest of core (test/internal.int.test.ts).
import { normalizeHost } from "@ebooktrivia/core/hosts";
import type { Logger } from "./log.ts";

export const HOOK_BODY_LIMIT = 64 * 1024;

export interface InternalAppDeps {
  readonly hasHost: (host: string) => boolean;
  readonly insertAlert: (row: AlertRow) => Promise<void>;
  readonly tokenSha256: Buffer;
  readonly ratePerMinute: number;
  readonly log: Logger;
  readonly now?: () => number;
}

export function createInternalApp(deps: InternalAppDeps): Hono {
  const now = deps.now ?? Date.now;
  const tokenMatches = (token: string): boolean => {
    if (token.length < 16 || token.length > 512) return false;
    return timingSafeEqual(createHash("sha256").update(token, "utf8").digest(), deps.tokenSha256);
  };
  let windowStart = now();
  let used = 0;
  const withinRate = (): boolean => {
    const at = now();
    if (at - windowStart >= 60_000) {
      windowStart = at;
      used = 0;
    }
    used++;
    return used <= deps.ratePerMinute;
  };

  const app = new Hono();

  app.get("/caddy/ask", (c) => {
    const values = c.req.queries("domain") ?? [];
    const host = values.length === 1 && values[0] !== undefined ? normalizeHost(values[0]) : null;
    if (host === null) return c.text("bad request", 400);
    return deps.hasHost(host) ? c.text("ok", 200) : c.text("not found", 404);
  });

  app.post("/hooks/glitchtip/:token", async (c) => {
    if (!tokenMatches(c.req.param("token"))) return c.text("not found", 404);
    if (!withinRate()) return c.text("too many requests", 429);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > HOOK_BODY_LIMIT) return c.text("payload too large", 413);
    const raw = await readLimitedBody(c.req.raw.body, HOOK_BODY_LIMIT);
    if (raw === "too_large") return c.text("payload too large", 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return c.text("bad request", 400);
    }
    const row = alertFromGlitchtip(parsed);
    if (row === null) return c.text("bad request", 400);
    try {
      await deps.insertAlert(row);
    } catch (err) {
      deps.log.error({ err }, "glitchtip alert could not be stored");
      return c.text("unavailable", 503);
    }
    deps.log.info({ kind: row.kind, dedupeKey: row.dedupeKey }, "glitchtip alert stored");
    return c.body(null, 204);
  });

  app.notFound((c) => c.text("not found", 404));
  app.onError((err, c) => {
    deps.log.error({ err }, "internal request failed");
    return c.text("error", 500);
  });
  return app;
}
