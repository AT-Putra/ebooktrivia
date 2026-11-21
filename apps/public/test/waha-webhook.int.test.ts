// US-025 criterion 3 and 5: the WAHA webhook route (lib/webhooks/waha.ts) against PostgreSQL as the public_rw login and Valkey as the ACL
// user `public`, with infra/waha-mock whose emitter posts signed (or forged) events straight into the handler. The webhook is untrusted:
// an invalid HMAC is a 401 before anything is parsed, a duplicate message is stored and queued once, the text is never stored, the
// sender is rate-limited (fail closed), and a verified ack only moves a delivery's ack forward.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webhookHmacSha512 } from "../../../infra/waha-mock/src/hmac.ts";
import { createWahaMockApp } from "../../../infra/waha-mock/src/app.ts";
import { createPublicSql } from "../src/lib/db.ts";
import { handleWahaWebhook, WAHA_BODY_MAX_BYTES, WAHA_SENDER_CAP, type WahaWebhookDeps } from "../src/lib/webhooks/waha.ts";
import { captureLog, freshIp, newValkey, publicSql, root, suffix, valkey } from "./support.ts";

const SECRET = "waha-webhook-secret-for-tests-0123456789";
const URL_ = "https://api.ebooktrivia.example.test/api/v1/webhooks/waha";
const CODE = "7K3M9XQ2PA";

function deps(overrides: Partial<WahaWebhookDeps> = {}): WahaWebhookDeps & { readonly lines: string[] } {
  const logs = captureLog();
  return { sql: publicSql, valkey, hmacSecret: SECRET, log: logs.log, lines: logs.lines, ...overrides };
}


/** The mock emitter, delivering to the handler from one client IP. */
function emitter(d: WahaWebhookDeps, ip = freshIp()) {
  const app = createWahaMockApp({
    apiKey: "k",
    webhookHmacSecret: SECRET,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-for", ip);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return handleWahaWebhook(d, new Request(url, { method: "POST", headers, body: init?.body ?? null }));
    },
  });
  return async (event: string, session: string, payload: Record<string, unknown>): Promise<{ status: number; body: string }> => {
    const res = await app.request("/__mock/emit", { method: "POST", body: JSON.stringify({ event, session, targetUrl: URL_, payload }) });
    const done = (await res.json()) as { targetStatus: number; body: string };
    return { status: done.targetStatus, body: done.body };
  };
}

const chat = (): string => `62812${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}@c.us`;
const messageId = (jid: string): string => `false_${jid}_${randomBytes(6).toString("hex").toUpperCase()}`;
const message = (jid: string, over: Record<string, unknown> = {}) => ({ id: messageId(jid), timestamp: Math.floor(Date.now() / 1000), from: jid, fromMe: false, body: `kode pesanan ${CODE}`, hasMedia: false, ...over });

const inboundOf = (id: string) =>
  root<{ id: string; session_name: string; from_jid: string; body: string | null; raw: Record<string, unknown>; outbox_id: string | null }[]>`
    SELECT id, session_name, from_jid, body, raw, outbox_id FROM waha_inbound WHERE message_id = ${id}`;
const outboxOf = (inboundId: string) => root<{ topic: string; payload: Record<string, unknown> }[]>`SELECT topic, payload FROM outbox WHERE dedupe_key = ${`waha.inbound:${inboundId}`}`;
const count = async (): Promise<number> => (await root<{ n: number }[]>`SELECT count(*)::int AS n FROM waha_inbound`)[0]?.n ?? 0;

/** A body signed as WAHA would (or with `hmac` overridden), posted straight to the handler. */
function post(d: WahaWebhookDeps, rawBody: string, headers: Record<string, string> = {}, signed = true): Promise<Response> {
  return handleWahaWebhook(
    d,
    new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": freshIp(),
        ...(signed ? { "x-webhook-hmac": webhookHmacSha512(rawBody, SECRET), "x-webhook-hmac-algorithm": "sha512" } : {}),
        ...headers,
      },
      body: rawBody,
    }),
  );
}
const eventBody = (event: string, session: string, payload: unknown, timestamp = Date.now()): string => JSON.stringify({ id: `evt_${randomUUID()}`, timestamp, event, session, payload });

describe("an invalid HMAC is a 401, before anything is parsed (AC-D6)", () => {
  it("refuses a missing, a wrong, a truncated and a differently-algorithmed signature, and stores and queues nothing", async () => {
    const d = deps();
    const before = await count();
    const jid = chat();
    const body = eventBody("message", "default", message(jid));
    const good = webhookHmacSha512(body, SECRET);
    const attempts: [string, Record<string, string>, boolean][] = [
      ["no signature", {}, false],
      ["a wrong signature", { "x-webhook-hmac": webhookHmacSha512(body, "another-secret-0123456789"), "x-webhook-hmac-algorithm": "sha512" }, false],
      ["a signature of another body", { "x-webhook-hmac": webhookHmacSha512(`${body} `, SECRET), "x-webhook-hmac-algorithm": "sha512" }, false],
      ["a truncated signature", { "x-webhook-hmac": good.slice(0, 64), "x-webhook-hmac-algorithm": "sha512" }, false],
      ["a signature with junk", { "x-webhook-hmac": `${good}00`, "x-webhook-hmac-algorithm": "sha512" }, false],
      ["the right bytes under sha256", { "x-webhook-hmac": good, "x-webhook-hmac-algorithm": "sha256" }, false],
    ];
    for (const [name, headers, signed] of attempts) {
      const res = await post(d, body, headers, signed);
      expect(res.status, name).toBe(401);
      expect(await res.json(), name).toEqual({ v: 1, error: "signature" });
    }
    // The body is not even parsed: junk under a bad signature is a 401, not a 400.
    expect((await post(d, "{not json", {}, false)).status).toBe(401);
    expect(await count()).toBe(before);
    expect(d.lines.filter((l) => l.includes('"reason":"bad_hmac"'))).toHaveLength(attempts.length + 1);
    expect(d.lines.join("\n")).not.toContain(jid);
    expect(d.lines.join("\n")).not.toContain(SECRET);
    expect(d.lines.join("\n")).not.toContain(CODE);
  });

  it("is closed (503) while the secret is not configured, and bounds the body (413) before verifying it", async () => {
    const body = eventBody("message", "default", message(chat()));
    expect((await post(deps({ hmacSecret: undefined }), body)).status).toBe(503);
    const d = deps();
    const big = "x".repeat(WAHA_BODY_MAX_BYTES + 1);
    expect((await post(d, big)).status).toBe(413);
    const declared = await handleWahaWebhook(d, new Request(URL_, { method: "POST", headers: { "content-length": String(WAHA_BODY_MAX_BYTES + 1), "content-type": "application/json" }, body }));
    expect(declared.status).toBe(413);
    const empty = await handleWahaWebhook(d, new Request(URL_, { method: "POST" }));
    expect(empty.status).toBe(413);
  });

  it("a signed body that is not JSON is a 400", async () => {
    const d = deps();
    expect((await post(d, "{not json")).status).toBe(400);
    expect((await post(d, "\xff\xfe")).status).toBe(400);
  });
});

describe("a verified message is stored and queued once, without its text (criterion 3)", () => {
  it("stores the hint, queues enqueue_waha_inbound once, and a duplicate message id is acknowledged and handled once", async () => {
    const d = deps();
    const emit = emitter(d);
    const session = `s${suffix()}`;
    const jid = chat();
    const payload = message(jid);
    const first = await emit("message", session, payload);
    expect(first.status).toBe(200);
    const [row] = await inboundOf(payload.id);
    expect(row).toMatchObject({ session_name: session, from_jid: jid, body: null });
    // The summary holds no text and no number beyond the chat id column.
    expect(row?.raw).toEqual({ v: 1, timestamp: payload.timestamp, hasMedia: false });
    const queued = await outboxOf(row?.id ?? "");
    expect(queued).toEqual([{ topic: "waha.inbound", payload: { inbound_id: row?.id, message_id: payload.id } }]);
    // The same message again (WAHA retries): 200, still one row and one outbox row.
    expect((await emit("message", session, payload)).status).toBe(200);
    expect((await emit("message", session, payload)).status).toBe(200);
    expect(await inboundOf(payload.id)).toHaveLength(1);
    expect(await outboxOf(row?.id ?? "")).toHaveLength(1);
    expect(d.lines.filter((l) => l.includes('"outcome":"new"'))).toHaveLength(1);
    expect(d.lines.filter((l) => l.includes('"outcome":"duplicate"'))).toHaveLength(2);
    // No phone, chat id, text or order code reaches a log line.
    expect(d.lines.join("\n")).not.toContain(jid);
    expect(d.lines.join("\n")).not.toContain(CODE);
  });

  it("drops what cannot be a buyer asking: no order code, a group, a broadcast, our own message, session status, a stale or undated event", async () => {
    const d = deps();
    const emit = emitter(d);
    const before = await count();
    const jid = chat();
    expect((await emit("message", "default", message(jid, { body: "halo, ebooknya mana?" }))).status).toBe(200);
    expect((await emit("message", "default", message("120363025246125486@g.us", { id: "false_120363025246125486@g.us_AAAA1111" }))).status).toBe(200);
    expect((await emit("message", "default", message(jid, { fromMe: true }))).status).toBe(200);
    expect((await emit("session.status", "default", { name: "default", status: "FAILED" })).status).toBe(200);
    const old = await post(d, eventBody("message", "default", message(jid), Date.now() - 2 * 3_600_000));
    expect(old.status).toBe(200);
    const future = await post(d, eventBody("message", "default", message(jid), Date.now() + 3_600_000));
    expect(future.status).toBe(200);
    const undated = await post(d, JSON.stringify({ event: "message", session: "default", payload: message(jid) }));
    expect(undated.status).toBe(200);
    expect(await count()).toBe(before);
    expect(d.lines.some((l) => l.includes('"reason":"outside_replay_window"'))).toBe(true);
    expect(d.lines.some((l) => l.includes('"reason":"no_order_code"'))).toBe(true);
  });

  it("keeps an @lid sender's message (the worker resolves it) and rate-limits each sender, fail closed", async () => {
    const d = deps();
    const emit = emitter(d);
    const lid = `${String(Math.floor(10_000_000_000 + Math.random() * 8_999_999_999))}@lid`;
    expect((await emit("message", "default", message(lid))).status).toBe(200);
    expect((await root`SELECT 1 FROM waha_inbound WHERE from_jid = ${lid}`).length).toBe(1);

    const spammer = chat();
    for (let i = 0; i < WAHA_SENDER_CAP + 5; i++) expect((await emit("message", "default", message(spammer))).status).toBe(200);
    // The first WAHA_SENDER_CAP were kept, the rest dropped (200: WAHA must not retry them).
    expect((await root`SELECT 1 FROM waha_inbound WHERE from_jid = ${spammer}`).length).toBe(WAHA_SENDER_CAP);
    expect(d.lines.filter((l) => l.includes('"reason":"rate_limited_sender"'))).toHaveLength(5);
    // Another sender is not affected.
    const other = chat();
    expect((await emit("message", "default", message(other))).status).toBe(200);
    expect((await root`SELECT 1 FROM waha_inbound WHERE from_jid = ${other}`).length).toBe(1);

    // Valkey down: nothing can be rate-limited, so nothing is taken (503: WAHA retries later).
    const down = deps({ valkey: await newValkey(1) });
    const before = await count();
    const refused = await post(down, eventBody("message", "default", message(chat())));
    expect(refused.status).toBe(503);
    expect(await count()).toBe(before);
    expect(down.lines.some((l) => l.includes('"reason":"valkey_unavailable"'))).toBe(true);
  });

  it("answers 500 when the database fails, so WAHA delivers the message again", async () => {
    const d = deps({ sql: createPublicSql("postgres://nobody:nothing@127.0.0.1:1/none", 1) });
    const res = await post(d, eventBody("message", "default", message(chat())));
    expect(res.status).toBe(500);
    expect(d.lines.some((l) => l.includes('"reason":"internal"'))).toBe(true);
  });
});

describe("delivery acks (AC-D6)", () => {
  async function sentDelivery(): Promise<{ deliveryId: string; messageId: string }> {
    const product = (await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`)[0]?.id ?? "";
    const program = (await root<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product}, ${`ack-${suffix()}`}, 'P', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`)[0]?.id ?? "";
    const lp = (await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program}) RETURNING id`)[0]?.id ?? "";
    const order = (await root<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
      VALUES (${randomBytes(11).toString("hex")}, ${randomBytes(5).toString("hex").toUpperCase().replace(/[AEIOU]/g, "7")}, ${lp}, ${program}, ${product}, 'B', '+6281234567890', 'b@example.test', ${randomBytes(32)}, 49000, 'pending', now() + interval '1 hour')
      RETURNING id`)[0]?.id ?? "";
    await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order}`;
    const msg = `true_6281234567890@c.us_${randomBytes(6).toString("hex").toUpperCase()}`;
    const delivery = (await root<{ id: string }[]>`INSERT INTO deliveries (order_id, channel, status, wa_message_id) VALUES (${order}, 'whatsapp', 'sent', ${msg}) RETURNING id`)[0]?.id ?? "";
    return { deliveryId: delivery, messageId: msg };
  }
  const ackOf = async (id: string) => (await root<{ wa_ack: string | null }[]>`SELECT wa_ack FROM deliveries WHERE id = ${id}`)[0]?.wa_ack;

  it("moves a delivery's ack forward from a verified webhook only, never backwards, and an invalid HMAC changes nothing", async () => {
    const d = deps();
    const emit = emitter(d);
    const { deliveryId, messageId: id } = await sentDelivery();
    const ack = (n: number) => emit("message.ack", "default", { id, from: "6281234567890@c.us", fromMe: true, ack: n });
    expect((await ack(1)).status).toBe(200);
    expect(await ackOf(deliveryId)).toBe("sent");
    expect((await ack(3)).status).toBe(200);
    expect(await ackOf(deliveryId)).toBe("read");
    expect((await ack(2)).status).toBe(200);
    expect(await ackOf(deliveryId)).toBe("read");
    // A forged ack (no valid HMAC) is a 401 and moves nothing.
    const { deliveryId: other, messageId: otherId } = await sentDelivery();
    const forged = eventBody("message.ack", "default", { id: otherId, fromMe: true, ack: 3 });
    expect((await post(d, forged, { "x-webhook-hmac": "ab".repeat(64) }, false)).status).toBe(401);
    expect(await ackOf(other)).toBeNull();
    // An ack for a message we never sent is acknowledged and changes nothing.
    expect((await emit("message.ack", "default", { id: "true_628000000000@c.us_NOSUCH", fromMe: true, ack: 3 })).status).toBe(200);
    expect(d.lines.some((l) => l.includes('"outcome":"unchanged"'))).toBe(true);
  });
});

describe("WhatsApp's limits on a number, and replies to our opener (US-025: first-contact delivery, Owner decision D7)", () => {
  async function numberOf(name: string): Promise<string> {
    const server = (await root<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W${suffix()}`}, 'https://waha.invalid/', 'waha.invalid') RETURNING id`)[0]?.id ?? "";
    return (await root<{ id: string }[]>`INSERT INTO waha_sessions (server_id, session_name) VALUES (${server}, ${name}) RETURNING id`)[0]?.id ?? "";
  }
  const stateOf = async (id: string) =>
    (await root<{ timelock_active: boolean; capping_status: string | null; warning_level: string; reachout_until: Date | null }[]>`
      SELECT timelock_active, capping_status, warning_level, reachout_until FROM waha_sessions WHERE id = ${id}`)[0];
  const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;

  it("records the timelock and capping a verified session.status event carries on the number; an event without them, or an unsigned one, changes nothing", async () => {
    const d = deps();
    const emit = emitter(d);
    const name = `lim${suffix()}`;
    const id = await numberOf(name);
    expect(await stateOf(id)).toMatchObject({ timelock_active: false, capping_status: null, warning_level: "none", reachout_until: null });
    const status = (data: Record<string, unknown>) => emit("session.status", name, { name, status: "WORKING", data });
    expect((await status({})).status).toBe(200);
    expect((await stateOf(id))?.reachout_until).toBeNull();
    expect((await status({ reachoutTimelock: { isActive: true, enforcementType: "DEFAULT", timeEnforcementEnds: inSeconds(7200) }, messageCapping: { cappingStatus: "FIRST_WARNING", totalQuota: 100, usedQuota: 80, cycleEnd: inSeconds(86_400) } })).status).toBe(200);
    const held = await stateOf(id);
    expect(held).toMatchObject({ timelock_active: true, capping_status: "FIRST_WARNING", warning_level: "first" });
    expect(Math.abs((held?.reachout_until?.getTime() ?? 0) - (Date.now() + 7_200_000))).toBeLessThan(60_000);
    expect(d.lines.some((l) => l.includes('"event":"webhook.waha.session_state"') && l.includes('"outcome":"recorded"'))).toBe(true);
    // A forged event (no valid HMAC) is a 401 and moves nothing; neither does a stale one, nor a name that belongs to no session.
    const forged = eventBody("session.status", name, { name, status: "WORKING", data: { messageCapping: { cappingStatus: "CAPPED", cycleEnd: inSeconds(86_400 * 5) } } });
    expect((await post(d, forged, { "x-webhook-hmac": "ab".repeat(64) }, false)).status).toBe(401);
    const old = await post(d, eventBody("session.status", name, { name, status: "WORKING", data: { messageCapping: { cappingStatus: "CAPPED" } } }, Date.now() - 2 * 3_600_000));
    expect(old.status).toBe(200);
    expect((await emit("session.status", "nobody-here", { name: "nobody-here", status: "WORKING", data: { messageCapping: { cappingStatus: "CAPPED" } } })).status).toBe(200);
    expect(await stateOf(id)).toMatchObject({ capping_status: "FIRST_WARNING", warning_level: "first" });
    // The state ends as WAHA reports it (the worker's poll reads it again; a block only ever extends until its own end).
    expect((await status({ reachoutTimelock: { isActive: false }, messageCapping: { cappingStatus: "NONE" } })).status).toBe(200);
    expect(await stateOf(id)).toMatchObject({ timelock_active: false, capping_status: "NONE", warning_level: "none" });
  });

  it("is rate limited with the other events (global, fail closed)", async () => {
    const down = deps({ valkey: await newValkey(1) });
    const name = `lim${suffix()}`;
    await numberOf(name);
    const res = await post(down, eventBody("session.status", name, { name, status: "WORKING", data: { messageCapping: { cappingStatus: "CAPPED" } } }));
    expect(res.status).toBe(503);
  });

  it("keeps a code-less message that answers our opener (the buyer was asked to reply), and still drops every other chatter", async () => {
    const d = deps();
    const emit = emitter(d);
    const name = `rep${suffix()}`;
    const sessionId = await numberOf(name);
    const phone = `+62812${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
    const jid = `${phone.slice(1)}@c.us`;
    const product = (await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`)[0]?.id ?? "";
    const program = (await root<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product}, ${`rep-${suffix()}`}, 'P', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`)[0]?.id ?? "";
    const lp = (await root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program}) RETURNING id`)[0]?.id ?? "";
    const order = (await root<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, status, expires_at)
      VALUES (${randomBytes(11).toString("hex")}, ${randomBytes(5).toString("hex").toUpperCase().replace(/[AEIOU]/g, "7")}, ${lp}, ${program}, ${product}, 'B', ${phone}, 'b@example.test', ${randomBytes(32)}, 49000, 'pending', now() + interval '1 hour')
      RETURNING id`)[0]?.id ?? "";
    await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order}`;
    const delivery = (await root<{ id: string }[]>`INSERT INTO deliveries (order_id, channel) VALUES (${order}, 'whatsapp') RETURNING id`)[0]?.id ?? "";
    const before = await count();
    // No opener yet: "ok" from this phone is chatter and is dropped (as before).
    expect((await emit("message", name, message(jid, { body: "ok" }))).status).toBe(200);
    expect(await count()).toBe(before);
    await root`INSERT INTO delivery_openers (delivery_id, status, session_id, sent_at) VALUES (${delivery}, 'sent', ${sessionId}, now())`;
    const reply = message(jid, { body: "ok kak, kirim ya" });
    expect((await emit("message", name, reply)).status).toBe(200);
    expect(await count()).toBe(before + 1);
    const [stored] = await inboundOf(reply.id);
    expect(stored).toMatchObject({ session_name: name, from_jid: jid, body: null });
    expect(await outboxOf(stored?.id ?? "")).toHaveLength(1);
    // Another phone's "ok", on the same number, is still chatter.
    expect((await emit("message", name, message(chat(), { body: "ok" }))).status).toBe(200);
    expect(await count()).toBe(before + 1);
  });

  it("applies the per-sender rate limit BEFORE any database query: a sender over its limit costs Valkey only, not even waha_reply_expected", async () => {
    // Every query of the handler goes through this counter.
    let queries = 0;
    const counting = new Proxy(publicSql, {
      apply(target, thisArg, args: unknown[]) {
        queries++;
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
    const d = deps({ sql: counting });
    const emit = emitter(d);
    const jid = chat();
    // The first WAHA_SENDER_CAP messages (code-less chatter) are within the limit: each is judged (one query for waha_reply_expected) and dropped.
    for (let i = 0; i < WAHA_SENDER_CAP; i++) expect((await emit("message", "default", message(jid, { body: "halo" }))).status).toBe(200);
    expect(queries).toBe(WAHA_SENDER_CAP);
    // Over the limit: dropped with no query at all.
    const before = queries;
    for (let i = 0; i < 5; i++) expect((await emit("message", "default", message(jid, { body: "halo lagi" }))).status).toBe(200);
    expect(queries).toBe(before);
    expect(d.lines.filter((l) => l.includes('"reason":"rate_limited_sender"'))).toHaveLength(5);
  });
});
