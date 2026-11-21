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
import { createWahaClient, mapAck, parseChatId, parseWebhookEvent, RECENT_MAX_PAGES, verifyWebhookHmac, WahaError } from "./waha.ts";

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

describe("human-like sending calls (US-025; request bodies UNVERIFIED until US-005 checks them against the Owner's instance)", () => {
  const callsOf = async () => (await (await mock.fetch(new Request("https://mock/__mock/calls"))).json()) as { path: string; body: Record<string, unknown> }[];
  const clearCalls = () => mock.fetch(new Request("https://mock/__mock/calls", { method: "DELETE" }));
  const MESSAGE_ID = "false_628123456789@c.us_3EB0AAAA0001";

  it("sends seen (with the message ids), typing, paused and offline with the documented presence bodies", async () => {
    await clearCalls();
    await client.sendSeen("default", CHAT, [MESSAGE_ID]);
    await client.startTyping("default", CHAT);
    await client.stopTyping("default", CHAT);
    await client.setOffline("default");
    expect(await callsOf()).toEqual([
      { method: "POST", path: "/api/sendSeen", body: { session: "default", chatId: CHAT, messageIds: [MESSAGE_ID] } },
      { method: "POST", path: "/api/default/presence", body: { presence: "typing", chatId: CHAT } },
      { method: "POST", path: "/api/default/presence", body: { presence: "paused", chatId: CHAT } },
      { method: "POST", path: "/api/default/presence", body: { presence: "offline" } },
    ]);
  });

  it("sendSeen without ids marks the chat; ids that are not WAHA message ids are dropped; a 4xx from /api/sendSeen falls back to the chat's read call", async () => {
    await clearCalls();
    await client.sendSeen("default", CHAT);
    await client.sendSeen("default", CHAT, ["not an id"]);
    expect((await callsOf()).map((c) => c.body)).toEqual([{ session: "default", chatId: CHAT }, { session: "default", chatId: CHAT }]);
    const seen: string[] = [];
    const fallback = createWahaClient({
      target,
      apiKey: API_KEY,
      fetch: (url, init) => {
        seen.push(`${init.method} ${new URL(url).pathname}`);
        return Promise.resolve<HttpResponse>({ status: new URL(url).pathname === "/api/sendSeen" ? 404 : 200, json: () => Promise.resolve({ ids: [] }), text: () => Promise.resolve("") });
      },
    });
    await fallback.sendSeen("default", CHAT, [MESSAGE_ID]);
    expect(seen).toEqual(["POST /api/sendSeen", `POST /api/default/chats/${encodeURIComponent(CHAT)}/messages/read`]);
    // Anything but a refusal is not retried on another endpoint.
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(503, {}) }).sendSeen("default", CHAT))).toBe("failed");
  });

  it("every call has a short budget of its own (the signal handed to the fetch), and a failing call is a WahaError, never maybe_sent", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const slow = createWahaClient({
      target,
      apiKey: API_KEY,
      presenceTimeoutMs: 50,
      fetch: (_url, init) => {
        signals.push(init.signal);
        return new Promise<HttpResponse>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      },
    });
    expect(await wahaError(slow.startTyping("default", CHAT))).toBe("failed");
    expect(await wahaError(slow.setOffline("default"))).toBe("failed");
    expect(signals.every((s) => s !== undefined)).toBe(true);
    await control("/__mock/faults", { presence: "http500" });
    expect(await wahaError(client.startTyping("default", CHAT))).toBe("failed");
    await control("/__mock/faults", { presence: "ok" });
  });

  it("refuses chat ids and session names that could rewrite the path", async () => {
    await expect(client.startTyping("default", "../x@c.us")).rejects.toThrow(RangeError);
    await expect(client.stopTyping("de/fault", CHAT)).rejects.toThrow(RangeError);
    await expect(client.sendSeen("default", "x")).rejects.toThrow(RangeError);
    await expect(client.setOffline("de fault")).rejects.toThrow(RangeError);
  });

  it("recognises WhatsApp's own refusals, 463 (reachout timelock) and 475 (message capping), on a send, as definite failures (never maybe_sent)", async () => {
    for (const [ban, code] of [["463", "reachout_timelock"], ["475", "message_capping"]] as const) {
      await control("/__mock/faults", { ban });
      expect(await wahaError(client.sendText("default", CHAT, "x"))).toBe(code);
      const file = { url: "https://api.example.id/files/a.pdf", filename: "a.pdf", mimetype: "application/pdf" };
      expect(await wahaError(client.sendFile("default", CHAT, file))).toBe(code);
    }
    await control("/__mock/faults", { ban: null });
    expect((await client.sendText("default", CHAT, "x")).id).toMatch(/^true_/);
    // The text is only read for the code: another 5xx stays an uncertain send, and a 4xx that says nothing of the kind stays a rejection.
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(500, { message: "Internal Server Error" }) }).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(422, { message: "server returned error 464" }) }).sendText("default", CHAT, "x"))).toBe("rejected");
    // ... and what is not a send never classifies by it.
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(500, { message: "server returned error 463" }) }).sessionStatus("default"))).toBe("failed");
    const noText: HttpFetch = () => Promise.resolve<HttpResponse>({ status: 500, json: () => Promise.resolve({}), text: () => Promise.reject(new Error("closed")) });
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: noText }).sendText("default", CHAT, "x"))).toBe("maybe_sent");
    const prefixed: HttpFetch = () => Promise.resolve<HttpResponse>({ status: 500, json: () => Promise.resolve({}), text: () => Promise.resolve(""), textPrefix: () => Promise.resolve("server returned error 475") });
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: prefixed }).sendText("default", CHAT, "x"))).toBe("message_capping");
  });

  it("checks that a phone is on WhatsApp before the first contact and returns the chat id WAHA gives (never one we build): a @c.us, a @lid, or not on WhatsApp", async () => {
    await clearCalls();
    expect(await client.checkExists("default", "+628123456789")).toEqual({ numberExists: true, chatId: "628123456789@c.us", lid: null, phone: "+628123456789" });
    expect((await callsOf())[0]).toEqual({ method: "GET", path: "/api/contacts/check-exists", body: { phone: "628123456789", session: "default" } });
    await control("/__mock/contacts", { phone: "628111111111", chatId: "98765432101234@lid", pn: "628111111111@c.us" });
    expect(await client.checkExists("default", "628111111111")).toEqual({ numberExists: true, chatId: "98765432101234@lid", lid: "98765432101234@lid", phone: "+628111111111" });
    await control("/__mock/contacts", { phone: "628222222222", numberExists: false });
    expect(await client.checkExists("default", "+628222222222")).toEqual({ numberExists: false, chatId: null, lid: null, phone: null });
    // No pn: the phone is unknown, the chat id is still what WAHA said.
    const bare = createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, { numberExists: true, chatId: "628333333333@c.us" }) });
    expect(await bare.checkExists("default", "628333333333")).toEqual({ numberExists: true, chatId: "628333333333@c.us", lid: null, phone: null });
  });

  it("a failing check-exists is a failed lookup (never maybe_sent), and an answer without a usable chat id is refused", async () => {
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(503, {}) }).checkExists("default", "628123456789"))).toBe("failed");
    const timeout = createWahaClient({ target, apiKey: API_KEY, fetch: () => Promise.reject(new SafeFetchError("timeout", "x")) });
    expect(await wahaError(timeout.checkExists("default", "628123456789"))).toBe("failed");
    for (const body of [{}, { numberExists: "yes" }, { numberExists: true }, { numberExists: true, chatId: "x@g.us" }, { numberExists: true, chatId: "../x@c.us" }]) {
      expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, body) }).checkExists("default", "628123456789")), JSON.stringify(body)).toBe("bad_response");
    }
    await expect(client.checkExists("default", "12")).rejects.toThrow(RangeError);
    await expect(client.checkExists("de/fault", "628123456789")).rejects.toThrow(RangeError);
  });

  it("reads the limits a session.status webhook carries (data.reachoutTimelock, data.messageCapping) as raw objects for the database to check", () => {
    const event = { event: "session.status", session: "default", timestamp: 1, payload: { status: "WORKING", data: { reachoutTimelock: { isActive: true, timeEnforcementEnds: 1_800_000_000 }, messageCapping: { cappingStatus: "CAPPED", cycleEnd: 1_800_100_000 } } } };
    expect(parseWebhookEvent(event)).toMatchObject({ kind: "session.status", status: "WORKING", reachoutTimelock: { isActive: true, timeEnforcementEnds: 1_800_000_000 }, messageCapping: { cappingStatus: "CAPPED" } });
    expect(parseWebhookEvent({ ...event, payload: { status: "WORKING", data: { reachoutTimelock: "x", messageCapping: [1] } } })).toMatchObject({ reachoutTimelock: undefined, messageCapping: undefined });
    expect(parseWebhookEvent({ ...event, payload: { status: "WORKING", data: null } })).toMatchObject({ reachoutTimelock: undefined, messageCapping: undefined });
  });

  it("reads the session's timelock and message-capping state (GET /api/sessions/{session}/timelock and /capping); null where WAHA has none", async () => {
    expect(await client.reachoutTimelock("default")).toEqual({ isActive: false, endsAt: null });
    expect(await client.messageCapping("default")).toEqual({ status: "NONE", cycleEnd: null, totalQuota: -1, usedQuota: 0 });
    await control("/__mock/sessions/default/reachout", { timelock: { isActive: true, timeEnforcementEnds: 1_800_000_000 }, capping: { cappingStatus: "FIRST_WARNING", cycleEnd: 1_800_100_000 } });
    expect(await client.reachoutTimelock("default")).toEqual({ isActive: true, endsAt: new Date(1_800_000_000_000) });
    expect(await client.messageCapping("default")).toEqual({ status: "FIRST_WARNING", cycleEnd: new Date(1_800_100_000_000), totalQuota: -1, usedQuota: 0 });
    await control("/__mock/sessions/default/reachout", { timelock: { isActive: false }, capping: { cappingStatus: "NONE" } });
    const none = createWahaClient({ target, apiKey: API_KEY, fetch: respond(404, {}) });
    expect(await none.reachoutTimelock("default")).toBeNull();
    expect(await none.messageCapping("default")).toBeNull();
    const odd = createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, { isActive: "yes" }) });
    expect(await wahaError(odd.reachoutTimelock("default"))).toBe("bad_response");
    expect(await wahaError(createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, {}) }).messageCapping("default"))).toBe("bad_response");
    expect(await createWahaClient({ target, apiKey: API_KEY, fetch: respond(200, { isActive: true, timeEnforcementEnds: -5 }) }).reachoutTimelock("default")).toEqual({ isActive: true, endsAt: null });
  });
});

describe("recentOutgoing: the outgoing-message lookup behind an uncertain send (live facts of the US-005 audit, WAHA 2026.10.1)", () => {
  const NOW = 1_800_000_000;
  /** An instance that serves `thread` (newest first) with the query's limit and offset, and IGNORES a bare `fromMe`, as the real one does. */
  function instance(thread: { id: string; fromMe: boolean; timestamp: number }[], urls: string[] = []): HttpFetch {
    return (url) => {
      const u = new URL(url);
      urls.push(`${u.pathname}${u.search}`);
      const limit = Number(u.searchParams.get("limit") ?? "10");
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const only = u.searchParams.get("filter.fromMe") === "true";
      const rows = thread.filter((m) => !only || m.fromMe).slice(offset, offset + limit);
      return Promise.resolve<HttpResponse>({ status: 200, json: () => Promise.resolve(rows), text: () => Promise.resolve("") });
    };
  }

  it("sends WAHA's own filter, `filter.fromMe=true`, never a bare `fromMe`", async () => {
    const urls: string[] = [];
    const c = createWahaClient({ target, apiKey: API_KEY, fetch: instance([], urls) });
    await c.recentOutgoing("default", CHAT, 20);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("filter.fromMe=true");
    expect(urls[0]).not.toMatch(/[?&]fromMe=/);
    expect(urls[0]).toContain("downloadMedia=false");
  });

  it("still keeps only our own messages when the instance ignores the filter (the client-side backstop)", async () => {
    const ignoring: HttpFetch = () =>
      Promise.resolve<HttpResponse>({
        status: 200,
        json: () => Promise.resolve([{ id: "a", fromMe: false, timestamp: NOW }, { id: "b", fromMe: true, timestamp: NOW - 1 }]),
        text: () => Promise.resolve(""),
      });
    expect((await createWahaClient({ target, apiKey: API_KEY, fetch: ignoring }).recentOutgoing("default", CHAT)).map((m) => m.id)).toEqual(["b"]);
  });

  it("pages on until the send's time is covered: a chatty buyer cannot push our message out of the window", async () => {
    // Our send is 130 messages deep (a buyer who wrote a lot since); the instance applies its filter or not, the lookup must find it either way.
    const thread = [
      ...Array.from({ length: 130 }, (_, i) => ({ id: `in-${String(i)}`, fromMe: false, timestamp: NOW - i })),
      { id: "ours", fromMe: true, timestamp: NOW - 200 },
      { id: "older", fromMe: true, timestamp: NOW - 100_000 },
    ];
    const ignoringFilter: HttpFetch = (url) => {
      const u = new URL(url);
      const rows = thread.slice(Number(u.searchParams.get("offset") ?? "0"), Number(u.searchParams.get("offset") ?? "0") + Number(u.searchParams.get("limit")));
      return Promise.resolve<HttpResponse>({ status: 200, json: () => Promise.resolve(rows), text: () => Promise.resolve("") });
    };
    for (const [fetch, filters] of [[instance(thread), true], [ignoringFilter, false]] as const) {
      const c = createWahaClient({ target, apiKey: API_KEY, fetch });
      // Without the filter one page of 50 does not reach it ...
      expect((await c.recentOutgoing("default", CHAT, 50)).map((m) => m.id).includes("ours")).toBe(filters);
      // ... and with the send's time (`since`) the lookup pages on until a page reaches back that far.
      const found = await c.recentOutgoing("default", CHAT, 50, new Date((NOW - 300) * 1000));
      expect(found.map((m) => m.id)).toContain("ours");
    }
  });

  it("stops paging at a short page, and never reads more than RECENT_MAX_PAGES pages", async () => {
    const urls: string[] = [];
    const short = createWahaClient({ target, apiKey: API_KEY, fetch: instance([{ id: "x", fromMe: true, timestamp: NOW }], urls) });
    expect((await short.recentOutgoing("default", CHAT, 50, new Date(0))).map((m) => m.id)).toEqual(["x"]);
    expect(urls).toHaveLength(1);

    const urls2: string[] = [];
    const endless: HttpFetch = (url) => {
      urls2.push(url);
      return Promise.resolve<HttpResponse>({ status: 200, json: () => Promise.resolve(Array.from({ length: 10 }, (_, i) => ({ id: `m${String(urls2.length)}-${String(i)}`, fromMe: true, timestamp: NOW }))), text: () => Promise.resolve("") });
    };
    await createWahaClient({ target, apiKey: API_KEY, fetch: endless }).recentOutgoing("default", CHAT, 10, new Date(0));
    expect(urls2).toHaveLength(RECENT_MAX_PAGES);
    expect(urls2[1]).toContain("offset=10");
  });
});

describe("the client never changes a session's configuration", () => {
  it("makes only GET and POST requests, and no request but a GET to a session: PUT /api/sessions/{session} replaces the whole config of an instance that hosts another app's session", async () => {
    const seen: { method: string; path: string }[] = [];
    const capture: HttpFetch = (url, init) => {
      seen.push({ method: init.method, path: new URL(url).pathname });
      return Promise.resolve<HttpResponse>({ status: 200, json: () => Promise.resolve({ id: "true_628123456789@c.us_AAAA", timestamp: 1, status: "WORKING", numberExists: false, isActive: false, cappingStatus: "NONE", lid: "1", pn: null }), text: () => Promise.resolve("") });
    };
    const c = createWahaClient({ target, apiKey: API_KEY, fetch: capture });
    const attempts: (() => Promise<unknown>)[] = [
      () => c.sendText("default", CHAT, "x"),
      () => c.sendFile("default", CHAT, { url: "https://api.example.id/f.pdf?exp=1&sig=x", filename: "f.pdf", mimetype: "application/pdf" }),
      () => c.sessionStatus("default"),
      () => c.resolveLid("default", "98765432101234@lid"),
      () => c.recentOutgoing("default", CHAT, 5, new Date(0)),
      () => c.getMessage("default", "false_628123456789@c.us_3EB0AAAA0001"),
      () => c.sendSeen("default", CHAT, ["false_628123456789@c.us_3EB0AAAA0001"]),
      () => c.startTyping("default", CHAT),
      () => c.stopTyping("default", CHAT),
      () => c.setOffline("default"),
      () => c.checkExists("default", "+628123456789"),
      () => c.reachoutTimelock("default"),
      () => c.messageCapping("default"),
    ];
    for (const attempt of attempts) await attempt().catch(() => undefined);
    expect(seen.length).toBeGreaterThanOrEqual(attempts.length);
    expect(new Set(seen.map((r) => r.method))).toEqual(new Set(["GET", "POST"]));
    expect(seen.filter((r) => /^\/api\/sessions\/[^/]+$/.test(r.path)).map((r) => r.method)).toEqual(["GET"]);
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
      "https://waha.example.id:3000/waha/api/default/chats/628123456789%40c.us/messages?limit=5&filter.fromMe=true&downloadMedia=false",
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
    expect(parseWebhookEvent(sessionFixture.example)).toEqual({ kind: "session.status", session: "default", status: "WORKING", reachoutTimelock: undefined, messageCapping: undefined });
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
