// The production OTP port (US-026): the messaging private key opens the sealed codes, and a minimal
// WhatsApp sender sends them through ONE active WAHA session (a WORKING one first; a session whose status
// was never polled counts as usable). The send itself is the audited WAHA path of the template test-sends
// (test-send-senders.ts: the session's server, its sealed API key bound to the server's host, safe-fetch).
// US-025 replaces `sender` with its health-aware session pool (weights, caps, failover); the consumer
// (otp-send.ts) only sees the OtpSender port.
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import { type Env, optional } from "./env.ts";
import { OtpSendError, type OtpSender } from "./otp-send.ts";
import { createTestSenders } from "./test-send-senders.ts";
import { TestSendError } from "./template-test-send.ts";
import type { WorkerConfig } from "./worker-config.ts";

export interface OtpPort {
  /** Opens the sealed codes (the messaging private key). */
  readonly opener: Pick<SecretOpener, "openOtp">;
  /** The WhatsApp sender, given the worker's pool. */
  readonly sender: (sql: postgres.Sql) => OtpSender;
}

export function createWahaOtpSender(deps: { readonly sql: postgres.Sql; readonly opener: SecretOpener; readonly dev: WorkerConfig["dev"] }): OtpSender {
  const wa = createTestSenders(deps);
  return {
    async send(message, signal) {
      const [session] = await deps.sql<{ id: string }[]>`
        SELECT s.id FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
         WHERE s.active AND w.active AND (s.status IS NULL OR s.status = 'WORKING')
         ORDER BY (s.status = 'WORKING') IS TRUE DESC, s.id
         LIMIT 1`;
      if (session === undefined) throw new OtpSendError("no_session");
      try {
        await wa.whatsapp({ sessionId: session.id, to: message.phone, text: message.text }, signal);
      } catch (error) {
        throw new OtpSendError(error instanceof TestSendError ? error.code : "send_failed");
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
  return { opener, sender: (sql) => createWahaOtpSender({ sql, opener, dev }) };
}
