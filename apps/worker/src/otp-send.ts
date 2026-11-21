// The otp.send consumer (plan M2.3 "the worker decrypts it, sends it, then wipes it", M9.1; US-026). The
// public app stores an OTP as player_otps (HMAC + the code sealed to the messaging public key) and calls
// enqueue_otp, which gates eligibility, the per-phone cap and the global breaker in SQL and MOVES the
// sealed code into the outbox row (player_otps.sealed_code becomes NULL): payload
// { otp_id, phone, expires_at }, `sealed` = the sealed code. Per job:
//   1. a job past its expires_at is DROPPED: processed, nothing sent (the code is dead; a backlog never
//      turns into a late burst of codes, US-009 carry-over);
//   2. the code is opened with the messaging private key (its AAD binds otp_id and phone) and must be
//      exactly ^[0-9]{6}$; a row that does not open, or holds anything else, is dropped, never sent;
//   3. the Owner's `otp` WhatsApp template is rendered with {kode_otp} and sent through the OtpSender;
//   4. the finalize (outbox-consumer.ts) marks the row processed and wipes `sealed`, the code's only
//      copy: after the send only its HMAC is left (player_otps.mac), and the minute sweeper
//      (sweepers.ts sweepExpiredOtps) deletes that row once it has expired.
// The code is never logged and never part of an error message; log lines carry the outbox id and an
// outcome only (no phone). At-least-once: a crash between the send and the finalize sends the SAME code
// again once the lease has passed (same code, same expiry), bounded by the expiry and the attempt cap.
// The sender is one port (OtpSender): this story's minimal WAHA sender (otp-senders.ts), which US-025
// replaces with its session pool.
import { type IdMobileE164, isIdMobileE164, isUuid, renderMessage } from "@ebooktrivia/core";
import type { SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import type { Logger } from "./log.ts";
import type { OutboxConsumer } from "./outbox-consumer.ts";

export const OTP_TOPIC = "otp.send";
/**
 * With the outbox backoff (30 s, doubling) the 5th claim of a failing send comes after the code's 5 min
 * life, so an undeliverable code always ends as a drop (processed, sealed wiped) before this cap.
 */
export const OTP_MAX_ATTEMPTS = 6;
/** Covers the worst case of the human-like sequence (typing, a short pause, three best-effort presence calls) on up to three numbers (US-025). */
const OTP_LEASE_MS = 90_000;
const CODE = /^[0-9]{6}$/;

export interface OtpMessage {
  /** The player's WhatsApp number. */
  readonly phone: IdMobileE164;
  /** The rendered message; it contains the code: never log it. */
  readonly text: string;
}

/** Sends one OTP message by WhatsApp. Throws OtpSendError (a code without payload values) on failure. */
export interface OtpSender {
  send(message: OtpMessage, signal: AbortSignal): Promise<void>;
}

/** A send failure: `code` only (^[a-z_]{1,64}$), never the phone or the text. */
export class OtpSendError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = /^[a-z_]{1,64}$/.test(code) ? code : "send_failed";
    super(`otp send failed: ${safe}`);
    this.name = "OtpSendError";
    this.code = safe;
  }
}

export interface OtpConsumerDeps {
  readonly sql: postgres.Sql;
  readonly opener: Pick<SecretOpener, "openOtp">;
  readonly sender: OtpSender;
  readonly log: Logger;
  readonly now?: () => number;
  readonly leaseMs?: number;
}

interface OtpPayload {
  readonly otpId: string;
  readonly phone: IdMobileE164;
  readonly expiresAtMs: number;
}

function parsePayload(payload: unknown): OtpPayload | null {
  // outbox.payload is always a JSON object (outbox_payload_check); enqueue_otp writes these three fields.
  const p = payload as Record<string, unknown>;
  const otpId = p["otp_id"];
  const phone = p["phone"];
  const expiresAt = p["expires_at"];
  if (!isUuid(otpId) || typeof phone !== "string" || !isIdMobileE164(phone) || typeof expiresAt !== "string") return null;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) ? null : { otpId, phone, expiresAtMs };
}

export function createOtpSendConsumer(deps: OtpConsumerDeps): OutboxConsumer {
  const now = deps.now ?? (() => Date.now());
  return {
    topic: OTP_TOPIC,
    leaseMs: deps.leaseMs ?? OTP_LEASE_MS,
    maxAttempts: OTP_MAX_ATTEMPTS,
    async perform(row, signal) {
      const drop = (reason: string): void => {
        deps.log.warn({ outboxId: row.id, reason }, "otp send dropped");
      };
      const job = parsePayload(row.payload);
      if (job === null) {
        drop("bad_payload");
        return undefined;
      }
      if (job.expiresAtMs <= now()) {
        deps.log.info({ outboxId: row.id, reason: "expired" }, "otp send dropped");
        return undefined;
      }
      if (row.sealed === null) {
        drop("no_sealed_code");
        return undefined;
      }
      let code: string;
      try {
        code = deps.opener.openOtp({ otpId: job.otpId, phone: job.phone, sealed: row.sealed });
      } catch {
        drop("unreadable_code");
        return undefined;
      }
      // openOtp checks it too; the worker does not rely on that (US-009 carry-over).
      if (!CODE.test(code)) {
        drop("malformed_code");
        return undefined;
      }

      const [template] = await deps.sql<{ body: string }[]>`
        SELECT body FROM public.message_templates WHERE key = 'otp' AND channel = 'whatsapp' AND locale = 'id'`;
      if (template === undefined) throw new OtpSendError("template_missing");
      let text: string;
      try {
        text = renderMessage(template.body, "whatsapp", { kode_otp: code });
      } catch {
        throw new OtpSendError("template_failed");
      }
      try {
        await deps.sender.send({ phone: job.phone, text }, signal);
      } catch (error) {
        throw error instanceof OtpSendError ? error : new OtpSendError("send_failed");
      }
      deps.log.info({ outboxId: row.id, outcome: "sent" }, "otp sent");
      return undefined;
    },
  };
}
