// src/proxy.ts without a database: the host gating, the rewrites, the nonce CSP and the headers of the order
// origin and the legal pages, and the failure of the order lookup (fail closed). The lookup that gives the
// CSP its vendors is tested against the database (test/order.int.test.ts) and in the browser (e2e).
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy.ts";

const ID = "AbCdEfGhIjKlMnOpQrStUv";

beforeEach(() => {
  vi.stubEnv("DOMAIN", "example.test");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const request = (host: string, path: string, headers: Record<string, string> = {}) => new NextRequest(`http://${host}${path}`, { headers: { host, ...headers } });
const rewriteTarget = (response: Response): string | null => {
  const target = response.headers.get("x-middleware-rewrite");
  return target === null ? null : new URL(target).pathname;
};
const csp = (response: Response): string => response.headers.get("content-security-policy") ?? "";
const nonceOf = (response: Response): string => /'nonce-([^']+)'/.exec(csp(response))?.[1] ?? "";

describe("order.<DOMAIN>", () => {
  it("rewrites the root to the shell with a vendor-less CSP and the order headers", async () => {
    const response = await proxy(request("order.example.test", "/"));
    expect(rewriteTarget(response)).toBe("/order");
    expect(csp(response)).toContain("script-src 'self' 'nonce-");
    expect(csp(response)).not.toMatch(/facebook|tiktok|google/);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers a malformed id, an unknown path and a foreign route with the one 404 page: the rewrite to /order/x", async () => {
    for (const path of ["/short", `/${ID}/x`, "/favicon.ico", "/order/" + ID, "/legal/p/terms/1", "/api/v1/checkout/lp_x"]) {
      const response = await proxy(request("order.example.test", path));
      expect(rewriteTarget(response), path).toBe("/order/x");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    }
  });

  it("gives every response its own nonce", async () => {
    const a = nonceOf(await proxy(request("order.example.test", "/")));
    const b = nonceOf(await proxy(request("order.example.test", "/")));
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });

  it("hands the order API through without a Cookie header and with the order headers", async () => {
    const response = await proxy(request("order.example.test", "/api/v1/order/status", { cookie: "__Host-play_session=secret" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-override-headers") ?? "").not.toContain("cookie");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
  });

  it("fails closed when the order lookup cannot run (no runtime): 503 text in Bahasa Indonesia, no page, no CSP", async () => {
    const response = await proxy(request("order.example.test", `/${ID}`));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(await response.text()).toBe("Layanan sedang sibuk. Coba lagi sebentar lagi.");
  });
});

describe("play.<DOMAIN>/legal", () => {
  it("serves the legal pages with a vendor-less nonce CSP", async () => {
    const response = await proxy(request("play.example.test", "/legal/juni-2026/terms/3"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(csp(response)).toContain("'nonce-");
    expect(csp(response)).not.toMatch(/facebook|tiktok|google/);
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("play.<DOMAIN>: the player login (US-026, security review L2)", () => {
  it("serves /login and /masuk with the play nonce CSP: strict-dynamic, wasm, blob workers; never unsafe-eval or blob scripts", async () => {
    for (const path of ["/login", "/masuk"]) {
      const response = await proxy(request("play.example.test", path, { "x-forwarded-proto": "https" }));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
      const policy = csp(response);
      const script = /script-src ([^;]+)/.exec(policy)?.[1] ?? "";
      expect(script).toBe(`'nonce-${nonceOf(response)}' 'strict-dynamic' 'wasm-unsafe-eval'`);
      expect(policy).toContain("worker-src blob:");
      expect(policy).toContain("connect-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("base-uri 'none'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("upgrade-insecure-requests");
      expect(policy).not.toContain("'unsafe-eval'");
      expect(script).not.toContain("blob:");
      expect(policy).not.toMatch(/facebook|tiktok|google/);
      // The nonce also reaches the page render (Next puts it on its scripts).
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(response));
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });

  it("never adds 'unsafe-eval', not even in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(csp(await proxy(request("play.example.test", "/login")))).not.toContain("'unsafe-eval'");
  });

  it("hands the play API through untouched on the play origin (the routes check the Origin themselves)", async () => {
    const response = await proxy(request("play.example.test", "/api/v1/play/auth/otp", { cookie: "__Host-play_session=s" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("answers every play route with a bare 404 on any other host", async () => {
    for (const host of ["api.example.test", "lp.example.test", "admin.example.test", "play.example.test.evil.test"]) {
      for (const path of ["/login", "/masuk", "/api/v1/play/auth/otp", "/api/v1/play/auth/session", "/api/v1/play/cap/challenge"]) {
        const response = await proxy(request(host, path));
        expect(response.status, `${host}${path}`).toBe(404);
        expect(await response.text()).toBe("");
      }
    }
    // On the order origin: the order page's own 404.
    expect(rewriteTarget(await proxy(request("order.example.test", "/login")))).toBe("/order/x");
  });

  it("refuses the play pages through Next's data route on every host", async () => {
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "1");
    for (const host of ["play.example.test", "api.example.test"]) {
      for (const path of ["/_next/data/BUILD/login.json", "/_next/data/BUILD/masuk.json", "/_next/data/BUILD/api/v1/play/auth/otp.json"]) {
        expect((await proxy(request(host, path))).status, `${host}${path}`).toBe(404);
      }
    }
  });

  it("serves the play routes on the dev play host (PUBLIC_DEV_PLAY_ORIGIN) only when it is a loopback host", async () => {
    vi.stubEnv("PUBLIC_DEV_PLAY_ORIGIN", "http://127.0.0.1:3103");
    expect((await proxy(request("127.0.0.1:3103", "/login"))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("localhost:3103", "/login"))).status).toBe(404);
    expect((await proxy(request("play.example.test", "/login"))).status).toBe(404);
    for (const ignored of ["http://play.evil.test:3103", "not a url"]) {
      vi.stubEnv("PUBLIC_DEV_PLAY_ORIGIN", ignored);
      expect((await proxy(request("play.example.test", "/login"))).headers.get("x-middleware-next"), ignored).toBe("1");
      expect((await proxy(request("play.evil.test:3103", "/login"))).status, ignored).toBe(404);
    }
  });
});

describe("play.<DOMAIN>: the trivia pages (US-027)", () => {
  it("rewrites /, /{programSlug} and /{programSlug}/set/{n} to the internal routes with the trivia nonce CSP and the play headers", async () => {
    for (const [path, target] of [
      ["/", "/trivia"],
      ["/juni-2026", "/trivia/juni-2026"],
      ["/juni-2026/set/3", "/trivia/juni-2026/set/3"],
    ] as const) {
      const response = await proxy(request("play.example.test", path, { "x-forwarded-proto": "https" }));
      expect(rewriteTarget(response), path).toBe(target);
      const policy = csp(response);
      expect(policy).toContain(`script-src 'nonce-${nonceOf(response)}' 'strict-dynamic'`);
      for (const directive of ["worker-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "upgrade-insecure-requests"]) expect(policy, directive).toContain(directive);
      expect(policy).not.toMatch(/unsafe-eval|wasm-unsafe-eval|blob:/);
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("answers the internal routes with a bare 404 on every host, and serves no trivia page elsewhere", async () => {
    for (const host of ["play.example.test", "api.example.test", "lp.example.test"]) {
      expect((await proxy(request(host, "/trivia/juni-2026"))).status, host).toBe(404);
      expect((await proxy(request(host, "/trivia/juni-2026/set/1"))).status, host).toBe(404);
    }
    const elsewhere = await proxy(request("api.example.test", "/juni-2026"));
    expect(elsewhere.headers.get("x-middleware-next")).toBe("1");
    expect(rewriteTarget(elsewhere)).toBeNull();
  });
});

describe("other hosts", () => {
  it("answers the legal and order routes with a bare 404", async () => {
    for (const [host, path] of [
      ["api.example.test", "/legal/juni-2026/terms/3"],
      ["order.example.test.evil.test", "/legal/juni-2026/terms/3"],
      ["play.example.test", "/order/x"],
      ["api.example.test", "/api/v1/order/status"],
      ["lp.example.test", "/order/" + ID],
    ] as const) {
      const response = await proxy(request(host, path));
      expect(response.status, `${host}${path}`).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("answers Next's data route with a bare 404 on every host, so it cannot reach the pages behind it (security N1)", async () => {
    // next.config.ts skipProxyUrlNormalize: Next then sets this and the proxy's NextURL keeps the RAW path
    // (/_next/data/{buildId}/...json) instead of the page path behind it.
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", "1");
    for (const host of ["order.example.test", "play.example.test", "api.example.test", "lp.example.test", "order.example.test."]) {
      for (const path of [`/_next/data/BUILD/order/${ID}.json`, "/_next/data/BUILD/api/v1/order/status.json", "/_next/data/BUILD/legal/p/terms/1.json", "/_next/%64ata/BUILD/x.json", "/%5Fnext/data/BUILD/x.json"]) {
        const response = await proxy(request(host, path));
        expect(response.status, `${host}${path}`).toBe(404);
        expect(await response.text()).toBe("");
      }
    }
    // A POST (the order API through the data route) is refused the same way.
    const post = await proxy(new NextRequest("http://order.example.test/_next/data/BUILD/api/v1/order/status.json", { method: "POST", headers: { host: "order.example.test" } }));
    expect(post.status).toBe(404);
  });

  it("passes the checkout, Cap, SDK config / visit, signed-file and mockup routes through untouched", async () => {
    for (const path of ["/api/v1/checkout/lp_x", "/api/v1/cap/lp_x/challenge", "/api/v1/lp/lp_x/config", "/api/v1/visit/lp_x", "/files/deliverables/x.pdf", "/cap/cap-v0.1.62.js", "/mockups/order/paid"]) {
      const response = await proxy(request("api.example.test", path));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
      expect(response.headers.get("content-security-policy"), path).toBeNull();
    }
  });

  // US-015: the deep /healthz is a JSON route of the api origin (Caddy lets the monitor's address reach it there and
  // answers 404 elsewhere). The proxy hands it through untouched there, and never to the route from the play or order
  // origin: /healthz is a program page (a 404) on the play origin and an unknown order on the order origin.
  it("passes /healthz through untouched on the api origin, and never serves it from the play or order origin", async () => {
    const api = await proxy(request("api.example.test", "/healthz"));
    expect(api.headers.get("x-middleware-next")).toBe("1");
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(rewriteTarget(await proxy(request("play.example.test", "/healthz")))).toBe("/trivia/healthz");
    expect(rewriteTarget(await proxy(request("order.example.test", "/healthz")))).toBe("/order/x");
  });

  // US-031 (the ZAP baseline found these pages without a script policy): every page the proxy does not route gets the
  // strictest one, the trivia nonce CSP, with the play headers.
  it("gives every other page (the api origin's /, robots.txt, any 404) the strict nonce CSP and the play headers", async () => {
    for (const [host, path] of [
      ["api.example.test", "/"],
      ["api.example.test", "/robots.txt"],
      ["play.example.test", "/sitemap.xml"],
      ["play.example.test", "/no/such/page"],
      ["lp.example.test", "/"],
    ] as const) {
      const response = await proxy(request(host, path, { "x-forwarded-proto": "https" }));
      expect(response.headers.get("x-middleware-next"), `${host}${path}`).toBe("1");
      expect(rewriteTarget(response)).toBeNull();
      const policy = csp(response);
      expect(policy, `${host}${path}`).toContain(`script-src 'nonce-${nonceOf(response)}' 'strict-dynamic'`);
      for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'", "worker-src 'none'"]) expect(policy, directive).toContain(directive);
      expect(policy).not.toMatch(/unsafe-eval|https:\/\//); // no eval, no third-party host
      expect(/script-src [^;]*'unsafe-inline'/.test(policy)).toBe(false);
      expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("does not serve the order or legal routes at all without a DOMAIN", async () => {
    vi.stubEnv("DOMAIN", "");
    for (const [host, path] of [
      ["order.example.test", "/order/x"],
      ["play.example.test", "/legal/juni-2026/terms/3"],
    ] as const) expect((await proxy(request(host, path))).status).toBe(404);
  });
});
