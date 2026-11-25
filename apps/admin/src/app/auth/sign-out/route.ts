// POST /auth/sign-out (a form post, never GET: no state change on GET). adminRoute refuses a
// cross-origin POST (403) before the session is touched. Without a usable session (12 hours after sign-in,
// already signed out) the answer is the same 303 to /login, with the cookies expired.
import { ADMIN_COOKIE_NAMES } from "../../../lib/auth/instance.ts";
import { signOut } from "../../../lib/auth/service.ts";
import { adminRoute } from "../../../lib/next/route.ts";

const EXPIRED = [ADMIN_COOKIE_NAMES.session_token, ADMIN_COOKIE_NAMES.two_factor].map(
  (name) => `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`,
);

const toLogin = (setCookies: readonly string[]): Response => {
  const headers = new Headers({ location: "/login", "cache-control": "no-store" });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
};

export const POST = adminRoute({ allowUnenrolled: true }, async ({ rt, req, admin }) => toLogin(await signOut(rt, admin, req)), {
  onAnonymous: () => toLogin(EXPIRED),
});
