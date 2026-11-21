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

  it("passes the checkout, Cap, SDK config / visit and mockup routes through untouched", async () => {
    for (const path of ["/api/v1/checkout/lp_x", "/api/v1/cap/lp_x/challenge", "/api/v1/lp/lp_x/config", "/api/v1/visit/lp_x", "/mockups/order/paid", "/"]) {
      const response = await proxy(request("api.example.test", path));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
      expect(response.headers.get("content-security-policy"), path).toBeNull();
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
