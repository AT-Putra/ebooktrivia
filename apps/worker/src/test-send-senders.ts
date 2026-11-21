// The real senders of template test-sends (US-017; template-test-send.ts): SMTP and WAHA with the messaging private key
// (worker.env SECRETS_MESSAGING_PRIVATE_KEY). Since US-025 they are the delivery code's own ports (delivery/access.ts), so a test-send exercises
// exactly what a delivery does: each send re-reads its endpoint and sealed secret from PostgreSQL and checks the binding before opening the secret:
//   - SMTP: smtp.password must be bound to smtp_settings.host (the DB refuses anything else, ET062; checked again there). Mail goes through
//     adapters sendMail (resolve + address policy, TLS);
//   - WAHA: the session's server and waha.<server>.api_key go through assertWahaTarget, the key is sent only to the URL it returns, over a safe-fetch
//     whose private-network allowlist holds that server's host only when the server has allow_private_ip (loopback, link-local and metadata stay refused).
// Errors become TestSendError codes (no provider text, no recipient).
import { SmtpError, WahaError } from "@ebooktrivia/adapters";
import { isIdMobileE164, toWaChatId } from "@ebooktrivia/core";
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import { createMailSender, createWahaAccess } from "./delivery/access.ts";
import { MailAccessError, WahaAccessError } from "./delivery/ports.ts";
import { TestSendError, type TestSender } from "./template-test-send.ts";
import { type Env, optional } from "./env.ts";
import type { WorkerConfig } from "./worker-config.ts";

/** A test-send is one small message: the timeouts the adapters had before they were shared with the deliveries. */
const WAHA_TIMEOUT_MS = 5000;
const SMTP_TIMEOUT_MS = 10_000;

/** The access errors keep the codes the console has always shown. */
export const ACCESS_CODES: Readonly<Record<WahaAccessError["code"] | MailAccessError["code"], string>> = {
  session_unusable: "session_inactive",
  key_missing: "waha_key_missing",
  binding_mismatch: "binding_mismatch",
  key_unreadable: "secret_unreadable",
  smtp_not_configured: "smtp_not_configured",
  smtp_password_missing: "smtp_password_missing",
};

export function createTestSenders(deps: { readonly sql: postgres.Sql; readonly opener: SecretOpener; readonly dev: WorkerConfig["dev"] }): TestSender {
  const { sql, opener, dev } = deps;
  const waha = createWahaAccess({ sql, opener, config: { dev, wahaTimeoutMs: WAHA_TIMEOUT_MS } });
  const mail = createMailSender({ sql, opener, config: { dev, smtpTimeoutMs: SMTP_TIMEOUT_MS } });
  return {
    async email(message) {
      try {
        await mail.send({ to: message.to, subject: message.subject, text: message.text, html: message.html });
      } catch (error) {
        if (error instanceof MailAccessError) throw new TestSendError(ACCESS_CODES[error.code]);
        if (error instanceof SmtpError) throw new TestSendError(`smtp_${error.code}`);
        throw new TestSendError("smtp_failed");
      }
    },

    async whatsapp(message, signal) {
      if (!isIdMobileE164(message.to)) throw new TestSendError("invalid_recipient");
      const chatId = toWaChatId(message.to);
      try {
        await waha.withSession(message.sessionId, ({ sessionName, client }) => {
          if (signal.aborted) throw new TestSendError("timeout");
          return client.sendText(sessionName, chatId, message.text);
        });
      } catch (error) {
        if (error instanceof TestSendError) throw error;
        if (error instanceof WahaAccessError) throw new TestSendError(ACCESS_CODES[error.code]);
        if (error instanceof WahaError) throw new TestSendError(`waha_${error.code}`);
        throw new TestSendError("waha_failed");
      }
    },
  };
}

/**
 * The production test-send port: real senders when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (a malformed key stops the worker), otherwise none
 * (template.test_send is then not relayed).
 */
export function testSendFromEnv(env: Env, dev: WorkerConfig["dev"]): ((sql: postgres.Sql) => TestSender) | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  return (sql) => createTestSenders({ sql, opener, dev });
}
