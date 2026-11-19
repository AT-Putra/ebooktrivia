// What a session may reach (no I/O): the decision behind requireAdmin (lib/next/require-admin.ts),
// adminAction (lib/next/actions.ts) and adminRoute (lib/next/route.ts). Fails closed:
//   no / invalid / expired (idle 30 min, absolute 12 h) session, disabled user  -> /login
//   signed in with the password but TOTP not enrolled                          -> /enroll
//   permission denied by policy.ts                                               -> 403
// Every guard states what it requires, exactly one of (a type error otherwise, and
// src/app/guards.test.ts checks each call against its expected value):
//   permission       an active session whose role policy.ts allows it;
//   enrollment       the TOTP enrollment page and its actions: un-enrolled sessions only (an
//                    enrolled user is sent on to the console);
//   allowUnenrolled  any signed-in session, enrolled or not (sign-out only).
import type { AdminIdentity, AdminSession } from "./auth/session.ts";
import { can, type Permission, type QuestionPermission } from "./policy.ts";

export type GuardPermission = Exclude<Permission, QuestionPermission>;

export type RequireOptions =
  | { readonly permission: GuardPermission; readonly enrollment?: never; readonly allowUnenrolled?: never }
  | { readonly enrollment: true; readonly permission?: never; readonly allowUnenrolled?: never }
  | { readonly allowUnenrolled: true; readonly permission?: never; readonly enrollment?: never };

export type AccessDecision =
  | { readonly kind: "allow"; readonly admin: AdminIdentity }
  | { readonly kind: "redirect"; readonly to: "/login" | "/enroll" | "/" }
  | { readonly kind: "forbidden" };

export function decide(session: AdminSession, options: RequireOptions): AccessDecision {
  if (session.status === "anonymous") return { kind: "redirect", to: "/login" };
  if (session.status === "unenrolled") {
    return options.enrollment === true || options.allowUnenrolled === true ? { kind: "allow", admin: session.admin } : { kind: "redirect", to: "/enroll" };
  }
  if (options.enrollment === true) return { kind: "redirect", to: "/" };
  if (options.allowUnenrolled === true) return { kind: "allow", admin: session.admin };
  // A permission is required by the type; refuse anyway if a caller got here without one.
  const permission = (options as { readonly permission?: GuardPermission }).permission;
  if (permission === undefined || !can(session.admin.role, permission)) return { kind: "forbidden" };
  return { kind: "allow", admin: session.admin };
}
