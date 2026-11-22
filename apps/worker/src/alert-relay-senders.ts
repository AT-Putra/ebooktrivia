// The production senders of the alert relay (US-015; alert-relay.ts): the Owner's alerts go out through the same audited paths as
// every other message of the worker. E-mail: the delivery code's SMTP sender (the settings the Owner saved, the sealed password
// opened with the messaging private key, TLS, the address policy). WhatsApp: the POOL sender (human-like pauses, check-exists before
// a first contact, a number picked by weight under its caps and health, recorded in the send ledger), so an alert never bypasses the
// rules that keep the numbers from being banned. Without SECRETS_MESSAGING_PRIVATE_KEY there are no senders and the relay is off (the
// backstop to Uptime Kuma still speaks for a critical alert).
import { isIdMobileE164 } from "@ebooktrivia/core";
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import type postgres from "postgres";
import type { AlertSenders } from "./alert-relay.ts";
import { createMailSender, createWahaAccess } from "./delivery/access.ts";
import { createPoolSender } from "./delivery/pool-sender.ts";
import { type Env, optional } from "./env.ts";
import type { Logger } from "./log.ts";
import type { WorkerConfig } from "./worker-config.ts";

/** An alert is one short message: the same timeouts as a login code. */
const WAHA_TIMEOUT_MS = 7000;
const SMTP_TIMEOUT_MS = 10_000;

export interface AlertRelayPort {
  readonly senders: (sql: postgres.Sql, log: Logger) => AlertSenders;
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function createAlertSenders(deps: { readonly sql: postgres.Sql; readonly log: Logger; readonly opener: SecretOpener; readonly dev: WorkerConfig["dev"] }): AlertSenders {
  const mail = createMailSender({ sql: deps.sql, opener: deps.opener, config: { dev: deps.dev, smtpTimeoutMs: SMTP_TIMEOUT_MS } });
  const waha = createWahaAccess({ sql: deps.sql, opener: deps.opener, config: { dev: deps.dev, wahaTimeoutMs: WAHA_TIMEOUT_MS } });
  const pool = createPoolSender({ sql: deps.sql, log: deps.log, waha });
  return {
    async email(message) {
      await mail.send({ to: message.to, subject: message.subject, text: message.text, html: `<pre style="font-family:monospace">${escapeHtml(message.text)}</pre>` });
    },
    async whatsapp(message, signal) {
      if (!isIdMobileE164(message.to)) throw new Error("the alert WhatsApp number is not an Indonesian mobile number");
      await pool.sendText({ to: message.to, text: message.text, signal });
    },
  };
}

/** The production port: real senders when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (a malformed key stops the worker), otherwise none. */
export function alertRelayFromEnv(env: Env, dev: WorkerConfig["dev"]): AlertRelayPort | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  return { senders: (sql, log) => createAlertSenders({ sql, log, opener, dev }) };
}
