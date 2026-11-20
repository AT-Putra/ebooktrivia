// The API client: no cookies, the right paths, and bodies checked field by field.
import { describe, expect, it } from "vitest";
import { createApi, type Fetch, parseCheckoutResponse, parseConfig, parseError } from "./api.ts";

const ORIGIN = "https://api.example.test";
const LP = "lp_Abcdefgh12345678abcdefgh";
const EVENT_ID = "0b9f5f0e-2c1d-4e6a-9d3f-1a2b3c4d5e6f";
const CONFIG = {
  v: 1,
  lp_key: LP,
  checkout_open: true,
  adnets: [{ slug: "adnet-a", clickid_param: "cid" }],
  pixels: { meta: "1234567890123", tiktok: "ABCDEFGH12345678", gtag: "AW-123456789" },
  midtrans_env: "sandbox",
  legal: { play_origin: "https://play.example.test", program: "juni-2026", terms: 3, privacy: 2 },
};
const CHECKOUT = { v: 1, event_id: EVENT_ID, snap_redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/x", value_idr: 49000, deduped: false };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: Fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { calls, fetchImpl };
}

describe("every request", () => {
  it("is a credential-less CORS request to the API origin, with a timeout and no redirects", async () => {
    const { calls, fetchImpl } = recorder(() => json(CONFIG));
    const api = createApi(ORIGIN, LP, fetchImpl);
    await api.config();
    await api.visit({ clickid: "c" });
    await api.checkout({ name: "Budi", phone: "+6281234567890", email: "b@example.co", cap_token: "t", consent: { terms: 3, privacy: 2 }, attribution: {} });
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/v1/lp/${LP}/config`, `${ORIGIN}/api/v1/visit/${LP}`, `${ORIGIN}/api/v1/checkout/${LP}`]);
    for (const { init } of calls) {
      expect(init.credentials).toBe("omit");
      expect(init.mode).toBe("cors");
      expect(init.redirect).toBe("error");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls[1]?.init.keepalive).toBe(true);
    expect(calls[2]?.init.keepalive).toBe(false);
  });

  it("sends exactly the contract's fields", async () => {
    const { calls, fetchImpl } = recorder(() => json(CHECKOUT));
    const api = createApi(ORIGIN, LP, fetchImpl);
    await api.checkout({ name: "Budi", phone: "+6281234567890", email: "b@example.co", cap_token: "tok", consent: { terms: 3, privacy: 2 }, attribution: { clickid: "c1" }, visit_id: EVENT_ID });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      v: 1,
      name: "Budi",
      phone: "+6281234567890",
      email: "b@example.co",
      cap_token: "tok",
      consent: { terms: 3, privacy: 2 },
      attribution: { clickid: "c1" },
      visit_id: EVENT_ID,
    });
    expect(calls[0]?.init.headers).toMatchObject({ "content-type": "application/json" });
  });
});

describe("config", () => {
  it("parses a valid config", async () => {
    const api = createApi(ORIGIN, LP, recorder(() => json(CONFIG)).fetchImpl);
    expect(await api.config()).toEqual(CONFIG);
  });

  it("is null when the request fails, is refused or is not JSON", async () => {
    expect(await createApi(ORIGIN, LP, () => Promise.reject(new TypeError("Failed to fetch"))).config()).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => json(CONFIG, 404)).fetchImpl).config()).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => new Response("<html>", { status: 200 })).fetchImpl).config()).toBeNull();
  });

  it("accepts no legal pages and no pixels", () => {
    expect(parseConfig({ ...CONFIG, legal: null, pixels: {}, adnets: [] }, LP)).toMatchObject({ legal: null, pixels: {}, adnets: [] });
  });

  it.each<[string, (c: typeof CONFIG) => unknown]>([
    ["another landing page's config", (c) => ({ ...c, lp_key: "lp_Zzzzzzzz00000000zzzzzzzz" })],
    ["a wire version it does not speak", (c) => ({ ...c, v: 2 })],
    ["a checkout_open that is not a boolean", (c) => ({ ...c, checkout_open: "yes" })],
    ["an unknown Midtrans environment", (c) => ({ ...c, midtrans_env: "staging" })],
    ["adnets that are not a list", (c) => ({ ...c, adnets: "cid" })],
    ["an adnet slug that is not a slug", (c) => ({ ...c, adnets: [{ slug: "A B", clickid_param: "cid" }] })],
    ["a click id parameter with a space", (c) => ({ ...c, adnets: [{ slug: "a", clickid_param: "c id" }] })],
    ["a click id parameter that is too long", (c) => ({ ...c, adnets: [{ slug: "a", clickid_param: "c".repeat(65) }] })],
    ["a pixel id that is not the vendor's format", (c) => ({ ...c, pixels: { meta: "123abc" } })],
    ["a pixel id with script in it", (c) => ({ ...c, pixels: { tiktok: 'ABCDEFGH12345678"><script>' } })],
    ["a Google id that is not AW-", (c) => ({ ...c, pixels: { gtag: "G-ABC123" } })],
    ["legal that is not an object", (c) => ({ ...c, legal: "yes" })],
    ["a legal program that is not a slug", (c) => ({ ...c, legal: { ...c.legal, program: "../x" } })],
    ["a legal version that is not a positive integer", (c) => ({ ...c, legal: { ...c.legal, terms: 0 } })],
    ["a fractional legal version", (c) => ({ ...c, legal: { ...c.legal, privacy: 1.5 } })],
    ["nothing", () => null],
    ["an array", () => []],
  ])("rejects %s", (_name, mutate) => {
    expect(parseConfig(mutate(CONFIG), LP)).toBeNull();
  });
});

describe("visit", () => {
  it("a 204 (no body) is a valid answer: no visit id, no error; the SDK never blocks or retries (the contract's rule for the beacon)", async () => {
    const calls: unknown[] = [];
    const api = createApi(ORIGIN, LP, (url, init) => {
      calls.push([url, init.method]);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    expect(await api.visit({ clickid: "c" })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns the visit id, or null for anything else", async () => {
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, visit_id: EVENT_ID })).fetchImpl).visit({})).toBe(EVENT_ID);
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, visit_id: "not-a-uuid" })).fetchImpl).visit({})).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, visit_id: EVENT_ID }, 500)).fetchImpl).visit({})).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, error: "origin" }, 403)).fetchImpl).visit({})).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, error: "rate_limited" }, 429)).fetchImpl).visit({})).toBeNull();
    expect(await createApi(ORIGIN, LP, () => Promise.reject(new TypeError("Failed to fetch"))).visit({})).toBeNull();
  });
});

describe("checkout", () => {
  const request = { name: "Budi", phone: "+6281234567890", email: "b@example.co", cap_token: "t", consent: { terms: 3, privacy: 2 }, attribution: {} } as const;

  it("returns the parsed response", async () => {
    const api = createApi(ORIGIN, LP, recorder(() => json({ ...CHECKOUT, extra: "ignored" })).fetchImpl);
    expect(await api.checkout(request)).toEqual({ ok: true, response: CHECKOUT });
  });

  it.each<[string, unknown]>([
    ["no event id", { ...CHECKOUT, event_id: undefined }],
    ["an event id that is not a UUID", { ...CHECKOUT, event_id: "evt-1" }],
    ["a redirect that is not a string", { ...CHECKOUT, snap_redirect_url: 5 }],
    ["a negative value", { ...CHECKOUT, value_idr: -1 }],
    ["a fractional value", { ...CHECKOUT, value_idr: 49000.5 }],
    ["a value that is a string", { ...CHECKOUT, value_idr: "49000" }],
    ["deduped that is not a boolean", { ...CHECKOUT, deduped: "no" }],
    ["another wire version", { ...CHECKOUT, v: 2 }],
    ["an array", []],
  ])("treats %s as the service being unavailable", async (_name, body) => {
    expect(parseCheckoutResponse(body)).toBeNull();
    expect(await createApi(ORIGIN, LP, recorder(() => json(body)).fetchImpl).checkout(request)).toEqual({ ok: false, error: "unavailable" });
  });

  it("maps a network failure and every API error", async () => {
    expect(await createApi(ORIGIN, LP, () => Promise.reject(new TypeError("Failed to fetch"))).checkout(request)).toEqual({ ok: false, error: "network" });
    const fields = { phone: "not_mobile", consent: "outdated" } as const;
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, error: "validation", fields }, 400)).fetchImpl).checkout(request)).toEqual({ ok: false, error: "validation", fields });
    expect(await createApi(ORIGIN, LP, recorder(() => json({ v: 1, error: "sales_closed" }, 409)).fetchImpl).checkout(request)).toEqual({ ok: false, error: "sales_closed" });
  });
});

describe("parseError", () => {
  it("takes the code from a contract body and only known field codes", () => {
    expect(parseError(400, { v: 1, error: "validation", fields: { name: "required", phone: "made_up", email: 5, extra: "x" } })).toEqual({ error: "validation", fields: { name: "required" } });
    expect(parseError(502, { v: 1, error: "gateway" })).toEqual({ error: "gateway" });
    expect(parseError(403, { v: 1, error: "origin" })).toEqual({ error: "origin" });
  });

  it("falls back to the HTTP status when the body is not the contract's", () => {
    expect(parseError(429, undefined)).toEqual({ error: "rate_limited" });
    expect(parseError(403, "<html>")).toEqual({ error: "captcha" });
    expect(parseError(409, {})).toEqual({ error: "sales_closed" });
    expect(parseError(400, { v: 1, error: "made_up" })).toEqual({ error: "validation" });
    expect(parseError(500, null)).toEqual({ error: "unavailable" });
    expect(parseError(502, { v: 2, error: "gateway" })).toEqual({ error: "unavailable" });
  });
});
