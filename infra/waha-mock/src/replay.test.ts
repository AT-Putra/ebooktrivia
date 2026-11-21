import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import contactsFixture from "../fixtures/contacts.json" with { type: "json" };
import humanFixture from "../fixtures/human-like.json" with { type: "json" };
import limitsFixture from "../fixtures/limits.json" with { type: "json" };
import messageFixture from "../fixtures/message.json" with { type: "json" };
import sendFixture from "../fixtures/send.json" with { type: "json" };
import sessionFixture from "../fixtures/session-status.json" with { type: "json" };
import { createWahaMockApp } from "./app.ts";

// The mock replays what the Owner's WAHA (2026.10.1, engine WEBJS, tier CORE) RECORDED in US-005 (fixtures/*.json, scrubbed; docs/spikes/R11.md). Every answer here is
// pinned to its fixture: the HTTP status, and the SHAPE (the keys and the type of each value, down the objects; the first item of a list; `_data` and `config` only by
// their presence, because the raw engine data is about 3 KB of internals).
const KEY = "k";
const headers = { "x-api-key": KEY, "content-type": "application/json" };
const ok = () => Promise.resolve(new Response("ok"));
const make = (opts: { fetchImpl?: typeof fetch; fetchFiles?: boolean | "webjs" } = {}) => createWahaMockApp({ apiKey: KEY, webhookHmacSecret: "s", timeoutMs: 5, fetchImpl: ok, ...opts });
type App = ReturnType<typeof make>;
const post = (app: App, path: string, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
const get = (app: App, path: string) => app.request(path, { headers });

const NULLABLE_NUMBERS = new Set(["cycleStart", "cycleEnd", "timeEnforcementEnds"]);
function shape(value: unknown, key = ""): unknown {
  if (NULLABLE_NUMBERS.has(key) && (value === null || typeof value === "number")) return "number|null";
  if (key === "_data" || key === "config") return "<present>";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : [shape(value[0])];
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v, k)]));
  return typeof value;
}
/** A recorded entry: `http_status` and `body` (`empty_body`: a 2xx with no body at all). */
interface Recorded {
  readonly http_status: number;
  readonly body?: unknown;
  readonly empty_body?: boolean;
}
async function expectAnswer(response: Response, recorded: Recorded, label: string): Promise<unknown> {
  expect(response.status, `${label}: status`).toBe(recorded.http_status);
  const text = await response.text();
  if (recorded.empty_body === true) {
    expect(text, `${label}: an empty body`).toBe("");
    return undefined;
  }
  const json = JSON.parse(text) as unknown;
  expect(shape(json), `${label}: shape`).toEqual(shape(recorded.body));
  return json;
}
const serialized = (raw: unknown): string => (raw as { id: { _serialized: string } }).id._serialized;

const LID = "98765432101234@lid";
const PHONE = "628123456789";
const INBOUND_ID = messageFixture.recorded_inbound_message_as_read_back.id;
const inbound = (app: App) =>
  post(app, "/__mock/emit", { event: "message", session: "default", targetUrl: "https://hook.test/waha", payload: { id: INBOUND_ID, from: LID, fromMe: false, body: "Halo, ini pesan uji.", timestamp: 1_760_000_020 } });

describe("waha-mock replays the recorded WEBJS answers", () => {
  it("every fixture says it is RECORDED, carries no PROVISIONAL marker and holds no real number, LID or message key", () => {
    const dir = new URL("../fixtures/", import.meta.url);
    const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    expect(names).toEqual(["contacts.json", "human-like.json", "limits.json", "message-ack.json", "message.json", "send.json", "session-status.json"]);
    // The stable placeholders and the times: nothing else may be a long run of digits.
    const placeholders = /62812345678\d|9876543210123\d|628111111111|300000000000001|100000000000001|3EB0[0-9]{18}|1760000\d{6,9}|179[35]\d{6}/g;
    for (const name of names) {
      const text = readFileSync(new URL(name, dir), "utf8");
      const provenance = (JSON.parse(text) as { _provenance: string })._provenance;
      expect(provenance, name).toMatch(/RECORDED/);
      expect(provenance, name).not.toMatch(/PROVISIONAL/);
      expect(text.replace(placeholders, ""), `${name}: a long digit run`).not.toMatch(/[0-9]{11,}/);
      // A WEBJS message key is "3EB0" and 18 hex digits; the fixtures only hold the placeholder 3EB0 + 18 digits.
      for (const key of text.match(/3EB0[0-9A-F]{18}/g) ?? []) expect(key, `${name}: a real-looking message key`).toMatch(/^3EB0[0-9]{18}$/);
    }
  });

  it("sendText: 201 and the raw WEBJS message (an OBJECT id whose _serialized is the string id, ack 0, no source); the stored message reads back as recorded", async () => {
    const app = make();
    const raw = await expectAnswer(await post(app, "/api/sendText", sendFixture.sendText.request), sendFixture.sendText, "sendText");
    const id = serialized(raw);
    expect(id).toMatch(/^true_98765432101234@lid_[0-9A-F]{22}$/);
    await expectAnswer(await get(app, `/api/default/chats/${LID}/messages/${id}`), sendFixture.sendText.message_by_id_after, "message by id");
  });

  it("sendFile: 201 and the raw message with mediaKey; the message carries the file name and mime type we sent and a null url; filter.fromMe lists it", async () => {
    const app = make();
    const raw = await expectAnswer(await post(app, "/api/sendFile", sendFixture.sendFile.request), sendFixture.sendFile, "sendFile");
    await expectAnswer(await get(app, `/api/default/chats/${LID}/messages/${serialized(raw)}`), sendFixture.sendFile.message_by_id_after, "file message by id");
    const listed = (await (await get(app, `/api/default/chats/${LID}/messages?limit=20&filter.fromMe=true&downloadMedia=false`)).json()) as unknown[];
    expect(listed).toHaveLength(1);
    expect(shape(listed[0])).toEqual(shape(sendFixture.recent_outgoing_filter_fromMe_true[0]));
  });

  it("the parameter is `filter.fromMe`: a bare `fromMe` is IGNORED (recorded), so the buyer's own message is listed too", async () => {
    const app = make();
    await inbound(app);
    await post(app, "/api/sendText", sendFixture.sendText.request);
    const all = (await (await get(app, `/api/default/chats/${LID}/messages?limit=20&fromMe=true`)).json()) as { fromMe: boolean }[];
    const own = (await (await get(app, `/api/default/chats/${LID}/messages?limit=20&filter.fromMe=true`)).json()) as { fromMe: boolean }[];
    expect(all.map((m) => m.fromMe).sort()).toEqual([false, true]);
    expect(own.map((m) => m.fromMe)).toEqual([true]);
  });

  it("a sendFile URL that answers 404 (fetchFiles: \"webjs\"): 201, and the 404 PAGE is the delivered document, as recorded", async () => {
    const page = "<html><body>Not Found</body></html>";
    const app = make({ fetchFiles: "webjs", fetchImpl: () => Promise.resolve(new Response(page, { status: 404 })) });
    const request = { ...sendFixture.sendFile.request, file: { ...sendFixture.sendFile.request.file, filename: "x.pdf" } };
    const raw = await expectAnswer(await post(app, "/api/sendFile", request), sendFixture.sendFile_url_answers_404, "unfetchable URL");
    const message = (await (await get(app, `/api/default/chats/${LID}/messages/${serialized(raw)}`)).json()) as { _data: { size: number; filename: string } };
    expect(message._data.size).toBe(page.length);
    expect(message._data.filename).toBe("x.pdf");
    // The recorded page was not the PDF either: its size differs from the real file's.
    expect(sendFixture.sendFile_url_answers_404.body._data.size).not.toBe(sendFixture.sendFile.body._data.size);
  });

  it("an empty text is NOT refused by WAHA (recorded: it sends an empty message); the mock still refuses it with 422 and the adapter refuses it before the call", async () => {
    const app = make();
    expect(sendFixture.errors.text_missing_sends_an_empty_message.http_status).toBe(201);
    expect((await post(app, "/api/sendText", { session: "default", chatId: LID })).status).toBe(422);
  });

  it("check-exists: a contact on a @lid is {numberExists, chatId} WITHOUT pn; a number that is not on WhatsApp is {numberExists: false}", async () => {
    const app = make();
    await post(app, "/__mock/contacts", { phone: PHONE, chatId: LID });
    await expectAnswer(await get(app, `/api/contacts/check-exists?phone=${PHONE}&session=default`), contactsFixture.check_exists.registered_lid_contact, "registered");
    await post(app, "/__mock/contacts", { phone: "628123456780", numberExists: false });
    await expectAnswer(await get(app, "/api/contacts/check-exists?phone=628123456780&session=default"), contactsFixture.check_exists.not_on_whatsapp, "not on WhatsApp");
  });

  it("lids: by lid and by phone answer {lid, pn}; an UNKNOWN lid is 200 {lid, pn: null}, never a 404", async () => {
    const app = make();
    await post(app, "/__mock/lids", { lid: LID, pn: `${PHONE}@c.us` });
    const byLid = await expectAnswer(await get(app, `/api/default/lids/${LID}`), contactsFixture.lids.by_lid, "by lid");
    expect(byLid).toEqual(contactsFixture.lids.by_lid.body);
    const byPhone = await expectAnswer(await get(app, `/api/default/lids/pn/${PHONE}@c.us`), contactsFixture.lids.by_phone, "by phone");
    expect(byPhone).toEqual(contactsFixture.lids.by_phone.body);
    const unknown = await expectAnswer(await get(app, "/api/default/lids/100000000000001@lid"), contactsFixture.lids.unknown_lid, "unknown lid");
    expect(unknown).toEqual(contactsFixture.lids.unknown_lid.body);
  });

  it("a message is found by its id through ANY chat id (the chat in the path is ignored), and an unknown id is 404 with WAHA's body", async () => {
    const app = make();
    await inbound(app);
    const recorded = messageFixture.recorded_inbound_message_as_read_back;
    for (const chat of [LID, `${PHONE}@c.us`, "100000000000001@lid"]) {
      const read = await expectAnswer(await get(app, `/api/default/chats/${chat}/messages/${INBOUND_ID}`), contactsFixture.message_by_id.through_the_lid_chat, `through ${chat}`);
      expect(read).toMatchObject({ id: INBOUND_ID, from: LID, to: recorded.to, fromMe: false, source: "app", ack: 0, ackName: "PENDING", body: recorded.body });
    }
    await expectAnswer(await get(app, `/api/default/chats/${LID}/messages/false_${LID}_3EB0000000000000000999`), contactsFixture.message_by_id.unknown_id, "unknown id");
  });

  it("the inbound message as the instance stored it: from the @lid, to our @c.us, source app, ack 0 PENDING, a few KB (far under any webhook body limit)", () => {
    const recorded = messageFixture.recorded_inbound_message_as_read_back;
    expect(recorded).toMatchObject({ fromMe: false, source: "app", ack: 0, ackName: "PENDING", hasMedia: false });
    expect(recorded.from.endsWith("@lid")).toBe(true);
    expect(recorded.to.endsWith("@c.us")).toBe(true);
    expect(recorded.whole_message_bytes).toBeLessThan(8 * 1024);
    expect(messageFixture.inbound_lid).toMatchObject({ engine: "WEBJS", event: "message" });
  });

  it("the human-like calls answer as recorded: seen, typing, presence (201 with no body), a value WEBJS does not support (501), typing without a chat (400)", async () => {
    const app = make();
    await expectAnswer(await post(app, "/api/sendSeen", { session: "default", chatId: LID, messageIds: [`false_${LID}_3EB0000000000000000001`] }), humanFixture.sendSeen_with_messageIds, "sendSeen with ids");
    await expectAnswer(await post(app, "/api/sendSeen", { session: "default", chatId: LID }), humanFixture.sendSeen_without_messageIds, "sendSeen without ids");
    await expectAnswer(await post(app, "/api/startTyping", { session: "default", chatId: LID }), humanFixture.startTyping, "startTyping");
    await expectAnswer(await post(app, "/api/stopTyping", { session: "default", chatId: LID }), humanFixture.stopTyping, "stopTyping");
    await expectAnswer(await post(app, "/api/default/presence", { chatId: LID, presence: "typing" }), humanFixture.presence_typing, "presence typing");
    await expectAnswer(await post(app, "/api/default/presence", { chatId: LID, presence: "paused" }), humanFixture.presence_paused, "presence paused");
    await expectAnswer(await post(app, "/api/default/presence", { chatId: LID, presence: "recording" }), humanFixture.presence_recording, "presence recording");
    await expectAnswer(await post(app, "/api/default/presence", { presence: "offline" }), humanFixture.presence_offline, "presence offline");
    await expectAnswer(await post(app, "/api/default/presence", { chatId: LID, presence: "bogus" }), humanFixture.presence_unsupported_value, "presence bogus");
    await expectAnswer(await post(app, "/api/default/presence", { presence: "typing" }), humanFixture.presence_typing_without_chat, "typing without a chat");
    expect((await post(app, "/api/sendSeen", { session: "default" })).status).toBe(humanFixture.sendSeen_without_chat.http_status);
    expect((await get(app, "/api/default/presence")).status).toBe(humanFixture.get_presence_all.http_status);
  });

  it("the session, its timelock and its capping answer as recorded (an account with no restriction)", async () => {
    const app = make();
    await expectAnswer(await get(app, "/api/sessions/default"), { http_status: 200, body: sessionFixture.session }, "session");
    await expectAnswer(await get(app, "/api/sessions/default/timelock"), limitsFixture.timelock, "timelock");
    await expectAnswer(await get(app, "/api/sessions/default/capping"), limitsFixture.capping, "capping");
    expect(limitsFixture.timelock.body).toMatchObject({ enforcementType: "DEFAULT", isActive: false, timeEnforcementEnds: null });
    expect(limitsFixture.capping.body).toMatchObject({ cappingStatus: "NONE", totalQuota: -1, usedQuota: 0 });
    // The session statuses of the instance's OpenAPI: the two passkey states are not WORKING either.
    expect(sessionFixture.statuses).toContain("PASSKEY_REQUIRED");
    expect(sessionFixture.statuses.filter((s) => s === "WORKING")).toHaveLength(1);
  });
});
