// SMTP adapter (plan M3.4; AC-D1 email delivery) on nodemailer, with the safe-fetch address policy.
//
//   - The configured host is resolved here and EVERY answer must pass isBlockedAddress (private
//     networks only when the host is on the audited allowlist); nodemailer then connects to the
//     checked IP, and the original name is the TLS servername, so certificates are still verified
//     against it and DNS rebinding cannot redirect the connection.
//   - TLS is required (implicit TLS on 465, otherwise STARTTLS with requireTLS) unless the caller
//     sets devAllowPlaintext (Mailpit in dev only). TLS 1.2+, certificates verified.
//   - nodemailer may not read local files or fetch URLs for attachments (disableFileAccess,
//     disableUrlAccess): attachments are passed as bytes.
//   - Exactly one recipient: `to` (and the address in `from`) must be a plain addr-spec (no
//     display name, comma, quotes, angle brackets or CR/LF), the SMTP envelope is set explicitly to
//     that one address, maxRecipients is 1, and the server must report exactly that address as
//     accepted. Attachment filenames and content types are checked the same way (security review
//     US-012: "a, b, c" reached three inboxes and "a\r\nBcc: x" reached only x).
//   - Errors are classified for the delivery machine: rejected (5xx, permanent), failed (nothing
//     can have been accepted: the DATA command was never written, or the server answered 4xx),
//     maybe_sent (the connection broke or timed out after DATA, so the message may have been
//     queued). nodemailer stamps every socket error with command "CONN" whatever the stage, so the
//     stage comes from its transaction log (transactionLog + a logger that only records "DATA").
//   - A9: devAllowPlaintext is dev-only. The worker config loader refuses its dev flags when
//     NODE_ENV=production (apps/worker/src/worker-config.ts); every other caller must do the same.

import { isPlainAddress, isSafeDisplayName, isSafeFileName } from "@ebooktrivia/core";
import { createTransport } from "nodemailer";
import { isRecord } from "./http.ts";
import { isBlockedAddress, type Resolver, systemResolver } from "./safe-fetch.ts";

export type SmtpErrorCode = "blocked_address" | "dns_failed" | "rejected" | "failed" | "maybe_sent";

export class SmtpError extends Error {
  readonly code: SmtpErrorCode;
  constructor(code: SmtpErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "SmtpError";
    this.code = code;
  }
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly auth?: { readonly user: string; readonly pass: string };
  /** The audited admin allowlist entry for an SMTP host on a private network. */
  readonly allowPrivate?: boolean;
  readonly resolver?: Resolver;
  /** Per-phase timeout (connect, greeting, socket idle). Default 10000 ms. */
  readonly timeoutMs?: number;
  /** Dev only: plain SMTP and loopback allowed (Mailpit). Never in production. */
  readonly devAllowPlaintext?: boolean;
}

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly { readonly filename: string; readonly content: Uint8Array; readonly contentType: string }[];
}

export interface SentMail {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

/** Codes nodemailer only uses before a message can be in flight (DNS, auth, TLS, envelope). */
const CONNECT_PHASE_CODES = new Set(["EDNS", "EAUTH", "ETLS", "EENVELOPE", "ENOAUTH", "EOAUTH2"]);
/** errno values (kept as originalCode) of a connection that was never established. */
const CONNECT_ERRNOS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);
const CONNECT_MESSAGES = /^(?:Connection timeout|Greeting never received)/;

/** How far the SMTP session got: true once the DATA command has been written to the socket. */
export interface SmtpStage {
  readonly dataWritten: boolean;
}

/**
 * Classifies a nodemailer error for the delivery machine. `stage` comes from sendMail's
 * transaction log; without it the classification is conservative (DATA may have been written).
 */
export function classifySmtpError(error: unknown, stage: SmtpStage = { dataWritten: true }): SmtpErrorCode {
  const record = isRecord(error) ? error : {};
  const responseCode = typeof record["responseCode"] === "number" ? record["responseCode"] : undefined;
  const code = typeof record["code"] === "string" ? record["code"] : undefined;
  const errno = typeof record["originalCode"] === "string" ? record["originalCode"] : undefined;
  const message = typeof record["message"] === "string" ? record["message"] : "";
  if (responseCode !== undefined && responseCode >= 500) return "rejected";
  // A 4xx is the server's explicit answer that it did not take the message (or the envelope).
  if (responseCode !== undefined && responseCode >= 400) return "failed";
  if (!stage.dataWritten) return "failed";
  if ((code !== undefined && CONNECT_PHASE_CODES.has(code)) || (errno !== undefined && CONNECT_ERRNOS.has(errno)) || CONNECT_MESSAGES.test(message)) return "failed";
  return "maybe_sent";
}

// --- addresses ---------------------------------------------------------------------------------

const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

// The address / name rules are core's (shared with the admin console, code review US-017 L5).
export { isPlainAddress };

/** `from` as "addr" or "Display Name <addr>"; the name goes to nodemailer as data, never as header text. */
function parseFrom(from: string): { readonly name: string | undefined; readonly address: string } {
  const named = /^(.*) <([^<>]*)>$/.exec(from);
  const name = named?.[1]?.trim();
  const address = named?.[2] ?? from;
  if (!isPlainAddress(address)) throw new RangeError("from must be a plain address, optionally with a display name");
  if (name !== undefined && !isSafeDisplayName(name)) throw new RangeError("from has an unsafe display name");
  return { name, address };
}

function assertMessage(message: MailMessage): { readonly name: string | undefined; readonly address: string } {
  if (!isPlainAddress(message.to)) throw new RangeError("to must be exactly one plain address");
  for (const a of message.attachments ?? []) {
    if (!isSafeFileName(a.filename)) throw new RangeError("attachment filename is unsafe");
    if (!CONTENT_TYPE.test(a.contentType)) throw new RangeError("attachment contentType must be type/subtype");
  }
  return parseFrom(message.from);
}

async function checkedAddress(config: SmtpConfig): Promise<string> {
  let answers;
  try {
    answers = await (config.resolver ?? systemResolver)(config.host);
  } catch (error) {
    throw new SmtpError("dns_failed", `${config.host} did not resolve`, { cause: error });
  }
  const policy = { allowPrivate: config.allowPrivate === true, allowLoopback: config.devAllowPlaintext === true };
  const blocked = answers.find((a) => isBlockedAddress(a.address, policy));
  if (blocked !== undefined) throw new SmtpError("blocked_address", `${config.host} resolves to a blocked address (${blocked.address})`);
  const first = answers[0];
  if (first === undefined) throw new SmtpError("dns_failed", `${config.host} did not resolve`);
  return first.address;
}

export async function sendMail(config: SmtpConfig, message: MailMessage): Promise<SentMail> {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new RangeError("port must be 1..65535");
  const sender = assertMessage(message);
  const address = await checkedAddress(config);
  const plaintext = config.devAllowPlaintext === true;
  const timeout = config.timeoutMs ?? 10_000;
  // Records only whether the DATA command went out (the stage for classifySmtpError); nothing is
  // logged, so commands, credentials (masked by nodemailer anyway) and bodies never leave here.
  let dataWritten = false;
  const ignore = (): void => undefined;
  const logger = {
    trace: ignore,
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
    debug: (...args: unknown[]): void => {
      const entry = args[0];
      if (isRecord(entry) && entry["tnx"] === "client" && args.slice(1).some((a) => typeof a === "string" && a.trim().toUpperCase() === "DATA")) dataWritten = true;
    },
  };
  const transport = createTransport({
    host: address,
    port: config.port,
    secure: config.port === 465,
    requireTLS: !plaintext && config.port !== 465,
    ignoreTLS: plaintext,
    tls: { servername: config.host, minVersion: "TLSv1.2", rejectUnauthorized: true },
    ...(config.auth === undefined ? {} : { auth: { user: config.auth.user, pass: config.auth.pass } }),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
    transactionLog: true,
    logger,
  });
  let sent: SentMail;
  try {
    const info = await transport.sendMail({
      from: sender.name === undefined ? sender.address : { name: sender.name, address: sender.address },
      to: message.to,
      envelope: { from: sender.address, to: [message.to] },
      maxRecipients: 1,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
    });
    const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : isRecord(v) && typeof v["address"] === "string" ? v["address"] : "")) : []);
    sent = { messageId: info.messageId, accepted: list(info.accepted), rejected: list(info.rejected) };
  } catch (error) {
    throw new SmtpError(classifySmtpError(error, { dataWritten }), "SMTP send failed", { cause: error });
  } finally {
    transport.close();
  }
  if (sent.accepted.length !== 1 || sent.accepted[0] !== message.to) {
    throw new SmtpError("maybe_sent", "SMTP server accepted other recipients than the one requested");
  }
  return sent;
}
