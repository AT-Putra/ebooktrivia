// US-012 criterion 3: WAHA adapter against the infra/waha-mock app (in-process, PROVISIONAL
// fixtures until US-005 records a real WAHA session).
import { createWahaMockApp } from "@ebooktrivia/waha-mock/src/app.ts";
import { webhookHmacSha512 } from "@ebooktrivia/waha-mock/src/hmac.ts";
import { describe, expect, it } from "vitest";
import ackFixture from "../../../infra/waha-mock/fixtures/message-ack.json" with { type: "json" };
import messageFixtures from "../../../infra/waha-mock/fixtures/message.json" with { type: "json" };
import sessionFixture from "../../../infra/waha-mock/fixtures/session-status.json" with { type: "json" };
import type { HttpFetch, HttpResponse } from "./http.ts";
import { SafeFetchError } from "./safe-fetch.ts";
import { createWahaClient, mapAck, parseChatId, parseWebhookEvent, verifyWebhookHmac, WahaError } from "./waha.ts";

const API_KEY = "waha-test-api-key";
const SECRET = "waha-webhook-hmac-secret";
const captured: { url: string; body: string }[] = [];
const mock = createWahaMockApp({
  apiKey: API_KEY,
  webhookHmacSecret: SECRET,
  timeoutMs: 20,
  fetchImpl: async (url, init) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    captured.push({ url: href, body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(new Response("ok"));
  },
});
const mockFetch: HttpFetch = async (url, init) =>
  await mock.fetch(new Request(url, { method: init.method, headers: init.headers, body: init.body ?? null }));
const control = async (path: string, body: unknown) => {
  await mock.fetch(new Request(`https://mock${path}`, { method: "POST", body: JSON.stringify(body) }));
};

const target = new URL("https://waha.example.id:3000/");
const client = createWahaClient({ target, apiKey: API_KEY, fetch: mockFetch });
const CHAT = "628123456789@c.us";

async function wahaError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WahaError) return e.code;
    throw e;
  }
  throw new Error("expected a WahaError");
}

const respond =
  (status: number, body: unknown): HttpFetch =>
  () =>
    Promise.resolve<HttpResponse>({
      status,
      json: () => (body === "not json" ? Promise.reject(new SyntaxError("x")) : Promise.resolve(body)),
      text: () => Promise.resolve(JSON.stringify(body)),
    });

describe("WAHA client (against waha-mock)", () => {
  it("sends text and files, and finds them again in the chat's recent outgoing messages", async () => {
    const text = await client.sendText("default", CHAT, "Halo Budi");
    expect(text.id).toMatch(/^true_628123456789@c\.us_/);
    const file = await client.sendFile(
      "default",
      CHAT,
      { url: "https://api.example.id/files/p/ebook.pdf?exp=1&sig=x", filename: "ebook.pdf", mimetype: "application/pdf" },
      "Ebook kamu",
    );
    const recent = await client.recentOutgoing("default", CHAT, 10);
    expect(recent[0]).toMatchObject({ id: file.id, filename: "ebook.pdf" });
    expect(recent.map((m) => m.id)).toContain(text.id);
  });

  it("reads session status and resolves @lid chats to phones", async () => {
    expect(await client.sessionStatus("default")).toBe("WORKING");
    await control("/__mock/sessions/s2/status", { status: "FAILED" });
    expect(await client.sessionStatus("s2")).toBe("FAILED");
    await control("/__mock/lids", { lid: "98765432101234@lid", pn: "628123456789@c.us" });
    expect(await client.resolveLid("default", "98765432101234@lid")).toBe("+628123456789");
    expect(await client.resolveLid("default", "11111111111@lid")).toBeNull();
  });

  it("A5: re-fetches an inbound message by id (the worker acts on this, not on the webhook body)", async () => {
    await control("/__mock/emit", { event: "message", session: "default", targetUrl: "https://public.example.id/hooks/waha", payload: messageFixtures.inbound_pn.payload });
    const id = messageFixtures.inbound_pn.payload.id;
    expect(await client.getMessage("default", id)).toEqual({
      messageId: id,
      chat: { kind: "phone", chatId: CHAT, phone: "+628123456789" },
      fromMe: false,
      body: "halo",
      hasMedia: false,
      timestamp: 1760000000,
    });
    expect(await client.getMessage("default", "false_628123456789@c.us_3EB0FFFF9999")).toBeNull();
    for (const bad of ["x", "false_../x@c.us_1", "maybe_628123456789@c.us_1", "false_628123456789@c.us_"]) {
      await expect(client.getMessage("default", bad)).rejects.toThrow(RangeError);
    }
    const with_ = (body: unknown) => createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, body) });
    expect(await wahaError(with_([1]).getMessage("default", id))).toBe("bad_response");
    expect(await wahaError(with_({ id: "other", timestamp: 1, from: CHAT, fromMe: false }).getMessage("default", id))).toBe("bad_response");
  });

  it("classifies failures for the delivery machine", async () => {
    expect(await wahaError(createWahaClient({ target, apiKey: "wrong", fetch: mockFetch }).sendText("default", CHAT, "x"))).toBe("unauthorized");
    expect(await wahaError(client.sendText("default", CHAT, ""))).toBe("rejected"); // 422
    await control("/__mock/faults", { sendFile: "http500" });
    const file = { url: "https://api.example.id/files/a.pdf", filename: "a.pdf", mimetype: "application/pdf" };
    expect(await wahaError(client.sendFile("default", CHAT, file))).toBe("maybe_sent");
    await control("/__mock/faults", { sendFile: "timeout" }); // the mock answers 504 after 20 ms
    expect(await wahaError(client.sendFile("default", CHAT, file))).toBe("maybe_sent");
    await control("/__mock/faults", { sendFile: "ok" });
  });

  it("treats transport errors as certain failures only when nothing can have been sent", async () => {
    const throwing = (error: Error) => createWahaClient({ target, apiKey: API_KEY, fetch: () => Promise.reject(error) });
    expect(await wahaError(throwing(new SafeFetchError("blocked_address", "x")).sendText("default", CHAT, "x"))).toBe("failed");
    expect(await wahaError(throwing(new SafeFetchError("dns_failed", "x")).sendText("default", CHAT, "x"))).toBe("failed");
    expect(await wahaError(throwing(new SafeFetchError("timeout", "x")).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(throwing(new Error("ECONNRESET")).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(throwing(new Error("ECONNRESET")).sessionStatus("default"))).toBe("failed");
  });

  it("refuses malformed answers", async () => {
    const with_ = (status: number, body: unknown) => createWahaClient({ target, apiKey: API_KEY, fetch: respond(status, body) });
    expect(await wahaError(with_(200, { id: "x" }).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(with_(200, "not json").sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(with_(200, [1]).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(with_(200, "not json").sessionStatus("default"))).toBe("bad_response");
    expect(await wahaError(with_(200, {}).sessionStatus("default"))).toBe("bad_response");
    expect(await wahaError(with_(200, [1]).resolveLid("default", "11111111111@lid"))).toBe("bad_response");
    expect(await wahaError(with_(200, { pn: 5 }).resolveLid("default", "11111111111@lid"))).toBe("bad_response");
    expect(await wahaError(with_(200, {}).recentOutgoing("default", CHAT))).toBe("bad_response");
    expect(await with_(200, [{ id: "a", fromMe: false, timestamp: 1 }, { fromMe: true }, "x"]).recentOutgoing("default", CHAT)).toEqual([]);
    expect(await wahaError(with_(503, {}).sessionStatus("default"))).toBe("failed");
  });
});

describe("request URLs stay on the WAHA origin", () => {
  const seen: string[] = [];
  const capture: HttpFetch = (url) => {
    seen.push(url);
    return Promise.resolve({ status: 200, json: () => Promise.resolve({ id: "i", timestamp: 1, status: "WORKING" }), text: () => Promise.resolve("") });
  };

  it("encodes every segment and keeps a base path", async () => {
    const c = createWahaClient({ target: new URL("https://waha.example.id:3000/waha/"), apiKey: API_KEY, fetch: capture });
    await c.sendText("default", CHAT, "x");
    await c.sessionStatus("s_1-a");
    await c.recentOutgoing("default", CHAT, 5).catch(() => undefined);
    await c.resolveLid("default", "98765432101234@lid");
    await c.getMessage("default", "false_628123456789@c.us_3EB0AAAA0001").catch(() => undefined);
    expect(seen).toEqual([
      "https://waha.example.id:3000/waha/api/sendText",
      "https://waha.example.id:3000/waha/api/sessions/s_1-a",
      // A6: never ask WAHA to download media for a reconciliation lookup.
      "https://waha.example.id:3000/waha/api/default/chats/628123456789%40c.us/messages?limit=5&fromMe=true&downloadMedia=false",
      "https://waha.example.id:3000/waha/api/default/lids/98765432101234%40lid",
      "https://waha.example.id:3000/waha/api/default/chats/628123456789%40c.us/messages/false_628123456789%40c.us_3EB0AAAA0001?downloadMedia=false",
    ]);
  });

  it("A7: sendFile requires an https file URL", async () => {
    await expect(client.sendFile("default", CHAT, { url: "http://api.example.id/files/a.pdf", filename: "a.pdf", mimetype: "application/pdf" })).rejects.toThrow(RangeError);
  });

  it("refuses session names, chat ids and parameters that could rewrite the path", async () => {
    for (const bad of ["../x", "//evil.example", "a/b", "", "x".repeat(65)]) {
      await expect(client.sessionStatus(bad)).rejects.toThrow(RangeError);
    }
    for (const bad of ["1203630@g.us", "status@broadcast", "../x@c.us", "123@c.us"]) {
      await expect(client.sendText("default", bad, "x")).rejects.toThrow(RangeError);
    }
    await expect(client.resolveLid("default", "628123@c.us")).rejects.toThrow(RangeError);
    await expect(client.recentOutgoing("default", CHAT, 0)).rejects.toThrow(RangeError);
    await expect(client.sendFile("default", CHAT, { url: "file:///etc/passwd", filename: "a", mimetype: "x" })).rejects.toThrow(RangeError);
    expect(() => createWahaClient({ target: new URL("ftp://waha.example.id/"), apiKey: API_KEY, fetch: capture })).toThrow(RangeError);
  });
});

describe("chat ids", () => {
  it.each([
    ["628123456789@c.us", { kind: "phone", phone: "+628123456789" }],
    ["98765432101234@lid", { kind: "lid", lid: "98765432101234@lid" }],
    ["120363012345678901@g.us", { kind: "other" }],
    ["14155550100@c.us", { kind: "other" }], // not an Indonesian mobile
    ["status@broadcast", { kind: "other" }],
  ])("parses %s", (chatId, expected) => {
    expect(parseChatId(chatId)).toMatchObject(expected);
  });
});

describe("webhooks", () => {
  it("verifies the X-Webhook-Hmac the mock signs, end to end", async () => {
    await mock.fetch(
      new Request("https://mock/__mock/emit", {
        method: "POST",
        body: JSON.stringify({ event: "message", session: "default", targetUrl: "https://public.example.id/hooks/waha", payload: messageFixtures.inbound_pn.payload }),
      }),
    );
    const delivered = captured.at(-1);
    if (delivered === undefined) throw new Error("the mock did not emit");
    const hmac = webhookHmacSha512(delivered.body, SECRET);
    expect(verifyWebhookHmac(delivered.body, { hmac, algorithm: "sha512" }, SECRET)).toBe(true);
    expect(verifyWebhookHmac(Buffer.from(delivered.body), { hmac: hmac.toUpperCase() }, SECRET)).toBe(true);
    expect(parseWebhookEvent(JSON.parse(delivered.body))).toMatchObject({ kind: "message", chat: { kind: "phone", phone: "+628123456789" } });
  });

  it("refuses a tampered body, another secret, another algorithm, or a missing header", () => {
    const body = JSON.stringify(messageFixtures.inbound_pn);
    const hmac = webhookHmacSha512(body, SECRET);
    expect(verifyWebhookHmac(`${body} `, { hmac }, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, { hmac }, "other-secret")).toBe(false);
    expect(verifyWebhookHmac(body, { hmac, algorithm: "sha256" }, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, { hmac: undefined }, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, { hmac: "abc" }, SECRET)).toBe(false);
    expect(verifyWebhookHmac(body, { hmac }, "")).toBe(false);
  });

  it("parses inbound messages (phone and @lid), acks and session status from the fixtures", () => {
    expect(parseWebhookEvent(messageFixtures.inbound_pn)).toEqual({
      kind: "message",
      session: "default",
      messageId: "false_628123456789@c.us_3EB0AAAA0001",
      chat: { kind: "phone", chatId: "628123456789@c.us", phone: "+628123456789" },
      body: "halo",
      hasMedia: false,
      timestamp: 1760000000,
    });
    expect(parseWebhookEvent(messageFixtures.inbound_lid)).toMatchObject({ kind: "message", chat: { kind: "lid", lid: "98765432101234@lid" } });
    expect(parseWebhookEvent(ackFixture.example)).toEqual({ kind: "ack", session: "default", messageId: "true_628123456789@c.us_3EB0AAAA0003", status: "read" });
    expect(parseWebhookEvent(sessionFixture.example)).toEqual({ kind: "session.status", session: "default", status: "WORKING" });
  });

  it("ignores our own messages, unknown events and malformed payloads", () => {
    const own = { ...messageFixtures.inbound_pn, payload: { ...messageFixtures.inbound_pn.payload, fromMe: true } };
    expect(parseWebhookEvent(own)).toBeUndefined();
    expect(parseWebhookEvent({ event: "presence.update", session: "default", payload: {} })).toBeUndefined();
    expect(parseWebhookEvent({ event: "message.ack", session: "default", payload: { id: "x", ack: 9 } })).toBeUndefined();
    expect(parseWebhookEvent({ event: "session.status", session: "default", payload: {} })).toBeUndefined();
    expect(parseWebhookEvent({ event: "message", session: "default", payload: { id: "x", from: CHAT, fromMe: false } })).toBeUndefined();
    expect(parseWebhookEvent({ ...messageFixtures.inbound_pn, payload: { ...messageFixtures.inbound_pn.payload, body: 7 } })).toMatchObject({ body: "" });
    expect(parseWebhookEvent("x")).toBeUndefined();
    expect(parseWebhookEvent({ event: "message", session: "default", payload: [] })).toBeUndefined();
  });

  it("A5: exposes the event timestamp (ms) so the caller can enforce a replay window", () => {
    const at = 1_760_000_000_123;
    expect(parseWebhookEvent({ ...messageFixtures.inbound_pn, timestamp: at })).toMatchObject({ kind: "message", eventTimestampMs: at });
    expect(parseWebhookEvent({ ...ackFixture.example, timestamp: at })).toMatchObject({ kind: "ack", eventTimestampMs: at });
    expect(parseWebhookEvent({ ...sessionFixture.example, timestamp: at })).toMatchObject({ kind: "session.status", eventTimestampMs: at });
    expect(parseWebhookEvent({ ...sessionFixture.example, timestamp: "soon" })).toMatchObject({ eventTimestampMs: undefined });
  });

  it("A5: the mock's emitted webhook carries a current event timestamp", async () => {
    await mock.fetch(
      new Request("https://mock/__mock/emit", {
        method: "POST",
        body: JSON.stringify({ event: "message", session: "default", targetUrl: "https://public.example.id/hooks/waha", payload: messageFixtures.inbound_pn.payload }),
      }),
    );
    const parsed = parseWebhookEvent(JSON.parse(captured.at(-1)?.body ?? "{}"));
    expect(parsed?.eventTimestampMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("maps every WAHA ack value (AC-D6)", () => {
    expect([-1, 0, 1, 2, 3, 4, 5].map(mapAck)).toEqual(["failed", "queued", "sent", "delivered", "read", "read", undefined]);
  });
});
