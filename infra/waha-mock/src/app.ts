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
  /**
   * sendFile downloads `file.url` (GET through fetchImpl) first, as WAHA does. Default false (the file is not fetched).
   *   true     a download that fails is REFUSED with 422 (what US-025 assumed; NOT what the Owner's WEBJS does).
   *   "webjs"  what the Owner's WEBJS 2026.10.1 RECORDED (US-005, docs/spikes/R11.md): a URL that answers 404 is not an error. WAHA takes the 404 PAGE as the
   *            file, sends it as a document under the requested filename and answers 201: the buyer gets a broken file and the send looks successful.
   */
  fetchFiles?: boolean | "webjs";
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
  mimetype?: string;
  /** The bytes the download of `url` returned (only when the mock downloads files): WEBJS reports them as _data.size. */
  size?: number;
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

  // The key of a WEBJS message is 22 upper-case hex digits (recorded).
  const messageKey = (): string => randomBytes(11).toString("hex").toUpperCase();
  const messageId = (chatId: string): string => `true_${chatId}_${messageKey()}`;
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
  const me = (name: string) => ({ id: "628111111111@c.us", lid: "300000000000001@lid", pushName: `mock-${name}` });
  // A session that is not WORKING (stopped, failed, waiting for its QR code) refuses every send: WAHA answers 422 (US-025: a killed session).
  const notWorking = (c: Context) => c.json({ message: "Session status is not as expected", statusCode: 422 }, 422);

  // The documented WAMessage as the instance LISTS and GETS a message (recorded on the Owner's WEBJS, scrubbed): our own messages have source "api" and
  // ack 2 DEVICE, the buyer's have source "app" and ack 0 PENDING.
  const waMessage = (m: RecordedMessage, sessionName: string) => ({
    id: m.id,
    timestamp: m.timestamp,
    from: m.fromMe ? me(sessionName).lid : m.chatId,
    fromMe: m.fromMe,
    source: m.fromMe ? "api" : "app",
    to: m.fromMe ? m.chatId : me(sessionName).id,
    body: m.body ?? m.caption ?? "",
    hasMedia: m.url !== undefined,
    media: m.url === undefined ? null : { url: null, mimetype: m.mimetype ?? "application/octet-stream", ...(m.filename !== undefined && { filename: m.filename }) },
    ack: m.fromMe ? 2 : 0,
    ackName: m.fromMe ? "DEVICE" : "PENDING",
    location: null,
    vCards: [],
    // Recorded: every message carries its raw engine data, and a file's carries the delivered size (the real one is about 3 KB; only what is used is kept).
    _data: m.url === undefined ? { type: "chat" } : { type: "document", mimetype: m.mimetype ?? "application/octet-stream", ...(m.filename !== undefined && { filename: m.filename }), ...(m.size !== undefined && { size: m.size }) },
  });
  // The answer of POST /api/sendText and /api/sendFile on WEBJS is NOT a WAMessage: it is the raw whatsapp-web.js message (recorded): `id` is an
  // OBJECT whose `_serialized` is the string id, `ack` is 0, there is no `source`, and a file answer also carries `mediaKey`.
  const rawWebjsSend = (m: RecordedMessage, sessionName: string, file: boolean) => {
    const key = m.id.slice(m.id.lastIndexOf("_") + 1);
    return {
      _data: { id: { fromMe: true, remote: m.chatId, id: key, _serialized: m.id }, type: file ? "document" : "chat", t: m.timestamp, ack: 0, ...(file && m.size !== undefined && { size: m.size }) },
      ...(file && { mediaKey: "bW9jay1tZWRpYS1rZXk=" }),
      id: { fromMe: true, remote: m.chatId, id: key, $1: m.id, _serialized: m.id },
      ack: 0,
      hasMedia: file,
      body: m.body ?? m.caption ?? "",
      type: file ? "document" : "chat",
      timestamp: m.timestamp,
      from: me(sessionName).lid,
      to: m.chatId,
      deviceType: "web",
      isForwarded: false,
      forwardingScore: 0,
      isStatus: false,
      isStarred: false,
      fromMe: true,
      hasQuotedMsg: false,
      hasReaction: false,
      vCards: [],
      mentionedIds: [],
      groupMentions: [],
      isGif: false,
      links: [],
    };
  };

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

  // What GET /api/contacts/check-exists answers for a phone (WAHA docs, Contacts; shapes RECORDED in US-005): by default every number exists and its
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
      // The Owner's instance (recorded, US-005): WAHA 2026.10.1, engine WEBJS, tier CORE. The webhook body itself was NOT recorded (no public URL).
      engine: "WEBJS",
      environment: { tier: "CORE", version: "2026.10.1", engine: "WEBJS" },
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
    const stored: RecordedMessage = { id, timestamp, chatId, fromMe: true, body: text };
    messages.push(stored);
    return c.json(rawWebjsSend(stored, str(body["session"]) ?? "default", false), 201);
  });

  // --- human-like sending: seen, typing, presence. The answers are what the Owner's WEBJS instance (2026.10.1) RECORDED in US-005 (docs/spikes/R11.md): ---
  //   POST /api/sendSeen            201 {"ids": null} without messageIds, 201 with NO BODY with them
  //   POST /api/startTyping|stopTyping   201 {"result": true}
  //   POST /api/{session}/presence  201 with NO BODY (typing, paused, recording, online, offline)
  //                                 a presence WEBJS does not support: 501; typing / recording / paused without chatId: 400 {"detail": ...}
  //   GET  /api/{session}/presence  501 (not implemented by WEBJS)
  const WEBJS_PRESENCES = ["online", "offline", "typing", "recording", "paused"];
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
    // Recorded: a missing chatId is a 500 with the engine's exception (WAHA does not validate it).
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ statusCode: 500, exception: { message: "Cannot read properties of undefined (reading 'includes')", name: "TypeError" } }, 500);
    const messageIds = Array.isArray(body["messageIds"]);
    record("POST", "/api/sendSeen", { session: body["session"], chatId: body["chatId"], ...(messageIds && { messageIds: body["messageIds"] }) });
    return messageIds ? c.body(null, 201) : c.json({ ids: null }, 201);
  });
  api.post("/startTyping", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ statusCode: 500, exception: { message: "Cannot read properties of undefined (reading 'includes')", name: "TypeError" } }, 500);
    record("POST", "/api/startTyping", { session: body["session"], chatId: body["chatId"] });
    return c.json({ result: true }, 201);
  });
  api.post("/stopTyping", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    if (!str(body["session"]) || !str(body["chatId"])) return c.json({ statusCode: 500, exception: { message: "Cannot read properties of undefined (reading 'includes')", name: "TypeError" } }, 500);
    record("POST", "/api/stopTyping", { session: body["session"], chatId: body["chatId"] });
    return c.json({ result: true }, 201);
  });
  api.post("/:session/presence", async (c) => {
    const failed = await presenceFault(c);
    if (failed !== undefined) return failed;
    const body = await readJson(c.req.raw);
    const presence = str(body["presence"]);
    const chatId = str(body["chatId"]);
    if (presence === undefined || !WEBJS_PRESENCES.includes(presence)) {
      return c.json({ message: `WEBJS engine doesn't support '${presence ?? ""}' presence. The method is not implemented by 'WEBJS' engine. Check the docs and try another engine: https://waha.devlike.pro/`, error: "Not Implemented", statusCode: 501 }, 501);
    }
    // Recorded: typing, recording and paused need a chatId (400); online and offline carry none.
    if ((presence === "typing" || presence === "recording" || presence === "paused") && chatId === undefined) return c.json({ detail: `'${presence}' presence requires 'chatId' field.` }, 400);
    record("POST", `/api/${c.req.param("session")}/presence`, { presence, ...(chatId !== undefined && { chatId }) });
    return c.body(null, 201);
  });
  // Recorded: reading everybody's presence is not implemented by WEBJS.
  api.get("/:session/presence", (c) =>
    c.json({ message: "The method is not implemented by 'WEBJS' engine. Check the docs and try another engine: https://waha.devlike.pro/", error: "Not Implemented", statusCode: 501 }, 501),
  );
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
    // fetchFiles: the mock does the GET of the URL (through fetchImpl) first, as WAHA does. true: a failed download refuses the send (422, what US-025 assumed).
    // "webjs": what the Owner's WEBJS recorded (US-005): a download that answers an error status is NOT an error, the answer page is sent as the document.
    let downloaded: number | undefined;
    if (opts.fetchFiles === "webjs") {
      try {
        downloaded = (await (await doFetch(url, { method: "GET" })).arrayBuffer()).byteLength;
      } catch {
        // A host that cannot be reached at all was not recorded; it is refused like a transport failure.
        return c.json({ message: "Failed to download the file", statusCode: 422 }, 422);
      }
    } else if (opts.fetchFiles === true) {
      let download: Response | undefined;
      try {
        download = await doFetch(url, { method: "GET" });
        downloaded = (await download.arrayBuffer()).byteLength;
      } catch {
        download = undefined;
      }
      if (download === undefined || !download.ok) {
        return c.json({ message: "Failed to download the file", statusCode: 422, downloadStatus: download?.status ?? 0 }, 422);
      }
    }
    const filename = isRecord(file) ? str(file["filename"]) : undefined;
    const mimetype = isRecord(file) ? str(file["mimetype"]) : undefined;
    const caption = str(body["caption"]);
    const id = messageId(chatId);
    const timestamp = Math.floor(Date.now() / 1000);
    const stored: RecordedMessage = {
      id,
      timestamp,
      chatId,
      fromMe: true,
      url,
      ...(filename !== undefined && { filename }),
      ...(mimetype !== undefined && { mimetype }),
      ...(caption !== undefined && { caption }),
      ...(downloaded !== undefined && { size: downloaded }),
    };
    messages.push(stored);
    return c.json(rawWebjsSend(stored, str(body["session"]) ?? "default", true), 201);
  });

  api.get("/sessions/:session", (c) => {
    const name = c.req.param("session");
    const state = session(name);
    // The recorded GET /api/sessions/{session} of WEBJS (the config, which holds webhook URLs and HMAC keys, is not part of what is replayed).
    return c.json({
      name,
      status: state.status,
      config: { metadata: {}, webhooks: [] },
      me: {
        ...me(name),
        reachoutTimelock: state.timelock.isActive ? { enforcementType: "DEFAULT", isActive: true, timeEnforcementEnds: state.timelock.timeEnforcementEnds } : null,
        messageCapping: { cappingStatus: state.capping.cappingStatus, totalQuota: -1, usedQuota: 0, cycleStart: 1_793_000_000, cycleEnd: state.capping.cycleEnd ?? 1_795_600_000, mvStatus: "NOT_ELIGIBLE", oteStatus: "NOT_ELIGIBLE" },
      },
      presence: "offline",
      timestamps: { activity: 1_760_000_000_000 },
      engine: { engine: "WEBJS", WWebVersion: "2.3000.0", state: "CONNECTED" },
    });
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
    // LIVE FACT (US-005 R11): for a contact whose chat id is a @lid the instance answers {numberExists, chatId} and NO `pn`.
    if (chatId.endsWith("@lid") && known?.pn === undefined) return c.json({ numberExists: true, chatId });
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
    return c.json({ cappingStatus, totalQuota: -1, usedQuota: 0, mvStatus: "NOT_ELIGIBLE", oteStatus: "NOT_ELIGIBLE", cycleStart: 1_793_000_000, cycleEnd });
  });

  // LIVE FACT (US-005 R11): an unknown LID is 200 {lid, pn: null}, never a 404; the lookup by phone answers {lid, pn} (or {lid: null, pn} when unknown).
  api.get("/:session/lids/:lid", (c) => {
    const lid = c.req.param("lid");
    return c.json({ lid, pn: lids.get(lid) ?? null });
  });
  api.get("/:session/lids/pn/:phone", (c) => {
    const phone = c.req.param("phone");
    const pn = phone.endsWith("@c.us") ? phone : `${phone}@c.us`;
    const found = [...lids.entries()].find(([, mapped]) => mapped === pn);
    return c.json({ lid: found?.[0] ?? null, pn });
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
      .map((m) => waMessage(m, c.req.param("session")));
    return c.json(out);
  });

  api.get("/:session/chats/:chatId/messages/:messageId", (c) => {
    // LIVE FACT (US-005 R11): WEBJS looks a message up by its id and ignores the chat in the path, so a message is found through any chat id.
    const m = messages.find((x) => x.id === c.req.param("messageId"));
    if (!m) return c.json({ message: "Message not found", error: "Not Found", statusCode: 404 }, 404);
    return c.json(waMessage(m, c.req.param("session")));
  });

  app.route("/api", api);
  return app;
}
