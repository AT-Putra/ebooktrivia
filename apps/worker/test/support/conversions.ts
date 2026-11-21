// Conversion fixtures (US-024): in-process HTTP stubs for the adnets and the Meta / TikTok APIs (no
// dependency, no real credential), a fetch that sends the vendors' https hosts to them, sealed secrets made with
// real keys, a shop with valid pixels and an adnet whose templates use {secret:api_key}, and helpers that pay an
// order through the REAL payments pipeline and run the due conversions through the REAL processor and fire port.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type HttpFetch } from "@ebooktrivia/adapters";
import { capiSecretName, CAPI_HOSTS } from "@ebooktrivia/core";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair, type SecretOpener } from "@ebooktrivia/crypto";
import { inertFailpoint } from "../../src/failpoint.ts";
import { createConversionProcessor, type ConversionResult, type FireConversion } from "../../src/conversion-fire.ts";
import { capiDedupesByEventId, createConversionFire } from "../../src/conversions.ts";
import { createOutboxProcessor } from "../../src/outbox-consumer.ts";
import { createPaymentNotificationConsumer } from "../../src/payments.ts";
import { first, sql, suffix } from "./db.ts";
import { createOrder, midtransStub, notification, type MidtransStub, type Order, type OrderOptions, PRICE_IDR, silentLog, type Shop, WA_DELAY_MS, workerPool } from "./midtrans.ts";

export const META_PIXEL = "1234567890123";
export const TIKTOK_PIXEL = "C3ABCDEFGH0123456";
export const API_KEY = "ADNET-secret-k3y/with+odd&chars=1";
export const META_TOKEN = "EAAmetaTOKEN0123456789abcdef";
export const TIKTOK_TOKEN = "tiktok-access-TOKEN-0123456789";
export const ADNET_HOST = "pb.example.test";

export const conversionsKeys = generateScopeKeyPair();
export const opener: SecretOpener = createSecretOpener({ conversions: conversionsKeys.privateKey });
const sealer = createSecretSealer({ conversions: conversionsKeys.publicKey });

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
}

export interface VendorStub {
  readonly origin: string;
  readonly requests: SeenRequest[];
  /** How the next requests are answered; default 200 {"ok":true}. */
  reply: (request: SeenRequest) => Reply;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
  });

/** A loopback HTTP server that records every request and answers by `reply`. */
export async function startVendorStub(): Promise<VendorStub> {
  const stub: VendorStub = {
    origin: "",
    requests: [],
    reply: () => ({ status: 200, body: '{"ok":true}' }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
  };
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const seen: SeenRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      stub.requests.push(seen);
      const reply = stub.reply(seen);
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body ?? "");
      }, reply.delayMs ?? 0);
    });
  });
  server.keepAliveTimeout = 500;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(stub, { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` });
}

/** The query of a stub request as a plain record (the last value of a repeated key wins). */
export const queryOf = (request: SeenRequest): Record<string, string> => Object.fromEntries(new URL(request.url, "http://x").searchParams);

/**
 * A fetch for tests: the https hosts of the adnet and of the Meta / TikTok APIs are sent to `stub`
 * (through a loopback-enabled safe-fetch); every other URL is refused. The path and query are kept.
 */
export function stubbedFetch(stub: Pick<VendorStub, "origin">, options: { timeoutMs?: number } = {}): { fetch: HttpFetch; close: () => Promise<void> } {
  const safe = createSafeFetch({ allowHttp: true, devAllowLoopback: true, timeoutMs: options.timeoutMs ?? 5000 });
  const hosts = new Set([ADNET_HOST, CAPI_HOSTS.meta, CAPI_HOSTS.tiktok]);
  return {
    fetch: (url, init) => {
      const parsed = new URL(url);
      if (!hosts.has(parsed.host)) return Promise.reject(new Error(`the test fetch refuses ${parsed.host}`));
      return safe(`${stub.origin}${parsed.pathname}${parsed.search}`, init);
    },
    close: () => safe.close(),
  };
}

export const hashOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------
// The shop: pixels, an adnet with templates and a sealed secret, CAPI tokens

export interface TrackingShop extends Shop {
  readonly programId: string;
  readonly adnetId: string;
}

async function putSecret(input: { name: string; adnetId: string | null; boundHost: string; plaintext: string }): Promise<string> {
  const sealed = sealer.sealSecret({ scope: "conversions", ...input });
  await sql`
    INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
    VALUES (${sealed.id}, 'conversions', ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
  return sealed.id;
}

async function putCapiToken(platform: "meta" | "tiktok", pixelId: string, token: string): Promise<void> {
  const name = capiSecretName(platform, pixelId);
  await sql`DELETE FROM settings_secrets WHERE scope = 'conversions' AND adnet_id IS NULL AND name = ${name}`;
  await putSecret({ name, adnetId: null, boundHost: CAPI_HOSTS[platform], plaintext: token });
}

/** Removes every CAPI token a file made (they are sealed with its own key pair). */
export const dropCapiTokens = (): Promise<unknown> => sql`DELETE FROM settings_secrets WHERE scope = 'conversions' AND adnet_id IS NULL AND name LIKE 'capi.%'`;

/** The alerts rows with this dedupe key. */
export const alertsRaised = (dedupeKey: string) => sql<{ kind: string; severity: string }[]>`SELECT kind, severity FROM alerts WHERE dedupe_key = ${dedupeKey}`;

export interface ShopOptions {
  readonly pixels?: Record<string, string>;
  readonly moTemplate?: string | null;
  readonly mtTemplate?: string | null;
  readonly reversalTemplate?: string | null;
  readonly endpointHost?: string;
  readonly metaToken?: boolean;
  readonly tiktokToken?: boolean;
  readonly apiKey?: boolean;
  readonly payoutIdr?: number;
}

export const MT_TEMPLATE = `https://${ADNET_HOST}/mt?c={clickid}&t={txid}&p={payout}&s={status}&sub={sub_id}&pub={pub}&k={secret:api_key}`;
export const MO_TEMPLATE = `https://${ADNET_HOST}/mo?c={clickid}&t={txid}&p={payout}&s={status}`;
export const REVERSAL_TEMPLATE = `https://${ADNET_HOST}/rev?c={clickid}&t={txid}&p={payout}&s={status}&k={secret:api_key}`;

export async function createTrackingShop(options: ShopOptions = {}): Promise<TrackingShop> {
  const tag = suffix();
  const product = first(await sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${tag}`}, ${PRICE_IDR}) RETURNING id`);
  const program = first(
    await sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product.id}, ${`trk-${tag}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`,
  );
  const pixels = options.pixels ?? { meta: META_PIXEL, tiktok: TIKTOK_PIXEL, gtag: "AW-123456" };
  const lp = first(
    await sql<{ id: string }[]>`
      INSERT INTO landing_pages (lp_key, name, program_id, pixels) VALUES (${`lp_${tag}${suffix()}`}, 'LP', ${program.id}, ${JSON.stringify(pixels)}::text::jsonb) RETURNING id`,
  );
  await sql`INSERT INTO lp_domains (landing_page_id, host) VALUES (${lp.id}, ${`lp-${tag}.example.test`})`;
  const host = options.endpointHost ?? ADNET_HOST;
  const adnet = first(
    await sql<{ id: string }[]>`
      INSERT INTO adnets (slug, name, clickid_param, mo_url_template, mt_url_template, reversal_url_template, payout_idr, endpoint_host)
      VALUES (${`adn-${tag}`}, 'Adnet', 'cid', ${options.moTemplate === undefined ? MO_TEMPLATE : options.moTemplate},
              ${options.mtTemplate === undefined ? MT_TEMPLATE : options.mtTemplate}, ${options.reversalTemplate === undefined ? REVERSAL_TEMPLATE : options.reversalTemplate},
              ${options.payoutIdr ?? 15_000}, ${host}) RETURNING id`,
  );
  if (options.apiKey ?? true) await putSecret({ name: "api_key", adnetId: adnet.id, boundHost: host, plaintext: API_KEY });
  // One token per pixel for the whole database, sealed with THIS file's key pair (every test file makes its own).
  if ((options.metaToken ?? true) && pixels["meta"] !== undefined) await putCapiToken("meta", pixels["meta"], META_TOKEN);
  if ((options.tiktokToken ?? true) && pixels["tiktok"] !== undefined) await putCapiToken("tiktok", pixels["tiktok"], TIKTOK_TOKEN);
  return { programId: program.id, landingPageId: lp.id, productId: product.id, adnetId: adnet.id };
}

/** An order with the attribution the CAPI events carry. */
export async function createAttributedOrder(shop: TrackingShop, options: OrderOptions & { clickid?: string; subId?: string; pub?: string } = {}): Promise<Order> {
  const order = await createOrder(shop, options);
  await sql`
    UPDATE orders SET clickid = ${options.attributed === false ? null : (options.clickid ?? `click-${suffix()}`)}, sub_id = ${options.subId ?? "sub1"}, pub = ${options.pub ?? "pub1"},
           fbp = 'fb.1.1700000000000.123456789', fbc = 'fb.1.1700000000000.AbCdEf', ttclid = 'ttclid-abc', ip = '203.0.113.9'
     WHERE id = ${order.id}`;
  return order;
}

// ---------------------------------------------------------------------------------------------
// Paying and firing

const workerSql = workerPool(8);

/** One notification of the order, re-queried through the Midtrans stub, processed by the real payment consumer. */
export async function settle(order: Order, stub: MidtransStub, state: Record<string, unknown>): Promise<void> {
  await stub.setState(order.midtransId(), state);
  const consumer = createPaymentNotificationConsumer({ sql: workerSql, midtrans: stub.source, log: silentLog, waDelayMs: WA_DELAY_MS });
  const outboxId = await notification(order.midtransId(), String(state["transaction_status"]));
  const result = await createOutboxProcessor(consumer, { sql: workerSql, failpoint: inertFailpoint, log: silentLog })({ id: outboxId });
  if (result !== "processed") throw new Error(`the notification was ${result}`);
}

/** Pays the order through the real payments pipeline (a Midtrans stub settlement, one notification). */
export async function payOrder(order: Order, stub: MidtransStub = midtransStub()): Promise<MidtransStub> {
  await stub.create(order.midtransId());
  await settle(order, stub, { transaction_status: "settlement", payment_type: "qris" });
  return stub;
}

/** Refunds the order through the same pipeline (the re-query now says refund). */
export const refundOrder = (order: Order, stub: MidtransStub): Promise<void> => settle(order, stub, { transaction_status: "refund", payment_type: "qris" });

export interface Firing {
  readonly process: (data: { id: string }) => Promise<ConversionResult>;
  readonly close: () => Promise<void>;
}

/** The processor of the real fire port over a stubbed vendor / adnet. */
export function firing(stub: Pick<VendorStub, "origin">, options: { fetch?: HttpFetch; leaseMs?: number; requestTimeoutMs?: number; fire?: FireConversion; timeoutMs?: number } = {}): Firing {
  const stubbed = stubbedFetch(stub, { timeoutMs: options.timeoutMs ?? 5000 });
  const fire = options.fire ?? createConversionFire({ sql: workerSql, opener, fetch: options.fetch ?? stubbed.fetch, metaApiVersion: "v24.0", log: silentLog });
  const process = createConversionProcessor({
    sql: workerSql,
    fire,
    failpoint: inertFailpoint,
    log: silentLog,
    leaseMs: options.leaseMs ?? 10_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    sinkDedupesByTxid: capiDedupesByEventId,
  });
  return { process, close: stubbed.close };
}

export interface EventRow {
  id: string;
  sink: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  last_http_status: number | null;
  event_id: string;
  txid: string;
}

export const eventsOf = (orderId: string) =>
  sql<EventRow[]>`
    SELECT id, sink, kind, status::text AS status, attempts, last_error, last_http_status, event_id, txid
      FROM conversion_events WHERE order_id = ${orderId} ORDER BY kind, sink`;

export const eventOf = async (orderId: string, sink: string, kind: string): Promise<EventRow> =>
  first((await eventsOf(orderId)).filter((e) => e.sink === sink && e.kind === kind));

export const attemptsOf = (eventId: string) =>
  sql<{ attempt: number; request_url_redacted: string | null; http_status: number | null; response_excerpt: string | null; latency_ms: number | null; error: string | null }[]>`
    SELECT attempt, request_url_redacted, http_status, response_excerpt, latency_ms, error FROM conversion_attempts WHERE conversion_event_id = ${eventId} ORDER BY attempt`;

/** Runs every due conversion of the order once, in sink order, through `firing`. */
export async function fireDue(f: Firing, orderId: string): Promise<ConversionResult[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM conversion_events WHERE order_id = ${orderId} AND status = 'pending' AND next_attempt_at <= now() ORDER BY kind, sink`;
  const out: ConversionResult[] = [];
  for (const row of rows) out.push(await f.process({ id: row.id }));
  return out;
}
