// SMTP (AC-A3; US-017). Owner only (smtp.edit). One server (smtp_settings, a single row). The
// password is a sealed messaging-scope secret `smtp.password` bound to the host: the database
// refuses it bound to any other host (ET062) and deletes it when the host changes. TLS is always
// required by the worker's SMTP adapter (implicit TLS or STARTTLS with requireTLS). The user name,
// sender address and sender name may be personal data: the audit log gets references only.
import { SECRET_NAMES } from "@ebooktrivia/db";
import { isPlainAddress, isSafeDisplayName } from "@ebooktrivia/core";
import { type FieldKind, withAudit } from "../audit.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import type { Sql } from "../db.ts";
import { checkSmtpHost, ENDPOINT_MESSAGES } from "./endpoints.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput, optionalLine, wholeNumber } from "./fields.ts";
import { clearSecret, parseSecret, requireSealer, secretStatus, type SecretStatus, writeSecret } from "./secrets.ts";

const SMTP_FIELDS: Readonly<Record<string, FieldKind>> = {
  host: "value",
  port: "value",
  security: "value",
  username: "pii",
  from_address: "pii",
  from_name: "pii",
  allow_private_ip: "value",
};

export interface SmtpInput {
  readonly host: string;
  readonly port: number;
  readonly security: "starttls" | "tls";
  readonly username: string | null;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly allowPrivateIp: boolean;
}

// The sender rules are core's, shared with the SMTP adapter (code review US-017 L5), so a sender it
// would refuse is refused here.

export function parseSmtp(values: Readonly<Record<"host" | "port" | "security" | "username" | "fromAddress" | "fromName", string>>, allowPrivateIp: boolean): SmtpInput {
  const host = checkSmtpHost(values.host, allowPrivateIp);
  if (!host.ok) throw new InvalidInput(ENDPOINT_MESSAGES[host.reason]);
  if (values.security !== "starttls" && values.security !== "tls") throw new InvalidInput("Choose STARTTLS or TLS.");
  const fromAddress = values.fromAddress.trim();
  if (!isPlainAddress(fromAddress)) throw new InvalidInput("Enter the sender address as name@domain (no display name here).");
  const fromName = optionalLine(values.fromName, "The sender name is up to 64 characters without < > \" \\ , ; : @ ( ) [ ].", 64);
  if (fromName !== null && !isSafeDisplayName(fromName)) throw new InvalidInput("The sender name is up to 64 characters without < > \" \\ , ; : @ ( ) [ ].");
  const port = wholeNumber(values.port, "The port is 1 to 65535 (usually 587 for STARTTLS or 465 for TLS).", { min: 1, max: 65_535 });
  // The worker's SMTP adapter uses implicit TLS on port 465 and STARTTLS (required) on any other.
  if ((values.security === "tls") !== (port === 465)) throw new InvalidInput("Use TLS with port 465, and STARTTLS with any other port (usually 587).");
  return {
    host: host.host,
    port,
    security: values.security,
    username: optionalLine(values.username, "The user name is one line of up to 256 characters.", 256),
    fromAddress,
    fromName,
    allowPrivateIp,
  };
}

const row = (s: SmtpInput) => ({
  host: s.host,
  port: s.port,
  security: s.security,
  username: s.username,
  from_address: s.fromAddress,
  from_name: s.fromName,
  allow_private_ip: s.allowPrivateIp,
});

/** Saves the server; returns whether the password was deleted because the host changed. */
export async function saveSmtp(sql: Sql, input: SmtpInput): Promise<{ readonly passwordCleared: boolean }> {
  return auditedChange(
    sql,
    async (tx, audit) => {
    const [before] = await tx<Record<string, unknown>[]>`
      SELECT host, port, security, username, from_address, from_name, allow_private_ip FROM public.smtp_settings FOR UPDATE`;
    const had = (await tx`SELECT 1 FROM public.settings_secrets WHERE name = ${SECRET_NAMES.smtpPassword}`).length > 0;
    const values = row(input);
    if (before === undefined) await tx`INSERT INTO public.smtp_settings ${tx(values)}`;
    else await tx`UPDATE public.smtp_settings SET ${tx(values)}, updated_at = clock_timestamp()`;
    const has = (await tx`SELECT 1 FROM public.settings_secrets WHERE name = ${SECRET_NAMES.smtpPassword}`).length > 0;
    audit({ action: "smtp.update", entityType: "smtp_settings", entityId: "default", fields: SMTP_FIELDS, before: before ?? null, after: values, facts: { password_cleared: had && !has } });
    return { passwordCleared: had && !has };
    },
    // Two first saves of the single row raced (code review US-017 L9).
    { "23505": CONCURRENT_SAVE },
  );
}

export async function setSmtpPassword(sql: Sql, settings: SettingsConfig, raw: string): Promise<void> {
  const sealer = requireSealer(settings, "messaging");
  const password = parseSecret(raw);
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [server] = await tx<{ host: string }[]>`SELECT host FROM public.smtp_settings FOR UPDATE`;
      if (server === undefined) throw new InvalidInput("Save the SMTP server first: the password is bound to its host.");
      await writeSecret(tx, audit, sealer, { scope: "messaging", name: SECRET_NAMES.smtpPassword, adnetId: null, boundHost: server.host }, password);
    },
    { "23505": CONCURRENT_SAVE },
  );
}

export async function clearSmtpPassword(sql: Sql): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    await clearSecret(tx, audit, { scope: "messaging", name: SECRET_NAMES.smtpPassword, adnetId: null });
  });
}

export interface SmtpView {
  readonly server: (SmtpInput & { readonly updatedAt: Date }) | null;
  readonly password: SecretStatus;
}

export async function getSmtp(sql: Sql): Promise<SmtpView> {
  const [s] = await sql<{ host: string; port: number; security: "starttls" | "tls"; username: string | null; from_address: string; from_name: string | null; allow_private_ip: boolean; updated_at: Date }[]>`
    SELECT host, port, security, username, from_address, from_name, allow_private_ip, updated_at FROM public.smtp_settings`;
  return {
    server:
      s === undefined
        ? null
        : { host: s.host, port: s.port, security: s.security, username: s.username, fromAddress: s.from_address, fromName: s.from_name, allowPrivateIp: s.allow_private_ip, updatedAt: s.updated_at },
    password: await secretStatus(sql, { scope: "messaging", name: SECRET_NAMES.smtpPassword, adnetId: null }),
  };
}
