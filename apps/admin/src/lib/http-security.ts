// Request-level protections applied by src/proxy.ts to every matched request, and again by the
// server action / route handler wrappers (lib/next/), so a matcher change cannot drop them.
//
// CSRF (plan M5a.2): the session cookie is SameSite=Strict, and every request that is not GET or
// HEAD must carry an Origin header exactly equal to ADMIN_ORIGIN. A missing Origin and "null"
// (sandboxed frames, some redirects) are refused: Next.js's own server action check lets a request
// without Origin through. GET and HEAD never change state.
//
// CSP: a fresh nonce per request. Scripts run only with that nonce ('strict-dynamic' lets them load
// their chunks); no 'unsafe-inline' for scripts. Styles allow 'unsafe-inline' (React style
// attributes, next/font); they cannot run code. 'unsafe-eval' only in development (React needs it
// for its dev tooling, never in a production build).
import { randomBytes } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** True when the request may proceed: a safe method, or an Origin exactly equal to the admin origin. */
export function originAllowed(method: string, origin: string | null, expected: string | null): boolean {
  if (isSafeMethod(method)) return true;
  return expected !== null && origin !== null && origin === expected;
}

/** 128 random bits, base64 (the CSP nonce source grammar). */
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

export function contentSecurityPolicy(options: { readonly nonce: string; readonly dev: boolean; readonly https: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/** Sent with every proxied response (Caddy adds HSTS in front). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
