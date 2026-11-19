// Route handler wrapper. Every exported method of a route.ts is `adminRoute(...)` (guards.test.ts,
// with the expected requirement of each). Before the handler runs: the Origin check for anything
// but GET / HEAD (403), the session (401 without one, or `onAnonymous`), the requirement (403). Only
// non-GET handlers get a mutation scope, so a GET handler cannot write through withAudit (no state
// change on GET). Errors are logged through lib/log.ts and answered with a bare 500.
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { decide, type RequireOptions } from "../access.ts";
import { runMutation } from "../audit.ts";
import type { AuthRuntime } from "../auth/runtime.ts";
import type { RequestInfo } from "../auth/service.ts";
import { type AdminIdentity, loadAdminSession } from "../auth/session.ts";
import { clientIp } from "../client-ip.ts";
import { isSafeMethod, originAllowed } from "../http-security.ts";
import { logEvent } from "../log.ts";
import { getRuntime } from "./runtime.ts";

export interface RouteContext {
  readonly rt: AuthRuntime;
  readonly req: RequestInfo;
  readonly admin: AdminIdentity;
}

export interface RouteExtras {
  /** The answer when there is no usable session (default 401), e.g. sign-out sends the browser to /login. */
  readonly onAnonymous?: (request: Request) => Response;
}

export const plain = (status: number, text: string, extra: Record<string, string> = {}): Response =>
  new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });

export function adminRoute(
  options: RequireOptions,
  handler: (ctx: RouteContext, request: Request) => Promise<Response>,
  extras: RouteExtras = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const rt = await getRuntime();
      if (!originAllowed(request.method, request.headers.get("origin"), rt.config.origin)) {
        logEvent("warn", "admin.cross_origin_refused", { kind: "route", method: request.method });
        return plain(403, "Forbidden");
      }
      const headers = new Headers(request.headers);
      const decision = decide(await loadAdminSession(rt, headers), options);
      if (decision.kind === "redirect") {
        if (decision.to !== "/login") return plain(403, "Forbidden");
        return extras.onAnonymous?.(request) ?? plain(401, "Unauthorized");
      }
      if (decision.kind === "forbidden") return plain(403, "Forbidden");
      const ctx: RouteContext = { rt, req: { headers, ip: clientIp(headers) }, admin: decision.admin };
      if (isSafeMethod(request.method)) return await handler(ctx, request);
      return await runMutation({ actor: { kind: "admin", userId: decision.admin.userId }, requestId: randomUUID(), ip: ctx.req.ip }, () => handler(ctx, request));
    } catch (error) {
      unstable_rethrow(error);
      logEvent("error", "admin.request_failed", { kind: "route", method: request.method }, error);
      return plain(500, "The request failed.");
    }
  };
}
