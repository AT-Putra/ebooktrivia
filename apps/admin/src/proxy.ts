// Runs before every request except static build assets (plan M5a.2; lib/http-security.ts):
//   - refuses any request other than GET / HEAD whose Origin is not exactly ADMIN_ORIGIN (403),
//     before a server action or route handler runs. Unset or invalid ADMIN_ORIGIN refuses them all;
//   - sets a per-request nonce CSP (request and response; Next.js reads the nonce from the request
//     header and puts it on its scripts) and the other security headers;
//   - marks every response no-store: pages and action results carry TOTP secrets, recovery codes
//     and personal data, which no browser or proxy cache may keep.
// The server action and route handler wrappers check the Origin again (a matcher change can
// silently drop proxy coverage, see the Next.js proxy docs).
import { type NextRequest, NextResponse } from "next/server";
import { adminOrigin } from "./lib/config.ts";
import { contentSecurityPolicy, newNonce, originAllowed, SECURITY_HEADERS } from "./lib/http-security.ts";

const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

function configuredOrigin(): string | null {
  try {
    return adminOrigin(process.env);
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest): NextResponse {
  const origin = configuredOrigin();
  if (!originAllowed(request.method, request.headers.get("origin"), origin)) {
    return new NextResponse("Forbidden: cross-origin request\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS },
    });
  }
  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development", https: origin?.startsWith("https://") === true });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  response.headers.set("cache-control", NO_STORE);
  response.headers.set("pragma", "no-cache");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg).*)"],
};
