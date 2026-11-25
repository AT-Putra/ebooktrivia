// Delivery settings of the worker (US-025), from worker.env. Parsed with the strict helpers of env.ts: a bad value stops
// the worker at start, and a message names the variable, never its value.
//
//   DOMAIN                         the base domain: the player's login link is https://play.<DOMAIN>/masuk#... and the
//                                  ebook download URL WAHA (and the e-mail fallback) fetches is https://api.<DOMAIN>/files/...
//                                  Required with the messaging key (the same value as public.env).
//   WORKER_DATA_DIR                where the ebook PDFs live, `deliverables/<id>.pdf` under it (default /srv/data; the quadlet
//                                  mounts /srv/data/deliverables read-only).
//   WORKER_DELIVERY_LEASE_MS       how long a claimed delivery is `sending` before the lease sweeper calls it unknown
//                                  (default 210000). It covers the longest wait for a send slot (core POOL_MAX_WAIT_MS), the wait for a contact gap
//                                  (CONTACT_MAX_WAIT_MS), the lookup of a first contact (LOOKUP_MAX_MS), the pre-flight of a file send (PREFLIGHT_TIMEOUT_MS), the
//                                  human-like pauses and presence calls (HUMAN_MAX_MS), WORKER_WAHA_TIMEOUT_MS and the read-back after a file send
//                                  (READBACK_TIMEOUT_MS), with a margin.
//   WORKER_WAHA_TIMEOUT_MS         whole-request timeout of a WAHA send (default 60000: WAHA downloads the PDF, then uploads it).
//   WORKER_SMTP_TIMEOUT_MS         per-phase SMTP timeout (default 30000: the ebook is attached).
//   WORKER_EMAIL_ATTACH_MAX_BYTES  an ebook larger than this goes as a signed link instead of an attachment (default 15 MiB: base64
//                                  grows it by a third, and common mail servers refuse above 25 MB). An attachment that the server
//                                  refuses for its size falls back to the same link.
//   WORKER_SESSION_POLL_INTERVAL_MS how often every pool number's status is polled (default 30000); its WhatsApp limits (timelock, capping) every 3 minutes.
//   WORKER_WA_WARNING_FACTORS      "first,second": the share of a number's daily budget of NEW contacts (waha_sessions.new_contact_cap) that WhatsApp's
//                                  FIRST_WARNING and SECOND_WARNING leave it (default 0.5,0.25).
//   WORKER_API_EDGE_ADDRESS        the edge proxy's (Caddy's) PRIVATE address on the pre-flight network (the quadlet sets 10.90.55.2): the pre-flight of a
//                                  file send connects there for api.<DOMAIN> instead of the public address, TLS still checked against that name. A
//                                  rootless container on the same VM cannot reach the VM's own public address (pasta gives the containers that address,
//                                  and the egress guard keeps the app user off the host's addresses), so without it every WhatsApp file is
//                                  `file_unavailable`. Unset: the public address, as WAHA uses it. Never a loopback, link-local or metadata address.
// The signed-URL key is derived from SECRETS_PAYMENT_PRIVATE_KEY (packages/crypto file-url-key.ts), which public.env holds too.
import { isIP } from "node:net";
import { isBlockedAddress } from "@ebooktrivia/adapters";
import { CONTACT_MAX_WAIT_MS, DEFAULT_WARNING_CAP_FACTORS, HUMAN_MAX_MS, HUMAN_PRESENCE_TIMEOUT_MS, POOL_MAX_WAIT_MS, normalizeHost } from "@ebooktrivia/core";
import { fileUrlKeyFromEnv } from "@ebooktrivia/crypto";
import { ConfigError, type Env, int, optional } from "../env.ts";
import type { WorkerConfig } from "../worker-config.ts";

export interface DeliveryConfig {
  /** https://play.<DOMAIN>: the only origin a {link_trivia} may have. */
  readonly playOrigin: string;
  /** https://api.<DOMAIN>: where the signed ebook URLs point. */
  readonly apiOrigin: string;
  /** The edge proxy's private address the pre-flight connects to for api.<DOMAIN> (WORKER_API_EDGE_ADDRESS), or null: the public address. */
  readonly apiEdgeAddress: string | null;
  readonly dataDir: string;
  readonly fileUrlKey: Uint8Array;
  readonly leaseMs: number;
  readonly wahaTimeoutMs: number;
  readonly smtpTimeoutMs: number;
  readonly emailAttachMaxBytes: number;
  /** How long the e-mail fallback link lives: as long as a magic link (72 h). */
  readonly emailLinkTtlSeconds: number;
  readonly sessionPollIntervalMs: number;
  /** The share of a number's new-contact budget each WhatsApp capping warning leaves (WORKER_WA_WARNING_FACTORS). */
  readonly warningCapFactors: readonly [number, number];
  /** A message the unknown-send lookup matches may be this far outside the lease (clock skew between the VM and the WAHA box). */
  readonly unknownSkewMs: number;
  readonly dev: WorkerConfig["dev"];
}

/** Margin between the end of the longest send (slot wait, contact gap, human-like pauses and the request) and the end of the lease. */
export const LEASE_MARGIN_MS = 10_000;

/** The longest a check-exists lookup (WhatsApp is asked where a first contact lives) can take before the send: the adapter's budget. */
export const LOOKUP_MAX_MS = 10_000;

/**
 * The longest the pre-flight of a file send (the worker fetches its own signed URL, US-005 R11) can take: its own whole-request budget (connect, headers, the first
 * bytes), short on purpose: WAHA's own download of the PDF is not what is being waited for, only a route that answers.
 */
export const PREFLIGHT_TIMEOUT_MS = 5000;

/** The longest the read-back of a file send (getMessage: the size WAHA delivered, US-005 R11) can take: a best-effort call like the presence ones. */
export const READBACK_TIMEOUT_MS = HUMAN_PRESENCE_TIMEOUT_MS;

/**
 * The shortest lease that covers the worst-case sequence before and during a send (core human-send): slot, contact gap, the lookup (an opener), the pre-flight (a
 * file), the pauses, the request and the read-back after it (a file). Both are counted although no one flow has both the lookup and the pre-flight.
 */
export const leaseFloorMs = (wahaTimeoutMs: number): number =>
  wahaTimeoutMs + POOL_MAX_WAIT_MS + CONTACT_MAX_WAIT_MS + LOOKUP_MAX_MS + PREFLIGHT_TIMEOUT_MS + HUMAN_MAX_MS + READBACK_TIMEOUT_MS + LEASE_MARGIN_MS;

/** The default lease: round, and never below the floor of the default WAHA timeout. */
export const DEFAULT_LEASE_MS = 210_000;

/**
 * WORKER_WA_WARNING_FACTORS="first,second": the share of a number's daily budget of NEW contacts that WhatsApp's FIRST_WARNING and SECOND_WARNING leave it
 * (default 0.5,0.25; each 0 to 1, the second not above the first). A number's budget itself is waha_sessions.new_contact_cap.
 */
export function loadWarningFactors(env: Env): readonly [number, number] {
  const raw = optional(env, "WORKER_WA_WARNING_FACTORS");
  if (raw === undefined) return DEFAULT_WARNING_CAP_FACTORS;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  const [first, second] = parts;
  const ok = parts.length === 2 && first !== undefined && second !== undefined && Number.isFinite(first) && Number.isFinite(second) && first >= 0 && first <= 1 && second >= 0 && second <= first;
  if (!ok) throw new ConfigError("WORKER_WA_WARNING_FACTORS must be two numbers from 0 to 1, \"first,second\", the second not above the first");
  return [first, second];
}

/** WORKER_API_EDGE_ADDRESS: an IP address the private-network allowlist accepts (never loopback, link-local or metadata; loopback in dev only), or null. */
export function loadApiEdgeAddress(env: Env, worker: Pick<WorkerConfig, "dev">): string | null {
  const raw = optional(env, "WORKER_API_EDGE_ADDRESS");
  if (raw === undefined) return null;
  if (isIP(raw) === 0 || isBlockedAddress(raw, { allowPrivate: true, allowLoopback: worker.dev.allowLoopback })) {
    throw new ConfigError("WORKER_API_EDGE_ADDRESS must be the edge proxy's private IP address (never a loopback, link-local or metadata address)");
  }
  return raw;
}

export function loadDeliveryConfig(env: Env, worker: Pick<WorkerConfig, "dev">): DeliveryConfig {
  const rawDomain = optional(env, "DOMAIN");
  const domain = rawDomain === undefined ? null : normalizeHost(rawDomain);
  if (domain === null || domain !== rawDomain || !domain.includes(".")) throw new ConfigError("DOMAIN must be a lowercase host name such as example.id (punycode for IDN, no trailing dot)");
  const fileUrlKey = fileUrlKeyFromEnv(env);
  if (fileUrlKey === undefined) throw new ConfigError("SECRETS_PAYMENT_PRIVATE_KEY is required for deliveries (the signed ebook URLs are keyed from it)");
  const wahaTimeoutMs = int(env, "WORKER_WAHA_TIMEOUT_MS", 60_000, 1000, 300_000);
  const leaseMs = int(env, "WORKER_DELIVERY_LEASE_MS", Math.max(DEFAULT_LEASE_MS, leaseFloorMs(wahaTimeoutMs)), 10_000, 3_600_000);
  if (leaseMs < leaseFloorMs(wahaTimeoutMs)) {
    throw new ConfigError(
      `WORKER_DELIVERY_LEASE_MS must be at least WORKER_WAHA_TIMEOUT_MS + ${String(leaseFloorMs(0))} ms (the waits for a send slot, the contact gap, the lookup and the file pre-flight, the human-like pauses, the read-back, and a margin)`,
    );
  }
  return {
    playOrigin: `https://play.${domain}`,
    apiOrigin: `https://api.${domain}`,
    apiEdgeAddress: loadApiEdgeAddress(env, worker),
    dataDir: optional(env, "WORKER_DATA_DIR") ?? "/srv/data",
    fileUrlKey,
    leaseMs,
    wahaTimeoutMs,
    smtpTimeoutMs: int(env, "WORKER_SMTP_TIMEOUT_MS", 30_000, 1000, 300_000),
    emailAttachMaxBytes: int(env, "WORKER_EMAIL_ATTACH_MAX_BYTES", 15 * 1024 * 1024, 1, 100 * 1024 * 1024),
    emailLinkTtlSeconds: 72 * 3600,
    sessionPollIntervalMs: int(env, "WORKER_SESSION_POLL_INTERVAL_MS", 30_000, 1000, 600_000),
    warningCapFactors: loadWarningFactors(env),
    unknownSkewMs: 60_000,
    dev: worker.dev,
  };
}
