// Admin app settings, from /etc/ebooktrivia/admin.env (infra/provision/files/env/admin.env).
// Parsed on first use and on every proxy request (ADMIN_ORIGIN only); a bad value stops the request
// (fail closed). Messages name the variable, never its value.
//
//   NODE_ENV            required.
//   ADMIN_ORIGIN        the console's exact origin, e.g. https://admin.<DOMAIN>: the Origin every
//                       state-changing request must carry, Better Auth's baseURL. https only; no
//                       path, query, credentials or trailing slash.
//   ADMIN_ALLOW_INSECURE_LOOPBACK
//                       "1" also allows http://127.0.0.1 / localhost / [::1] (the e2e tests run
//                       `next start` over plain http). Never set on a server; an http origin on
//                       any other host is refused even with it.
//   ADMIN_AUTH_SECRETS  Better Auth's versioned secrets, newest first: "<version>:<secret>,...",
//                       e.g. "2:<new>,1:<old>". The first signs cookies and encrypts new TOTP
//                       secrets; the others only decrypt (rotation keeps enrolled authenticators).
//                       Each secret is exactly 64 hex characters (what provisioning generates,
//                       `openssl rand -hex 32` by hand), and no secret repeats across versions.
//   DATABASE_URL_ADMIN  postgres:// URL of a LOGIN role in group admin_rw only (checked at startup).

export type Env = Readonly<Record<string, string | undefined>>;

export class AdminConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigError";
  }
}

export interface AuthSecret {
  readonly version: number;
  readonly value: string;
}

export interface AdminConfig {
  readonly production: boolean;
  readonly origin: string;
  /** Newest first. */
  readonly authSecrets: readonly AuthSecret[];
  readonly databaseUrl: string;
}

const value = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

const NODE_ENVS = new Set(["production", "development", "test"]);

export function isProduction(env: Env): boolean {
  const nodeEnv = value(env, "NODE_ENV");
  if (nodeEnv === undefined || !NODE_ENVS.has(nodeEnv)) throw new AdminConfigError("NODE_ENV must be production, development or test");
  return nodeEnv === "production";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The canonical origin, or null when `raw` is not exactly `https://host[:port]` (or
 * `http://<loopback>[:port]` with `allowInsecureLoopback`).
 */
export function parseOrigin(raw: string | undefined, allowInsecureLoopback: boolean): string | null {
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && allowInsecureLoopback && LOOPBACK_HOSTS.has(url.hostname));
  if (!schemeOk || url.username !== "" || url.password !== "") return null;
  // URL normalises ("HTTPS://X/" -> "https://x"): only the canonical spelling is accepted, so the
  // value compared against Origin headers is exactly what browsers send.
  return url.origin === raw ? raw : null;
}

export function allowInsecureLoopback(env: Env): boolean {
  const flag = value(env, "ADMIN_ALLOW_INSECURE_LOOPBACK");
  if (flag === undefined || flag === "0") return false;
  if (flag === "1") return true;
  throw new AdminConfigError("ADMIN_ALLOW_INSECURE_LOOPBACK must be 1 or 0");
}

/** ADMIN_ORIGIN, or null when unset or invalid (the proxy then refuses every state change). */
export function adminOrigin(env: Env): string | null {
  isProduction(env);
  return parseOrigin(value(env, "ADMIN_ORIGIN"), allowInsecureLoopback(env));
}

/** ADMIN_AUTH_SECRETS ("<version>:<64 hex>,...", newest first; versions and secrets distinct). */
export function parseAuthSecrets(raw: string | undefined): AuthSecret[] {
  const fail = (): never => {
    throw new AdminConfigError('ADMIN_AUTH_SECRETS must be "<version>:<64 hex characters>,..." with distinct versions and distinct secrets');
  };
  if (raw === undefined) return fail();
  const versions = new Set<number>();
  const values = new Set<string>();
  return raw.split(",").map((entry) => {
    const match = /^\s*(\d{1,6}):([0-9a-fA-F]{64})\s*$/.exec(entry);
    if (match === null) return fail();
    const version = Number(match[1]);
    const value = match[2] ?? "";
    if (versions.has(version) || values.has(value.toLowerCase())) return fail();
    versions.add(version);
    values.add(value.toLowerCase());
    return { version, value };
  });
}

export function loadAdminConfig(env: Env): AdminConfig {
  const production = isProduction(env);
  const origin = parseOrigin(value(env, "ADMIN_ORIGIN"), allowInsecureLoopback(env));
  if (origin === null) throw new AdminConfigError("ADMIN_ORIGIN must be an origin like https://host[:port]");
  const authSecrets = parseAuthSecrets(value(env, "ADMIN_AUTH_SECRETS"));
  const databaseUrl = value(env, "DATABASE_URL_ADMIN");
  let protocol = "";
  try {
    protocol = new URL(databaseUrl ?? "").protocol;
  } catch {
    // reported below
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new AdminConfigError("DATABASE_URL_ADMIN must be a postgres:// or postgresql:// URL");
  }
  return { production, origin, authSecrets, databaseUrl: databaseUrl as string };
}
