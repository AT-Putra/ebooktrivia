// Delivery settings of the worker (US-025), from worker.env. Parsed with the strict helpers of env.ts: a bad value stops
// the worker at start, and a message names the variable, never its value.
//
//   DOMAIN                         the base domain: the player's login link is https://play.<DOMAIN>/masuk#... and the
//                                  ebook download URL WAHA (and the e-mail fallback) fetches is https://api.<DOMAIN>/files/...
//                                  Required with the messaging key (the same value as public.env).
//   WORKER_DATA_DIR                where the ebook PDFs live, `deliverables/<id>.pdf` under it (default /srv/data; the quadlet
//                                  mounts /srv/data/deliverables read-only).
//   WORKER_DELIVERY_LEASE_MS       how long a claimed delivery is `sending` before the lease sweeper calls it unknown
//                                  (default 200000). It covers the longest wait for a send slot (core POOL_MAX_WAIT_MS), the wait for a contact gap
//                                  (CONTACT_MAX_WAIT_MS), the human-like pauses and presence calls (HUMAN_MAX_MS) and
//                                  WORKER_WAHA_TIMEOUT_MS, with a margin.
//   WORKER_WAHA_TIMEOUT_MS         whole-request timeout of a WAHA send (default 60000: WAHA downloads the PDF, then uploads it).
//   WORKER_SMTP_TIMEOUT_MS         per-phase SMTP timeout (default 30000: the ebook is attached).
//   WORKER_EMAIL_ATTACH_MAX_BYTES  an ebook larger than this goes as a signed link instead of an attachment (default 15 MiB: base64
//                                  grows it by a third, and common mail servers refuse above 25 MB). An attachment that the server
//                                  refuses for its size falls back to the same link.
//   WORKER_SESSION_POLL_INTERVAL_MS how often every pool number's status is polled (default 30000); its WhatsApp limits (timelock, capping) every 3 minutes.
//   WORKER_WA_WARNING_FACTORS      "first,second": the share of a number's daily budget of NEW contacts (waha_sessions.new_contact_cap) that WhatsApp's
//                                  FIRST_WARNING and SECOND_WARNING leave it (default 0.5,0.25).
// The signed-URL key is derived from SECRETS_PAYMENT_PRIVATE_KEY (packages/crypto file-url-key.ts), which public.env holds too.
import { CONTACT_MAX_WAIT_MS, DEFAULT_WARNING_CAP_FACTORS, HUMAN_MAX_MS, POOL_MAX_WAIT_MS, normalizeHost } from "@ebooktrivia/core";
import { fileUrlKeyFromEnv } from "@ebooktrivia/crypto";
import { ConfigError, type Env, int, optional } from "../env.ts";
import type { WorkerConfig } from "../worker-config.ts";

export interface DeliveryConfig {
  /** https://play.<DOMAIN>: the only origin a {link_trivia} may have. */
  readonly playOrigin: string;
  /** https://api.<DOMAIN>: where the signed ebook URLs point. */
  readonly apiOrigin: string;
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

/** The shortest lease that covers the worst-case sequence before and during a send (core human-send): slot, contact gap, the lookup, the pauses, the request. */
export const leaseFloorMs = (wahaTimeoutMs: number): number => wahaTimeoutMs + POOL_MAX_WAIT_MS + CONTACT_MAX_WAIT_MS + LOOKUP_MAX_MS + HUMAN_MAX_MS + LEASE_MARGIN_MS;

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

export function loadDeliveryConfig(env: Env, worker: Pick<WorkerConfig, "dev">): DeliveryConfig {
  const rawDomain = optional(env, "DOMAIN");
  const domain = rawDomain === undefined ? null : normalizeHost(rawDomain);
  if (domain === null || domain !== rawDomain || !domain.includes(".")) throw new ConfigError("DOMAIN must be a lowercase host name such as example.id (punycode for IDN, no trailing dot)");
  const fileUrlKey = fileUrlKeyFromEnv(env);
  if (fileUrlKey === undefined) throw new ConfigError("SECRETS_PAYMENT_PRIVATE_KEY is required for deliveries (the signed ebook URLs are keyed from it)");
  const wahaTimeoutMs = int(env, "WORKER_WAHA_TIMEOUT_MS", 60_000, 1000, 300_000);
  const leaseMs = int(env, "WORKER_DELIVERY_LEASE_MS", Math.max(200_000, leaseFloorMs(wahaTimeoutMs)), 10_000, 3_600_000);
  if (leaseMs < leaseFloorMs(wahaTimeoutMs)) {
    throw new ConfigError(`WORKER_DELIVERY_LEASE_MS must be at least WORKER_WAHA_TIMEOUT_MS + ${String(leaseFloorMs(0))} ms (the waits for a send slot, the contact gap and the human-like pauses, and a margin)`);
  }
  return {
    playOrigin: `https://play.${domain}`,
    apiOrigin: `https://api.${domain}`,
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
