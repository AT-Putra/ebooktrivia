// The real delivery ports (US-025): WAHA clients, the SMTP sender and the ebook files, all with the messaging private key
// (worker.env SECRETS_MESSAGING_PRIVATE_KEY). Each use re-reads its endpoint and sealed secret from PostgreSQL and checks the
// endpoint binding before the secret is opened, so an Owner key or host change applies at once and a key is never sent to a host
// it was not bound to (the same rules as the template test-send, test-send-senders.ts):
//   - WAHA: the session's server and waha.<server>.api_key go through assertWahaTarget; the key is only sent to the URL it returns,
//     over a safe-fetch whose private-network allowlist holds that server's host only when the server has allow_private_ip;
//   - SMTP: smtp.password must be bound to smtp_settings.host; mail goes through adapters sendMail (resolve + address policy, TLS).
// Errors name a code, never a key, a host or an address.
import { createSafeFetch, createWahaClient, sendMail, signFileUrl } from "@ebooktrivia/adapters";
import { assertWahaTarget, CryptoError, type SecretOpener } from "@ebooktrivia/crypto";
import { SECRET_NAMES, type SettingsSecretRow } from "@ebooktrivia/db";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type postgres from "postgres";
import { type DeliveryConfig, PREFLIGHT_TIMEOUT_MS } from "./config.ts";
import { type EbookFiles, MailAccessError, type MailSender, type OutgoingMail, WahaAccessError, type WahaAccess } from "./ports.ts";

async function messagingSecret(sql: postgres.Sql, name: string): Promise<SettingsSecretRow | undefined> {
  const [row] = await sql<SettingsSecretRow[]>`
    SELECT id, scope, name, adnet_id AS "adnetId", bound_host AS "boundHost", key_id AS "keyId", ciphertext, nonce, sealed_dek AS "sealedDek"
      FROM public.settings_secrets WHERE scope = 'messaging' AND name = ${name} AND adnet_id IS NULL`;
  return row;
}

function openSecret(opener: SecretOpener, row: SettingsSecretRow, unreadable: () => Error): string {
  try {
    return opener.openSecret(row);
  } catch (error) {
    if (error instanceof CryptoError) throw unreadable();
    throw error;
  }
}

export function createWahaAccess(deps: { readonly sql: postgres.Sql; readonly opener: SecretOpener; readonly config: Pick<DeliveryConfig, "dev" | "wahaTimeoutMs"> }): WahaAccess {
  const { sql, opener, config } = deps;
  return {
    async withSession(sessionId, use, options) {
      const [session] = await sql<{ session_name: string; server_id: string; base_url: string; base_url_host: string; allow_private_ip: boolean; active: boolean }[]>`
        SELECT s.session_name, s.server_id, w.base_url, w.base_url_host, w.allow_private_ip, (s.active AND w.active) AS active
          FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id WHERE s.id = ${sessionId}`;
      if (session === undefined || !session.active) throw new WahaAccessError("session_unusable");
      const row = await messagingSecret(sql, SECRET_NAMES.wahaApiKey(session.server_id));
      if (row === undefined) throw new WahaAccessError("key_missing");
      let target: URL;
      try {
        target = assertWahaTarget({ baseUrl: session.base_url, baseUrlHost: session.base_url_host }, row);
      } catch {
        throw new WahaAccessError("binding_mismatch");
      }
      const apiKey = openSecret(opener, row, () => new WahaAccessError("key_unreadable"));
      const fetch = createSafeFetch({
        allowHttp: config.dev.allowHttp,
        devAllowLoopback: config.dev.allowLoopback,
        timeoutMs: options?.timeoutMs ?? config.wahaTimeoutMs,
        // The allowlist covers an IPv4 literal only (the DB CHECK waha_servers_allow_private_ip_check enforces it too).
        ...(session.allow_private_ip && isIP(target.hostname) === 4 ? { allowPrivateHosts: [session.base_url_host] } : {}),
      });
      try {
        return await use({ sessionName: session.session_name, client: createWahaClient({ target, apiKey, fetch }) });
      } finally {
        await fetch.close();
      }
    },
  };
}

export function createMailSender(deps: { readonly sql: postgres.Sql; readonly opener: SecretOpener; readonly config: Pick<DeliveryConfig, "dev" | "smtpTimeoutMs"> }): MailSender {
  const { sql, opener, config } = deps;
  return {
    async send(message: OutgoingMail) {
      const [server] = await sql<{ host: string; port: number; username: string | null; from_address: string; from_name: string | null; allow_private_ip: boolean }[]>`
        SELECT host, port, username, from_address, from_name, allow_private_ip FROM public.smtp_settings`;
      if (server === undefined) throw new MailAccessError("smtp_not_configured");
      const row = await messagingSecret(sql, SECRET_NAMES.smtpPassword);
      if (row !== undefined && row.boundHost !== server.host) throw new MailAccessError("binding_mismatch");
      const password = row === undefined ? undefined : openSecret(opener, row, () => new MailAccessError("key_unreadable"));
      if (server.username !== null && password === undefined) throw new MailAccessError("smtp_password_missing");
      await sendMail(
        {
          host: server.host,
          port: server.port,
          ...(server.username === null || password === undefined ? {} : { auth: { user: server.username, pass: password } }),
          allowPrivate: server.allow_private_ip,
          timeoutMs: config.smtpTimeoutMs,
          devAllowPlaintext: config.dev.allowPlaintextSmtp,
        },
        {
          from: server.from_name === null ? server.from_address : `${server.from_name} <${server.from_address}>`,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        },
      );
    },
  };
}

/** `deliverables/<upload id>.pdf` as the admin upload writes it (uploads.storage_path): the only shape read or signed. */
const STORAGE_PATH = /^deliverables\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

function assertStoragePath(storagePath: string): void {
  if (!STORAGE_PATH.test(storagePath)) throw new RangeError("not a deliverable storage path");
}

/** What the pre-flight needs of a fetch (adapters createSafeFetch satisfies it; a test passes a fake that serves the file as the public route does). */
export interface PreflightResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** At most `maxBytes` of the body as text; the rest is discarded. */
  textPrefix(maxBytes: number): Promise<string>;
  cancel(): Promise<void>;
}
export type PreflightFetch = (url: string) => Promise<PreflightResponse>;

/** A pre-flight URL lives this long: enough for one request. (It is also its own URL with its own nonce, so its downloads never count against WAHA's.) */
export const PREFLIGHT_TTL_SECONDS = 60;

/**
 * The injected fetch (tests), or a safe-fetch of the worker's own that is closed afterwards. It goes through the SAME egress rules as every outgoing call of the worker
 * (https only, no private, loopback or metadata address), over its own SHORT budget (PREFLIGHT_TIMEOUT_MS: connect, headers and the first bytes), never WAHA's request
 * timeout. So the worker needs public egress to https://api.<DOMAIN> (docs/runbooks/delivery.md): a VM that cannot reach its own public API address gets `file_unavailable`.
 */
function preflightFetch(
  config: Partial<Pick<DeliveryConfig, "dev">>,
  options: { readonly fetch?: PreflightFetch; readonly timeoutMs?: number },
): { readonly fetch: PreflightFetch; readonly close: () => Promise<void> } {
  if (options.fetch !== undefined) return { fetch: options.fetch, close: () => Promise.resolve() };
  const safe = createSafeFetch({ allowHttp: config.dev?.allowHttp ?? false, devAllowLoopback: config.dev?.allowLoopback ?? false, timeoutMs: options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS });
  return { fetch: (url) => safe(url, { method: "GET" }), close: () => safe.close().catch(() => undefined) };
}

export function createEbookFiles(
  config: Pick<DeliveryConfig, "dataDir" | "apiOrigin" | "fileUrlKey"> & Partial<Pick<DeliveryConfig, "dev">>,
  options: { readonly fetch?: PreflightFetch; /** The whole-request budget of the pre-flight (default PREFLIGHT_TIMEOUT_MS); a test shortens it. */ readonly timeoutMs?: number } = {},
): EbookFiles {
  const absolute = (storagePath: string): string => {
    assertStoragePath(storagePath);
    return join(config.dataDir, storagePath);
  };
  return {
    async preflight(storagePath, now) {
      const expected = (await stat(absolute(storagePath))).size;
      const url = signFileUrl({ origin: config.apiOrigin, path: `/files/${storagePath}`, key: config.fileUrlKey, now, ttlSeconds: PREFLIGHT_TTL_SECONDS });
      const { fetch: get, close } = preflightFetch(config, options);
      try {
        const response = await get(url);
        try {
          if (response.status !== 200) return { ok: false, reason: "status" };
          if (!/^application\/pdf\b/i.test(response.headers.get("content-type") ?? "")) return { ok: false, reason: "content_type" };
          // An exact whole number: a missing, chunked or different length is a different file than the one stored.
          const length = response.headers.get("content-length");
          if (length === null || !/^[0-9]{1,15}$/.test(length) || Number(length) !== expected) return { ok: false, reason: "content_length" };
          if ((await response.textPrefix(5)) !== "%PDF-") return { ok: false, reason: "magic" };
          return { ok: true, size: expected };
        } finally {
          await response.cancel().catch(() => undefined);
        }
      } catch {
        // The route could not be reached (DNS, TLS, a timeout, a refused address): WAHA would not reach it either. Nothing is said about why: never the URL.
        return { ok: false, reason: "unreachable" };
      } finally {
        await close();
      }
    },
    async size(storagePath) {
      return (await stat(absolute(storagePath))).size;
    },
    async read(storagePath) {
      return readFile(absolute(storagePath));
    },
    signedUrl(storagePath, now, ttlSeconds) {
      assertStoragePath(storagePath);
      return signFileUrl({ origin: config.apiOrigin, path: `/files/${storagePath}`, key: config.fileUrlKey, now, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
    },
  };
}
