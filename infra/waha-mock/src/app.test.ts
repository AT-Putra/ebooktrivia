import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWahaMockApp } from "./app.ts";

const KEY = "test-key";
const SECRET = "test-secret";
const auth = { "X-Api-Key": KEY, "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = auth) => ({
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

function make(fetchImpl?: typeof fetch) {
  return createWahaMockApp({
    apiKey: KEY,
    webhookHmacSecret: SECRET,
    timeoutMs: 20,
    ...(fetchImpl && { fetchImpl }),
  });
}

describe("waha-mock", () => {
  it("rejects requests without the API key", async () => {
    const app = make();
    expect((await app.request("/api/sessions/default")).status).toBe(401);
    expect((await app.request("/api/sendText", post({}, { "content-type": "application/json" }))).status).toBe(401);
  });

  it("sendText answers like WEBJS (201, the raw message with an OBJECT id whose _serialized is the string id), and the message is listed as a WAMessage", async () => {
    const app = make();
    const res = await app.request("/api/sendText", post({ session: "default", chatId: "628123@c.us", text: "hi" }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: { fromMe: boolean; remote: string; id: string; $1: string; _serialized: string }; timestamp: number; ack: number; source?: string };
    expect(json.id._serialized).toMatch(/^true_628123@c\.us_[0-9A-F]{22}$/);
    expect(json.id).toMatchObject({ fromMe: true, remote: "628123@c.us", $1: json.id._serialized });
    expect(json.id._serialized.endsWith(`_${json.id.id}`)).toBe(true);
    expect(typeof json.timestamp).toBe("number");
    expect(json.ack).toBe(0);
    expect(json).not.toHaveProperty("source");
    const list = await app.request("/api/default/chats/628123@c.us/messages?limit=5&filter.fromMe=true", {
      headers: auth,
    });
    const msgs = (await list.json()) as { id: string; body: string }[];
    expect(msgs[0]).toMatchObject({ id: json.id._serialized, body: "hi", fromMe: true, source: "api", ack: 2, ackName: "DEVICE", hasMedia: false, media: null });
  });

  it("sendFile records filename and url", async () => {
    const app = make();
    const res = await app.request(
      "/api/sendFile",
      post({
        session: "default",
        chatId: "628123@c.us",
        file: { url: "https://example.test/a.pdf", mimetype: "application/pdf", filename: "a.pdf" },
        caption: "cap",
      }),
    );
    expect(res.status).toBe(201);
    const raw = (await res.json()) as { id: { _serialized: string }; hasMedia: boolean; type: string; body: string; mediaKey?: string };
    expect(raw).toMatchObject({ hasMedia: true, type: "document", body: "cap" });
    expect(typeof raw.mediaKey).toBe("string");
    const list = await app.request("/api/default/chats/628123@c.us/messages", { headers: auth });
    const msgs = (await list.json()) as { id: string; media: { filename: string; url: string | null; mimetype: string } }[];
    // Recorded: the listed media carries the filename and mimetype WE SENT and a null url.
    expect(msgs[0]?.media).toEqual({ url: null, mimetype: "application/pdf", filename: "a.pdf" });
    expect(msgs[0]?.id).toBe(raw.id._serialized);
  });

  it("session status is controllable", async () => {
    const app = make();
    const first = (await (await app.request("/api/sessions/default", { headers: auth })).json()) as {
      status: string;
      me: { id: string };
    };
    expect(first.status).toBe("WORKING");
    expect(first.me.id).toMatch(/@c\.us$/);
    await app.request("/__mock/sessions/default/status", post({ status: "FAILED" }, { "content-type": "application/json" }));
    const second = (await (await app.request("/api/sessions/default", { headers: auth })).json()) as {
      status: string;
    };
    expect(second.status).toBe("FAILED");
  });

  it("a session that is not WORKING refuses sends with a 422, like WAHA, and only that session", async () => {
    const app = make();
    const json = { "content-type": "application/json" };
    const file = { chatId: "1@c.us", file: { url: "https://example.test/a.pdf", mimetype: "application/pdf", filename: "a.pdf" } };
    await app.request("/__mock/sessions/dead/status", post({ status: "STOPPED" }, json));
    expect((await app.request("/api/sendFile", post({ session: "dead", ...file }))).status).toBe(422);
    expect((await app.request("/api/sendText", post({ session: "dead", chatId: "1@c.us", text: "hi" }))).status).toBe(422);
    expect((await app.request("/api/sendFile", post({ session: "alive", ...file }))).status).toBe(201);
    await app.request("/__mock/sessions/dead/status", post({ status: "WORKING" }, json));
    expect((await app.request("/api/sendText", post({ session: "dead", chatId: "1@c.us", text: "hi" }))).status).toBe(201);
  });

  it("with fetchFiles, sendFile downloads file.url first and fails like WAHA when the download does", async () => {
    const seen: string[] = [];
    let status = 200;
    const app = createWahaMockApp({
      apiKey: "k",
      webhookHmacSecret: "s",
      fetchFiles: true,
      fetchImpl: (input) => {
        seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return Promise.resolve(new Response("%PDF-1.4", { status }));
      },
    });
    const body = { session: "default", chatId: "1@c.us", file: { url: "https://example.test/a.pdf?sig=x", mimetype: "application/pdf", filename: "a.pdf" } };
    const send = () => app.request("/api/sendFile", { method: "POST", headers: { "x-api-key": "k", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send()).status).toBe(201);
    expect(seen).toEqual(["https://example.test/a.pdf?sig=x"]);
    status = 403;
    const refused = await send();
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ downloadStatus: 403 });
    // Without fetchFiles nothing is downloaded (the default, as before).
    seen.length = 0;
    expect((await make().request("/api/sendFile", post(body))).status).toBe(201);
    expect(seen).toEqual([]);
  });

  it("fetchFiles \"webjs\": a download that answers 404 is NOT refused: the answer page is sent as the document and the answer is 201 (recorded on the Owner's WEBJS)", async () => {
    const app = createWahaMockApp({
      apiKey: "k",
      webhookHmacSecret: "s",
      fetchFiles: "webjs",
      fetchImpl: () => Promise.resolve(new Response("<html>Not Found</html>", { status: 404 })),
    });
    const res = await app.request("/api/sendFile", {
      method: "POST",
      headers: { "x-api-key": "k", "content-type": "application/json" },
      body: JSON.stringify({ session: "default", chatId: "628123@c.us", file: { url: "https://example.test/missing.pdf", mimetype: "application/pdf", filename: "x.pdf" } }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ hasMedia: true, type: "document" });
    const list = await app.request("/api/default/chats/628123@c.us/messages", { headers: { "x-api-key": "k" } });
    const listed = (await list.json()) as { media: { filename: string }; _data: { size: number; type: string } }[];
    expect(listed[0]?.media.filename).toBe("x.pdf");
    // Recorded: the delivered size is the size of what the URL answered (the 404 page), not of the PDF: how a wrong file is told from the right one.
    expect(listed[0]?._data).toMatchObject({ type: "document", size: "<html>Not Found</html>".length });
  });

  it("lids mapping resolves, unmapped is null", async () => {
    const app = make();
    await app.request("/__mock/lids", post({ lid: "111@lid", pn: "62899@c.us" }, { "content-type": "application/json" }));
    const mapped = await app.request("/api/default/lids/111@lid", { headers: auth });
    expect(await mapped.json()).toEqual({ lid: "111@lid", pn: "62899@c.us" });
    const unmapped = await app.request("/api/default/lids/222@lid", { headers: auth });
    // LIVE FACT (US-005 audit, WAHA 2026.10.1): an unknown @lid is a 200 with pn null, not a 404.
    expect(unmapped.status).toBe(200);
    expect(await unmapped.json()).toEqual({ lid: "222@lid", pn: null });
  });

  it("lists a chat's messages newest first with WAHA's `filter.fromMe` and `offset`, and ignores a bare `fromMe` like the live instance", async () => {
    const app = make();
    const chat = "628555@c.us";
    for (const text of ["one", "two", "three"]) await app.request("/api/sendText", post({ session: "default", chatId: chat, text }));
    // An inbound message in between (the buyer writing): it is in the chat but not ours.
    await app.request("/__mock/emit", post({ event: "message", session: "default", targetUrl: "https://hook.invalid/waha", payload: { id: "false_628555@c.us_BUYER1", from: chat, fromMe: false, timestamp: 1_800_000_000, body: "halo" } }, { "content-type": "application/json" }));
    const list = async (query: string) => (await (await app.request(`/api/default/chats/${chat}/messages?${query}`, { headers: auth })).json()) as { body: string; fromMe: boolean }[];
    expect((await list("limit=10&filter.fromMe=true")).map((m) => m.body)).toEqual(["three", "two", "one"]);
    expect((await list("limit=2&offset=1&filter.fromMe=true")).map((m) => m.body)).toEqual(["two", "one"]);
    // The bare `fromMe` is not a filter of WAHA: nothing is filtered.
    expect((await list("limit=10&fromMe=true")).some((m) => !m.fromMe)).toBe(true);
  });

  it("faults: sendFile http500 and timeout", async () => {
    const app = make();
    const body = {
      session: "default",
      chatId: "1@c.us",
      file: { url: "https://example.test/a.pdf", mimetype: "application/pdf", filename: "a.pdf" },
    };
    await app.request("/__mock/faults", post({ sendFile: "http500" }, { "content-type": "application/json" }));
    expect((await app.request("/api/sendFile", post(body))).status).toBe(500);
    await app.request("/__mock/faults", post({ sendFile: "timeout" }, { "content-type": "application/json" }));
    expect((await app.request("/api/sendFile", post(body))).status).toBe(504);
    await app.request("/__mock/faults", post({ sendFile: "ok" }, { "content-type": "application/json" }));
    expect((await app.request("/api/sendFile", post(body))).status).toBe(201);
  });

  it("serves a message by id: emitted inbound messages and sent ones, 404 otherwise", async () => {
    const app = make(() => Promise.resolve(new Response("ok")));
    const payload = { id: "false_628123@c.us_AAA1", from: "628123@c.us", fromMe: false, body: "halo", hasMedia: false, timestamp: 1760000000 };
    await app.request("/__mock/emit", post({ event: "message", session: "default", targetUrl: "http://hook.test/waha", payload }, { "content-type": "application/json" }));
    const found = await app.request("/api/default/chats/628123@c.us/messages/false_628123@c.us_AAA1?downloadMedia=false", { headers: auth });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: payload.id, from: "628123@c.us", fromMe: false, body: "halo", hasMedia: false, timestamp: 1760000000 });
    const sent = (await (await app.request("/api/sendText", post({ session: "default", chatId: "628123@c.us", text: "hi" }))).json()) as { id: { _serialized: string } };
    const sentId = sent.id._serialized;
    expect(await (await app.request(`/api/default/chats/628123@c.us/messages/${sentId}`, { headers: auth })).json()).toMatchObject({ id: sentId, fromMe: true, body: "hi" });
    // Recorded: an unknown id is 404 with WAHA's own body.
    const unknown = await app.request("/api/default/chats/628123@c.us/messages/false_628123@c.us_NOPE", { headers: auth });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ message: "Message not found", error: "Not Found", statusCode: 404 });
    // Recorded: WEBJS ignores the chat in the path (a message is found through any chat id, an @lid one or a wrong one).
    expect((await app.request("/api/default/chats/628999@c.us/messages/false_628123@c.us_AAA1", { headers: auth })).status).toBe(200);
  });

  it("emit posts a webhook whose X-Webhook-Hmac is HMAC-SHA512 of the raw body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} });
      return Promise.resolve(new Response("ok", { status: 200 }));
    };
    const app = make(fake);
    const res = await app.request(
      "/__mock/emit",
      post(
        { event: "message", session: "default", targetUrl: "http://hook.test/waha", payload: { from: "1@lid" } },
        { "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("http://hook.test/waha");
    const raw = call?.init.body as string;
    const headers = call?.init.headers as Record<string, string>;
    const expected = createHmac("sha512", SECRET).update(raw).digest("hex");
    expect(headers["X-Webhook-Hmac"]).toBe(expected);
    expect(headers["X-Webhook-Hmac-Algorithm"]).toBe("sha512");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: "message", session: "default", engine: "WEBJS", payload: { from: "1@lid" } });
    expect(parsed).toHaveProperty("environment");
    expect(parsed).toHaveProperty("me");
  });
});

describe("waha-mock: human-like sending, ban signals (answers recorded from the Owner's WEBJS 2026.10.1, US-005 R11)", () => {
  const control = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) satisfies RequestInit;
  const callsOf = async (app: ReturnType<typeof make>) => (await (await app.request("/__mock/calls")).json()) as { method: string; path: string; body: Record<string, unknown> }[];
  const CHAT = "628123@c.us";

  it("serves seen, typing (the shortcuts and the presence endpoint), paused and offline, and records them in order", async () => {
    const app = make();
    expect((await app.request("/api/sendSeen", post({ session: "default", chatId: CHAT, messageIds: ["false_628123@c.us_AAAA"] }))).status).toBe(201);
    expect((await app.request("/api/default/presence", post({ chatId: CHAT, presence: "typing" }))).status).toBe(201);
    expect((await app.request("/api/default/presence", post({ chatId: CHAT, presence: "paused" }))).status).toBe(201);
    expect((await app.request("/api/startTyping", post({ session: "default", chatId: CHAT }))).status).toBe(201);
    expect((await app.request("/api/stopTyping", post({ session: "default", chatId: CHAT }))).status).toBe(201);
    expect((await app.request(`/api/default/chats/${CHAT}/messages/read`, post({}))).status).toBe(200);
    expect((await app.request("/api/sendText", post({ session: "default", chatId: CHAT, text: "hi" }))).status).toBe(201);
    expect((await app.request("/api/default/presence", post({ presence: "offline" }))).status).toBe(201);
    expect((await callsOf(app)).map((c) => `${c.path}${typeof c.body["presence"] === "string" ? `:${c.body["presence"]}` : ""}`)).toEqual([
      "/api/sendSeen",
      "/api/default/presence:typing",
      "/api/default/presence:paused",
      "/api/startTyping",
      "/api/stopTyping",
      `/api/default/chats/${CHAT}/messages/read`,
      "/api/sendText",
      "/api/default/presence:offline",
    ]);
    expect((await app.request("/__mock/calls", { method: "DELETE" })).status).toBe(200);
    expect(await callsOf(app)).toEqual([]);
  });

  it("answers the human-like calls EXACTLY like WEBJS: 201 with no body for presence and for seen with ids, {ids: null} without ids, {result: true} for the typing shortcuts", async () => {
    const app = make();
    const bodyOf = async (response: Response) => ({ status: response.status, text: await response.text() });
    expect(await bodyOf(await app.request("/api/default/presence", post({ chatId: CHAT, presence: "typing" })))).toEqual({ status: 201, text: "" });
    expect(await bodyOf(await app.request("/api/default/presence", post({ chatId: CHAT, presence: "recording" })))).toEqual({ status: 201, text: "" });
    expect(await bodyOf(await app.request("/api/default/presence", post({ presence: "online" })))).toEqual({ status: 201, text: "" });
    expect(await bodyOf(await app.request("/api/default/presence", post({ presence: "offline" })))).toEqual({ status: 201, text: "" });
    expect(await bodyOf(await app.request("/api/sendSeen", post({ session: "default", chatId: CHAT, messageIds: ["false_628123@c.us_AAAA"] })))).toEqual({ status: 201, text: "" });
    expect(await bodyOf(await app.request("/api/sendSeen", post({ session: "default", chatId: CHAT })))).toEqual({ status: 201, text: '{"ids":null}' });
    expect(await bodyOf(await app.request("/api/startTyping", post({ session: "default", chatId: CHAT })))).toEqual({ status: 201, text: '{"result":true}' });
    expect(await bodyOf(await app.request("/api/stopTyping", post({ session: "default", chatId: CHAT })))).toEqual({ status: 201, text: '{"result":true}' });
  });

  it("refuses what WEBJS refused: typing without a chat (400), a presence it does not support (501), reading all presences (501), a seen or typing without a chat (500), a missing API key", async () => {
    const app = make();
    const typing = await app.request("/api/default/presence", post({ presence: "typing" }));
    expect(typing.status).toBe(400);
    expect(await typing.json()).toEqual({ detail: "'typing' presence requires 'chatId' field." });
    const dancing = await app.request("/api/default/presence", post({ chatId: CHAT, presence: "dancing" }));
    expect(dancing.status).toBe(501);
    expect(((await dancing.json()) as { error: string }).error).toBe("Not Implemented");
    expect((await app.request("/api/default/presence", { headers: auth })).status).toBe(501);
    expect((await app.request("/api/sendSeen", post({ session: "default" }))).status).toBe(500);
    expect((await app.request("/api/startTyping", post({ session: "default" }))).status).toBe(500);
    expect((await app.request("/api/stopTyping", post({ session: "default" }))).status).toBe(500);
    expect((await app.request("/api/default/presence", post({ presence: "offline" }, { "content-type": "application/json" }))).status).toBe(401);
    expect(await callsOf(app)).toEqual([]);
  });

  it("a presence fault fails every seen / typing / presence call, and only those (the send still works)", async () => {
    const app = make();
    expect((await app.request("/__mock/faults", control({ presence: "http500" }))).status).toBe(200);
    const targets: [string, unknown][] = [
      ["/api/sendSeen", { session: "default", chatId: CHAT }],
      ["/api/startTyping", { session: "default", chatId: CHAT }],
      ["/api/stopTyping", { session: "default", chatId: CHAT }],
      ["/api/default/presence", { presence: "offline" }],
      [`/api/default/chats/${CHAT}/messages/read`, {}],
    ];
    for (const [path, body] of targets) expect((await app.request(path, post(body))).status, path).toBe(500);
    expect((await app.request("/api/sendText", post({ session: "default", chatId: CHAT, text: "hi" }))).status).toBe(201);
    expect((await app.request("/__mock/faults", control({ presence: "timeout" }))).status).toBe(200);
    expect((await app.request("/api/default/presence", post({ presence: "offline" }))).status).toBe(504);
    expect((await app.request("/__mock/faults", control({ presence: "nope" }))).status).toBe(400);
  });

  it("WhatsApp's ban signals: with ban 463 or 475 a send fails with WAHA's own text and the session stays WORKING; null clears it", async () => {
    const app = make();
    for (const ban of ["463", "475"] as const) {
      expect((await app.request("/__mock/faults", control({ ban }))).status).toBe(200);
      const sends: [string, unknown][] = [
        ["/api/sendText", { session: "default", chatId: CHAT, text: "hi" }],
        ["/api/sendFile", { session: "default", chatId: CHAT, file: { url: "https://x.test/a.pdf" } }],
      ];
      for (const [path, body] of sends) {
        const res = await app.request(path, post(body));
        expect(res.status).toBe(500);
        expect(((await res.json()) as { message: string }).message).toBe(`server returned error ${ban}`);
      }
      expect(((await (await app.request("/api/sessions/default", { headers: auth })).json()) as { status: string }).status).toBe("WORKING");
    }
    expect((await app.request("/__mock/faults", control({ ban: "999" }))).status).toBe(400);
    expect((await app.request("/__mock/faults", control({ ban: null }))).status).toBe(200);
    expect((await app.request("/api/sendText", post({ session: "default", chatId: CHAT, text: "hi" }))).status).toBe(201);
  });

  it("check-exists answers {numberExists, chatId, pn}: every phone exists by default, a @lid chat id and numberExists false can be set, and a fault fails it", async () => {
    const app = make();
    const check = async (phone: string) => (await app.request(`/api/contacts/check-exists?phone=${phone}&session=default`, { headers: auth })).json() as Promise<Record<string, unknown>>;
    expect(await check("628123456789")).toEqual({ numberExists: true, chatId: "628123456789@c.us", pn: "628123456789@c.us" });
    await app.request("/__mock/contacts", control({ phone: "+628111111111", chatId: "98765432101234@lid", pn: "628111111111@c.us" }));
    expect(await check("628111111111")).toEqual({ numberExists: true, chatId: "98765432101234@lid", pn: "628111111111@c.us" });
    await app.request("/__mock/contacts", control({ phone: "628222222222", numberExists: false }));
    expect(await check("628222222222")).toEqual({ numberExists: false });
    // The call is refused without digits or a session, and without the key; every served lookup is recorded.
    expect((await app.request("/api/contacts/check-exists?phone=%2B628123&session=default", { headers: auth })).status).toBe(422);
    expect((await app.request("/api/contacts/check-exists?phone=628123456789", { headers: auth })).status).toBe(422);
    expect((await app.request("/api/contacts/check-exists?phone=628123456789&session=default")).status).toBe(401);
    expect((await callsOf(app)).filter((c) => c.path === "/api/contacts/check-exists")).toHaveLength(3);
    expect((await app.request("/__mock/contacts", control({}))).status).toBe(400);
    await app.request("/__mock/faults", control({ presence: "http500" }));
    expect((await app.request("/api/contacts/check-exists?phone=628123456789&session=default", { headers: auth })).status).toBe(500);
  });

  it("reports the session's timelock and capping state, quiet by default", async () => {
    const app = make();
    expect(await (await app.request("/api/sessions/default/timelock", { headers: auth })).json()).toEqual({ enforcementType: "DEFAULT", isActive: false, timeEnforcementEnds: null });
    expect(await (await app.request("/api/sessions/default/capping", { headers: auth })).json()).toMatchObject({ cappingStatus: "NONE", totalQuota: -1, mvStatus: "NOT_ELIGIBLE", cycleEnd: null });
    await app.request("/__mock/sessions/default/reachout", control({ timelock: { isActive: true, timeEnforcementEnds: 1_800_000_000 }, capping: { cappingStatus: "SECOND_WARNING", cycleEnd: 1_800_100_000 } }));
    expect(await (await app.request("/api/sessions/default/timelock", { headers: auth })).json()).toMatchObject({ isActive: true, timeEnforcementEnds: 1_800_000_000 });
    expect(await (await app.request("/api/sessions/default/capping", { headers: auth })).json()).toMatchObject({ cappingStatus: "SECOND_WARNING", cycleEnd: 1_800_100_000 });
    // Anything else in the body leaves the state as it is.
    await app.request("/__mock/sessions/default/reachout", control({}));
    expect(await (await app.request("/api/sessions/default/timelock", { headers: auth })).json()).toMatchObject({ isActive: true });
    await app.request("/__mock/sessions/other/reachout", control({ capping: {}, timelock: {} }));
    expect(await (await app.request("/api/sessions/other/capping", { headers: auth })).json()).toMatchObject({ cappingStatus: "NONE", cycleEnd: null });
  });
});
