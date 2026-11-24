// Settings configuration of the admin app (US-017), from admin.env, read once at startup by
// createRuntime (lib/auth/runtime.ts); kept out of lib/config.ts so the proxy does not load it.
// Messages name the variable, never its value.
//
//   DOMAIN               the base domain (admin./play./order./api.<DOMAIN>): the LP snippet loads
//                        https://api.<DOMAIN>/sdk/v1.js, and no LP domain may share its registrable
//                        domain (lib/settings/lp-domains.ts). Unset: LP domains and snippets are
//                        unavailable (fail closed).
//   ADMIN_DATA_DIR       absolute path of the data directory (/srv/data on the VM): ebook PDFs go to
//                        <dir>/deliverables, chunked uploads are staged in <dir>/upload-staging.
//                        Unset: uploads are unavailable.
//   ADMIN_LP_DIR         absolute path of the landing-page root (/srv/lp on the VM, US-023): uploaded LP
//                        ZIPs are extracted to <dir>/versions/<lpId>/<version> (staged in
//                        <dir>/.staging on the same filesystem) and each domain's <dir>/hosts/<host>/current
//                        symlink is switched to the live version; Caddy serves <dir>/hosts read-only.
//                        The uploaded ZIP itself is kept in ADMIN_DATA_DIR/lp-zips. Unset (or no
//                        ADMIN_DATA_DIR): LP hosting is unavailable.
//   ADMIN_PDF_MAX_BYTES  the PDF hard cap (plan M2.5; default and maximum 100 MiB, at least 1 MiB).
//                        PDFs over 20 MiB need the uploader's confirmation of the size warning.
//                        The assembled file is streamed (hashed and copied), never held in memory.
//   ADMIN_UPLOAD_MAX_OPEN_SESSIONS / ADMIN_UPLOAD_MAX_STAGED_BYTES
//                        per admin: unfinished uploads at once (default 3, 1..20) and their declared
//                        bytes together (default 300 MiB, at least the PDF cap, at most 2 GiB), so
//                        staging cannot fill the disk (security review US-017 M1).
//   SECRETS_<SCOPE>_PUBLIC_KEY
//                        the sealing keys (payment, messaging, conversions; @ebooktrivia/crypto).
//                        The admin app writes secrets it can never read back. None set: secret
//                        fields are disabled.
//   SECRETS_<SCOPE>_PRIVATE_KEY
//                        REFUSED: admin.env must not hold any private key (plan M2.3, T1: the admin
//                        process cannot decrypt). Startup fails if one is present, even empty.
import { isAbsolute } from "node:path";
import { normalizeHost } from "@ebooktrivia/core";
import { isCryptoError, SECRET_SCOPES, type SecretSealer, sealerFromEnv } from "@ebooktrivia/crypto/sealer";
import { getDomain } from "tldts";
import { AdminConfigError, type Env } from "../config.ts";

const MiB = 1024 * 1024;
export const PDF_WARN_BYTES = 20 * MiB;
export const DEFAULT_PDF_MAX_BYTES = 100 * MiB;
const PDF_MAX_RANGE = { min: MiB, max: 100 * MiB } as const;

export interface SettingsConfig {
  readonly domain: string | null;
  readonly dataDir: string | null;
  readonly lpDir: string | null;
  readonly pdfMaxBytes: number;
  readonly uploadMaxOpenSessions: number;
  readonly uploadMaxStagedBytes: number;
  /** Built from public keys only; it has no method that decrypts. */
  readonly sealer: SecretSealer | null;
}

/** Nothing configured: every setting that needs one of these is unavailable. */
export const DEFAULT_UPLOAD_MAX_OPEN_SESSIONS = 3;
export const DEFAULT_UPLOAD_MAX_STAGED_BYTES = 300 * MiB;

export const NO_SETTINGS: SettingsConfig = Object.freeze({
  domain: null,
  dataDir: null,
  lpDir: null,
  pdfMaxBytes: DEFAULT_PDF_MAX_BYTES,
  uploadMaxOpenSessions: DEFAULT_UPLOAD_MAX_OPEN_SESSIONS,
  uploadMaxStagedBytes: DEFAULT_UPLOAD_MAX_STAGED_BYTES,
  sealer: null,
});

/** A whole number from the environment within [min, max], or the default when unset. */
function bounded(env: Env, name: string, fallback: number, min: number, max: number, unit: string): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new AdminConfigError(`${name} must be a whole number from ${String(min)} to ${String(max)} ${unit}`);
  return n;
}

const value = (env: Env, name: string): string | undefined => {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
};

/** The names of private-key variables present in `env` (set at all, even empty). */
export function privateKeyVariables(env: Env): string[] {
  return Object.keys(env).filter((name) => /^SECRETS_.*PRIVATE_KEY/i.test(name));
}

/** DOMAIN in its stored form (lowercase ASCII, punycode, no trailing dot) with a registrable domain. */
export function parseDomain(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const host = normalizeHost(raw);
  if (host === null || host !== raw) throw new AdminConfigError("DOMAIN must be a lowercase host name such as example.id (punycode for IDN, no trailing dot)");
  if (getDomain(host, { allowPrivateDomains: true }) === null) throw new AdminConfigError("DOMAIN must have a registrable domain (it is a public suffix)");
  return host;
}

export function loadSettingsConfig(env: Env): SettingsConfig {
  const leaked = privateKeyVariables(env);
  if (leaked.length > 0) {
    throw new AdminConfigError(`${leaked.join(", ")}: admin.env must not hold a private key (the admin app only seals secrets)`);
  }
  const dataDir = value(env, "ADMIN_DATA_DIR");
  if (dataDir !== undefined && !isAbsolute(dataDir)) throw new AdminConfigError("ADMIN_DATA_DIR must be an absolute path");
  const lpDir = value(env, "ADMIN_LP_DIR");
  if (lpDir !== undefined && !isAbsolute(lpDir)) throw new AdminConfigError("ADMIN_LP_DIR must be an absolute path");
  const pdfMaxBytes = bounded(env, "ADMIN_PDF_MAX_BYTES", DEFAULT_PDF_MAX_BYTES, PDF_MAX_RANGE.min, PDF_MAX_RANGE.max, "bytes (1 MiB to 100 MiB)");
  const uploadMaxOpenSessions = bounded(env, "ADMIN_UPLOAD_MAX_OPEN_SESSIONS", DEFAULT_UPLOAD_MAX_OPEN_SESSIONS, 1, 20, "sessions");
  const uploadMaxStagedBytes = bounded(env, "ADMIN_UPLOAD_MAX_STAGED_BYTES", DEFAULT_UPLOAD_MAX_STAGED_BYTES, pdfMaxBytes, 2048 * MiB, "bytes (the PDF cap to 2 GiB)");
  let sealer: SecretSealer | null = null;
  if (SECRET_SCOPES.some((scope) => value(env, `SECRETS_${scope.toUpperCase()}_PUBLIC_KEY`) !== undefined)) {
    try {
      sealer = sealerFromEnv(env);
    } catch (error) {
      if (isCryptoError(error)) throw new AdminConfigError("SECRETS_<SCOPE>_PUBLIC_KEY must be base64url X25519 public keys");
      throw error;
    }
  }
  return { domain: parseDomain(value(env, "DOMAIN")), dataDir: dataDir ?? null, lpDir: lpDir ?? null, pdfMaxBytes, uploadMaxOpenSessions, uploadMaxStagedBytes, sealer };
}
