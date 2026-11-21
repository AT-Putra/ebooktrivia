import { randomBytes } from "node:crypto";
import { type Context, Hono } from "hono";
import { webhookHmacSha512 } from "./hmac.ts";

export type FaultMode = "ok" | "http500" | "timeout";
/** WhatsApp's refusals of a new contact, as WAHA words them: "server returned error 463" (reachout timelock), "475" (message capping). */
export type BanFault = "463" | "475" | null;
/** One API call the mock served, in order (GET /__mock/calls): what the human-like sending tests look at. No message text is recorded. */
export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}
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
  /** sendFile downloads `file.url` (GET through fetchImpl) first, like real WAHA, and answers 422 when that fails. Default false. */
  fetchFiles?: boolean;
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
  /** GET /api/sessions/:session/timelock (WAHA docs, Sessions: Reachout timelock). */
  timelock: { isActive: boolean; timeEnforcementEnds: number | null };
  /** GET /api/sessions/:session/capping (Message capping): NONE | FIRST_WARNING | SECOND_WARNING | CAPPED. */
  capping: { cappingStatus: string; cycleEnd: number | null };
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
  const faults = { sendFile: "ok" as FaultMode, presence: "ok" as FaultMode, ban: null as BanFault };
  const contacts = new Map<string, { numberExists: boolean; chatId?: string; pn?: string }>();
  const calls: RecordedCall[] = [];
  const record = (method: string, path: string, body: Record<string, unknown> = {}): void => {
    calls.push({ method, path, body });
  };

  const messageId = (chatId: string): string =>
    `true_${chatId}_${randomBytes(8).toString("hex").toUpperCase()}`;
  const session = (name: string): SessionState => {
    let s = sessions.get(name);
    if (!s) {
      s = {
        status: "WORKING",
        timelock: { isActive: false, timeEnforcementEnds: null },
        capping: { cappingStatus: "NONE", cycleEnd: null },
      };
      sessions.set(name, s);
    }
    return s;
  };
  // WhatsApp refusing a message to a new contact (463 / 475): the session stays WORKING and the send did not happen.
  const banned = (c: Context) =>
    faults.ban === null ? undefined : c.json({ message: `server returned error ${faults.ban}`, statusCode: 500 }, 500);
  const me = (name: string) => ({ id: "628111111111@c.us", pushName: `mock-${name}` });
  // A session that is not WORKING (stopped, failed, waiting for its QR code) refuses every send: WAHA answers 422 (US-025: a killed session).
  const notWorking = (c: Context) => c.json({ message: "Session status is not as expected", statusCode: 422 }, 422);

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
    const sf = body["sendFile"] ?? faults.sendFile;
    if (sf !== "ok" && sf !== "http500" && sf !== "timeout") {
      return c.json({ error: 'sendFile must be "ok"|"http500"|"timeout"' }, 400);
    }
    const pf = body["presence"] ?? faults.presence;
    if (pf !== "ok" && pf !== "http500" && pf !== "timeout") {
      return c.json({ error: 'presence must be "ok"|"http500"|"timeout"' }, 400);
    }
    const ban = body["ban"] === undefined ? faults.ban : body["ban"];
    if (ban !== null && ban !== "463" && ban !== "475") return c.json({ error: 'ban must be "463"|"475"|null' }, 400);
    faults.sendFile = sf;
    faults.presence = pf;
    faults.ban = ban;
    return c.json({ ...faults });
  });

  // The session's WhatsApp ban-signal state, as GET /api/sessions/:session/timelock and /capping report it.
  app.post("/__mock/sessions/:session/reachout", async (c) => {
    const body = await readJson(c.req.raw);
    const s = session(c.req.param("session"));
    const timelock = body["timelock"];
    if (isRecord(timelock)) s.timelock = { isActive: timelock["isActive"] === true, timeEnforcementEnds: typeof timelock["timeEnforcementEnds"] === "number" ? timelock["timeEnforcementEnds"] : null };
    const capping = body["capping"];
    if (isRecord(capping)) s.capping = { cappingStatus: str(capping["cappingStatus"]) ?? "NONE", cycleEnd: typeof capping["cycleEnd"] === "number" ? capping["cycleEnd"] : null };
    return c.json({ timelock: s.timelock, capping: s.capping });
  });

  // What GET /api/contacts/check-exists answers for a phone (WAHA docs, Contacts; shapes UNVERIFIED until US-005): by default every number exists and its
  // chat id is `<digits>@c.us`; `numberExists: false` is a phone that is not on WhatsApp; `chatId` can be `<lid>@lid` (WhatsApp's LID rollout: a first contact
  // must be sent to the chat id returned, never to a built `<phone>@c.us`).
  app.post("/__mock/contacts", async (c) => {
    const body = await readJson(c.req.raw);
    const phone = str(body["phone"])?.replace(/^\+/, "");
    if (phone === undefined) return c.json({ error: "phone required" }, 400);
    const numberExists = body["numberExists"] !== false;
    const chatId = str(body["chatId"]);
    contacts.set(phone, { numberExists, ...(chatId !== undefined && { chatId }), ...(str(body["pn"]) !== undefined && { pn: str(body["pn"]) as string }) });
    return c.json({ phone, ...contacts.get(phone) });
  });

  // The API calls served so far, in order (seen, typing, presence, sends: no message text).
  app.get("/__mock/calls", (c) => c.json(calls));
  app.delete("/__mock/calls", (c) => {
    calls.length = 0;
    return c.json({ cleared: true });
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
    // Inbound messages are recorded so GET .../messages/:messageId can serve them (the worker
    // re-fetches an inbound message by id before acting on it).
    if (event === "message" && isRecord(payload) && payload["fromMe"] === false) {
      const id = str(payload["id"]);
      const from = str(payload["from"]);
      const timestamp = payload["timestamp"];
      const text = str(payload["body"]);
      if (id !== undefined && from !== undefined && typeof timestamp === "number") {
        messages.push({ id, timestamp, chatId: from, fromMe: false, ...(text !== undefined && { body: text }) });
      }
    }
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
    if (session(str(body["session"]) ?? "").status !== "WORKING") return notWorking(c);
    const refused = banned(c);
    if (refused !== undefined) return refused;
    record("POST", "/api/sendText", { session: body["session"], chatId });
    const id = messageId(chatId);
    const timestamp = Math.floor(Date.now() / 1000);
    messages.push({ id, timestamp, chatId, fromMe: true, body: text });
    return c.json({ id, timestamp });
  });

  // --- human-like sending: seen, typing, presence (WAHA docs "How to avoid blocking", "Presence", "Chats"; request bodies UNVERIFIED until US-005) ---
  const presenceFault = async (c: Context) => {
    if (faults.presence === "http500") return c.json({ message: "Internal Server Error" }, 500);
    if (faults.presence === "timeout") {
      await new Promise((r) => setTimeout(r, opts.timeoutMs ?? 60_000));
      return c.json({ message: "Gateway Timeout" }, 504);
    }
    return undefined;
  };
  api.post("/sendSeen", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ message: "session, chatId required" }, 422);
    record("POST", "/api/sendSeen", { session: body["session"], chatId: body["chatId"], ...(Array.isArray(body["messageIds"]) && { messageIds: body["messageIds"] }) });
    return c.json({});
  });
  api.post("/startTyping", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ message: "session, chatId required" }, 422);
    record("POST", "/api/startTyping", { session: body["session"], chatId: body["chatId"] });
    return c.json({});
  });
  api.post("/stopTyping", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ message: "session, chatId required" }, 422);
    record("POST", "/api/stopTyping", { session: body["session"], chatId: body["chatId"] });
    return c.json({});
  });
  api.post("/:session/presence", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    const presence = str(body["presence"]);
    const chatId = str(body["chatId"]);
    if (presence === undefined || !["online", "offline", "typing", "recording", "paused"].includes(presence)) return c.json({ message: "presence must be online, offline, typing, recording or paused" }, 422);
    // Documented: online / offline carry no chatId; typing, recording and paused need one.
    if ((presence === "typing" || presence === "recording" || presence === "paused") && chatId === undefined) return c.json({ message: "chatId is required" }, 422);
    record("POST", `/api/${c.req.param("session")}/presence`, { presence, ...(chatId !== undefined && { chatId }) });
    return c.json({});
  });
  api.post("/:session/chats/:chatId/messages/read", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    record("POST", `/api/${c.req.param("session")}/chats/${c.req.param("chatId")}/messages/read`, {});
    return c.json({ ids: [] });
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
    if (session(str(body["session"]) ?? "").status !== "WORKING") return notWorking(c);
    const refused = banned(c);
    if (refused !== undefined) return refused;
    record("POST", "/api/sendFile", { session: body["session"], chatId });
    // Real WAHA downloads the file from its URL before it sends it, and refuses the send when that fails (US-025): with fetchFiles the
    // mock does the same GET (through fetchImpl), so a download URL that cannot be fetched is a failed send here too.
    if (opts.fetchFiles === true) {
      let download: Response | undefined;
      try {
        download = await doFetch(url, { method: "GET" });
        await download.arrayBuffer();
      } catch {
        download = undefined;
      }
      if (download === undefined || !download.ok) {
        return c.json({ message: "Failed to download the file", statusCode: 422, downloadStatus: download?.status ?? 0 }, 422);
      }
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

  api.get("/contacts/check-exists", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const phone = (c.req.query("phone") ?? "").replace(/^\+/, "");
    if (!/^[0-9]{8,15}$/.test(phone) || !str(c.req.query("session"))) return c.json({ message: "phone (digits) and session required" }, 422);
    record("GET", "/api/contacts/check-exists", { phone, session: c.req.query("session") });
    const known = contacts.get(phone);
    if (known?.numberExists === false) return c.json({ numberExists: false });
    const chatId = known?.chatId ?? `${phone}@c.us`;
    return c.json({ numberExists: true, chatId, pn: known?.pn ?? `${phone}@c.us` });
  });

  // WhatsApp's ban signals of a session (WAHA docs, Sessions: Reachout timelock, Message capping).
  api.get("/sessions/:session/timelock", (c) => {
    const { isActive, timeEnforcementEnds } = session(c.req.param("session")).timelock;
    return c.json({ enforcementType: "DEFAULT", isActive, timeEnforcementEnds });
  });
  api.get("/sessions/:session/capping", (c) => {
    const { cappingStatus, cycleEnd } = session(c.req.param("session")).capping;
    // LIVE FACT: an account with no capping state answers 200 {cappingStatus: "NONE", totalQuota: -1, mvStatus: "NOT_ELIGIBLE", ...}.
    return c.json({ cappingStatus, totalQuota: -1, usedQuota: 0, mvStatus: "NOT_ELIGIBLE", cycleStart: null, cycleEnd });
  });

  api.get("/:session/lids/:lid", (c) => {
    const lid = c.req.param("lid");
    return c.json({ lid, pn: lids.get(lid) ?? null });
  });

  api.get("/:session/chats/:chatId/messages", (c) => {
    const chatId = c.req.param("chatId");
    const parsed = Number.parseInt(c.req.query("limit") ?? "10", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    const offsetParsed = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isFinite(offsetParsed) && offsetParsed > 0 ? offsetParsed : 0;
    // LIVE FACT (WAHA 2026.10.1, the US-005 audit): the filter is `filter.fromMe`; the instance silently IGNORES a bare `fromMe`, so the mock does too.
    const fromMe = c.req.query("filter.fromMe");
    const out = messages
      .filter((m) => m.chatId === chatId && (fromMe === undefined || String(m.fromMe) === fromMe))
      .reverse()
      .slice(offset, offset + limit)
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

  api.get("/:session/chats/:chatId/messages/:messageId", (c) => {
    const chatId = c.req.param("chatId");
    const m = messages.find((x) => x.id === c.req.param("messageId") && x.chatId === chatId);
    if (!m) return c.json({ message: "Message not found" }, 404);
    return c.json({
      id: m.id,
      timestamp: m.timestamp,
      from: m.fromMe ? me(c.req.param("session")).id : m.chatId,
      fromMe: m.fromMe,
      body: m.body ?? m.caption ?? "",
      hasMedia: m.url !== undefined,
      ...(m.filename !== undefined && { media: { filename: m.filename, url: m.url } }),
    });
  });

  app.route("/api", api);
  return app;
}
