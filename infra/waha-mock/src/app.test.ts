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

  it("sendText returns id and timestamp, and the message is listed", async () => {
    const app = make();
    const res = await app.request("/api/sendText", post({ session: "default", chatId: "628123@c.us", text: "hi" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; timestamp: number };
    expect(json.id).toMatch(/^true_628123@c\.us_[0-9A-F]+$/);
    expect(typeof json.timestamp).toBe("number");
    const list = await app.request("/api/default/chats/628123@c.us/messages?limit=5&fromMe=true", {
      headers: auth,
    });
    const msgs = (await list.json()) as { id: string; body: string }[];
    expect(msgs[0]).toMatchObject({ id: json.id, body: "hi" });
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
    expect(res.status).toBe(200);
    const list = await app.request("/api/default/chats/628123@c.us/messages", { headers: auth });
    const msgs = (await list.json()) as { media: { filename: string; url: string } }[];
    expect(msgs[0]?.media).toEqual({ filename: "a.pdf", url: "https://example.test/a.pdf" });
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

  it("lids mapping resolves, unmapped is null", async () => {
    const app = make();
    await app.request("/__mock/lids", post({ lid: "111@lid", pn: "62899@c.us" }, { "content-type": "application/json" }));
    const mapped = await app.request("/api/default/lids/111@lid", { headers: auth });
    expect(await mapped.json()).toEqual({ lid: "111@lid", pn: "62899@c.us" });
    const unmapped = await app.request("/api/default/lids/222@lid", { headers: auth });
    expect(await unmapped.json()).toEqual({ lid: "222@lid", pn: null });
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
    expect((await app.request("/api/sendFile", post(body))).status).toBe(200);
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
    expect(parsed).toMatchObject({ event: "message", session: "default", engine: "GOWS", payload: { from: "1@lid" } });
    expect(parsed).toHaveProperty("environment");
    expect(parsed).toHaveProperty("me");
  });
});
