// US-012 criterion 4 (conversions): S2S, Meta CAPI and TikTok requests render correctly; results
// are classified for the conversion machine. Hashes below are computed independently here.
import { createHash } from "node:crypto";
import { type IdMobileE164, TemplateError } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import {
  buildMetaCapiRequest,
  buildS2sRequest,
  buildTikTokEventRequest,
  type ConversionEvent,
  sendConversion,
  TIKTOK_EVENTS_URL,
} from "./conversions.ts";
import type { HttpFetch } from "./http.ts";
import { SafeFetchError } from "./safe-fetch.ts";

const ADNET = "0b9c4a61-7d2e-4f3a-9b8c-1d2e3f4a5b6c";
const HOST = "track.adnet.example";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PHONE = "+628123456789" as IdMobileE164;

const event = (overrides: Partial<ConversionEvent> = {}): ConversionEvent => ({
  kind: "mt",
  eventId: "evt_7Q2mXk9pLr4s",
  eventTime: new Date("2027-04-01T03:04:05Z"),
  orderId: "ord_9f8e7d",
  valueIdr: 49_000,
  email: "  Budi.Santoso@Example.COM ",
  phone: PHONE,
  clientIp: "203.0.113.7",
  userAgent: "Mozilla/5.0 (Linux; Android 14)",
  pageUrl: "https://juara.example.id/beli",
  fbp: "fb.1.1700000000000.123",
  fbc: "fb.1.1700000000000.abc",
  ttclid: "E.C.P.tt123",
  ...overrides,
});

describe("S2S postbacks", () => {
  const template = `https://${HOST}/pb?click={clickid}&tx={txid}&p={payout}&s={status}&key={secret:api_key}`;
  const values = { clickid: "c1&x=y", txid: "tx-1", payout: "15000", status: "approved" };
  const resolve = () => ({ value: "s3cr3t/key", scope: "conversions", adnetId: ADNET, boundHost: HOST });

  it("renders the URL with the bound secret, and a redacted twin for the log", () => {
    const request = buildS2sRequest({ template, values, binding: { adnetId: ADNET, host: HOST }, resolve });
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`https://${HOST}/pb?click=c1%26x%3Dy&tx=tx-1&p=15000&s=approved&key=s3cr3t%2Fkey`);
    expect(request.redacted.url).toContain("[secret:api_key]");
    expect(request.redacted.url).not.toContain("s3cr3t");
  });

  it("refuses to render for another host than the adnet's endpoint", () => {
    expect(() => buildS2sRequest({ template, values, binding: { adnetId: ADNET, host: "other.example" }, resolve })).toThrow(TemplateError);
  });
});

describe("Meta Conversions API", () => {
  const build = (e = event()) => buildMetaCapiRequest({ apiVersion: "v24.0", pixelId: "123456789012345", accessToken: "EAAG-token", event: e });

  it("sends a Purchase with the shared event_id, IDR value and hashed email/phone only", () => {
    const request = build();
    if (request === null) throw new Error("expected a request");
    expect(request.url).toBe("https://graph.facebook.com/v24.0/123456789012345/events");
    expect(request.url).not.toContain("token");
    const body = JSON.parse(request.body ?? "") as { data: Record<string, unknown>[]; access_token: string };
    expect(body.access_token).toBe("EAAG-token");
    expect(body.data[0]).toEqual({
      event_name: "Purchase",
      event_time: 1806548645,
      event_id: "evt_7Q2mXk9pLr4s",
      action_source: "website",
      event_source_url: "https://juara.example.id/beli",
      user_data: {
        em: [sha("budi.santoso@example.com")],
        ph: [sha("628123456789")],
        client_ip_address: "203.0.113.7",
        client_user_agent: "Mozilla/5.0 (Linux; Android 14)",
        fbp: "fb.1.1700000000000.123",
        fbc: "fb.1.1700000000000.abc",
      },
      custom_data: { currency: "IDR", value: 49000, order_id: "ord_9f8e7d" },
    });
    expect(request.body).not.toMatch(/budi|628123456789/i);
  });

  it("redacts the token and the hashes in the log form", () => {
    const request = build();
    expect(request?.redacted.body).toContain('"access_token":"[secret]"');
    expect(request?.redacted.body).toContain('"em":["[sha256]"]');
    expect(request?.redacted.body).not.toContain("EAAG-token");
    expect(request?.redacted.body).not.toContain(sha("628123456789"));
  });

  it("A8: the log form drops IP, user agent, fbp, fbc and the page URL", () => {
    const redacted = build()?.redacted.body ?? "";
    for (const value of ["203.0.113.7", "Mozilla", "fb.1.1700000000000.123", "fb.1.1700000000000.abc", "juara.example.id"]) expect(redacted).not.toContain(value);
    const logged = JSON.parse(redacted) as { data: { event_source_url: string; user_data: Record<string, unknown> }[] };
    expect(logged.data[0]?.event_source_url).toBe("[redacted]");
    expect(logged.data[0]?.user_data).toMatchObject({ client_ip_address: "[redacted]", client_user_agent: "[redacted]", fbp: "[redacted]", fbc: "[redacted]" });
  });

  it("sends InitiateCheckout for MO, omits absent fields, and sends nothing for a refund", () => {
    const mo = buildMetaCapiRequest({
      apiVersion: "v24.0",
      pixelId: "123456789012345",
      accessToken: "t",
      testEventCode: "TEST123",
      event: { kind: "mo", eventId: "evt_7Q2mXk9pLr4s", eventTime: new Date(0), orderId: "o", valueIdr: 0 },
    });
    const body = JSON.parse(mo?.body ?? "") as { data: Record<string, unknown>[]; test_event_code: string };
    expect(body.test_event_code).toBe("TEST123");
    expect(body.data[0]).toMatchObject({ event_name: "InitiateCheckout", user_data: {} });
    expect(body.data[0]).not.toHaveProperty("event_source_url");
    expect(build(event({ kind: "refund" }))).toBeNull();
  });

  it("validates its inputs", () => {
    expect(() => buildMetaCapiRequest({ apiVersion: "latest", pixelId: "123456789012345", accessToken: "t", event: event() })).toThrow(RangeError);
    expect(() => buildMetaCapiRequest({ apiVersion: "v24.0", pixelId: "abc", accessToken: "t", event: event() })).toThrow(RangeError);
    expect(() => build(event({ eventId: "short" }))).toThrow(RangeError);
    expect(() => build(event({ valueIdr: 1.5 }))).toThrow(RangeError);
    expect(() => build(event({ eventTime: new Date(Number.NaN) }))).toThrow(RangeError);
  });
});

describe("TikTok Events API", () => {
  const build = (e = event()) => buildTikTokEventRequest({ pixelCode: "C4ABCDEF12345", accessToken: "tt-token", event: e });

  it("sends CompletePayment with the same event_id, the token in a header and E.164 phone hashes", () => {
    const request = build();
    if (request === null) throw new Error("expected a request");
    expect(request.url).toBe(TIKTOK_EVENTS_URL);
    expect(request.headers["access-token"]).toBe("tt-token");
    const body = JSON.parse(request.body ?? "") as { event_source: string; event_source_id: string; data: Record<string, unknown>[] };
    expect(body).toMatchObject({ event_source: "web", event_source_id: "C4ABCDEF12345" });
    expect(body.data[0]).toEqual({
      event: "CompletePayment",
      event_time: 1806548645,
      event_id: "evt_7Q2mXk9pLr4s",
      user: {
        email: sha("budi.santoso@example.com"),
        phone: sha("+628123456789"),
        ttclid: "E.C.P.tt123",
        ip: "203.0.113.7",
        user_agent: "Mozilla/5.0 (Linux; Android 14)",
      },
      properties: { currency: "IDR", value: 49000, order_id: "ord_9f8e7d" },
      page: { url: "https://juara.example.id/beli" },
    });
    expect(request.body).not.toContain("tt-token");
    expect(request.redacted.body).toContain('"phone":"[sha256]"');
  });

  it("A8: the log form drops ip, user_agent, ttclid and page.url", () => {
    const redacted = build()?.redacted.body ?? "";
    for (const value of ["203.0.113.7", "Mozilla", "E.C.P.tt123", "juara.example.id"]) expect(redacted).not.toContain(value);
    const logged = JSON.parse(redacted) as { data: { page: { url: string }; user: Record<string, unknown> }[] };
    expect(logged.data[0]?.page.url).toBe("[redacted]");
    expect(logged.data[0]?.user).toMatchObject({ ip: "[redacted]", user_agent: "[redacted]", ttclid: "[redacted]" });
  });

  it("shares the event_id with Meta for the same order event (dedupe with the browser pixel)", () => {
    const meta = JSON.parse(buildMetaCapiRequest({ apiVersion: "v24.0", pixelId: "123456789012345", accessToken: "t", event: event() })?.body ?? "") as { data: { event_id: string }[] };
    const tiktok = JSON.parse(build()?.body ?? "") as { data: { event_id: string }[] };
    expect(meta.data[0]?.event_id).toBe(tiktok.data[0]?.event_id);
  });

  it("sends InitiateCheckout for MO and nothing for a refund; validates inputs", () => {
    const mo = buildTikTokEventRequest({
      pixelCode: "C4ABCDEF12345",
      accessToken: "t",
      testEventCode: "TEST1",
      event: { kind: "mo", eventId: "evt_7Q2mXk9pLr4s", eventTime: new Date(0), orderId: "o", valueIdr: 5 },
    });
    const body = JSON.parse(mo?.body ?? "") as { test_event_code: string; data: Record<string, unknown>[] };
    expect(body.test_event_code).toBe("TEST1");
    expect(body.data[0]).toMatchObject({ event: "InitiateCheckout", user: {} });
    expect(body.data[0]).not.toHaveProperty("page");
    expect(build(event({ kind: "refund" }))).toBeNull();
    expect(() => buildTikTokEventRequest({ pixelCode: "lower", accessToken: "t", event: event() })).toThrow(RangeError);
    expect(() => buildTikTokEventRequest({ pixelCode: "C4ABCDEF12345", accessToken: "t", event: event(), endpoint: "http://x.example/" })).toThrow(RangeError);
  });
});

describe("sendConversion classifies results for the conversion machine", () => {
  const request = buildS2sRequest({
    template: `https://${HOST}/pb?c={clickid}&t={txid}&p={payout}&s={status}`,
    values: { clickid: "c", txid: "t", payout: "1", status: "s" },
    binding: { adnetId: ADNET, host: HOST },
    resolve: () => undefined,
  });
  const answering =
    (status: number, text = "ok"): HttpFetch =>
    () =>
      Promise.resolve({ status, json: () => Promise.resolve({}), text: () => Promise.resolve(text) });
  const throwing =
    (error: Error): HttpFetch =>
    () =>
      Promise.reject(error);
  let clock = 1000;
  const now = () => (clock += 25);

  it("2xx is sent, anything else is a failure to retry, with latency and a truncated body", async () => {
    expect(await sendConversion(answering(200), request, now)).toEqual({ outcome: { kind: "sent", httpStatus: 200 }, latencyMs: 25, responseSnippet: "ok" });
    expect((await sendConversion(answering(204), request)).outcome.kind).toBe("sent");
    expect((await sendConversion(answering(500, "x".repeat(5000)), request)).outcome).toEqual({ kind: "failed", httpStatus: 500, error: "HTTP 500" });
    expect((await sendConversion(answering(500, "x".repeat(5000)), request)).responseSnippet).toHaveLength(1024);
    expect((await sendConversion(answering(302), request)).outcome.kind).toBe("failed");
  });

  it("a transport error is failed only when nothing can have been sent", async () => {
    expect((await sendConversion(throwing(new SafeFetchError("blocked_address", "x")), request)).outcome).toEqual({ kind: "failed", httpStatus: null, error: "x" });
    expect((await sendConversion(throwing(new SafeFetchError("timeout", "t")), request)).outcome).toEqual({ kind: "maybe_sent", error: "t" });
    expect((await sendConversion(throwing(new Error("ECONNRESET")), request)).outcome.kind).toBe("maybe_sent");
  });

  it("M4: reads at most 1 KiB of the body through textPrefix, never the whole body", async () => {
    const asked: number[] = [];
    const bounded: HttpFetch = () =>
      Promise.resolve({
        status: 200,
        json: () => Promise.reject(new Error("must not read the whole body")),
        text: () => Promise.reject(new Error("must not read the whole body")),
        textPrefix: (maxBytes: number) => {
          asked.push(maxBytes);
          return Promise.resolve("y".repeat(maxBytes));
        },
      });
    const result = await sendConversion(bounded, request);
    expect(asked).toEqual([1024]);
    expect(result.responseSnippet).toBe("y".repeat(1024));
    expect(result.outcome).toEqual({ kind: "sent", httpStatus: 200 });
  });

  it("A4: a refused redirect is a failed HTTP attempt (retried), not maybe_sent", async () => {
    const redirect = new SafeFetchError("redirect_refused", "redirect (302) refused", { httpStatus: 302 });
    expect((await sendConversion(throwing(redirect), request)).outcome).toEqual({ kind: "failed", httpStatus: 302, error: "HTTP 302" });
  });

  it("passes the method, headers and body through", async () => {
    let seen: { url: string; method: string; body: unknown } | undefined;
    const capture: HttpFetch = (url, init) => {
      seen = { url, method: init.method, body: init.body };
      return Promise.resolve({ status: 200, json: () => Promise.resolve({}), text: () => Promise.reject(new Error("no body")) });
    };
    const tiktok = buildTikTokEventRequest({ pixelCode: "C4ABCDEF12345", accessToken: "t", event: event() });
    if (tiktok === null) throw new Error("expected a request");
    expect((await sendConversion(capture, tiktok)).responseSnippet).toBe("");
    expect(seen).toEqual({ url: TIKTOK_EVENTS_URL, method: "POST", body: tiktok.body });
  });
});
