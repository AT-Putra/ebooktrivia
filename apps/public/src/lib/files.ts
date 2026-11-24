// GET api.<DOMAIN>/files/deliverables/<upload id>.pdf?exp=..&sig=..&n=.. (US-025; plan M3.3, M2.5): the ebook PDF, served only to a holder of
// a signed URL. The worker mints the URL (adapters signFileUrl; the key is derived from the payment-scope private key both apps
// hold, packages/crypto file-url-key.ts): WAHA fetches it to send the file over WhatsApp (10 minutes, usable several times, WAHA may
// retry the download), and the e-mail fallback for an ebook the SMTP server would not carry holds one for 72 hours.
//
//   - Only the api origin: any other host is a 404, so the route does not exist on the play, order or landing-page origins.
//   - Only `/files/deliverables/<uuid>.pdf`: the path is matched whole, never joined from the request, so no traversal is possible.
//   - The signature (HMAC-SHA256 of the path and the expiry, constant time) and the expiry are checked before the disk is touched; a
//     missing, malformed, wrong or expired signature is one answer (403) that says nothing about which.
//   - A Valkey limit PER SIGNED URL (at most FILE_URL_CAP downloads of one URL, counted for the life of the URL), not per client IP: WAHA
//     downloads from one address for every delivery of a burst, and a per-IP limit there would stop deliveries. It also caps a leaked link.
//     Counted only for a valid signature (a flood of forged URLs costs one HMAC each). With Valkey down, a short-lived URL (WAHA's, 10 minutes
//     or less) is served anyway: the HMAC already authenticates it and it expires on its own; a long one (the 72 h e-mail link) fails closed.
//   - The file is streamed from /srv/data/deliverables (mounted read-only here), opened without following a link and read from the open
//     handle (a link at its name is as good as no file: 404, lib/safe-file.ts); `nosniff`, `Content-Disposition: attachment` and a CSP
//     `sandbox` are always sent (the file is never rendered on our origin), and nothing is cached.
// The URL is a bearer credential: the query is never logged (Caddy redacts /files/ URIs, infra/caddy/Caddyfile), only an outcome code.
import { join } from "node:path";
import { Readable } from "node:stream";
import { verifyFileUrl } from "@ebooktrivia/adapters";
import { createHash } from "node:crypto";
import type { Logger } from "./log.ts";
import { openRegularFile } from "./safe-file.ts";
import { hitRateLimits, isValkeyUnavailable, type Valkey } from "./valkey.ts";

/** Downloads of one signed URL (WAHA may retry a fetch; a leaked link is worth this many). */
export const FILE_URL_CAP = 10;
/** A URL with at most this long left is WAHA's (the worker mints those with FILE_URL_TTL_SECONDS): served even while Valkey is down. */
export const SHORT_URL_SECONDS = 600;

/**
 * The rate-limit key of a URL: a digest of what the signature covers (the path, the expiry and the URL's own random nonce `n`), never the signature or the path
 * itself. The nonce makes every minted URL its own counter: a pre-flight URL and WAHA's, or two URLs of one file that expire in the same second, never share one.
 */
export const urlKey = (path: string, exp: string, nonce: string): string => createHash("sha256").update(`ebooktrivia/files-url/v2|${path}|${exp}|${nonce}`).digest("hex").slice(0, 32);

/** The one path served: the admin upload's storage path (`deliverables/<id>.pdf`) under /files. */
const PATH = /^\/files\/(deliverables\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf)$/;

export interface FilesDeps {
  readonly valkey: Valkey;
  readonly domain: string;
  /** The data directory (default /srv/data): `deliverables/<id>.pdf` lives under it. */
  readonly dataDir: string;
  /** The signed-URL key; undefined closes the route. */
  readonly key: Uint8Array | undefined;
  readonly log: Logger;
  readonly now?: () => Date;
}

const HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
} as const;

const plain = (status: number, extra: Record<string, string> = {}): Response => new Response(null, { status, headers: { ...HEADERS, ...extra } });

export async function handleFileDownload(deps: FilesDeps, request: Request): Promise<Response> {
  const log = (level: "info" | "warn" | "error", event: string, fields: Record<string, string | number> = {}, error?: unknown): void => {
    deps.log(level, event, { route: "files", ...fields }, error);
  };
  const host = (request.headers.get("host") ?? "").trim().toLowerCase().replace(/:[0-9]{1,5}$/, "");
  if (host !== `api.${deps.domain}`) return plain(404);
  const url = new URL(request.url);
  const storagePath = PATH.exec(url.pathname)?.[1];
  if (storagePath === undefined) return plain(404);
  if (deps.key === undefined) {
    log("error", "files.refused", { reason: "key_not_configured" });
    return plain(503, { "retry-after": "30" });
  }
  const checked = verifyFileUrl({ path: url.pathname, exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig"), nonce: url.searchParams.get("n"), key: deps.key, now: (deps.now ?? (() => new Date()))() });
  if (!checked.ok) {
    log("warn", "files.refused", { reason: checked.reason });
    return plain(403);
  }
  // Per signed URL, for as long as the URL lives (verifyFileUrl has checked that exp is valid, so it is a whole number of seconds, and that n is the URL's nonce).
  const secondsLeft = Number(url.searchParams.get("exp")) - Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);
  try {
    const limited = await hitRateLimits(deps.valkey, [
      { key: `files:url:${urlKey(url.pathname, url.searchParams.get("exp") ?? "", url.searchParams.get("n") ?? "")}`, limit: FILE_URL_CAP, windowMs: Math.max(1000, secondsLeft * 1000) },
    ]);
    if (!limited.allowed) {
      log("warn", "files.refused", { reason: "rate_limited" });
      return plain(429, { "retry-after": String(limited.retryAfterSeconds) });
    }
  } catch (error) {
    if (!isValkeyUnavailable(error)) throw error;
    if (secondsLeft > SHORT_URL_SECONDS) {
      log("error", "files.failed", { reason: "valkey_unavailable" }, error);
      return plain(503, { "retry-after": "5" });
    }
    // A short-lived URL (WAHA's) is authenticated by its signature and expires on its own: not a reason to stop a delivery.
    log("warn", "files.degraded", { reason: "valkey_unavailable_short_url" }, error);
  }
  // Opened without following a link (a link at the file's name is as good as no file) and streamed from the open handle (lib/safe-file.ts).
  const opened = await openRegularFile(join(deps.dataDir, storagePath)).catch(() => null);
  if (opened === null) {
    log("warn", "files.refused", { reason: "missing_file" });
    return plain(404);
  }
  log("info", "files.served", { outcome: "ok", count: opened.size });
  return new Response(Readable.toWeb(opened.handle.createReadStream()) as ReadableStream, {
    status: 200,
    headers: { ...HEADERS, "content-type": "application/pdf", "content-length": String(opened.size), "content-disposition": 'attachment; filename="ebook.pdf"' },
  });
}
