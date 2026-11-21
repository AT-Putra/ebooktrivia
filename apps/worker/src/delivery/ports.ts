// What the delivery code needs from the outside world (US-025), behind small ports so the consumers are tested with
// the WAHA mock, Mailpit or a plain fake, and the real implementations (access.ts) hold the keys.
import type { WahaClient } from "@ebooktrivia/adapters";
import type { MagicLinkChannel } from "@ebooktrivia/core";
import type postgres from "postgres";

/** A pool number, opened: its WAHA session name and a client bound to its server and key. */
export interface WahaHandle {
  readonly sessionName: string;
  readonly client: WahaClient;
}

/** Why a session cannot be used at all (nothing was sent); the code carries no secret and no personal data. */
export type WahaAccessCode = "session_unusable" | "key_missing" | "key_unreadable" | "binding_mismatch";

export class WahaAccessError extends Error {
  readonly code: WahaAccessCode;
  constructor(code: WahaAccessCode) {
    super(`WAHA session unusable: ${code}`);
    this.name = "WahaAccessError";
    this.code = code;
  }
}

export interface WahaAccess {
  /** Runs `use` with a client for the pool session `sessionId`; the client is closed afterwards. Throws WahaAccessError when it cannot be opened. */
  withSession<T>(sessionId: string, use: (handle: WahaHandle) => Promise<T>, options?: { readonly timeoutMs?: number }): Promise<T>;
}

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments?: readonly { readonly filename: string; readonly content: Uint8Array; readonly contentType: string }[];
}

export type MailAccessCode = "smtp_not_configured" | "binding_mismatch" | "smtp_password_missing" | "key_unreadable";

export class MailAccessError extends Error {
  readonly code: MailAccessCode;
  constructor(code: MailAccessCode) {
    super(`SMTP unusable: ${code}`);
    this.name = "MailAccessError";
    this.code = code;
  }
}

export interface MailSender {
  /** Throws adapters SmtpError (classified), or MailAccessError when the SMTP settings cannot be used. */
  send(message: OutgoingMail): Promise<void>;
}

/**
 * What a pre-flight of the signed file URL found. `ok` means: HTTP 200, `application/pdf`, a Content-Length equal to the stored file's size and the `%PDF`
 * magic bytes. `size` is that stored size (the expected size of what WAHA will deliver). Otherwise `reason` is a short code (never a URL or a body).
 */
export type FilePreflight =
  | { readonly ok: true; readonly size: number }
  | { readonly ok: false; readonly reason: "unreachable" | "status" | "content_type" | "content_length" | "magic" };

/** The ebook PDF: its bytes (for an attachment) and a signed download URL (for WAHA, and the e-mail fallback). */
export interface EbookFiles {
  /** Size in bytes of the stored file; throws when it is missing. */
  size(storagePath: string): Promise<number>;
  read(storagePath: string): Promise<Uint8Array>;
  /** A signed https URL under api.<DOMAIN>/files for the stored file. */
  signedUrl(storagePath: string, now: Date, ttlSeconds?: number): string;
  /**
   * Fetches the first bytes of the file through its own signed URL, as WAHA will (US-005 R11: WAHA does NOT refuse a URL it cannot fetch, it delivers the
   * error page as the document). The pre-flight signs a URL of its own, with a short life, so it is counted apart from the URL WAHA gets (the route caps the
   * downloads of ONE signed URL) and cannot use up WAHA's. Throws only when the stored file is missing (ENOENT, like size()); every other problem is a result.
   */
  preflight(storagePath: string, now: Date): Promise<FilePreflight>;
}

/**
 * The player's login link for one channel (plan M8.4): a fresh single-use token, stored hashed with its 72 h expiry,
 * replacing the previous live one of that channel, returned as the URL to send. The URL is a bearer credential: it goes into
 * the message and nowhere else (never a log, an error or a table). Wired to US-026's issue_magic_link at the integration
 * step (magic-links.ts); tests pass a fake.
 */
export interface MagicLinks {
  issue(input: { readonly playerId: string; readonly channel: MagicLinkChannel }): Promise<string>;
}

/**
 * How the worker builds its MagicLinks once its database pool exists (like testSend): the real issuer calls issue_magic_link as worker_rw on
 * that pool. runWorker takes it as ports.magicLinks.
 */
export type MagicLinksFactory = (context: { readonly sql: postgres.Sql; readonly playOrigin: string }) => MagicLinks;

/** The magic link could not be issued; no message was sent. */
export class MagicLinkUnavailable extends Error {
  constructor() {
    super("a magic link could not be issued");
    this.name = "MagicLinkUnavailable";
  }
}
