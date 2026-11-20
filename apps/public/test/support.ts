// Shared helpers of the public API integration tests: a superuser connection for fixtures and
// inspection, the app's own pool as the public_rw login, Valkey as the ACL user `public`, a Cap
// provider on Valkey (small challenges, solved in-process), and infra/midtrans-stub's Hono app behind
// a recording fetch that can fail or slow down a Snap call on demand.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { type CapChallenge, type CapProvider, createCapProvider, type HttpFetch, type HttpResponse } from "@ebooktrivia/adapters";
import { createSecretOpener } from "@ebooktrivia/crypto";
import { PG_CONNECTION_OPTIONS } from "@ebooktrivia/db/connection";
import { createMidtransStubApp } from "@ebooktrivia/midtrans-stub/src/app.ts";
import postgres from "postgres";
import { afterAll, inject } from "vitest";
import { capProviders, type CapRouteDeps } from "../src/lib/cap-routes.ts";
import type { CheckoutDeps } from "../src/lib/checkout/handler.ts";
import { createPublicSql } from "../src/lib/db.ts";
import { formatLogLine, type Logger } from "../src/lib/log.ts";
import { createValkey, type Valkey, valkeyCapTokenMarks } from "../src/lib/valkey.ts";

export const root = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
export const publicSql = createPublicSql(inject("publicDbUrl"), 12);
export const DOMAIN = "ebooktrivia.example.test";
export const PRICE_IDR = 49_000;

const valkeys: Valkey[] = [];
/** Valkey as the app's ACL user `public` (or, with `inspect`, a user that may SCAN, for assertions only). */
export async function newValkey(port?: number, inspect = false): Promise<Valkey> {
  const url = new URL(inject("valkeyUrl"));
  const valkey = createValkey({
    host: url.hostname,
    port: port ?? Number(url.port === "" ? "6379" : url.port),
    db: 0,
    username: inject(inspect ? "valkeyInspectUsername" : "valkeyUsername"),
    password: inject(inspect ? "valkeyInspectPassword" : "valkeyPassword"),
    tls: false,
  });
  valkeys.push(valkey);
  if (port === undefined) await valkey.connect();
  return valkey;
}
export const valkey = await newValkey();

afterAll(async () => {
  for (const v of valkeys) v.disconnect();
  await Promise.all([root.end({ timeout: 5 }), publicSql.end({ timeout: 5 })]);
});

export const suffix = (): string => randomBytes(4).toString("hex");
export const freshIp = (): string => `2001:db8:${randomInt(1, 0xffff).toString(16)}:${randomInt(1, 0xffff).toString(16)}::1`;
export const uniquePhone = (): string => `+62812${randomInt(10_000_000, 99_999_999).toString()}`;

export async function one<T>(rows: Promise<readonly T[]>): Promise<T> {
  const [row] = await rows;
  if (row === undefined) throw new Error("query returned no row");
  return row;
}

// ---------------------------------------------------------------------------------------------
// Cap (the real stateless provider, its token marks in Valkey, small challenges)

export const SMALL_CHALLENGES = { challengeCount: 4, challengeSize: 16, challengeDifficulty: 2 } as const;
/** CAPTCHA_HMAC_KEY of this test file's "deployment" (every instance shares it). */
export const CAPTCHA_KEY = randomBytes(32);

/** The Cap provider of one landing page, as one apps/public instance holds it. */
export function newCap(store: Valkey, landingPageId: string, key: Uint8Array = CAPTCHA_KEY): CapProvider {
  return createCapProvider({ ...SMALL_CHALLENGES, key, scope: landingPageId, replay: valkeyCapTokenMarks(store) });
}

/** @cap.js/server 4.0.5's deterministic prng (not exported; copied as in packages/adapters captcha.test.ts). */
function prng(seed: string, length: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  let state = hash >>> 0;
  let result = "";
  while (result.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result += (state >>> 0).toString(16).padStart(8, "0");
  }
  return result.substring(0, length);
}

/** The widget's side: the proof of work of a challenge. */
export function solve({ challenge, token }: CapChallenge): { token: string; solutions: number[] } {
  const solutions = Array.from({ length: challenge.c }, (_, index) => {
    const salt = prng(`${token}${String(index + 1)}`, challenge.s);
    const target = prng(`${token}${String(index + 1)}d`, challenge.d);
    let nonce = 0;
    while (!createHash("sha256").update(`${salt}${String(nonce)}`).digest("hex").startsWith(target)) nonce++;
    return nonce;
  });
  return { token, solutions };
}

/** A fresh Cap token redeemed for `page` (a landing page, or its id). */
export async function capToken(page: { readonly landingPageId: string }): Promise<string> {
  const provider = newCap(valkey, page.landingPageId);
  const redeemed = await provider.redeem(solve(await provider.challenge()));
  if (!redeemed.success) throw new Error("Cap redeem failed");
  return redeemed.token;
}

// ---------------------------------------------------------------------------------------------
// midtrans-stub

export interface SnapCall {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface MidtransStub {
  readonly fetch: HttpFetch;
  /** Snap create requests, in order. */
  readonly calls: SnapCall[];
  /** What the next Snap calls do instead of reaching the stub: 500, 400, a network error, or a 201 whose redirect is not on Snap's host. */
  readonly failures: ("500" | "400" | "network" | "bad_host")[];
  /** Delay before each Snap call is answered. */
  delayMs: number;
}

const response = (status: number, body: unknown): HttpResponse => ({
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

export function midtransStub(): MidtransStub {
  const app = createMidtransStubApp({ serverKey: inject("midtransServerKey") });
  const stub: MidtransStub = {
    calls: [],
    failures: [],
    delayMs: 0,
    fetch: async (url, init) => {
      if (url.includes("/snap/v1/transactions")) {
        stub.calls.push({ url, authorization: init.headers["authorization"], body: JSON.parse(String(init.body)) as Record<string, unknown> });
        if (stub.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
        const failure = stub.failures.shift();
        if (failure === "network") throw new TypeError("fetch failed");
        if (failure === "500") return response(500, { error_messages: ["stub: internal error"] });
        if (failure === "400") return response(400, { error_messages: ["stub: rejected"] });
        if (failure === "bad_host") return response(201, { token: "t", redirect_url: "https://evil.example.test/snap/v4/redirection/t" });
      }
      return app.fetch(new Request(url, { method: init.method, headers: init.headers, body: typeof init.body === "string" ? init.body : null }));
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------------------------
// Deps and requests

export interface Captured {
  readonly lines: string[];
  readonly log: Logger;
}
export function captureLog(): Captured {
  const lines: string[] = [];
  return { lines, log: (level, event, fields, error) => lines.push(formatLogLine(level, event, fields, error)) };
}

export const opener = createSecretOpener({ payment: Buffer.from(inject("paymentPrivateKey"), "base64url") });

export function checkoutDeps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps & { readonly stub: MidtransStub; readonly logs: Captured } {
  const stub = midtransStub();
  const logs = captureLog();
  return { sql: publicSql, valkey, capFor: capProviders(valkey, CAPTCHA_KEY, SMALL_CHALLENGES), opener, midtransFetch: stub.fetch, domain: DOMAIN, log: logs.log, pollIntervalMs: 50, stub, logs, ...overrides };
}

export function capDeps(overrides: Partial<CapRouteDeps> = {}): CapRouteDeps & { readonly logs: Captured } {
  const logs = captureLog();
  return { sql: publicSql, valkey, capFor: capProviders(valkey, CAPTCHA_KEY, SMALL_CHALLENGES), log: logs.log, logs, ...overrides };
}

export interface RequestOptions {
  readonly origin?: string | null;
  readonly ip?: string;
  readonly contentType?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

export function apiRequest(path: string, body: unknown, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": options.ip ?? freshIp(),
    "user-agent": "public-int-test/1.0",
    ...(options.origin === null || options.origin === undefined ? {} : { origin: options.origin }),
    ...(body === undefined ? {} : { "content-type": options.contentType ?? "application/json" }),
    ...options.headers,
  };
  return new Request(`https://api.${DOMAIN}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

// ---------------------------------------------------------------------------------------------
// Fixtures (as the superuser: bypasses grants, not triggers)

export interface Shop {
  readonly lpKey: string;
  readonly landingPageId: string;
  readonly programId: string;
  readonly productId: string;
  readonly host: string;
  readonly origin: string;
  readonly terms: { readonly id: string; readonly version: number };
  readonly privacy: { readonly id: string; readonly version: number };
  /** An active adnet allowed on the page. */
  readonly adnet: { readonly id: string; readonly slug: string };
  /** An active adnet NOT allowed on the page. */
  readonly foreignAdnet: { readonly id: string; readonly slug: string };
}

export interface ShopOptions {
  readonly salesStartAt?: Date;
  readonly salesEndAt?: Date;
  readonly programStatus?: string;
  readonly lpActive?: boolean;
  readonly productActive?: boolean;
  readonly published?: boolean;
}

export async function createShop(options: ShopOptions = {}): Promise<Shop> {
  const tag = suffix();
  const product = await one(root<{ id: string }[]>`INSERT INTO products (title, price_idr, active) VALUES (${`Ebook Trivia ${tag}`}, ${PRICE_IDR}, ${options.productActive ?? true}) RETURNING id`);
  const program = await one(root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product.id}, ${`juni-${tag}`}, 'Program', ${options.programStatus ?? "published"},
            ${options.salesStartAt ?? new Date(Date.now() - 86_400_000)}, ${options.salesEndAt ?? new Date(Date.now() + 30 * 86_400_000)}, 30)
    RETURNING id`);
  const lpKey = `lp_${randomBytes(8).toString("hex")}`;
  const lp = await one(root<{ id: string }[]>`INSERT INTO landing_pages (lp_key, name, program_id, active) VALUES (${lpKey}, 'LP', ${program.id}, ${options.lpActive ?? true}) RETURNING id`);
  const host = `lp-${tag}.example.test`;
  await root`INSERT INTO lp_domains (landing_page_id, host) VALUES (${lp.id}, ${host})`;
  const published = options.published ?? true;
  // A version is saved as a draft and published afterwards (legal_pages guard, US-018).
  const legal = async (kind: string, version: number, isPublished: boolean) => {
    const page = await one(root<{ id: string }[]>`
      INSERT INTO legal_pages (program_id, kind, version, title, body) VALUES (${program.id}, ${kind}, ${version}, ${kind}, 'Isi') RETURNING id`);
    if (isPublished) await root`UPDATE legal_pages SET published_at = now() WHERE id = ${page.id}`;
    return page;
  };
  await legal("terms", 1, published);
  const terms2 = await legal("terms", 2, published);
  const privacy1 = await legal("privacy", 1, published);
  // A newer DRAFT never counts: the newest PUBLISHED pair is terms 2 + privacy 1.
  await legal("terms", 3, false);
  const adnet = await one(root<{ id: string; slug: string }[]>`INSERT INTO adnets (slug, name, clickid_param) VALUES (${`adn-${tag}`}, 'Adnet', 'cid') RETURNING id, slug`);
  const foreignAdnet = await one(root<{ id: string; slug: string }[]>`INSERT INTO adnets (slug, name, clickid_param) VALUES (${`other-${tag}`}, 'Other', 'oid') RETURNING id, slug`);
  await root`INSERT INTO landing_page_adnets (landing_page_id, adnet_id) VALUES (${lp.id}, ${adnet.id})`;
  return {
    lpKey,
    landingPageId: lp.id,
    programId: program.id,
    productId: product.id,
    host,
    origin: `https://${host}`,
    terms: { id: terms2.id, version: 2 },
    privacy: { id: privacy1.id, version: 1 },
    adnet,
    foreignAdnet,
  };
}

/** A valid checkout body for the shop (fresh phone and Cap token unless given). */
export async function checkoutBody(shop: Shop, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    v: 1,
    name: "Budi Santoso",
    phone: uniquePhone(),
    email: "budi@example.test",
    cap_token: await capToken(shop),
    consent: { terms: shop.terms.version, privacy: shop.privacy.version },
    attribution: {},
    ...overrides,
  };
}

/** Sets app_settings values for the duration of `fn` (the shared test database), then restores them. */
export async function withSettings<T>(values: Readonly<Record<string, unknown>>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(values);
  const before = await root<{ key: string; value: unknown }[]>`SELECT key, value FROM app_settings WHERE key = ANY (${keys})`;
  for (const [key, value] of Object.entries(values)) await root`UPDATE app_settings SET value = ${JSON.stringify(value)}::text::jsonb WHERE key = ${key}`;
  try {
    return await fn();
  } finally {
    for (const row of before) await root`UPDATE app_settings SET value = ${JSON.stringify(row.value)}::text::jsonb WHERE key = ${row.key}`;
  }
}

export interface OrderRow {
  id: string;
  public_id: string;
  status: string;
  snap_attempt_count: number;
  snap_redirect_url: string | null;
  snap_expires_at: Date | null;
  expires_at: Date;
  created_at: Date;
  event_id: string;
  amount_idr: string;
  buyer_phone: string;
  buyer_name: string;
  mo_outbox_id: string | null;
  adnet_id: string | null;
  visit_id: string | null;
  clickid: string | null;
  sub_id: string | null;
  utm_source: string | null;
  fbp: string | null;
  fbc: string | null;
  gclid: string | null;
  ip: string | null;
}

export const ordersOf = (shop: Shop): Promise<OrderRow[]> =>
  root<OrderRow[]>`
    SELECT id, public_id, status::text AS status, snap_attempt_count, snap_redirect_url, snap_expires_at, expires_at, created_at, event_id,
           amount_idr::text AS amount_idr, buyer_phone, buyer_name, mo_outbox_id, adnet_id, visit_id, clickid, sub_id, utm_source, fbp, fbc, gclid,
           host(ip) AS ip
      FROM orders WHERE landing_page_id = ${shop.landingPageId} ORDER BY created_at`;

export const attemptsOf = (orderId: string) =>
  root<{ n: number; midtrans_order_id: string; status: string; redirect_url: string | null; error: string | null }[]>`
    SELECT n, midtrans_order_id, status, redirect_url, error FROM midtrans_attempts WHERE order_id = ${orderId} ORDER BY n`;

export const moRowsOf = (orderId: string) => root<{ id: string }[]>`SELECT id FROM outbox WHERE dedupe_key = ${`conversion.mo:${orderId}`}`;
