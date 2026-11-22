// The header policy of security-headers.ts (US-031): a compliant response of each host passes, and every rule fails
// when its header is missing or weakened (so a policy change that stops checking a rule is caught here). The real
// responses are checked by infra/verify/local/security-headers.sh.
import { describe, expect, it } from "vitest";
import { type Answer, checkFreshNonce, checkProbe, type HostKind, noncesOf, parseCsp, parseHeaderDump } from "./security-headers.ts";

const EDGE = [
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["content-security-policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"],
] as const;
const NONCE_CSP = (nonce: string) => `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
const APP_PAGE: Answer = {
  status: 200,
  headers: [
    ["content-type", "text/html; charset=utf-8"],
    ["content-security-policy", NONCE_CSP("AbCdEfGhIjKlMnOpQrStUv==")],
    ["cache-control", "private, no-cache, no-store, max-age=0, must-revalidate"],
    ["cross-origin-opener-policy", "same-origin"],
    ["cross-origin-resource-policy", "same-origin"],
    ["permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ...EDGE,
  ],
};
const LP_PAGE: Answer = {
  status: 200,
  headers: [
    ["content-type", "text/html; charset=utf-8"],
    ["content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://api.example.test; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"],
    ["strict-transport-security", "max-age=31536000"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
  ],
};
const JSON_ANSWER: Answer = {
  status: 503,
  headers: [["content-type", "application/json; charset=utf-8"], ["cache-control", "no-store"], ["vary", "Origin"], ["referrer-policy", "strict-origin-when-cross-origin"], ...EDGE],
};
const SDK_FILE: Answer = {
  status: 200,
  headers: [["content-type", "text/javascript; charset=utf-8"], ["access-control-allow-origin", "*"], ["cross-origin-resource-policy", "cross-origin"], ["cache-control", "public, max-age=31536000, immutable"], ["referrer-policy", "strict-origin-when-cross-origin"], ...EDGE],
};

const check = (host: HostKind, answer: Answer, expectedStatus: number | null = answer.status) => checkProbe({ host, label: "t", expectedStatus, response: answer });
const without = (answer: Answer, name: string): Answer => ({ ...answer, headers: answer.headers.filter(([n]) => n !== name) });
const replaced = (answer: Answer, name: string, value: string): Answer => ({ ...without(answer, name), headers: [...without(answer, name).headers, [name, value]] });
const plus = (answer: Answer, name: string, value: string): Answer => ({ ...answer, headers: [...answer.headers, [name, value]] });

describe("the header policy", () => {
  it("passes a compliant response of every host", () => {
    for (const host of ["admin", "play"] as const) expect(check(host, APP_PAGE), host).toEqual([]);
    expect(check("order", replaced(APP_PAGE, "referrer-policy", "strict-origin"))).toEqual([]);
    expect(check("lp", LP_PAGE)).toEqual([]);
    expect(check("api", JSON_ANSWER)).toEqual([]);
    expect(check("sdk", SDK_FILE)).toEqual([]);
    expect(check("play", APP_PAGE, null)).toEqual([]);
  });

  it("fails each edge header that is missing, doubled or weakened", () => {
    expect(check("admin", without(APP_PAGE, "strict-transport-security"))).toContain("strict-transport-security: 0 headers, want exactly 1");
    expect(check("admin", plus(APP_PAGE, "strict-transport-security", "max-age=31536000; includeSubDomains"))).toContain("strict-transport-security: 2 headers, want exactly 1");
    expect(check("admin", replaced(APP_PAGE, "strict-transport-security", "max-age=300; includeSubDomains")).join()).toMatch(/strict-transport-security "max-age=300/);
    expect(check("admin", replaced(APP_PAGE, "strict-transport-security", "max-age=31536000; includeSubDomains; preload")).join()).toMatch(/want "max-age=31536000; includeSubDomains"/);
    expect(check("lp", replaced(LP_PAGE, "strict-transport-security", "max-age=31536000; includeSubDomains")).join()).toMatch(/want "max-age=31536000"/);
    expect(check("admin", without(APP_PAGE, "x-content-type-options"))).toContain("x-content-type-options: 0 headers, want exactly 1");
    expect(check("admin", plus(APP_PAGE, "referrer-policy", "same-origin"))).toContain("referrer-policy: 2 headers, want exactly 1");
    expect(check("admin", replaced(APP_PAGE, "referrer-policy", "unsafe-url")).join()).toMatch(/referrer-policy "unsafe-url" is not one of/);
    expect(check("order", APP_PAGE).join()).toMatch(/want strict-origin on the order origin/);
    expect(check("admin", plus(APP_PAGE, "server", "Caddy"))).toContain("server must not be sent");
    expect(check("admin", plus(APP_PAGE, "x-powered-by", "Next.js"))).toContain("x-powered-by must not be sent");
    expect(check("order", plus(replaced(APP_PAGE, "referrer-policy", "strict-origin"), "x-middleware-rewrite", "/order/x"))).toContain("x-middleware-rewrite must not be sent");
    expect(check("api", plus(JSON_ANSWER, "access-control-allow-origin", "*"))).toContain("access-control-allow-origin: * outside the SDK files");
    expect(check("api", plus(JSON_ANSWER, "access-control-allow-credentials", "true"))).toContain("access-control-allow-credentials must never be sent");
    expect(check("admin", APP_PAGE, 404)).toContain("status 200, want 404");
  });

  it("fails an app page without the nonce CSP, or with unsafe script sources, framing, caching or COOP", () => {
    expect(check("admin", without(APP_PAGE, "content-security-policy"))).toContain("HTML without an enforced Content-Security-Policy");
    const csp = (policy: string) => replaced(without(APP_PAGE, "content-security-policy"), "content-security-policy", policy);
    expect(check("admin", csp("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))).toContain("CSP script-src has no per-request nonce");
    expect(check("admin", csp(`${NONCE_CSP("AbCdEfGhIjKlMnOpQrStUv==")}; script-src 'unsafe-inline'`))).toEqual([]); // a repeated directive is ignored by browsers
    expect(check("admin", csp("default-src 'self'; script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv==' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))).toContain("CSP allows 'unsafe-inline' for scripts");
    expect(check("admin", csp("default-src 'self'; script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv==' 'unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))).toContain("CSP allows 'unsafe-eval' for scripts");
    expect(check("admin", csp("default-src 'self' 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))).toEqual([]); // default-src is the fallback
    expect(check("admin", csp("img-src 'self'"))).toContain("no CSP restricts scripts (script-src or default-src)");
    // script-src-elem governs <script> elements and script-src-attr inline handlers (code review 12): each is checked.
    const BASE = "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    expect(check("admin", csp(`script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; script-src-elem 'self' 'unsafe-inline'; ${BASE}`))).toEqual(
      expect.arrayContaining(["CSP script-src has no per-request nonce", "CSP allows 'unsafe-inline' for scripts"]),
    );
    expect(check("admin", csp(`script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; script-src-elem 'nonce-AbCdEfGhIjKlMnOpQrStUv==' 'unsafe-eval'; ${BASE}`))).toContain("CSP allows 'unsafe-eval' for scripts");
    expect(check("admin", csp(`script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; script-src-attr 'unsafe-inline'; ${BASE}`))).toContain("CSP allows 'unsafe-inline' for scripts");
    expect(check("admin", csp(`script-src 'self'; script-src-elem 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; ${BASE}`))).toEqual([]);
    expect(check("admin", csp("script-src 'nonce-short'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"))).toContain("CSP script-src has no per-request nonce");
    expect(check("admin", csp("script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; base-uri 'none'; frame-ancestors 'none'"))).toContain("CSP has no object-src 'none'");
    expect(check("admin", csp("script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; object-src 'none'; frame-ancestors 'none'"))).toContain("CSP has no base-uri 'none' or 'self'");
    expect(check("admin", csp("script-src 'nonce-AbCdEfGhIjKlMnOpQrStUv=='; object-src 'none'; base-uri 'none'"))).toContain("CSP has no frame-ancestors 'none'");
    expect(check("admin", replaced(APP_PAGE, "x-frame-options", "SAMEORIGIN")).join()).toMatch(/x-frame-options "SAMEORIGIN", want DENY/);
    expect(check("admin", replaced(APP_PAGE, "cache-control", "public, max-age=60")).join()).toMatch(/has no no-store/);
    expect(check("admin", without(APP_PAGE, "cross-origin-opener-policy"))).toContain("cross-origin-opener-policy is not same-origin");
    expect(check("admin", replaced(APP_PAGE, "permissions-policy", "camera=()"))).toEqual(["permissions-policy lacks microphone=()", "permissions-policy lacks geolocation=()"]);
    expect(check("admin", without(APP_PAGE, "cross-origin-resource-policy"))).toContain("cross-origin-resource-policy is not same-origin on admin");
    expect(check("play", without(APP_PAGE, "cross-origin-resource-policy"))).toEqual([]);
    expect(check("api", APP_PAGE)).toEqual([]); // the api origin's / and 404 pages: held to the page rules
    expect(check("sdk", APP_PAGE)).toContain("HTML from the sdk host");
  });

  it("holds an LP page to its documented default: inline scripts allowed, never eval, never framed by others", () => {
    const csp = (policy: string) => replaced(LP_PAGE, "content-security-policy", policy);
    expect(check("lp", csp("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'none'; frame-ancestors 'self'"))).toContain("CSP allows 'unsafe-eval' for scripts");
    expect(check("lp", csp("default-src 'self'; script-src 'self'; object-src 'none'"))).toContain("LP CSP has no frame-ancestors 'self' or 'none'");
    expect(check("lp", csp("default-src 'self'; frame-ancestors 'self'"))).toContain("CSP has no object-src 'none'");
  });

  it("allows cookies only on admin and play, and only __Host-, Secure, HttpOnly, SameSite, Path=/, no Domain", () => {
    const good = "__Host-admin_session=v; Path=/; Secure; HttpOnly; SameSite=Strict";
    expect(check("admin", plus(APP_PAGE, "set-cookie", good))).toEqual([]);
    expect(check("play", plus(APP_PAGE, "set-cookie", "__Host-play_session=v; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax"))).toEqual([]);
    for (const host of ["order", "api", "sdk", "lp"] as const) {
      const base = { order: replaced(APP_PAGE, "referrer-policy", "strict-origin"), api: JSON_ANSWER, sdk: SDK_FILE, lp: LP_PAGE }[host];
      expect(check(host, plus(base, "set-cookie", good)), host).toEqual([`set-cookie on the ${host} host (1)`]);
    }
    const bad = (cookie: string) => check("admin", plus(APP_PAGE, "set-cookie", cookie));
    expect(bad("sid=v; Path=/; Secure; HttpOnly; SameSite=Strict")).toEqual(["cookie sid: not a __Host- name"]);
    expect(bad("__Host-a=v; Path=/; HttpOnly; SameSite=Strict")).toEqual(["cookie __Host-a: no Secure"]);
    expect(bad("__Host-a=v; Path=/; Secure; SameSite=Strict")).toEqual(["cookie __Host-a: no HttpOnly"]);
    expect(bad("__Host-a=v; Path=/; Secure; HttpOnly; SameSite=None")).toEqual(["cookie __Host-a: SameSite is not Strict or Lax"]);
    expect(bad("__Host-a=v; Path=/x; Secure; HttpOnly; SameSite=Lax")).toEqual(["cookie __Host-a: Path is not /"]);
    expect(bad("__Host-a=v; Path=/; Domain=example.test; Secure; HttpOnly; SameSite=Lax")).toEqual(["cookie __Host-a: has a Domain"]);
  });

  it("requires the edge's global CSP (frame-ancestors, object-src, base-uri 'none') on every response of our hosts, not on LP domains", () => {
    const GLOBAL = "no CSP with frame-ancestors, object-src and base-uri 'none' (the edge's global policy)";
    expect(check("api", without(JSON_ANSWER, "content-security-policy"))).toEqual([GLOBAL]);
    expect(check("sdk", replaced(SDK_FILE, "content-security-policy", "frame-ancestors 'none'"))).toEqual([GLOBAL]);
    expect(check("api", replaced(JSON_ANSWER, "content-security-policy", "frame-ancestors 'none'; object-src 'self'; base-uri 'none'"))).toEqual([GLOBAL]);
    expect(check("lp", LP_PAGE)).toEqual([]);
  });

  it("requires no-store on JSON and the CORS / CORP of the SDK files", () => {
    expect(check("api", replaced(JSON_ANSWER, "cache-control", "max-age=60")).join()).toMatch(/JSON with cache-control "max-age=60", want no-store/);
    expect(check("sdk", without(SDK_FILE, "access-control-allow-origin")).join()).toMatch(/SDK file without access-control-allow-origin/);
    expect(check("sdk", without(SDK_FILE, "cross-origin-resource-policy")).join()).toMatch(/SDK file without cross-origin-resource-policy/);
  });

  it("wants a fresh nonce per load", () => {
    const second = replaced(APP_PAGE, "content-security-policy", NONCE_CSP("ZyXwVuTsRqPoNmLkJiHgFe=="));
    expect(noncesOf(APP_PAGE)).toEqual(["'nonce-AbCdEfGhIjKlMnOpQrStUv=='"]);
    expect(checkFreshNonce(APP_PAGE, second)).toEqual([]);
    expect(checkFreshNonce(APP_PAGE, APP_PAGE)).toEqual(["the same CSP nonce on two loads"]);
    expect(checkFreshNonce(APP_PAGE, JSON_ANSWER)).toEqual(["no nonce to compare"]);
  });

  it("parses a curl dump (the last block after 100 Continue) and a CSP", () => {
    const dump = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nX-Content-Type-Options: nosniff\r\nVary: Origin\r\n\r\n";
    expect(parseHeaderDump(dump)).toEqual({ status: 503, headers: [["content-type", "application/json"], ["x-content-type-options", "nosniff"], ["vary", "Origin"]] });
    expect(parseHeaderDump("")).toEqual({ status: 0, headers: [] });
    expect([...parseCsp("Script-Src 'self'; ; img-src data:").entries()]).toEqual([["script-src", ["'self'"]], ["img-src", ["data:"]]]);
  });
});
