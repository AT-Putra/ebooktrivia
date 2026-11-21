// Internal role configuration (internal.env). The internal process holds NO keys: it connects as a
// login role in group internal_rw (EXECUTE lp_served_hosts, INSERT alerts) and knows only the SHA-256 of
// the GlitchTip hook token, never the token. Its environment is an ALLOWLIST (security review
// US-013 #3a): every name outside INTERNAL_ENV and RUNTIME_ENV is refused, checked by name without
// reading the value, so a misplaced line of another process's env (a key, a database URL, a token
// under any name) stops the process instead of putting a credential into it. Run it with a
// curated environment (the M4 quadlet), not from a shell or a package-manager script.
import { isIP } from "node:net";
import { ConfigError, type Env, int, type LogLevel, logLevel, nodeEnv, type NodeEnv, optional, postgresUrl, required } from "./env.ts";

/** Every variable the internal process reads. */
export const INTERNAL_ENV = [
  "NODE_ENV",
  "LOG_LEVEL",
  "DATABASE_URL_INTERNAL",
  "GLITCHTIP_HOOK_TOKEN_SHA256",
  "INTERNAL_HOST",
  "INTERNAL_PORT",
  "INTERNAL_DOMAINS_RELOAD_MS",
  "INTERNAL_HOOK_RATE_PER_MINUTE",
] as const;

/** Names the OS, the container runtime or Node set; each one is needed or harmless. */
export const RUNTIME_ENV = [
  "PATH", // executable lookup
  "Path", // the same on Windows
  "HOME", // os.homedir() (POSIX)
  "USERPROFILE", // os.homedir() (Windows)
  "HOSTNAME", // set by container runtimes
  "container", // set by podman
  "PWD", // set by podman for every container (the working directory; US-014 found it in the quadlet)
  "TZ", // time zone
  "LANG", // locale
  "NODE_OPTIONS", // Node runtime flags, operator-controlled
  "NODE_VERSION", // set by the official node images
  "YARN_VERSION", // set by the official node images
  "SystemRoot", // Windows: Winsock and DNS need it
  "SYSTEMROOT",
  "WINDIR", // Windows system directory
  "TEMP", // os.tmpdir() (Windows)
  "TMP",
  "APPDATA", // Windows: where the postgres driver looks for pgpass
  // Windows: libuv copies these into every child process environment, even an explicit one.
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
] as const;

const ACCEPTED = new Set<string>([...INTERNAL_ENV, ...RUNTIME_ENV]);

export interface InternalConfig {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
  readonly hookTokenSha256: Buffer;
  readonly host: string;
  readonly port: number;
  /** Safety-net full reload of the served-hosts set (NOTIFY does the fast path). */
  readonly domainsReloadMs: number;
  readonly hookRatePerMinute: number;
}

export function loadInternalConfig(env: Env): InternalConfig {
  // Object.keys only lists names (ownKeys); no foreign value is read.
  const foreign = Object.keys(env).filter((name) => !ACCEPTED.has(name));
  if (foreign.length > 0) {
    throw new ConfigError(`${foreign.sort().join(", ")}: not accepted by the internal process (it holds no keys or other roles' settings)`);
  }
  const mode = nodeEnv(env);
  const tokenHash = required(env, "GLITCHTIP_HOOK_TOKEN_SHA256");
  if (!/^[0-9a-fA-F]{64}$/.test(tokenHash)) throw new ConfigError("GLITCHTIP_HOOK_TOKEN_SHA256 must be 64 hex characters");
  const host = optional(env, "INTERNAL_HOST") ?? "127.0.0.1";
  if (isIP(host) === 0) throw new ConfigError("INTERNAL_HOST must be an IP address");
  return {
    nodeEnv: mode,
    logLevel: logLevel(env),
    databaseUrl: postgresUrl(env, "DATABASE_URL_INTERNAL"),
    hookTokenSha256: Buffer.from(tokenHash, "hex"),
    host,
    port: int(env, "INTERNAL_PORT", 9000, 0, 65_535),
    domainsReloadMs: int(env, "INTERNAL_DOMAINS_RELOAD_MS", 60_000, 100, 3_600_000),
    hookRatePerMinute: int(env, "INTERNAL_HOOK_RATE_PER_MINUTE", 60, 1, 10_000),
  };
}
