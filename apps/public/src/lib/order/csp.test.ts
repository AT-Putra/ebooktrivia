// AC-T5: the order page's CSP allows only the vendors its landing page has a pixel id for.
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, LEGAL_HEADERS, ORDER_HEADERS, VENDOR_HOSTS } from "./csp.ts";
import { VENDORS, type Vendor } from "./vendors.ts";

const NONCE = "bm9uY2U=";
const csp = (vendors: readonly Vendor[], extra: { dev?: boolean; https?: boolean } = {}) => contentSecurityPolicy({ nonce: NONCE, vendors, dev: extra.dev ?? false, https: extra.https ?? true });
const directive = (policy: string, name: string): string[] => (policy.split("; ").find((d) => d.startsWith(`${name} `))?.split(" ").slice(1)) ?? [];
const HOST = /^https:\/\/[a-z0-9.-]+$/;

describe("contentSecurityPolicy", () => {
  it("allows no vendor at all for a landing page without pixels", () => {
    const policy = csp([]);
    expect(directive(policy, "script-src")).toEqual(["'self'", `'nonce-${NONCE}'`]);
    expect(directive(policy, "connect-src")).toEqual(["'self'"]);
    expect(directive(policy, "img-src")).toEqual(["'self'", "data:"]);
    expect(policy).not.toMatch(/facebook|tiktok|google|doubleclick|googlesyndication/);
  });

  it.each(VENDORS)("allows %s's hosts and no other vendor's", (vendor) => {
    const policy = csp([vendor]);
    const mine = [...VENDOR_HOSTS[vendor].script, ...VENDOR_HOSTS[vendor].connect, ...VENDOR_HOSTS[vendor].img];
    for (const host of mine) expect(policy, host).toContain(host);
    const others = VENDORS.filter((v) => v !== vendor).flatMap((v) => [...VENDOR_HOSTS[v].script, ...VENDOR_HOSTS[v].connect, ...VENDOR_HOSTS[v].img]);
    for (const host of others.filter((h) => !mine.includes(h))) expect(policy, host).not.toContain(host);
  });

  it("lets only www.googletagmanager.com serve scripts for Google; Google's other hosts are for requests only", () => {
    const policy = csp(["gtag"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, "https://www.googletagmanager.com"]);
    for (const host of ["https://www.google.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://pagead2.googlesyndication.com"]) {
      expect(directive(policy, "script-src"), host).not.toContain(host);
      expect(directive(policy, "connect-src"), host).toContain(host);
      expect(directive(policy, "img-src"), host).toContain(host);
    }
    expect(directive(policy, "frame-src")).toEqual(["'none'"]);
  });

  it("allows the union for a page with several pixels, each host once", () => {
    const policy = csp(["meta", "gtag"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, ...VENDOR_HOSTS.meta.script, ...VENDOR_HOSTS.gtag.script]);
    expect(policy).not.toContain("tiktok");
    const connect = directive(policy, "connect-src");
    expect(new Set(connect).size).toBe(connect.length);
  });

  it("lists only https hosts, no wildcard, no scheme-only source and no bare *", () => {
    for (const vendor of VENDORS) for (const host of [...VENDOR_HOSTS[vendor].script, ...VENDOR_HOSTS[vendor].connect, ...VENDOR_HOSTS[vendor].img]) expect(host, host).toMatch(HOST);
    expect(csp([...VENDORS])).not.toMatch(/ \*[ ;]| \*$|https:[ ;]|http:|\*\./);
  });

  it("has no inline-script escape: no 'unsafe-inline' or 'unsafe-eval' in scripts (eval only in development) and no 'strict-dynamic'", () => {
    for (const policy of [csp([]), csp([...VENDORS])]) {
      const scripts = directive(policy, "script-src");
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain("'unsafe-eval'");
      expect(scripts).not.toContain("'strict-dynamic'");
      expect(scripts).toContain(`'nonce-${NONCE}'`);
    }
    expect(directive(csp([], { dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("locks down everything else", () => {
    const policy = csp(["meta"]);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    for (const name of ["frame-src", "object-src", "base-uri", "form-action", "frame-ancestors"]) expect(directive(policy, name), name).toEqual(["'none'"]);
  });

  it("upgrades insecure requests only when the browser came over https", () => {
    expect(csp([], { https: true })).toContain("upgrade-insecure-requests");
    expect(csp([], { https: false })).not.toContain("upgrade-insecure-requests");
  });
});

describe("headers", () => {
  it("sends Referrer-Policy: strict-origin on the order origin, never cached, never framed, not indexed", () => {
    expect(ORDER_HEADERS["Referrer-Policy"]).toBe("strict-origin");
    expect(ORDER_HEADERS["Cache-Control"]).toContain("no-store");
    expect(ORDER_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(ORDER_HEADERS["X-Robots-Tag"]).toContain("noindex");
    expect(Object.keys(ORDER_HEADERS).map((h) => h.toLowerCase())).not.toContain("set-cookie");
  });

  it("keeps the legal pages on the usual policy", () => {
    expect(LEGAL_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(LEGAL_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});
