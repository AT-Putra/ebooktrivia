// The real senders of template test-sends (US-017; template-test-send.ts): SMTP and WAHA with the
// messaging private key (worker.env SECRETS_MESSAGING_PRIVATE_KEY). Each send re-reads its
// endpoint and sealed secret from PostgreSQL and checks the binding before opening the secret:
//   - SMTP: smtp.password must be bound to smtp_settings.host (the DB refuses anything else, ET062;
//     checked again here). Mail goes through adapters sendMail (resolve + address policy, TLS).
//   - WAHA: the session's server and waha.<server>.api_key go through assertWahaTarget, the key is
//     sent only to the URL it returns, over a safe-fetch whose private-network allowlist holds that
//     server's host only when the server has allow_private_ip (loopback, link-local and metadata
//     stay refused).
// Errors become TestSendError codes (no provider text, no recipient).
import { createSafeFetch, createWahaClient, sendMail, SmtpError, WahaError } from "@ebooktrivia/adapters";
import { isIdMobileE164, toWaChatId } from "@ebooktrivia/core";
import { assertWahaTarget, CryptoError, openerFromEnv, type SecretOpener } from "@ebooktrivia/crypto";
import { SECRET_NAMES, type SettingsSecretRow } from "@ebooktrivia/db";
import { isIP } from "node:net";
import type postgres from "postgres";
import { TestSendError, type TestSender } from "./template-test-send.ts";
import { type Env, optional } from "./env.ts";
import type { WorkerConfig } from "./worker-config.ts";

async function secretRow(sql: postgres.Sql, name: string): Promise<SettingsSecretRow | undefined> {
  const [row] = await sql<SettingsSecretRow[]>`
    SELECT id, scope, name, adnet_id AS "adnetId", bound_host AS "boundHost", key_id AS "keyId", ciphertext, nonce, sealed_dek AS "sealedDek"
      FROM public.settings_secrets WHERE scope = 'messaging' AND name = ${name} AND adnet_id IS NULL`;
  return row;
}

function open(opener: SecretOpener, row: SettingsSecretRow): string {
  try {
    return opener.openSecret(row);
  } catch (error) {
    if (error instanceof CryptoError) throw new TestSendError("secret_unreadable");
    throw error;
  }
}

export function createTestSenders(deps: { readonly sql: postgres.Sql; readonly opener: SecretOpener; readonly dev: WorkerConfig["dev"] }): TestSender {
  const { sql, opener, dev } = deps;
  return {
    async email(message) {
      const [server] = await sql<{ host: string; port: number; username: string | null; from_address: string; from_name: string | null; allow_private_ip: boolean }[]>`
        SELECT host, port, username, from_address, from_name, allow_private_ip FROM public.smtp_settings`;
      if (server === undefined) throw new TestSendError("smtp_not_configured");
      const row = await secretRow(sql, SECRET_NAMES.smtpPassword);
      if (row !== undefined && row.boundHost !== server.host) throw new TestSendError("binding_mismatch");
      const password = row === undefined ? undefined : open(opener, row);
      if (server.username !== null && password === undefined) throw new TestSendError("smtp_password_missing");
      try {
        await sendMail(
          {
            host: server.host,
            port: server.port,
            ...(server.username === null || password === undefined ? {} : { auth: { user: server.username, pass: password } }),
            allowPrivate: server.allow_private_ip,
            devAllowPlaintext: dev.allowPlaintextSmtp,
          },
          { from: server.from_name === null ? server.from_address : `${server.from_name} <${server.from_address}>`, to: message.to, subject: message.subject, text: message.text, html: message.html },
        );
      } catch (error) {
        if (error instanceof SmtpError) throw new TestSendError(`smtp_${error.code}`);
        throw new TestSendError("smtp_failed");
      }
    },

    async whatsapp(message, signal) {
      if (!isIdMobileE164(message.to)) throw new TestSendError("invalid_recipient");
      const [session] = await sql<{ session_name: string; server_id: string; base_url: string; base_url_host: string; allow_private_ip: boolean; active: boolean }[]>`
        SELECT s.session_name, s.server_id, w.base_url, w.base_url_host, w.allow_private_ip, (s.active AND w.active) AS active
          FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id WHERE s.id = ${message.sessionId}`;
      if (session === undefined || !session.active) throw new TestSendError("session_inactive");
      const row = await secretRow(sql, SECRET_NAMES.wahaApiKey(session.server_id));
      if (row === undefined) throw new TestSendError("waha_key_missing");
      let target: URL;
      try {
        target = assertWahaTarget({ baseUrl: session.base_url, baseUrlHost: session.base_url_host }, row);
      } catch {
        throw new TestSendError("binding_mismatch");
      }
      const fetch = createSafeFetch({
        allowHttp: dev.allowHttp,
        devAllowLoopback: dev.allowLoopback,
        // The allowlist covers an IPv4 literal only (security review US-017 S3; the DB CHECK
        // waha_servers_allow_private_ip_check enforces it, this keeps it if that ever changes).
        ...(session.allow_private_ip && isIP(target.hostname) === 4 ? { allowPrivateHosts: [session.base_url_host] } : {}),
      });
      try {
        if (signal.aborted) throw new TestSendError("timeout");
        const client = createWahaClient({ target, apiKey: open(opener, row), fetch });
        await client.sendText(session.session_name, toWaChatId(message.to), message.text);
      } catch (error) {
        if (error instanceof TestSendError) throw error;
        if (error instanceof WahaError) throw new TestSendError(`waha_${error.code}`);
        throw new TestSendError("waha_failed");
      } finally {
        await fetch.close();
      }
    },
  };
}

/**
 * The production test-send port: real senders when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY
 * (a malformed key stops the worker), otherwise none (template.test_send is then not relayed).
 */
export function testSendFromEnv(env: Env, dev: WorkerConfig["dev"]): ((sql: postgres.Sql) => TestSender) | undefined {
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined) return undefined;
  const opener = openerFromEnv(env);
  return (sql) => createTestSenders({ sql, opener, dev });
}
