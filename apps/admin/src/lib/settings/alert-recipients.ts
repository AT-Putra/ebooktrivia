// Alert recipients (US-015): where the worker's alert relay (apps/worker/src/alert-relay.ts) sends the Owner's alerts: ONE WhatsApp
// number (an Indonesian mobile number, stored as E.164), ONE e-mail address, and the lowest severity that is sent (default
// warning). Owner only (alert_recipients.edit): the page, the action and the table's own use are the Owner's, Staff see nothing of it.
// Every change is audited with the number and the address classified as PII (the audit log masks them). "Send a test alert"
// writes an info alert that the relay sends whatever the minimum is, so the Owner can see that the whole path works.
import { maskPhoneTail, normalizeIdMobile } from "@ebooktrivia/core";
import type { FieldKind } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { formValue, InvalidInput } from "./fields.ts";

export const MIN_SEVERITIES = ["info", "warning", "critical"] as const;
export type MinSeverity = (typeof MIN_SEVERITIES)[number];

export const ALERT_RECIPIENT_FIELDS: readonly string[] = ["phone", "email", "minSeverity"];
const AUDIT_FIELDS: Readonly<Record<string, FieldKind>> = { phone: "pii", email: "pii", min_severity: "value" };

export interface AlertRecipients {
  readonly phone: string | null;
  readonly email: string | null;
  readonly minSeverity: MinSeverity;
}

/** What the page shows before anything was saved. */
export const NO_ALERT_RECIPIENTS: AlertRecipients = { phone: null, email: null, minSeverity: "warning" };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The form: a blank field means "none"; the number is normalised, the address lower-cased. Messages are fixed text. */
export function parseAlertRecipients(form: FormData): AlertRecipients {
  const phoneText = formValue(form, "phone").trim();
  const emailText = formValue(form, "email").trim().toLowerCase();
  const severity = formValue(form, "minSeverity");
  let phone: string | null = null;
  if (phoneText !== "") {
    const parsed = normalizeIdMobile(phoneText);
    if (!parsed.ok) throw new InvalidInput("Enter an Indonesian mobile number, e.g. 0812 3456 7890, or leave it empty.");
    phone = parsed.e164;
  }
  if (emailText !== "" && (emailText.length > 254 || !EMAIL.test(emailText))) throw new InvalidInput("Enter a valid e-mail address, or leave it empty.");
  if (!(MIN_SEVERITIES as readonly string[]).includes(severity)) throw new InvalidInput("Choose info, warning or critical as the lowest severity.");
  return { phone, email: emailText === "" ? null : emailText, minSeverity: severity as MinSeverity };
}

export async function getAlertRecipients(sql: Sql): Promise<AlertRecipients> {
  const [row] = await sql<{ phone: string | null; email: string | null; min_severity: MinSeverity }[]>`
    SELECT phone, email, min_severity FROM public.alert_recipients WHERE id = 1`;
  return row === undefined ? NO_ALERT_RECIPIENTS : { phone: row.phone, email: row.email, minSeverity: row.min_severity };
}

/** "0812-3456-****" (core maskPhoneTail, the one masked form of a number; Owner decision 2026-11-25): enough for the page to show which number is set. */
export const maskedPhone = (e164: string): string => maskPhoneTail(e164);

export async function saveAlertRecipients(sql: Sql, adminUserId: string, next: AlertRecipients): Promise<void> {
  await auditedChange(sql, async (tx, audit) => {
    const [row] = await tx<{ phone: string | null; email: string | null; min_severity: MinSeverity }[]>`
      SELECT phone, email, min_severity FROM public.alert_recipients WHERE id = 1 FOR UPDATE`;
    const before = row === undefined ? null : { phone: row.phone, email: row.email, min_severity: row.min_severity };
    const after = { phone: next.phone, email: next.email, min_severity: next.minSeverity };
    if (before !== null && before.phone === after.phone && before.email === after.email && before.min_severity === after.min_severity) throw new InvalidInput("Nothing changed.");
    await tx`
      INSERT INTO public.alert_recipients (id, phone, email, min_severity, updated_by_admin_user_id, updated_at)
      VALUES (1, ${next.phone}, ${next.email}, ${next.minSeverity}, ${adminUserId}, clock_timestamp())
      ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, email = EXCLUDED.email, min_severity = EXCLUDED.min_severity,
        updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
    audit({ action: "alert_recipients.update", entityType: "alert_recipients", entityId: "1", fields: AUDIT_FIELDS, before, after });
  });
}

/** The text of a test alert: no data, so nothing in it can be PII. */
export const TEST_ALERT_MESSAGE = "Test alert from the admin console: if you read this, alerts reach you.";

/**
 * Writes an info alert (source admin, kind test_alert, payload {"test": true}) for the relay to send, whatever the lowest severity is.
 * Needs at least one channel to be set, so the Owner is not told "sent" when nothing can be.
 */
export async function sendTestAlert(sql: Sql, adminUserId: string): Promise<void> {
  await auditedChange(sql, async (tx, audit) => {
    const [row] = await tx<{ phone: string | null; email: string | null }[]>`SELECT phone, email FROM public.alert_recipients WHERE id = 1`;
    if (row === undefined || (row.phone === null && row.email === null)) throw new InvalidInput("Save a WhatsApp number or an e-mail address first.");
    const [alert] = await tx<{ id: string }[]>`
      INSERT INTO public.alerts (source, kind, severity, dedupe_key, message, payload)
      VALUES ('admin', 'test_alert', 'info', ${`test_alert:${crypto.randomUUID()}`}, ${TEST_ALERT_MESSAGE}, '{"test": true}'::jsonb)
      RETURNING id`;
    audit({ action: "alert_recipients.test", entityType: "alert", entityId: alert?.id ?? null, facts: { by_admin_user_id: adminUserId } });
  });
}
