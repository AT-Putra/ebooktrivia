// Public app settings for the checkout API (US-020), from /etc/ebooktrivia/public.env. Parsed once by
// the runtime (lib/runtime.ts) on the first API request; a bad value fails that request closed (503)
// and is retried on the next one. Messages name the variable, never its value.
//
//   NODE_ENV              required: production, development or test.
//   DOMAIN                the base domain: the Snap finish URL is https://order.<DOMAIN>/{publicId}
//                         (AC-S10; the page itself is US-022). Lowercase ASCII / punycode.
//   DATABASE_URL_PUBLIC   postgres:// URL of a LOGIN role in group public_rw only (checked at start).
//   VALKEY_URL            redis://host:port[/0] or rediss://, database 0 only, no credentials in the URL;
//   VALKEY_USERNAME / VALKEY_PASSWORD
//                         the ACL user `public` (keys rl:* and cache:public:*). Required in production.
//   CAPTCHA_HMAC_KEY      the key that signs Cap challenges and tokens (stateless Cap, US-020): at least
//                         32 bytes as canonical hex (provisioning's @GEN@: 64 hex characters), the same
//                         in public@a and public@b. Changing it voids every open challenge and token.
//   SECRETS_PAYMENT_PRIVATE_KEY
//                         opens the sealed Midtrans server key (@ebooktrivia/crypto). public.env holds
//                         the payment private key ONLY (plan M2.3): a messaging or conversions private
//                         key here stops the app.
//   WAHA_WEBHOOK_HMAC_SECRET
//                         optional, at least 16 characters: the secret WAHA signs its webhooks with (X-Webhook-Hmac, HMAC-SHA512 of
//                         the raw body; a plain env secret, public.env holds no messaging key). Without it POST
//                         /api/v1/webhooks/waha answers 503 (US-025: buyer-first messages and delivery acks are not taken).
//   PUBLIC_DATA_DIR       the data directory (default /srv/data): the ebook PDF is read from deliverables/<id>.pdf under it for the
//                         signed download URLs (GET /files/..., US-025). The quadlet mounts /srv/data/deliverables read-only.
//   PUBLIC_DEV_MIDTRANS_STUB_URL
//                         dev / test only: http(s)://<loopback>:<port> of infra/midtrans-stub. The
//                         sandbox hosts are rewritten to it (the environment stays sandbox, so the
//                         redirect host check is unchanged). Refused with NODE_ENV=production.
// Player login (US-026, lib/play/*):
//   PLAYER_AUTH_SECRETS   Better Auth's versioned secrets of the player instance, newest first:
//                         "<version>:<64 hex>,..."; the first signs the __Host-play_session cookie,
//                         older ones still verify it (rotation without logging everyone out).
//   PLAYER_OTP_PEPPER     the OTP HMAC key (player_otps.mac = HMAC-SHA256(pepper, phone:code)): at least
//                         32 bytes as canonical hex, never in the database. Changing it voids the codes in
//                         flight (players ask for a new one).
//   SECRETS_MESSAGING_PUBLIC_KEY
//                         the messaging PUBLIC key (base64url X25519): every OTP is sealed to it for the
//                         worker, which alone holds the private key (lib/runtime.ts).
//   PUBLIC_DEV_PLAY_ORIGIN
//                         dev / test only: the play origin when it is not https://play.<DOMAIN> (the e2e
//                         server on http://127.0.0.1:<port>). Refused with NODE_ENV=production.
import { decodeSecretKey, normalizeHost } from "@ebooktrivia/core";

export type Env = Readonly<Record<string, string | undefined>>;

export class PublicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicConfigError";
  }
}

export interface ValkeyConfig {
  readonly host: string;
  readonly port: number;
  /** Always 0. */
  readonly db: 0;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly tls: boolean;
}

export interface PublicConfig {
  readonly production: boolean;
  readonly domain: string;
  readonly databaseUrl: string;
  readonly valkey: ValkeyConfig;
  /** Signs the stateless Cap challenges and tokens. */
  readonly captchaKey: Buffer;
  /** Dev / test only (refused in production). */
  readonly midtransStubUrl: string | null;
  /**
   * The player login, or null with `playUnavailable` saying which variable is missing or malformed: the
   * login is optional for the rest of the app (checkout and the Midtrans webhook keep working; only the play
   * routes answer 503, lib/runtime.ts).
   */
  readonly play: PlayConfig | null;
  readonly playUnavailable: string | null;
  /** The WAHA webhook HMAC secret (US-025); undefined closes the webhook route. */
  readonly wahaWebhookSecret: string | undefined;
  /** Where the ebook files are read from for the signed download URLs (US-025). */
  readonly dataDir: string;
}

export interface PlayConfig {
  /** https://play.<DOMAIN> (or the dev override): Better Auth's baseURL and the one Origin play mutations accept. */
  readonly playOrigin: string;
  /** Newest first. */
  readonly playerAuthSecrets: readonly { readonly version: number; readonly value: string }[];
  readonly otpPepper: Buffer;
}

export const DEV_FLAG_ENV = ["PUBLIC_DEV_MIDTRANS_STUB_URL", "PUBLIC_DEV_PLAY_ORIGIN"] as const;
const FOREIGN_PRIVATE_KEYS = ["SECRETS_MESSAGING_PRIVATE_KEY", "SECRETS_CONVERSIONS_PRIVATE_KEY"] as const;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

const value = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

function nodeEnv(env: Env): boolean {
  const mode = value(env, "NODE_ENV");
  if (mode !== "production" && mode !== "development" && mode !== "test") throw new PublicConfigError("NODE_ENV must be production, development or test");
  return mode === "production";
}

function postgresUrl(env: Env, name: string): string {
  const raw = value(env, name);
  let protocol = "";
  try {
    protocol = new URL(raw ?? "").protocol;
  } catch {
    // reported below
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") throw new PublicConfigError(`${name} must be a postgres:// or postgresql:// URL`);
  return raw as string;
}

export function parseValkey(env: Env, production: boolean): ValkeyConfig {
  const raw = value(env, "VALKEY_URL");
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new PublicConfigError("VALKEY_URL must be redis://host:port[/db] or rediss://");
  }
  if ((url.protocol !== "redis:" && url.protocol !== "rediss:") || url.hostname === "") throw new PublicConfigError("VALKEY_URL must be redis://host:port[/db] or rediss://");
  if (url.username !== "" || url.password !== "") throw new PublicConfigError("VALKEY_URL must not carry credentials: use VALKEY_USERNAME and VALKEY_PASSWORD");
  if (url.search !== "" || url.hash !== "") throw new PublicConfigError("VALKEY_URL must not have a query or fragment");
  // Database 0 only: the ACL key patterns are per server, not per database, and every app shares db 0.
  const path = url.pathname.replace(/^\//, "");
  if (path !== "" && path !== "0") throw new PublicConfigError("VALKEY_URL must use database 0 (no other /db index)");
  const username = value(env, "VALKEY_USERNAME");
  const password = value(env, "VALKEY_PASSWORD");
  if ((username === undefined) !== (password === undefined)) throw new PublicConfigError("VALKEY_USERNAME and VALKEY_PASSWORD go together");
  if (production && username === undefined) throw new PublicConfigError("VALKEY_USERNAME and VALKEY_PASSWORD are required in production");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? 6379 : Number(url.port),
    db: 0,
    username,
    password,
    tls: url.protocol === "rediss:",
  };
}

function stubUrl(env: Env, production: boolean): string | null {
  const raw = value(env, "PUBLIC_DEV_MIDTRANS_STUB_URL");
  if (raw === undefined) return null;
  if (production) throw new PublicConfigError("PUBLIC_DEV_MIDTRANS_STUB_URL is a dev-only flag and is refused with NODE_ENV=production");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicConfigError("PUBLIC_DEV_MIDTRANS_STUB_URL must be http(s)://<loopback>:<port>");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname) || url.origin !== raw) {
    throw new PublicConfigError("PUBLIC_DEV_MIDTRANS_STUB_URL must be http(s)://<loopback>:<port>");
  }
  return url.origin;
}

function captchaKey(env: Env): Buffer {
  let key: Buffer;
  try {
    key = decodeSecretKey(value(env, "CAPTCHA_HMAC_KEY") ?? "", "hex");
  } catch {
    throw new PublicConfigError("CAPTCHA_HMAC_KEY must be at least 32 bytes of canonical hex (64 hex characters)");
  }
  // A placeholder such as 64 zeros is not a key (security review P2-3).
  if (key.every((byte) => byte === key[0])) throw new PublicConfigError("CAPTCHA_HMAC_KEY must be random bytes, not one byte repeated");
  return key;
}

function hexKey(env: Env, name: string): Buffer {
  let key: Buffer;
  try {
    key = decodeSecretKey(value(env, name) ?? "", "hex");
  } catch {
    throw new PublicConfigError(`${name} must be at least 32 bytes of canonical hex (64 hex characters)`);
  }
  if (key.every((byte) => byte === key[0])) throw new PublicConfigError(`${name} must be random bytes, not one byte repeated`);
  return key;
}

/** PLAYER_AUTH_SECRETS ("<version>:<64 hex>,...", newest first; versions and secrets distinct). */
export function parsePlayerAuthSecrets(raw: string | undefined): { version: number; value: string }[] {
  const fail = (): never => {
    throw new PublicConfigError('PLAYER_AUTH_SECRETS must be "<version>:<64 hex characters>,..." with distinct versions and distinct secrets');
  };
  if (raw === undefined) return fail();
  const versions = new Set<number>();
  const values = new Set<string>();
  return raw.split(",").map((entry) => {
    const match = /^\s*(\d{1,6}):([0-9a-fA-F]{64})\s*$/.exec(entry);
    if (match === null) return fail();
    const version = Number(match[1]);
    const secret = (match[2] ?? "").toLowerCase();
    const bytes = Buffer.from(secret, "hex");
    // One byte repeated (such as 64 zeros) is a placeholder, not a secret.
    if (versions.has(version) || values.has(secret) || bytes.every((byte) => byte === bytes[0])) return fail();
    versions.add(version);
    values.add(secret);
    return { version, value: secret };
  });
}

function playOrigin(env: Env, production: boolean, domain: string): string {
  const raw = value(env, "PUBLIC_DEV_PLAY_ORIGIN");
  if (raw === undefined) return `https://play.${domain}`;
  if (production) throw new PublicConfigError("PUBLIC_DEV_PLAY_ORIGIN is a dev-only flag and is refused with NODE_ENV=production");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicConfigError("PUBLIC_DEV_PLAY_ORIGIN must be http(s)://<loopback>:<port>");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOOPBACK.has(url.hostname) || url.origin !== raw) {
    throw new PublicConfigError("PUBLIC_DEV_PLAY_ORIGIN must be http(s)://<loopback>:<port>");
  }
  return url.origin;
}

function wahaWebhookSecret(env: Env): string | undefined {
  const secret = value(env, "WAHA_WEBHOOK_HMAC_SECRET");
  if (secret !== undefined && !/^[\x21-\x7e]{16,256}$/.test(secret)) throw new PublicConfigError("WAHA_WEBHOOK_HMAC_SECRET must be 16 to 256 printable characters");
  return secret;
}

export function loadPublicConfig(env: Env): PublicConfig {
  const production = nodeEnv(env);
  const leaked = FOREIGN_PRIVATE_KEYS.filter((name) => env[name] !== undefined);
  if (leaked.length > 0) throw new PublicConfigError(`${leaked.join(", ")}: public.env holds the payment private key only`);
  const rawDomain = value(env, "DOMAIN");
  const domain = rawDomain === undefined ? null : normalizeHost(rawDomain);
  if (domain === null || domain !== rawDomain || !domain.includes(".")) throw new PublicConfigError("DOMAIN must be a lowercase host name such as example.id (punycode for IDN, no trailing dot)");
  // A dev-only flag in production is refused for the whole app, as PUBLIC_DEV_MIDTRANS_STUB_URL is.
  const origin = playOrigin(env, production, domain);
  let play: PlayConfig | null = null;
  let playUnavailable: string | null = null;
  try {
    play = { playOrigin: origin, playerAuthSecrets: parsePlayerAuthSecrets(value(env, "PLAYER_AUTH_SECRETS")), otpPepper: hexKey(env, "PLAYER_OTP_PEPPER") };
  } catch (error) {
    if (!(error instanceof PublicConfigError)) throw error;
    playUnavailable = error.message;
  }
  return {
    production,
    domain,
    databaseUrl: postgresUrl(env, "DATABASE_URL_PUBLIC"),
    valkey: parseValkey(env, production),
    captchaKey: captchaKey(env),
    midtransStubUrl: stubUrl(env, production),
    play,
    playUnavailable,
    wahaWebhookSecret: wahaWebhookSecret(env),
    dataDir: value(env, "PUBLIC_DATA_DIR") ?? "/srv/data",
  };
}
