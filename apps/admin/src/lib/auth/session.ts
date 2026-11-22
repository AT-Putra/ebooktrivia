// Who is asking: the session behind the __Host-admin_session cookie, judged fail-closed.
// Better Auth checks the cookie signature and the 12 h expiry; this adds, in ONE statement that
// also moves last_seen_at forward: the session_state row exists (created only by our sign-in
// flows), idle < 30 min, created < 12 h ago, not expired. Then the admin profile must exist, be
// enabled and carry a known role, an enrolled user's session must have passed the second factor,
// and an un-enrolled user must still be within the enrollment deadline (enroll_by). Anything else
// is "anonymous" (sign in again). An enrolled admin whose password the worker found in a known breach
// (admin_profiles.password_breached_at, US-031) may only change it ("password_change").
import { isRole, type Role } from "../policy.ts";
import { SESSION_ABSOLUTE_SECONDS, SESSION_COOKIE, SESSION_IDLE_SECONDS } from "./instance.ts";
import { authHeaders } from "./request.ts";
import type { AuthRuntime } from "./runtime.ts";

export interface AdminIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly displayName: string;
}

export type AdminSession =
  | { readonly status: "anonymous" }
  /** Signed in with the password, TOTP not enrolled yet: may only enroll. */
  | { readonly status: "unenrolled"; readonly admin: AdminIdentity }
  /** Fully signed in, but the password is in a known breach (US-031): may only change it. */
  | { readonly status: "password_change"; readonly admin: AdminIdentity }
  | { readonly status: "active"; readonly admin: AdminIdentity };

const ANONYMOUS: AdminSession = { status: "anonymous" };

export function hasSessionCookie(headers: Headers): boolean {
  return authHeaders(headers, [SESSION_COOKIE]).has("cookie");
}

export async function loadAdminSession(rt: AuthRuntime, headers: Headers): Promise<AdminSession> {
  if (!hasSessionCookie(headers)) return ANONYMOUS;
  const session = await rt.auth.api.getSession({ headers: authHeaders(headers, [SESSION_COOKIE]), query: { disableRefresh: true } });
  if (session === null) return ANONYMOUS;
  const [row] = await rt.sql<
    { user_id: string; mfa_verified: boolean; two_factor_enabled: boolean | null; role: string | null; display_name: string | null; disabled: boolean | null; enroll_open: boolean | null; must_change: boolean | null }[]
  >`
    WITH touched AS (
      UPDATE admin_auth.session_state st SET last_seen_at = clock_timestamp()
        FROM admin_auth.session s
       WHERE st.session_id = s.id
         AND s.id = ${session.session.id}
         AND s."expiresAt" > clock_timestamp()
         AND s."createdAt" > clock_timestamp() - make_interval(secs => ${SESSION_ABSOLUTE_SECONDS})
         AND st.last_seen_at > clock_timestamp() - make_interval(secs => ${SESSION_IDLE_SECONDS})
      RETURNING s."userId" AS user_id, st.mfa_verified_at IS NOT NULL AS mfa_verified
    )
    SELECT t.user_id, t.mfa_verified, u."twoFactorEnabled" AS two_factor_enabled,
           p.role, p.display_name, p.disabled_at IS NOT NULL AS disabled, p.enroll_by > clock_timestamp() AS enroll_open,
           p.password_breached_at IS NOT NULL AS must_change
      FROM touched t
      JOIN admin_auth."user" u ON u.id = t.user_id
      LEFT JOIN public.admin_profiles p ON p.auth_user_id = t.user_id`;
  if (row === undefined || row.disabled !== false || !isRole(row.role) || row.display_name === null) return ANONYMOUS;
  const admin: AdminIdentity = { userId: row.user_id, sessionId: session.session.id, role: row.role, displayName: row.display_name };
  if (row.two_factor_enabled !== true) return row.enroll_open === true ? { status: "unenrolled", admin } : ANONYMOUS;
  if (!row.mfa_verified) return ANONYMOUS;
  return row.must_change === true ? { status: "password_change", admin } : { status: "active", admin };
}
