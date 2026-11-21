// The production OTP port (US-026, on the pool since US-025): the messaging private key opens the sealed codes, and the OTP is
// sent through the WhatsApp POOL (delivery/pool-sender.ts) like every other message of the worker: a number picked by weight, under
// its daily cap and its health, paced by the short OTP gap, recorded in the send ledger (kind `otp`), failing over to another number
// when WAHA refuses the send (up to 3 numbers), and NEVER to a second number once a send may have gone out (the player would receive
// two codes; the consumer's retry sends the same, still valid code again, bounded by its expiry). The WAHA access is the audited
// delivery one (the session's server, its sealed API key bound to the server's host, safe-fetch). The consumer (otp-send.ts) only
// sees the OtpSender port.
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import { createWahaAccess } from "./delivery/access.ts";
import { loadWarningFactors } from "./delivery/config.ts";
import { createPoolSender, PoolSendError } from "./delivery/pool-sender.ts";
import type { WahaAccess } from "./delivery/ports.ts";
import { type Env, optional } from "./env.ts";
import type { Logger } from "./log.ts";
import { OtpSendError, type OtpSender } from "./otp-send.ts";
import { ACCESS_CODES } from "./test-send-senders.ts";
import type { WorkerConfig } from "./worker-config.ts";

/**
 * A code is one short text, and up to three numbers may be asked inside the consumer's lease (30 s, otp-send.ts): the request timeout is
 * short, and the OTP gap (core OTP_GAP_MS) keeps the wait for a slot short too.
 */
export const OTP_WAHA_TIMEOUT_MS = 7000;

export interface OtpPort {
  /** Opens the sealed codes (the messaging private key). */
  readonly opener: Pick<SecretOpener, "openOtp">;
  /** The WhatsApp sender, given the worker's pool and logger. */
  readonly sender: (sql: postgres.Sql, log: Logger) => OtpSender;
}

export function createWahaOtpSender(deps: {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly opener: SecretOpener;
  readonly dev: WorkerConfig["dev"];
  readonly random?: () => number;
  /** The share of the new-contact budget each WhatsApp capping warning leaves (WORKER_WA_WARNING_FACTORS). */
  readonly warningCapFactors?: readonly [number, number];
  /** The WAHA access (default: the delivery one, over the worker's pool); tests pass a fake. */
  readonly waha?: WahaAccess;
}): OtpSender {
  const waha = deps.waha ?? createWahaAccess({ sql: deps.sql, opener: deps.opener, config: { dev: deps.dev, wahaTimeoutMs: OTP_WAHA_TIMEOUT_MS } });
  const pool = createPoolSender({
    sql: deps.sql,
    log: deps.log,
    waha,
    ...(deps.random === undefined ? {} : { random: deps.random }),
    ...(deps.warningCapFactors === undefined ? {} : { warningCapFactors: deps.warningCapFactors }),
  });
  return {
    async send(message, signal) {
      try {
        await pool.sendText({ to: message.phone, text: message.text, signal });
      } catch (error) {
        if (!(error instanceof PoolSendError)) throw new OtpSendError("send_failed");
        // Codes only, as the console has always shown them for a WAHA failure.
        if (error.code === "no_number") throw new OtpSendError("no_session");
        // The contact has its messages for the hour, or its 30 to 60 s gap is running: not sent, the outbox retries (the code lives 5 minutes).
        if (error.code === "contact_limit") throw new OtpSendError("contact_limit");
        // The phone is not on WhatsApp (WAHA's check-exists): no number would change it, so no code can go out that way.
        if (error.code === "no_whatsapp") throw new OtpSendError("no_whatsapp");
        const refusal = error.refusal;
        if (refusal === undefined) throw new OtpSendError(error.code === "maybe_sent" ? "waha_maybe_sent" : "send_failed");
        throw new OtpSendError(refusal.kind === "access" ? ACCESS_CODES[refusal.code] : `waha_${refusal.code}`);
      }
    },
  };
}

/**
 * The production OTP port: when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (a malformed key stops the
 * worker), otherwise none (otp.send is then not relayed, and no player receives a login code).
 */
export function otpFromEnv(env: Env, dev: WorkerConfig["dev"]): OtpPort | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  const warningCapFactors = loadWarningFactors(env);
  return { opener, sender: (sql, log) => createWahaOtpSender({ sql, log, opener, dev, warningCapFactors }) };
}
