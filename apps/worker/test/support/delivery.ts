// Delivery fixtures (US-025): a shop whose product has a real PDF on disk, paid orders with their two deliveries, WAHA sessions, an
// in-process WAHA (infra/waha-mock behind a fetch that can fail per session, like a killed session or a timeout after the send), a
// recording mail sender, a fake magic-link issuer and the config the consumers take. Rows are inserted as the superuser (bypasses grants,
// not triggers); the code under test connects as the worker_rw login.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWahaClient, type HttpFetch, SafeFetchError } from "@ebooktrivia/adapters";
import { createWahaMockApp } from "../../../../infra/waha-mock/src/app.ts";
import type { MagicLinkChannel } from "@ebooktrivia/core";
import type { DeliveryConfig } from "../../src/delivery/config.ts";
import { testFiles } from "./files.ts";
import { type EbookFiles, type MagicLinks, MagicLinkUnavailable, type MailSender, type OutgoingMail, type WahaAccess, WahaAccessError } from "../../src/delivery/ports.ts";
import { first, sql, suffix } from "./db.ts";
import { createOrder, createShop, type Shop, uniquePhone } from "./midtrans.ts";

export const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(2048), Buffer.from("\n%%EOF\n")]);

export interface DeliveryShop extends Shop {
  readonly dataDir: string;
  readonly storagePath: string;
  readonly title: string;
  cleanup(): Promise<void>;
}

/** A shop whose product has an uploaded PDF (a real file under a temp data dir, `deliverables/<id>.pdf`). */
export async function createDeliveryShop(options: { readonly pdf?: Buffer | null } = {}): Promise<DeliveryShop> {
  const shop = await createShop();
  const dataDir = await mkdtemp(join(tmpdir(), "ebt-delivery-"));
  const bytes = options.pdf === undefined ? PDF_BYTES : options.pdf;
  const uploadId = randomUUID();
  const storagePath = `deliverables/${uploadId}.pdf`;
  if (bytes !== null) {
    await mkdir(join(dataDir, "deliverables"), { recursive: true });
    await writeFile(join(dataDir, storagePath), bytes);
    await sql`
      INSERT INTO uploads (id, kind, storage_path, original_filename, content_type, size_bytes, sha256)
      VALUES (${uploadId}, 'pdf', ${storagePath}, 'ebook.pdf', 'application/pdf', ${bytes.length}, ${randomBytes(32)})`;
    await sql`UPDATE products SET pdf_upload_id = ${uploadId} WHERE id = ${shop.productId}`;
  }
  const [product] = await sql<{ title: string }[]>`SELECT title FROM products WHERE id = ${shop.productId}`;
  return { ...shop, dataDir, storagePath, title: product?.title ?? "", cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

export interface PaidOrder {
  readonly orderId: string;
  readonly code: string;
  readonly phone: string;
  readonly email: string;
  readonly name: string;
  readonly playerId: string;
  readonly deliveries: { readonly email: string; readonly whatsapp: string };
  readonly chatId: string;
}

/** A paid order of the shop with its player and its two deliveries, both due now (the WhatsApp delay is not under test). */
export async function paidOrder(shop: Shop, options: { readonly phone?: string; readonly name?: string; readonly waNotBefore?: Date } = {}): Promise<PaidOrder> {
  const phone = options.phone ?? uniquePhone();
  const name = options.name ?? "Budi Santoso";
  const email = `budi-${suffix()}${suffix()}@example.test`;
  const order = await createOrder(shop, { phone, attributed: false });
  await sql`UPDATE orders SET buyer_name = ${name}, buyer_email = ${email} WHERE id = ${order.id}`;
  await sql`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order.id}`;
  const player = first(
    await sql<{ id: string }[]>`
      INSERT INTO players (phone, name, email) VALUES (${phone}, ${name}, ${email}) ON CONFLICT (phone) DO UPDATE SET updated_at = now() RETURNING id`,
  );
  await sql`UPDATE orders SET player_id = ${player.id} WHERE id = ${order.id}`;
  // What payments does for a paid order: the player is eligible for the program (issue_magic_link refuses a player who is not).
  await sql`
    INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${player.id}, ${shop.programId}, now(), true)
    ON CONFLICT (player_id, program_id) DO NOTHING`;
  const rows = await sql<{ id: string; channel: string }[]>`
    INSERT INTO deliveries (order_id, channel, not_before)
    VALUES (${order.id}, 'email', now() - interval '1 second'), (${order.id}, 'whatsapp', ${options.waNotBefore ?? new Date(Date.now() - 1000)})
    RETURNING id, channel`;
  const idOf = (channel: string): string => first(rows.filter((r) => r.channel === channel)).id;
  const { order_code: code } = first(await sql<{ order_code: string }[]>`SELECT order_code FROM orders WHERE id = ${order.id}`);
  return { orderId: order.id, code, phone, email, name, playerId: player.id, deliveries: { email: idOf("email"), whatsapp: idOf("whatsapp") }, chatId: `${phone.slice(1)}@c.us` };
}

/** An order that is not paid (any status the orders table allows, `pending` by default), with no deliveries: what its buyer may ask about in a chat. */
export async function unpaidOrder(shop: Shop, status = "pending"): Promise<Pick<PaidOrder, "orderId" | "code" | "phone" | "chatId">> {
  const phone = uniquePhone();
  const order = await createOrder(shop, { phone, attributed: false, status });
  const { order_code: code } = first(await sql<{ order_code: string }[]>`SELECT order_code FROM orders WHERE id = ${order.id}`);
  return { orderId: order.id, code, phone, chatId: `${phone.slice(1)}@c.us` };
}

export interface DeliveryRowState {
  readonly status: string;
  readonly attempts: number;
  readonly attempts_base: number;
  readonly session_id: string | null;
  readonly tried_session_ids: string[];
  readonly wa_message_id: string | null;
  readonly last_error: string | null;
  readonly wa_chat_id: string | null;
  readonly filename: string | null;
  readonly lease_until: Date | null;
  readonly not_before: Date;
}

export const deliveryOf = async (id: string): Promise<DeliveryRowState> =>
  first(
    await sql<DeliveryRowState[]>`
      SELECT status::text AS status, attempts, attempts_base, session_id, tried_session_ids, wa_message_id, last_error, wa_chat_id, filename, lease_until, not_before
        FROM deliveries WHERE id = ${id}`,
  );

export interface TestSession {
  readonly id: string;
  readonly name: string;
  readonly serverId: string;
}

/**
 * An active WAHA server with one session, polled just now (status WORKING unless said otherwise). An ESTABLISHED number (no warm-up: warmup_started_at NULL) unless
 * `warmupStartedAt` says when its warm-up began: the column's own default (a number that is warming up since now) would hold every test's openers to five a day.
 */
export async function createSession(
  options: { readonly weight?: number; readonly dailyCap?: number; readonly status?: string | null; readonly name?: string; readonly sentToday?: number; readonly warmupStartedAt?: Date } = {},
): Promise<TestSession> {
  const tag = `${suffix()}${suffix()}`;
  const name = options.name ?? `s${tag}`;
  const server = first(await sql<{ id: string }[]>`INSERT INTO waha_servers (name, base_url, base_url_host) VALUES (${`W ${tag}`}, ${`https://waha-${tag}.invalid/`}, ${`waha-${tag}.invalid`}) RETURNING id`);
  const status = options.status === undefined ? "WORKING" : options.status;
  const session = first(
    await sql<{ id: string }[]>`
      INSERT INTO waha_sessions (server_id, session_name, weight, daily_cap, status, status_at, warmup_started_at)
      VALUES (${server.id}, ${name}, ${options.weight ?? 1}, ${options.dailyCap ?? 200}, ${status}, ${status === null ? null : new Date()}, ${options.warmupStartedAt ?? null}) RETURNING id`,
  );
  if (options.sentToday !== undefined && options.sentToday > 0) {
    await sql`INSERT INTO waha_sends (session_id, kind) SELECT ${session.id}, 'otp' FROM generate_series(1, ${options.sentToday}::int)`;
  }
  return { id: session.id, name, serverId: server.id };
}

/** The pool is global to the test database: take every other session out of it so a test starts from the sessions it made. */
export async function retireSessions(): Promise<void> {
  await sql`UPDATE waha_sessions SET active = false`;
}

/** Cancels what a delivery test leaves pending (the due sweepers of other files count every due row). */
export async function retireDeliveries(): Promise<void> {
  await sql`UPDATE deliveries SET status = 'cancelled' WHERE status = 'pending'`;
  // What WAHA said about a phone or a @lid is cached per phone; a lid reused by another test file must not point at the previous test's phone.
  await sql`DELETE FROM wa_contacts`;
  await sql`UPDATE outbox SET processed_at = now() WHERE topic IN ('waha.inbound', 'order.paid') AND processed_at IS NULL`;
}

// ---------------------------------------------------------------------------------------------
// WAHA

export const WAHA_KEY = "waha-test-api-key";
export const WAHA_HMAC = "waha-test-hmac-secret";

/** `ban463` / `ban475`: WhatsApp refuses a message to a new contact ("server returned error 463" / "475"; the session stays WORKING). */
export type SendFault = "timeout" | "timeout_after_send" | "unauthorized" | "reset" | "ban463" | "ban475";

export interface WahaFake {
  readonly access: WahaAccess;
  /** Every sendFile / sendText the mock accepted: [session name, chat id, filename, caption/text]. */
  readonly sent: { readonly id: string; readonly kind: "file" | "text"; readonly session: string; readonly chatId: string; readonly filename: string | null; readonly text: string; readonly url: string | null }[];
  /** Every request, by session name and path (health polls, lookups). */
  readonly calls: { readonly session: string; readonly path: string }[];
  /** A fault for this session's sends (default: none). */
  fault(sessionName: string, fault: SendFault | undefined): void;
  /** Every WAHA API call the mock served, in order (seen, typing, presence, check-exists, sends): `path` and the body without any message text. */
  callLog(): Promise<{ readonly method: string; readonly path: string; readonly body: Record<string, unknown> }[]>;
  clearCallLog(): Promise<void>;
  /** What check-exists answers for a phone (default: on WhatsApp at `<digits>@c.us`): a @lid chat id, or not on WhatsApp. */
  contact(phone: string, answer: { readonly numberExists?: boolean; readonly chatId?: string; readonly pn?: string }): Promise<void>;
  /** The mock's seen / typing / presence / check-exists calls fail with a 500 (or work again with "ok"). */
  presenceFault(mode: "ok" | "http500"): Promise<void>;
  /** The timelock and capping state the mock reports for a session. */
  limits(sessionName: string, state: { readonly timelock?: { isActive: boolean; timeEnforcementEnds?: number }; readonly capping?: { cappingStatus: string; cycleEnd?: number } }): Promise<void>;
  /** The session's WAHA status (a non-WORKING session refuses sends, as WAHA does with a 422). */
  status(sessionName: string, status: string): Promise<void>;
  /** Registers an inbound message in the mock (re-fetchable by id) and returns its id. */
  inbound(input: { readonly session: string; readonly chatId: string; readonly body: string; readonly key?: string }): Promise<string>;
  /** Maps an @lid to a phone (or to nothing). */
  lid(lid: string, phoneChat: string | null): Promise<void>;
  /** Makes the next session lookups for the name fail with this status (an outage). */
  outage(sessionName: string, on: boolean): void;
}

/** The mock app of infra/waha-mock in process, and a WahaAccess over it for the sessions of the test database. */
export function createWahaFake(options: { readonly files?: { readonly fetch: typeof fetch } } = {}): WahaFake {
  const faults = new Map<string, SendFault>();
  const outages = new Set<string>();
  const calls: WahaFake["calls"][number][] = [];
  const sent: WahaFake["sent"][number][] = [];
  // `files`: WAHA downloads the file URL itself, as the Owner's WEBJS does (US-005 R11): an answer that is an error page is delivered as the document, not refused.
  const mock = createWahaMockApp({
    apiKey: WAHA_KEY,
    webhookHmacSecret: WAHA_HMAC,
    timeoutMs: 5,
    fetchImpl: options.files?.fetch ?? (() => Promise.resolve(new Response("ok"))),
    ...(options.files === undefined ? {} : { fetchFiles: "webjs" as const }),
  });
  const control = (path: string, body: unknown): Promise<Response> => Promise.resolve(mock.fetch(new Request(`https://mock${path}`, { method: "POST", body: JSON.stringify(body) })));

  const sessionOf = (url: URL, body: unknown): string => {
    const fromBody = typeof body === "object" && body !== null ? (body as { session?: unknown }).session : undefined;
    if (typeof fromBody === "string") return fromBody;
    const parts = url.pathname.split("/").filter((p) => p !== "");
    return parts[1] === "sessions" ? (parts[2] ?? "") : (parts[1] ?? "");
  };

  const fetch: HttpFetch = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const session = sessionOf(url, body);
    calls.push({ session, path: url.pathname });
    if (outages.has(session)) throw new SafeFetchError("request_failed", "the WAHA box is down");
    const sending = url.pathname.endsWith("/sendFile") || url.pathname.endsWith("/sendText");
    const fault = faults.get(session);
    if (sending && fault === "timeout") throw new SafeFetchError("timeout", "the request timed out");
    if (sending && fault === "reset") throw new SafeFetchError("request_failed", "the connection was reset");
    if (sending && fault === "unauthorized") return { status: 401, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") };
    if (sending && (fault === "ban463" || fault === "ban475")) {
      const text = JSON.stringify({ message: `server returned error ${fault === "ban463" ? "463" : "475"}`, statusCode: 500 });
      return { status: 500, json: () => Promise.resolve(JSON.parse(text)), text: () => Promise.resolve(text) };
    }
    const response = await mock.fetch(new Request(rawUrl, { method: init.method, headers: init.headers, body: init.body ?? null }));
    if (sending && response.status < 300) {
      const sentBody = body as { chatId: string; text?: string; caption?: string; file?: { filename?: string; url?: string } };
      // WEBJS answers the raw message: `id` is an object whose `_serialized` is the string id (US-005 R11; the documented shape is the string itself).
      const answered = ((await response.clone().json()) as { id: string | { _serialized: string } }).id;
      sent.push({
        id: typeof answered === "string" ? answered : answered._serialized,
        kind: url.pathname.endsWith("/sendFile") ? "file" : "text",
        session,
        chatId: sentBody.chatId,
        filename: sentBody.file?.filename ?? null,
        text: sentBody.text ?? sentBody.caption ?? "",
        url: sentBody.file?.url ?? null,
      });
      // The message went out, but the answer never arrives: the case the unknown-send lookup exists for.
      if (fault === "timeout_after_send") throw new SafeFetchError("timeout", "the response did not arrive in time");
    }
    return { status: response.status, json: () => response.json(), text: () => response.text() };
  };

  const access: WahaAccess = {
    async withSession(sessionId, use) {
      const [row] = await sql<{ session_name: string; active: boolean }[]>`SELECT session_name, active FROM waha_sessions WHERE id = ${sessionId}`;
      if (row === undefined || !row.active) throw new WahaAccessError("session_unusable");
      return use({ sessionName: row.session_name, client: createWahaClient({ target: new URL("https://waha.invalid/"), apiKey: WAHA_KEY, fetch }) });
    },
  };

  return {
    access,
    sent,
    calls,
    fault: (name, fault) => {
      if (fault === undefined) faults.delete(name);
      else faults.set(name, fault);
    },
    callLog: async () => (await (await mock.fetch(new Request("https://mock/__mock/calls"))).json()) as Awaited<ReturnType<WahaFake["callLog"]>>,
    clearCallLog: async () => {
      await mock.fetch(new Request("https://mock/__mock/calls", { method: "DELETE" }));
    },
    contact: async (phone, answer) => {
      await control("/__mock/contacts", { phone, ...answer });
    },
    presenceFault: async (mode) => {
      await control("/__mock/faults", { presence: mode });
    },
    limits: async (name, state) => {
      await control(`/__mock/sessions/${name}/reachout`, { ...(state.timelock === undefined ? {} : { timelock: state.timelock }), ...(state.capping === undefined ? {} : { capping: state.capping }) });
    },
    status: async (name, status) => {
      await control(`/__mock/sessions/${name}/status`, { status });
    },
    inbound: async ({ session, chatId, body, key }) => {
      const id = `false_${chatId}_${key ?? randomBytes(6).toString("hex").toUpperCase()}`;
      await control("/__mock/emit", { event: "message", session, targetUrl: "https://public.invalid/api/v1/webhooks/waha", payload: { id, timestamp: Math.floor(Date.now() / 1000), from: chatId, fromMe: false, body, hasMedia: false } });
      return id;
    },
    lid: async (lid, phoneChat) => {
      await control("/__mock/lids", { lid, pn: phoneChat });
    },
    outage: (name, on) => {
      if (on) outages.add(name);
      else outages.delete(name);
    },
  };
}

/** An inbound message as the public route stores it, and its outbox row (enqueue_waha_inbound); returns both ids. */
export async function storeInbound(input: { readonly sessionName: string; readonly messageId: string; readonly fromJid: string }): Promise<{ readonly inboundId: string; readonly outboxId: string }> {
  const inbound = first(
    await sql<{ id: string }[]>`
      INSERT INTO waha_inbound (message_id, session_name, from_jid, raw) VALUES (${input.messageId}, ${input.sessionName}, ${input.fromJid}, '{}') RETURNING id`,
  );
  const outbox = first(await sql<{ id: string }[]>`SELECT public.enqueue_waha_inbound(${inbound.id}) AS id`);
  return { inboundId: inbound.id, outboxId: outbox.id };
}

export const inboundOf = async (id: string) =>
  first(await sql<{ processed: boolean; outcome: string | null; replied: boolean }[]>`SELECT processed_at IS NOT NULL AS processed, outcome, replied_at IS NOT NULL AS replied FROM waha_inbound WHERE id = ${id}`);

// ---------------------------------------------------------------------------------------------
// Mail, magic links, files, config

export interface RecordingMail extends MailSender {
  readonly sent: OutgoingMail[];
  /** Fail the next sends with this error (consumed one by one). */
  readonly failures: Error[];
}

export function recordingMail(): RecordingMail {
  const mail: RecordingMail = {
    sent: [],
    failures: [],
    send(message) {
      const failure = mail.failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      mail.sent.push(message);
      return Promise.resolve();
    },
  };
  return mail;
}

export interface FakeMagicLinks extends MagicLinks {
  readonly issued: { readonly playerId: string; readonly channel: MagicLinkChannel; readonly url: string }[];
  failing: boolean;
}

/** Issues `https://play.example.test/masuk#c=<channel>&t=<token>` and remembers it (never stores a token in the database). */
export function fakeMagicLinks(): FakeMagicLinks {
  const links: FakeMagicLinks = {
    issued: [],
    failing: false,
    issue({ playerId, channel }) {
      if (links.failing) return Promise.reject(new MagicLinkUnavailable());
      const url = `https://play.example.test/masuk#c=${channel}&t=${randomBytes(32).toString("base64url")}`;
      links.issued.push({ playerId, channel, url });
      return Promise.resolve(url);
    },
  };
  return links;
}

export function deliveryConfig(shop: Pick<DeliveryShop, "dataDir">, over: Partial<DeliveryConfig> = {}): DeliveryConfig {
  return {
    playOrigin: "https://play.example.test",
    apiOrigin: "https://api.example.test",
    dataDir: shop.dataDir,
    fileUrlKey: randomBytes(32),
    leaseMs: 120_000,
    wahaTimeoutMs: 60_000,
    smtpTimeoutMs: 10_000,
    emailAttachMaxBytes: 15 * 1024 * 1024,
    emailLinkTtlSeconds: 72 * 3600,
    sessionPollIntervalMs: 30_000,
    warningCapFactors: [0.5, 0.25],
    unknownSkewMs: 60_000,
    dev: { allowHttp: false, allowLoopback: false, allowPlaintextSmtp: true },
    ...over,
  };
}

export const filesFor = (config: DeliveryConfig): EbookFiles => testFiles(config);
export const noSleep = (): Promise<void> => Promise.resolve();
