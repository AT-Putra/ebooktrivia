import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AlertRow } from "./glitchtip.ts";
import { createInternalApp, HOOK_BODY_LIMIT } from "./internal-app.ts";
import { createLogger } from "./log.ts";

const TOKEN = "gt-hook-token-0123456789abcdef";
const silent = createLogger({ level: "silent", role: "internal" }, new Writable({ write: (_c, _e, done) => { done(); } }));

function app(options: { hosts?: string[]; failInsert?: boolean; rate?: number; now?: () => number } = {}) {
  const inserted: AlertRow[] = [];
  const hosts = new Set(options.hosts ?? ["shop.example.com", "xn--bcher-kva.example"]);
  const instance = createInternalApp({
    hasHost: (host) => hosts.has(host),
    insertAlert: (row) => {
      if (options.failInsert === true) return Promise.reject(new Error("db down"));
      inserted.push(row);
      return Promise.resolve();
    },
    tokenSha256: createHash("sha256").update(TOKEN).digest(),
    ratePerMinute: options.rate ?? 60,
    log: silent,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { instance, inserted };
}

const ask = (a: ReturnType<typeof app>, domain: string) => a.instance.request(`/caddy/ask?domain=${encodeURIComponent(domain)}`);
const hook = (a: ReturnType<typeof app>, body: string, token = TOKEN, headers: Record<string, string> = {}) =>
  a.instance.request(`/hooks/glitchtip/${token}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("GET /caddy/ask", () => {
  it("answers 200 for a registered host (ASCII case aside, exactly as stored), 404 otherwise", async () => {
    const a = app();
    for (const domain of ["shop.example.com", "SHOP.example.com", "xn--bcher-kva.example", "XN--BCHER-KVA.EXAMPLE"]) {
      expect((await ask(a, domain)).status, domain).toBe(200);
    }
    // Security review US-013 #1: no alias of a stored host is approved.
    for (const domain of ["shop.example.com.", "\uFF53hop.example.com", "sh\u00ADop.example.com", "shop\u3002example.com", "sho\u200Bp.example.com", "bücher.example"]) {
      expect((await ask(a, domain)).status, domain).toBe(400);
    }
    for (const domain of ["other.example.com", "example.com", "shop.example.com.evil.example"]) {
      expect((await ask(a, domain)).status, domain).toBe(404);
    }
  });

  it("answers 400 for a missing, repeated or non-host domain, and never matches it", async () => {
    const a = app({ hosts: ["10.0.0.1", "shop.example.com"] });
    expect((await a.instance.request("/caddy/ask")).status).toBe(400);
    expect((await a.instance.request("/caddy/ask?domain=shop.example.com&domain=x.example")).status).toBe(400);
    for (const domain of ["", "10.0.0.1", "[::1]", "shop.example.com:443", "a".repeat(300)]) {
      expect((await ask(a, domain)).status, domain).toBe(400);
    }
  });

  it("answers 500 without details when a handler throws", async () => {
    const broken = createInternalApp({
      hasHost: () => {
        throw new Error("set exploded");
      },
      insertAlert: () => Promise.resolve(),
      tokenSha256: Buffer.alloc(32),
      ratePerMinute: 1,
      log: silent,
    });
    const response = await broken.request("/caddy/ask?domain=shop.example.com");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("exploded");
  });

  it("is GET only", async () => {
    expect((await app().instance.request("/caddy/ask?domain=shop.example.com", { method: "POST" })).status).toBe(404);
  });
});

describe("POST /hooks/glitchtip/:token", () => {
  const body = JSON.stringify({ text: "GlitchTip Alert", attachments: [{ title: "Boom", title_link: "https://g.example/issues/1", text: "x" }] });

  it("inserts one alert row for a valid token and JSON object", async () => {
    const a = app();
    const response = await hook(a, body);
    expect(response.status).toBe(204);
    expect(a.inserted).toHaveLength(1);
    expect(a.inserted[0]).toMatchObject({ kind: "glitchtip_webhook", message: "Boom", dedupeKey: "glitchtip:https://g.example/issues/1" });
  });

  it("answers 404 for a wrong, short or long token, like an unknown route, without inserting", async () => {
    const a = app();
    for (const token of [`${TOKEN}x`, "short", "x".repeat(600), TOKEN.toUpperCase()]) {
      expect((await hook(a, body, token)).status, token).toBe(404);
    }
    expect((await a.instance.request("/hooks/glitchtip/", { method: "POST", body })).status).toBe(404);
    expect((await a.instance.request(`/hooks/glitchtip/${TOKEN}`)).status).toBe(404);
    expect((await a.instance.request("/hooks/other", { method: "POST", body })).status).toBe(404);
    expect(a.inserted).toEqual([]);
  });

  it("accepts exactly 64 KB and refuses one byte more with 413, whatever Content-Length claims", async () => {
    const a = app();
    const exact = JSON.stringify({ text: "x".repeat(HOOK_BODY_LIMIT - 11) });
    expect(Buffer.byteLength(exact)).toBe(HOOK_BODY_LIMIT);
    expect((await hook(a, exact)).status).toBe(204);
    const over = `${exact} `;
    expect((await hook(a, over)).status).toBe(413);
    expect((await hook(a, over, TOKEN, { "content-length": "10" })).status).toBe(413);
    expect((await hook(a, "{}", TOKEN, { "content-length": String(HOOK_BODY_LIMIT + 1) })).status).toBe(413);
    // A streamed (chunked) body without Content-Length is counted while it is read.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 70; i++) controller.enqueue(new Uint8Array(1024).fill(0x20));
        controller.close();
      },
    });
    expect((await a.instance.request(`/hooks/glitchtip/${TOKEN}`, { method: "POST", body: chunked, duplex: "half" })).status).toBe(413);
    expect(a.inserted).toHaveLength(1);
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    const a = app();
    for (const bad of ["not json", "[]", "1", "", "{\"a\":"]) expect((await hook(a, bad)).status, bad).toBe(400);
    expect(a.inserted).toEqual([]);
  });

  it("rate-limits accepted alerts per minute with 429", async () => {
    let now = 1_000_000;
    const a = app({ rate: 3, now: () => now });
    for (let i = 0; i < 3; i++) expect((await hook(a, body)).status).toBe(204);
    expect((await hook(a, body)).status).toBe(429);
    expect((await hook(a, body, "wrong-token-but-long-enough")).status).toBe(404);
    now += 60_000;
    expect((await hook(a, body)).status).toBe(204);
    expect(a.inserted).toHaveLength(4);
  });

  it("answers 503 when the alert cannot be stored, so GlitchTip may retry", async () => {
    expect((await hook(app({ failInsert: true }), body)).status).toBe(503);
  });
});
