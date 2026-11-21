// Content-Security-Policy and security headers of the order status page (order.<DOMAIN>, AC-T5) and of
// the legal pages (play.<DOMAIN>/legal/...). Built per request by src/proxy.ts.
//
//   - Scripts: 'self' (Next's own chunks), the request's nonce (Next's inline bootstrap scripts), and the
//     script hosts of the vendors THIS landing page has a pixel id for, nothing else. No 'unsafe-inline',
//     no 'unsafe-eval' (development only), and NO 'strict-dynamic': with it a nonced script may load any
//     script from anywhere, which would make the per-vendor list meaningless. The vendor libraries are
//     loaded by our own script from the hosts below.
//   - A vendor's img / connect hosts come with it: a page without a TikTok pixel cannot talk to TikTok.
//   - Styles: 'unsafe-inline' like the admin console (React style attributes, next/font); a style cannot
//     run code, and scripts are the control that matters here.
//   - The vendor hosts are the ones in the vendors' own CSP guidance (Google: developers.google.com/
//     tag-platform/security/guides/csp, Google Ads section; Meta and TikTok: the hosts their pixel
//     libraries load from and report to). They are checked against the real vendors on staging
//     (plan M6 Verify: the MT pixel fires once from order.<DOMAIN>).
import type { Vendor } from "./vendors.ts";

interface VendorHosts {
  readonly script: readonly string[];
  readonly connect: readonly string[];
  readonly img: readonly string[];
}

export const VENDOR_HOSTS: Readonly<Record<Vendor, VendorHosts>> = {
  meta: {
    script: ["https://connect.facebook.net"],
    connect: ["https://www.facebook.com", "https://connect.facebook.net"],
    img: ["https://www.facebook.com"],
  },
  tiktok: {
    script: ["https://analytics.tiktok.com"],
    connect: ["https://analytics.tiktok.com", "https://analytics-ipv6.tiktokw.us"],
    img: ["https://analytics.tiktok.com"],
  },
  // Google's guide lists www.googleadservices.com and www.google.com as script sources for Ads too. They
  // are left out of script-src on purpose: those hosts serve many scripts (Google search pages, widgets),
  // so they would let a script from them run on a page that carries buyer data. gtag.js itself comes from
  // www.googletagmanager.com; the Ads conversion ping is a request (img / connect), which is allowed to
  // them. A browser may log a blocked secondary script from them in the console: expected, the conversion
  // is still sent (docs/runbooks/order-status-page.md, staging checks).
  gtag: {
    script: ["https://www.googletagmanager.com"],
    connect: [
      "https://www.googletagmanager.com",
      "https://www.googleadservices.com",
      "https://googleads.g.doubleclick.net",
      "https://pagead2.googlesyndication.com",
      "https://www.google.com",
      "https://www.google.co.id",
      "https://ad.doubleclick.net",
    ],
    img: [
      "https://www.googletagmanager.com",
      "https://www.googleadservices.com",
      "https://googleads.g.doubleclick.net",
      "https://pagead2.googlesyndication.com",
      "https://www.google.com",
      "https://www.google.co.id",
    ],
  },
};

export interface CspOptions {
  readonly nonce: string;
  /** The vendors the landing page of this order has a pixel id for (none: none is allowed). */
  readonly vendors: readonly Vendor[];
  readonly dev: boolean;
  readonly https: boolean;
}

const hostsOf = (vendors: readonly Vendor[], kind: keyof VendorHosts): string[] => [...new Set(vendors.flatMap((vendor) => VENDOR_HOSTS[vendor][kind]))];

export function contentSecurityPolicy(options: CspOptions): string {
  const { vendors } = options;
  const directives = [
    "default-src 'self'",
    ["script-src 'self'", `'nonce-${options.nonce}'`, ...hostsOf(vendors, "script"), ...(options.dev ? ["'unsafe-eval'"] : [])].join(" "),
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data:", ...hostsOf(vendors, "img")].join(" "),
    "font-src 'self'",
    ["connect-src 'self'", ...hostsOf(vendors, "connect")].join(" "),
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

/**
 * Sent with every response of the order origin. `Referrer-Policy: strict-origin` (AC-T5): a vendor
 * library or a link never sees more than `https://order.<DOMAIN>`, whatever the document's URL is.
 * Caddy sets its own Referrer-Policy on every app host after the app (defer); the order site overrides
 * it with this same value (infra/caddy/Caddyfile).
 */
export const ORDER_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "strict-origin",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** The legal pages (play origin): static text, so no vendor and no cookie-bearing request is involved. */
export const LEGAL_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * The player login pages, /login and /masuk (US-026, security review L2), on the play origin. No vendor at all.
 * Scripts: the request's nonce and 'strict-dynamic' (the self-hosted Cap widget is loaded by our own nonced
 * script, apps/public/public/cap), 'wasm-unsafe-eval' for its WebAssembly solver; its proof of work runs in
 * workers made from blob: URLs, so worker-src blob: (and blob: never in script-src). Never 'unsafe-eval', not
 * even in development. Requests go to the page's own origin only (the login API, the Cap routes, the wasm).
 */
export function playContentSecurityPolicy(options: { readonly nonce: string; readonly https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${options.nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "worker-src blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The trivia pages (US-027: /, /{programSlug}, /{programSlug}/set/{n}) on the play origin. No vendor and no Cap
 * widget: the request's nonce and 'strict-dynamic' for Next's own scripts, nothing else (no 'wasm-unsafe-eval', no
 * workers); requests go to the page's own origin only (the play API). No form posts anywhere.
 */
export function triviaContentSecurityPolicy(options: { readonly nonce: string; readonly https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${options.nonce}' 'strict-dynamic'`,
    "worker-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The player login pages (and the trivia pages, US-027): never framed, never cached, no Referer leaves them (the magic link's confirm page has
 * just read its token from the URL fragment; a fragment is never in a Referer, and no other URL part is either).
 */
export const PLAY_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
