import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { webhookHmacSha512 } from "./hmac.ts";

export type FaultMode = "ok" | "http500" | "timeout";
export type AckValue = -1 | 0 | 1 | 2 | 3 | 4;

export const ACK_NAMES: Record<AckValue, string> = {
  [-1]: "ERROR",
  0: "PENDING",
  1: "SERVER",
  2: "DEVICE",
  3: "READ",
  4: "PLAYED",
};

export interface WahaMockOptions {
  apiKey: string;
  webhookHmacSecret: string;
  /** Delay used by the "timeout" fault, in ms. Default 60000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RecordedMessage {
  id: string;
  timestamp: number;
  chatId: string;
  fromMe: boolean;
  body?: string;
  filename?: string;
  url?: string;
  caption?: string;
}

interface SessionState {
  status: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

export function createWahaMockApp(opts: WahaMockOptions): Hono {
  const app = new Hono();
  const doFetch = opts.fetchImpl ?? fetch;
  const sessions = new Map<string, SessionState>();
  const lids = new Map<string, string | null>();
  const messages: RecordedMessage[] = [];
  const faults = { sendFile: "ok" as FaultMode };

  const messageId = (chatId: string): string =>
    `true_${chatId}_${randomBytes(8).toString("hex").toUpperCase()}`;
  const session = (name: string): SessionState => {
    let s = sessions.get(name);
    if (!s) {
      s = { status: "WORKING" };
      sessions.set(name, s);
    }
    return s;
  };
  const me = (name: string) => ({ id: "628111111111@c.us", pushName: `mock-${name}` });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // --- control plane (no API key; local dev only) ---
  app.post("/__mock/sessions/:session/status", async (c) => {
    const body = await readJson(c.req.raw);
    const status = str(body["status"]);
    if (!status) return c.json({ error: "status required" }, 400);
    session(c.req.param("session")).status = status;
    return c.json({ name: c.req.param("session"), status });
  });

  app.post("/__mock/lids", async (c) => {
    const body = await readJson(c.req.raw);
    const lid = str(body["lid"]);
    if (!lid) return c.json({ error: "lid required" }, 400);
    const pn = body["pn"];
    lids.set(lid, typeof pn === "string" ? pn : null);
    return c.json({ lid, pn: lids.get(lid) });
  });

  app.post("/__mock/faults", async (c) => {
    const body = await readJson(c.req.raw);
    const sf = body["sendFile"];
    if (sf !== "ok" && sf !== "http500" && sf !== "timeout") {
      return c.json({ error: 'sendFile must be "ok"|"http500"|"timeout"' }, 400);
    }
    faults.sendFile = sf;
    return c.json({ ...faults });
  });

  app.post("/__mock/emit", async (c) => {
    const body = await readJson(c.req.raw);
    const event = str(body["event"]);
    const sessionName = str(body["session"]);
    const targetUrl = str(body["targetUrl"]);
    if (!event || !sessionName || !targetUrl) {
      return c.json({ error: "event, session, targetUrl required" }, 400);
    }
    const payload = body["payload"] ?? {};
    const raw = JSON.stringify({
      id: `evt_${randomBytes(8).toString("hex")}`,
      timestamp: Date.now(),
      event,
      session: sessionName,
      me: me(sessionName),
      payload,
      engine: "GOWS",
      environment: { tier: "CORE", version: "mock", engine: "GOWS", browser: null },
    });
    const res = await doFetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Webhook-Hmac": webhookHmacSha512(raw, opts.webhookHmacSecret),
        "X-Webhook-Hmac-Algorithm": "sha512",
      },
      body: raw,
    });
    return c.json({ delivered: true, targetStatus: res.status, body: raw });
  });

  // --- WAHA-shaped API (X-Api-Key required) ---
  const api = new Hono();
  api.use("*", async (c, next) => {
    if (c.req.header("X-Api-Key") !== opts.apiKey) return c.json({ message: "Unauthorized" }, 401);
    await next();
  });

  api.post("/sendText", async (c) => {
    const body = await readJson(c.req.raw);
    const chatId = str(body["chatId"]);
    const text = str(body["text"]);
    if (!str(body["session"]) || !chatId || !text) {
      return c.json({ message: "session, chatId, text required" }, 422);
    }
    const id = messageId(chatId);
    const timestamp = Math.floor(Date.now() / 1000);
    messages.push({ id, timestamp, chatId, fromMe: true, body: text });
    return c.json({ id, timestamp });
  });

  api.post("/sendFile", async (c) => {
    if (faults.sendFile === "http500") return c.json({ message: "Internal Server Error" }, 500);
    if (faults.sendFile === "timeout") {
      await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 60_000));
      return c.json({ message: "Gateway Timeout" }, 504);
    }
    const body = await readJson(c.req.raw);
    const chatId = str(body["chatId"]);
    const file = body["file"];
    const url = isRecord(file) ? str(file["url"]) : undefined;
    if (!str(body["session"]) || !chatId || url === undefined) {
      return c.json({ message: "session, chatId, file.url required" }, 422);
    }
    const filename = isRecord(file) ? str(file["filename"]) : undefined;
    const caption = str(body["caption"]);
    const id = messageId(chatId);
    const timestamp = Math.floor(Date.now() / 1000);
    messages.push({
      id,
      timestamp,
      chatId,
      fromMe: true,
      url,
      ...(filename !== undefined && { filename }),
      ...(caption !== undefined && { caption }),
    });
    return c.json({ id, timestamp });
  });

  api.get("/sessions/:session", (c) => {
    const name = c.req.param("session");
    return c.json({ name, status: session(name).status, me: me(name) });
  });

  api.get("/:session/lids/:lid", (c) => {
    const lid = c.req.param("lid");
    return c.json({ lid, pn: lids.get(lid) ?? null });
  });

  api.get("/:session/chats/:chatId/messages", (c) => {
    const chatId = c.req.param("chatId");
    const parsed = Number.parseInt(c.req.query("limit") ?? "10", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const fromMe = c.req.query("fromMe");
    const out = messages
      .filter((m) => m.chatId === chatId && (fromMe === undefined || String(m.fromMe) === fromMe))
      .slice(-limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        fromMe: m.fromMe,
        body: m.body ?? m.caption ?? "",
        hasMedia: m.url !== undefined,
        ...(m.filename !== undefined && { media: { filename: m.filename, url: m.url } }),
      }));
    return c.json(out);
  });

  app.route("/api", api);
  return app;
}
