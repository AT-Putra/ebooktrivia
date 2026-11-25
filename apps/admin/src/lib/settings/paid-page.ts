// The order page after a successful payment (the Owner's request of 2026-11-25): its three texts, one wording for every program, edited on the
// Message templates page (message_template.edit) and kept in app_settings (PAID_PAGE_SETTING_KEY, core paid-page.ts holds the defaults and the rules).
// "Reset to default" stores the defaults. Every change is audited (the texts are values, not personal data); messages are fixed text, never the input.
import { isPaidPageText, PAID_PAGE_DEFAULTS, PAID_PAGE_FIELDS, PAID_PAGE_LIMITS, PAID_PAGE_SETTING_KEY, type PaidPageField, type PaidPageWording, paidPageWordingOf } from "@ebooktrivia/core";
import type { FieldKind } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { formValue, InvalidInput } from "./fields.ts";

export const PAID_PAGE_FORM_FIELDS: readonly string[] = [...PAID_PAGE_FIELDS, "reset"];
const SETTING_FIELDS: Readonly<Record<string, FieldKind>> = { value: "value" };

const LABEL: Readonly<Record<PaidPageField, string>> = { body: "The text under the title", button: "The button", note: "The line under the button" };

/** The form: each text trimmed and checked; "reset" (the reset button) gives the defaults. */
export function parsePaidPageForm(form: FormData): PaidPageWording {
  if (formValue(form, "reset") === "1") return PAID_PAGE_DEFAULTS;
  const read = (field: PaidPageField): string => {
    const value = formValue(form, field).trim();
    if (!isPaidPageText(field, value)) {
      const { min, max } = PAID_PAGE_LIMITS[field];
      throw new InvalidInput(`${LABEL[field]}: ${min === 0 ? `up to ${String(max)}` : `${String(min)} to ${String(max)}`} characters on one line, with no line break or invisible character.`);
    }
    return value;
  };
  return { body: read("body"), button: read("button"), note: read("note") };
}

/** What the page shows now (the defaults until the Owner saves a wording). */
export async function getPaidPageWording(sql: Sql): Promise<PaidPageWording> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = ${PAID_PAGE_SETTING_KEY}`;
  return paidPageWordingOf(row?.value);
}

export async function savePaidPageWording(sql: Sql, adminUserId: string, next: PaidPageWording): Promise<void> {
  await auditedChange(sql, async (tx, audit) => {
    const [row] = await tx<{ value: unknown }[]>`SELECT value FROM public.app_settings WHERE key = ${PAID_PAGE_SETTING_KEY} FOR UPDATE`;
    const before = paidPageWordingOf(row?.value);
    if (before.body === next.body && before.button === next.button && before.note === next.note) throw new InvalidInput("Nothing changed.");
    const after = { body: next.body, button: next.button, note: next.note };
    await tx`
      INSERT INTO public.app_settings (key, value, updated_by_admin_user_id, updated_at)
      VALUES (${PAID_PAGE_SETTING_KEY}, ${tx.json(after)}, ${adminUserId}, clock_timestamp())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
    audit({ action: "app_setting.update", entityType: "app_setting", entityId: PAID_PAGE_SETTING_KEY, fields: SETTING_FIELDS, before: { value: before }, after: { value: after } });
  });
}
