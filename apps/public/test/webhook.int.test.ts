// US-021 criterion 1: the Midtrans notification route (lib/webhooks/midtrans.ts) against PostgreSQL as
// the public_rw login, Valkey as the ACL user `public`, and infra/midtrans-stub, whose notification
// injector posts signed (or forged) notifications straight into the handler.
import { createSecretOpener, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { throttleBucket } from "@ebooktrivia/edge";
import { createMidtransStubApp } from "@ebooktrivia/midtrans-stub/src/app.ts";
import { midtransSignature } from "@ebooktrivia/midtrans-stub/src/signature.ts";
import { randomBytes } from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { throttleBucket48 } from "@ebooktrivia/edge";
import { createMidtransKeyCache } from "../src/lib/checkout/data.ts";
import { createPublicSql } from "../src/lib/db.ts";
import { handleMidtransNotification, type MidtransWebhookDeps, WEBHOOK_IP_CAP, WEBHOOK_IP48_CAP } from "../src/lib/webhooks/midtrans.ts";
import { captureLog, DOMAIN, freshIp, newValkey, opener, publicSql, root, valkey } from "./support.ts";

const SERVER_KEY = inject("midtransServerKey");
const stubAuth = `Basic ${Buffer.from(`${SERVER_KEY}:`).toString("base64")}`;
const URL_ = `https://api.${DOMAIN}/api/v1/webhooks/midtrans`;

function deps(overrides: Partial<MidtransWebhookDeps> = {}): MidtransWebhookDeps & { readonly lines: string[] } {
  const logs = captureLog();
  return { sql: publicSql, valkey, opener, serverKey: createMidtransKeyCache(), log: logs.log, lines: logs.lines, ...overrides };
}

/** The stub, whose injector delivers to the handler from one client IP. */
function stubFor(d: MidtransWebhookDeps, ip = freshIp()) {
  return createMidtransStubApp({
    serverKey: SERVER_KEY,
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-for", ip);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return handleMidtransNotification(d, new Request(url, { method: "POST", headers, body: init?.body ?? null }));
    },
  });
}

const midtransId = (): string => `${randomBytes(11).toString("hex")}-1`;
type Stub = ReturnType<typeof stubFor>;
const control = (stub: Stub, path: string, body: unknown) =>
  stub.request(path, { method: "POST", headers: { authorization: stubAuth, "content-type": "application/json" }, body: JSON.stringify(body) });

async function transaction(stub: Stub, orderId = midtransId()): Promise<string> {
  const created = await control(stub, "/snap/v1/transactions", { transaction_details: { order_id: orderId, gross_amount: 49_000 } });
  expect(created.status).toBe(201);
  return orderId;
}

async function notify(stub: Stub, orderId: string, forge = false): Promise<number> {
  const res = await control(stub, "/__stub/notify", { order_id: orderId, targetUrl: URL_, forge });
  return ((await res.json()) as { targetStatus: number }).targetStatus;
}

const inbox = (orderId: string) =>
  root<{ id: string; transaction_status: string; status_code: string; signature: string; raw: Record<string, unknown>; outbox_id: string | null }[]>`
    SELECT id, transaction_status, status_code, signature, raw, outbox_id FROM payment_notifications WHERE midtrans_order_id = ${orderId} ORDER BY received_at`;
const outboxOf = (inboxIds: readonly string[]) =>
  root<{ id: string; topic: string; payload: Record<string, unknown> }[]>`
    SELECT id, topic, payload FROM outbox WHERE dedupe_key = ANY (${inboxIds.map((id) => `payment.notification:${id}`)})`;

/** A body signed with the stub's key, as Midtrans would send it. */
function signedBody(orderId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const statusCode = "200";
  const gross = "49000.00";
  return { order_id: orderId, status_code: statusCode, gross_amount: gross, transaction_status: "settlement", signature_key: midtransSignature(orderId, statusCode, gross, SERVER_KEY), ...overrides };
}

const post = (body: unknown, options: { ip?: string; contentType?: string; origin?: string } = {}): Request =>
  new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-forwarded-for": options.ip ?? freshIp(),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("forged notifications (AC-S6)", () => {
  it("answers 401 to a forged signature, stores nothing and logs no PII", async () => {
    const d = deps();
    const stub = stubFor(d);
    const orderId = await transaction(stub);
    expect(await notify(stub, orderId, true)).toBe(401);
    expect(await inbox(orderId)).toEqual([]);
    const refused = d.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["event"] === "webhook.midtrans.refused");
    expect(refused).toEqual([expect.objectContaining({ level: "warn", reason: "bad_signature", route: "webhook_midtrans" })]);
    expect(d.lines.join("\n")).not.toContain(orderId);
    expect(d.lines.join("\n")).not.toContain(SERVER_KEY);
  });

  it("P1-1: answers 401 to a signature that aliases a hex digit (U+0239 for 9), before any Valkey or database work", async () => {
    const orderId = midtransId();
    const body = signedBody(orderId);
    const alias = String(body["signature_key"]).replace(/9/, "\u0239");
    expect(alias).not.toBe(body["signature_key"]);
    const d = deps();
    expect((await handleMidtransNotification(d, post({ ...body, signature_key: alias }))).status).toBe(401);
    expect(d.lines.some((l) => l.includes('"reason":"bad_signature"'))).toBe(true);
    // Neither Valkey nor PostgreSQL is reachable here, and the answer is still 401, not 503 / 500.
    const offline = deps({ valkey: await newValkey(1), sql: createPublicSql("postgres://nobody:nothing@127.0.0.1:1/none", 1) });
    for (const signature of [alias, "z".repeat(128), "abc"]) {
      expect((await handleMidtransNotification(offline, post({ ...body, signature_key: signature }))).status).toBe(401);
    }
    await offline.sql.end({ timeout: 1 });
    expect(await inbox(orderId)).toEqual([]);
    // The canonical form is stored: an upper-case signature is the same row as the lower-case one.
    const upper = { ...body, signature_key: String(body["signature_key"]).toUpperCase() };
    expect((await handleMidtransNotification(deps(), post(upper))).status).toBe(200);
    expect((await handleMidtransNotification(deps(), post(body))).status).toBe(200);
    expect((await inbox(orderId)).map((r) => r.signature)).toEqual([String(body["signature_key"]).toLowerCase()]);
  });

  it("answers 401 to a signature made with another key, or over another amount", async () => {
    const orderId = midtransId();
    const other = signedBody(orderId, { signature_key: midtransSignature(orderId, "200", "49000.00", "SB-Mid-server-OTHER") });
    expect((await handleMidtransNotification(deps(), post(other))).status).toBe(401);
    expect((await handleMidtransNotification(deps(), post(signedBody(orderId, { gross_amount: "1.00" })))).status).toBe(401);
    expect(await inbox(orderId)).toEqual([]);
  });
});

describe("the inbox (AC-S7)", () => {
  it("stores a signed notification once and enqueues it once: 5 deliveries answer 200 each", async () => {
    const d = deps();
    const stub = stubFor(d);
    const orderId = await transaction(stub);
    await control(stub, `/__stub/transactions/${orderId}/state`, { transaction_status: "settlement" });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await notify(stub, orderId));
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    const rows = await inbox(orderId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ transaction_status: "settlement", status_code: "200" });
    expect(row?.signature).toMatch(/^[0-9a-f]{128}$/);
    const queued = await outboxOf(rows.map((r) => r.id));
    expect(queued).toEqual([{ id: row?.outbox_id, topic: "payment.notification", payload: { inbox_id: row?.id, midtrans_order_id: orderId } }]);
    const stored = d.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["event"] === "webhook.midtrans.stored");
    expect(stored.map((l) => l["outcome"])).toEqual(["new", "duplicate", "duplicate", "duplicate", "duplicate"]);
  });

  it("five identical notifications at once still make one inbox row and one outbox row", async () => {
    const orderId = midtransId();
    const body = signedBody(orderId);
    const answers = await Promise.all(Array.from({ length: 5 }, () => handleMidtransNotification(deps(), post(body))));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await inbox(orderId);
    expect(rows).toHaveLength(1);
    expect(await outboxOf(rows.map((r) => r.id))).toHaveLength(1);
  });

  it("a new status of the same transaction is a new inbox row (each one is re-queried)", async () => {
    const d = deps();
    const stub = stubFor(d);
    const orderId = await transaction(stub);
    expect(await notify(stub, orderId)).toBe(200);
    await control(stub, `/__stub/transactions/${orderId}/state`, { transaction_status: "settlement" });
    expect(await notify(stub, orderId)).toBe(200);
    const rows = await inbox(orderId);
    expect(rows.map((r) => [r.transaction_status, r.status_code])).toEqual([
      ["pending", "201"],
      ["settlement", "200"],
    ]);
    expect(await outboxOf(rows.map((r) => r.id))).toHaveLength(2);
  });

  it("keeps the body untrusted: the unsigned label is normalised and only a whitelisted summary is stored", async () => {
    const orderId = midtransId();
    const body = signedBody(orderId, {
      transaction_status: "settled-for-sure",
      customer_details: { first_name: "Budi", email: "budi@example.test", phone: "+6281234567890" },
      payment_type: "qris",
    });
    expect((await handleMidtransNotification(deps(), post(body))).status).toBe(200);
    // An edited label replayed with the same signature collapses into the same row.
    expect((await handleMidtransNotification(deps(), post({ ...body, transaction_status: "anything-else" }))).status).toBe(200);
    const rows = await inbox(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transaction_status).toBe("unknown");
    expect(rows[0]?.raw).toEqual({ order_id: orderId, status_code: "200", gross_amount: "49000.00", transaction_status: "settled-for-sure", payment_type: "qris" });
  });

  it("acknowledges and drops a signed notification for an order id the worker could not re-query", async () => {
    const odd = "a/b";
    const response = await handleMidtransNotification(deps(), post(signedBody(odd)));
    expect(response.status).toBe(200);
    expect(await inbox(odd)).toEqual([]);
  });
});

describe("bounded, server to server, fail closed", () => {
  it("400 for a non-JSON, oversized or incomplete body", async () => {
    const orderId = midtransId();
    expect((await handleMidtransNotification(deps(), post("{not json"))).status).toBe(400);
    expect((await handleMidtransNotification(deps(), post(signedBody(orderId), { contentType: "text/plain" }))).status).toBe(400);
    expect((await handleMidtransNotification(deps(), post({ ...signedBody(orderId), pad: "x".repeat(17 * 1024) }))).status).toBe(400);
    const unsigned = signedBody(orderId);
    delete unsigned["signature_key"];
    expect((await handleMidtransNotification(deps(), post(unsigned))).status).toBe(400);
    expect(await inbox(orderId)).toEqual([]);
  });

  it("sends no CORS headers, whatever the Origin", async () => {
    const response = await handleMidtransNotification(deps(), post(signedBody(midtransId()), { origin: "https://evil.example.test" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rate-limits per client IP (429), and answers 503 while Valkey is down", async () => {
    const ip = freshIp();
    // The bucket's counter already at the cap (the route counts per IPv6 /64).
    await valkey.set(`rl:webhook:midtrans:ip:${throttleBucket(ip)}`, String(WEBHOOK_IP_CAP), "PX", 60_000);
    const limited = await handleMidtransNotification(deps(), post(signedBody(midtransId()), { ip }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // The IPv6 /48 is counted first (a /48 over its cap never creates a counter for another /64 of it).
    const sibling = freshIp();
    const network = throttleBucket48(sibling);
    if (network === null) throw new Error("expected an IPv6 test address");
    await valkey.set(`rl:webhook:midtrans:ip48:${network}`, String(WEBHOOK_IP48_CAP), "PX", 60_000);
    const d48 = deps();
    expect((await handleMidtransNotification(d48, post(signedBody(midtransId()), { ip: sibling }))).status).toBe(429);
    expect(d48.lines.some((l) => l.includes('"reason":"rate_limited_ip48"'))).toBe(true);

    const down = deps({ valkey: await newValkey(1) });
    const orderId = midtransId();
    expect((await handleMidtransNotification(down, post(signedBody(orderId)))).status).toBe(503);
    expect(await inbox(orderId)).toEqual([]);
  });

  it("503 when the server key cannot be opened (Midtrans retries later)", async () => {
    const stranger = createSecretOpener({ payment: generateScopeKeyPair().privateKey });
    const orderId = midtransId();
    expect((await handleMidtransNotification(deps({ opener: stranger }), post(signedBody(orderId)))).status).toBe(503);
    expect(await inbox(orderId)).toEqual([]);
  });

  it("P2-1: a forged notification costs no database read while the key is cached; a rotated key is opened again", async () => {
    let clock = 0;
    let opened = 0;
    const counting = { ...opener, openSecret: (...args: Parameters<typeof opener.openSecret>) => (opened++, opener.openSecret(...args)) };
    const serverKey = createMidtransKeyCache(60_000, () => clock);
    const orderId = midtransId();
    expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), post(signedBody(orderId)))).status).toBe(200);
    // Within the minute: no database at all for a well-shaped forgery.
    const offline = deps({ serverKey, opener: counting, sql: createPublicSql("postgres://nobody:nothing@127.0.0.1:1/none", 1) });
    const forged = { ...signedBody(midtransId()), signature_key: "f".repeat(128) };
    expect((await handleMidtransNotification(offline, post(forged))).status).toBe(401);
    await offline.sql.end({ timeout: 1 });
    expect(opened).toBe(1);
    // After the minute the version is read again: unchanged, nothing is opened again; rotated, it is.
    clock = 61_000;
    expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), post(forged))).status).toBe(401);
    expect(opened).toBe(1);
    await root`UPDATE settings_secrets SET updated_at = now() WHERE scope = 'payment'`;
    clock = 122_000;
    expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), post(forged))).status).toBe(401);
    expect(opened).toBe(2);
  });

  it("P2-B: a re-encryption that did not bump updated_at is still detected (key_id and nonce are in the version)", async () => {
    let clock = 0;
    let opened = 0;
    const counting = { ...opener, openSecret: (...args: Parameters<typeof opener.openSecret>) => (opened++, opener.openSecret(...args)) };
    const serverKey = createMidtransKeyCache(60_000, () => clock);
    const forged = () => post({ ...signedBody(midtransId()), signature_key: "f".repeat(128) });
    expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), forged())).status).toBe(401);
    expect(opened).toBe(1);
    const secret = (await root<{ id: string; nonce: Uint8Array }[]>`SELECT id, nonce FROM settings_secrets WHERE scope = 'payment'`)[0];
    if (secret === undefined) throw new Error("the sandbox server key is missing");
    // Only the nonce changes, updated_at stays: the cached key must not be used past the minute.
    await root`UPDATE settings_secrets SET nonce = ${randomBytes(12)} WHERE id = ${secret.id}`;
    try {
      clock = 61_000;
      // Opened again; this nonce no longer decrypts it, so 503 (never the stale cached key).
      expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), forged())).status).toBe(503);
      expect(opened).toBe(2);
    } finally {
      await root`UPDATE settings_secrets SET nonce = ${secret.nonce} WHERE id = ${secret.id}`;
    }
    // Restored: the version equals the cached one again (a failed open is never cached), so no new open.
    clock = 122_000;
    expect((await handleMidtransNotification(deps({ serverKey, opener: counting }), forged())).status).toBe(401);
    expect(opened).toBe(2);
  });

  it("503 (not 500) on a real database error: Midtrans retries a 503 four times and a 500 only once; the retry is stored", async () => {
    const orderId = midtransId();
    await root.unsafe("ALTER TABLE payment_notifications ADD CONSTRAINT us021_refuse_all CHECK (false) NOT VALID");
    try {
      const d = deps();
      const refused = await handleMidtransNotification(d, post(signedBody(orderId)));
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ v: 1, error: "unavailable" });
      expect(d.lines.some((l) => l.includes('"reason":"internal"'))).toBe(true);
    } finally {
      await root.unsafe("ALTER TABLE payment_notifications DROP CONSTRAINT us021_refuse_all");
    }
    expect((await handleMidtransNotification(deps(), post(signedBody(orderId)))).status).toBe(200);
    expect(await inbox(orderId)).toHaveLength(1);
  });
});
