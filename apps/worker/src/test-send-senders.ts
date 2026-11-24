// The real senders of template test-sends (US-017; template-test-send.ts): SMTP and WAHA with the messaging private key
// (worker.env SECRETS_MESSAGING_PRIVATE_KEY). Since US-025 they are the delivery code's own ports (delivery/access.ts), so a test-send exercises
// exactly what a delivery does: each send re-reads its endpoint and sealed secret from PostgreSQL and checks the binding before opening the secret:
//   - SMTP: smtp.password must be bound to smtp_settings.host (the DB refuses anything else, ET062; checked again there). Mail goes through
//     adapters sendMail (resolve + address policy, TLS);
//   - WAHA: the session's server and waha.<server>.api_key go through assertWahaTarget, the key is sent only to the URL it returns, over a safe-fetch
//     whose private-network allowlist holds that server's host only when the server has allow_private_ip (loopback, link-local and metadata stay refused).
//     The message goes to the chat id check-exists returns for the recipient (resolveContact: cached like a delivery's), never to a built `<phone>@c.us`: a
//     recipient who lives at `<lid>@lid` is answered by WAHA with the message in that chat, which would read as an uncertain send; a recipient not on WhatsApp
//     is `no_whatsapp` and nothing is sent. It is sent the way every message of the worker is (delivery/human.ts, WAHA "How to avoid blocking"): the chat is marked
//     as read, typing, a random wait by the length of the text, paused, the send, offline; an abort during a wait is `timeout` and nothing is sent.
// Errors become TestSendError codes (no provider text, no recipient).
import { SmtpError, WahaError } from "@ebooktrivia/adapters";
import { HUMAN_MAX_MS, isIdMobileE164 } from "@ebooktrivia/core";
import { openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import { createMailSender, createWahaAccess } from "./delivery/access.ts";
import { ContactCacheError, resolveContact } from "./delivery/contacts.ts";
import { sendLikeAHuman } from "./delivery/human.ts";
import { MailAccessError, type WahaAccess, WahaAccessError } from "./delivery/ports.ts";
import type { Logger } from "./log.ts";
import { TestSendError, type TestSender } from "./template-test-send.ts";
import { type Env, optional } from "./env.ts";
import type { WorkerConfig } from "./worker-config.ts";

/** A WAHA request of a test-send has this long (each request has its own: the human sequence is several of them), an SMTP one the second. */
const WAHA_TIMEOUT_MS = 5000;
const SMTP_TIMEOUT_MS = 10_000;
/**
 * The longest a WhatsApp test-send can take: the check-exists, the human sequence (core HUMAN_MAX_MS, its presence calls included) and the send. The consumer's signal
 * (90 % of its lease, template-test-send.ts) must outlast it, or a slow but healthy send would be cut short as `timeout`.
 */
export const TEST_SEND_WHATSAPP_MAX_MS = WAHA_TIMEOUT_MS + HUMAN_MAX_MS + WAHA_TIMEOUT_MS;

/** The access errors keep the codes the console has always shown. */
export const ACCESS_CODES: Readonly<Record<WahaAccessError["code"] | MailAccessError["code"], string>> = {
  session_unusable: "session_inactive",
  key_missing: "waha_key_missing",
  binding_mismatch: "binding_mismatch",
  key_unreadable: "secret_unreadable",
  smtp_not_configured: "smtp_not_configured",
  smtp_password_missing: "smtp_password_missing",
};

export function createTestSenders(deps: {
  readonly sql: postgres.Sql;
  readonly opener: SecretOpener;
  readonly dev: WorkerConfig["dev"];
  /** For the human sequence's best-effort presence calls (a code only is ever logged). */
  readonly log: Logger;
  /** The WAHA access (default: the delivery one, over the worker's pool); tests pass a fake. */
  readonly waha?: WahaAccess;
  /** The human pauses' random source (default: the operating system's CSPRNG) and wait (default: node timers). A test passes its own. */
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): TestSender {
  const { sql, opener, dev } = deps;
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const waha = deps.waha ?? createWahaAccess({ sql, opener, config: { dev, wahaTimeoutMs: WAHA_TIMEOUT_MS } });
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
      try {
        await waha.withSession(message.sessionId, async ({ sessionName, client }) => {
          if (signal.aborted) throw new TestSendError("timeout");
          // Where the message goes is what WAHA's check-exists says, exactly as for a delivery (delivery/contacts.ts): a contact that lives at `<lid>@lid` is not at
          // `<phone>@c.us`, and WAHA answers a send to the latter with the message in the former chat, which the adapter cannot tell from a message that is not ours
          // (maybe_sent). A failed lookup throws before any send: its `waha_<code>` is never `waha_maybe_sent`, so nothing went out.
          const contact = await resolveContact(sql, client, sessionName, message.to);
          if (contact.kind === "no_whatsapp") throw new TestSendError("no_whatsapp");
          // The same human sequence as every send of the worker (delivery/human.ts): the chat is marked as read, typing, a wait by the length of the message, paused, the send,
          // offline. The send's own outcome is untouched by it. The signal ending during a wait means nothing was sent.
          const result = await sendLikeAHuman(
            { log: deps.log, random: deps.random, sleep },
            {
              client,
              sessionName,
              chatId: contact.chatId,
              textLength: message.text.length,
              kind: "message",
              signal,
              send: () => client.sendText(sessionName, contact.chatId, message.text),
            },
          );
          if (result.kind === "not_sent") throw new TestSendError("timeout");
        });
      } catch (error) {
        if (error instanceof TestSendError) throw error;
        if (error instanceof WahaAccessError) throw new TestSendError(ACCESS_CODES[error.code]);
        if (error instanceof WahaError) throw new TestSendError(`waha_${error.code}`);
        if (error instanceof ContactCacheError) throw new TestSendError("contact_cache_failed");
        throw new TestSendError("waha_failed");
      }
    },
  };
}

/**
 * The production test-send port: real senders when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (a malformed key stops the worker), otherwise none
 * (template.test_send is then not relayed).
 */
export function testSendFromEnv(env: Env, dev: WorkerConfig["dev"]): ((sql: postgres.Sql, log: Logger) => TestSender) | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  return (sql, log) => createTestSenders({ sql, opener, dev, log });
}
