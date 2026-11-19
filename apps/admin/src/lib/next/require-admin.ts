// requireAdmin (plan M5a.1): EVERY console layout, page and server action calls it, and route
// handlers use the same decision (src/app/guards.test.ts fails otherwise). See lib/access.ts for
// the rules; here a refusal becomes Next.js's redirect() or forbidden() (403).
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { decide, type RequireOptions } from "../access.ts";
import { type AdminIdentity, type AdminSession, hasSessionCookie, loadAdminSession } from "../auth/session.ts";
import { getRuntime } from "./runtime.ts";

export type { RequireOptions };

/** The session of the current request, judged once per request (React cache). */
export const currentSession = cache(async (): Promise<AdminSession> => {
  const h = new Headers(await headers());
  // No cookie: answer without the database (the login page and mockups need no configuration).
  if (!hasSessionCookie(h)) return { status: "anonymous" };
  return loadAdminSession(await getRuntime(), h);
});

export async function requireAdmin(options: RequireOptions): Promise<AdminIdentity> {
  const decision = decide(await currentSession(), options);
  if (decision.kind === "redirect") redirect(decision.to);
  if (decision.kind === "forbidden") forbidden();
  return decision.admin;
}
