// What the checkout and Cap routes read from PostgreSQL (as public_rw, sql/grants.sql). Every read is
// of the deployment's own state: the landing page and its registered hosts, the catalog price (AC-S5:
// the amount is never taken from the client), the published legal pages, the bounded settings and the
// sealed Midtrans server key.
import { enabledMidtransMethods, type MidtransMethod } from "@ebooktrivia/core";
import { CryptoError, type SecretOpener } from "@ebooktrivia/crypto";
// The subpath, not "@ebooktrivia/db": that index pulls the drizzle schema into the bundle (code review).
import { SECRET_NAMES } from "@ebooktrivia/db/secrets";
import type { Sql } from "../db.ts";

export type MidtransEnvironment = "sandbox" | "production";

export interface LandingPage {
  readonly id: string;
  readonly lpKey: string;
  readonly active: boolean;
  readonly hosts: readonly string[];
  readonly programId: string;
  readonly programStatus: string;
  readonly salesStartAt: Date;
  readonly salesEndAt: Date;
  readonly productId: string;
  readonly productTitle: string;
  readonly productActive: boolean;
  /** products.price_idr, whole rupiah. */
  readonly priceIdr: number;
  /** The database clock when this was read (decisions use one clock: PostgreSQL's). */
  readonly now: Date;
}

/** A bigint read as text (postgres.js would give a string anyway), as a safe integer. */
export function idrOf(text: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n)) throw new RangeError("an IDR amount is not a safe integer");
  return n;
}

export async function loadLandingPage(sql: Sql, lpKey: string): Promise<LandingPage | undefined> {
  const [row] = await sql<
    {
      id: string;
      active: boolean;
      hosts: string[];
      program_id: string;
      program_status: string;
      sales_start_at: Date;
      sales_end_at: Date;
      product_id: string;
      product_title: string;
      product_active: boolean;
      price_idr: string;
      now: Date;
    }[]
  >`
    SELECT lp.id, lp.active,
           coalesce((SELECT array_agg(d.host ORDER BY d.host) FROM public.lp_domains d WHERE d.landing_page_id = lp.id), '{}') AS hosts,
           p.id AS program_id, p.status::text AS program_status, p.sales_start_at, p.sales_end_at,
           pr.id AS product_id, pr.title AS product_title, pr.active AS product_active, pr.price_idr::text AS price_idr,
           clock_timestamp() AS now
      FROM public.landing_pages lp
      JOIN public.programs p ON p.id = lp.program_id
      JOIN public.products pr ON pr.id = p.product_id
     WHERE lp.lp_key = ${lpKey}`;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    lpKey,
    active: row.active,
    hosts: row.hosts,
    programId: row.program_id,
    programStatus: row.program_status,
    salesStartAt: row.sales_start_at,
    salesEndAt: row.sales_end_at,
    productId: row.product_id,
    productTitle: row.product_title,
    productActive: row.product_active,
    priceIdr: idrOf(row.price_idr),
    now: row.now,
  };
}

/** A landing page's id and registered hosts only (the Cap routes and the preflights). */
export async function landingPageHosts(sql: Sql, lpKey: string): Promise<{ readonly id: string; readonly hosts: readonly string[] } | undefined> {
  const [row] = await sql<{ id: string; hosts: string[] }[]>`
    SELECT lp.id, coalesce((SELECT array_agg(d.host ORDER BY d.host) FROM public.lp_domains d WHERE d.landing_page_id = lp.id), '{}') AS hosts
      FROM public.landing_pages lp WHERE lp.lp_key = ${lpKey}`;
  return row;
}

// ---------------------------------------------------------------------------------------------
// Settings (bounded app_settings keys, APP_SETTING_BOUNDS; edited on the admin limits page)

export class SettingsUnavailable extends Error {
  constructor(key: string) {
    super(`setting ${key} is missing or malformed`);
    this.name = "SettingsUnavailable";
  }
}

const CHECKOUT_KEYS = [
  "orders.expiry_seconds",
  "orders.sales_close_buffer_minutes",
  "checkout.ip_cap",
  "checkout.ip_window_seconds",
  "checkout.phone_cap",
  "checkout.phone_window_seconds",
  "checkout.lp_cap",
  "checkout.lp_window_seconds",
] as const;
const CAPTCHA_KEYS = ["captcha.ip_cap", "captcha.ip_window_seconds", "captcha.ip48_cap"] as const;

type IntSettings<K extends string> = Readonly<Record<K, number>>;

/** Positive whole numbers (the DB CHECKs guarantee it; a missing one fails closed, like setting_positive_int). */
async function intSettings<K extends string>(sql: Sql, keys: readonly K[]): Promise<IntSettings<K>> {
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings WHERE key = ANY (${keys as readonly string[] as string[]})`;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = byKey.get(key);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new SettingsUnavailable(key);
    out[key] = value;
  }
  return out as IntSettings<K>;
}

export interface CheckoutSettings {
  readonly limits: IntSettings<(typeof CHECKOUT_KEYS)[number]>;
  /** The deployment's Midtrans configuration (never a per-landing-page setting). */
  readonly midtransEnvironment: MidtransEnvironment;
  readonly enabledMethods: readonly MidtransMethod[];
}

export async function loadCheckoutSettings(sql: Sql): Promise<CheckoutSettings> {
  const limits = await intSettings(sql, CHECKOUT_KEYS);
  const rows = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM public.app_settings WHERE key IN ('midtrans.environment', 'midtrans.enabled_methods')`;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const environment = byKey.get("midtrans.environment");
  if (environment !== "sandbox" && environment !== "production") throw new SettingsUnavailable("midtrans.environment");
  return { limits, midtransEnvironment: environment, enabledMethods: enabledMidtransMethods(byKey.get("midtrans.enabled_methods")) };
}

export const loadCaptchaSettings = (sql: Sql): Promise<IntSettings<(typeof CAPTCHA_KEYS)[number]>> => intSettings(sql, CAPTCHA_KEYS);

// ---------------------------------------------------------------------------------------------
// Legal pages, adnets, visits

export interface PublishedLegal {
  readonly terms: { readonly id: string; readonly version: number };
  readonly privacy: { readonly id: string; readonly version: number };
}

/** The program's newest PUBLISHED terms and privacy pair (AC-A10), or undefined when either is missing. */
export async function publishedLegal(sql: Sql, programId: string): Promise<PublishedLegal | undefined> {
  const rows = await sql<{ id: string; kind: string; version: number }[]>`
    SELECT DISTINCT ON (kind) id, kind, version FROM public.legal_pages
     WHERE program_id = ${programId} AND published_at IS NOT NULL
     ORDER BY kind, version DESC`;
  const terms = rows.find((r) => r.kind === "terms");
  const privacy = rows.find((r) => r.kind === "privacy");
  return terms === undefined || privacy === undefined ? undefined : { terms: { id: terms.id, version: terms.version }, privacy: { id: privacy.id, version: privacy.version } };
}

/** slug -> id of the active adnets allowed on the landing page. */
export async function allowedAdnets(sql: Sql, landingPageId: string): Promise<ReadonlyMap<string, string>> {
  const rows = await sql<{ id: string; slug: string }[]>`
    SELECT a.id, a.slug FROM public.landing_page_adnets l JOIN public.adnets a ON a.id = l.adnet_id
     WHERE l.landing_page_id = ${landingPageId} AND a.active`;
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** True when the visit exists and belongs to this landing page. */
export async function visitBelongs(sql: Sql, visitId: string, landingPageId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM public.visits WHERE id = ${visitId} AND landing_page_id = ${landingPageId}`;
  return rows.length === 1;
}

// ---------------------------------------------------------------------------------------------
// The Midtrans server key (sealed payment secret, US-017)

export class ServerKeyUnavailable extends Error {
  constructor(reason: "missing" | "unreadable") {
    super(`the Midtrans server key is ${reason}`);
    this.name = "ServerKeyUnavailable";
  }
}

/**
 * The server key of `environment`, opened with the payment private key (public.env). Only the
 * payment-scope rows are visible (get_payment_secret()). The key never leaves this process except
 * in Midtrans' Basic auth header; it is never logged and never part of an error.
 */
export async function midtransServerKey(sql: Sql, opener: SecretOpener, environment: MidtransEnvironment): Promise<string> {
  const name = SECRET_NAMES.midtransServerKey(environment);
  const rows = await sql<{ id: string; name: string; ciphertext: Uint8Array; nonce: Uint8Array; sealed_dek: Uint8Array; key_id: string; bound_host: string | null }[]>`
    SELECT id, name, ciphertext, nonce, sealed_dek, key_id, bound_host FROM public.get_payment_secret() WHERE name = ${name}`;
  const row = rows[0];
  if (row === undefined) throw new ServerKeyUnavailable("missing");
  try {
    return opener.openSecret({ id: row.id, scope: "payment", name: row.name, adnetId: null, boundHost: row.bound_host, keyId: row.key_id, ciphertext: row.ciphertext, nonce: row.nonce, sealedDek: row.sealed_dek });
  } catch (error) {
    if (error instanceof CryptoError) throw new ServerKeyUnavailable("unreadable");
    throw error;
  }
}
