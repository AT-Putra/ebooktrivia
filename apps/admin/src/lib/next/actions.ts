// Server action wrappers. Every export of a server-action module is one of these
// (src/app/guards.test.ts checks it, with the expected requirement of each). Each wrapper, before
// the action body runs:
//   1. checks the Origin header against ADMIN_ORIGIN exactly (missing / "null" refused) — the proxy
//      does too, this keeps it if a matcher change ever skips the proxy;
//   2. adminAction: requireAdmin(options) (redirect / 403); authAction: nothing more (sign-in steps);
//   3. opens the mutation scope (actor, request id, client IP) that withAudit requires.
// Any other error is logged through lib/log.ts (type and code only) and replaced by a bare Error,
// so no driver detail (a "Failing row contains (...)" or a key value) reaches Next.js's own error
// log or the client. Next.js control flow (redirect, forbidden) passes through unchanged.
import { randomUUID } from "node:crypto";
import { forbidden, unstable_rethrow } from "next/navigation";
import type { RequireOptions } from "../access.ts";
import { runMutation } from "../audit.ts";
import type { AuthRuntime } from "../auth/runtime.ts";
import type { RequestInfo } from "../auth/service.ts";
import type { AdminIdentity } from "../auth/session.ts";
import { originAllowed } from "../http-security.ts";
import { logEvent } from "../log.ts";
import { requestInfo } from "./request.ts";
import { requireAdmin } from "./require-admin.ts";
import { getRuntime } from "./runtime.ts";

export interface AuthActionContext {
  readonly rt: AuthRuntime;
  readonly req: RequestInfo;
}

export interface AdminActionContext extends AuthActionContext {
  readonly admin: AdminIdentity;
}

export const REQUEST_FAILED = "The request failed.";

async function sameOrigin(): Promise<{ rt: AuthRuntime; req: RequestInfo }> {
  const [rt, req] = await Promise.all([getRuntime(), requestInfo()]);
  if (!originAllowed("POST", req.headers.get("origin"), rt.config.origin)) {
    logEvent("warn", "admin.cross_origin_refused", { kind: "server_action" });
    forbidden();
  }
  return { rt, req };
}

async function contained<R>(kind: string, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    logEvent("error", "admin.request_failed", { kind }, error);
    // eslint-disable-next-line preserve-caught-error -- the cause is dropped on purpose: its message and driver detail may quote PII (logged above as type + code)
    throw new Error(REQUEST_FAILED);
  }
}

/** A console action: Origin check, requireAdmin(options), mutation scope as the signed-in admin. */
export function adminAction<A extends unknown[], R>(options: RequireOptions, body: (ctx: AdminActionContext, ...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A): Promise<R> =>
    contained("server_action", async () => {
      const { rt, req } = await sameOrigin();
      const admin = await requireAdmin(options);
      return runMutation({ actor: { kind: "admin", userId: admin.userId }, requestId: randomUUID(), ip: req.ip }, () => body({ rt, req, admin }, ...args));
    });
}

/** A sign-in step (no session yet): Origin check and a mutation scope as the system. */
export function authAction<A extends unknown[], R>(body: (ctx: AuthActionContext, ...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args: A): Promise<R> =>
    contained("auth_action", async () => {
      const { rt, req } = await sameOrigin();
      return runMutation({ actor: { kind: "system" }, requestId: randomUUID(), ip: req.ip }, () => body({ rt, req }, ...args));
    });
}
