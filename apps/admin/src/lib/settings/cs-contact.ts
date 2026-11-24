// The customer-service (CS) contact (Owner decision 2026-11-24): the WhatsApp number, e-mail address and opening hours a buyer with a
// problem is shown (the buyer site's help block on every page, a CS line in a few fixed WhatsApp replies, the {cs_whatsapp} / {cs_email}
// template variables). Owner only (cs_contact.edit): the page, the action and the table's use are the Owner's; Staff see nothing of it.
//   - Each field may be empty; an empty one is shown nowhere. The number is an Indonesian mobile number, stored as E.164 and shown to
//     buyers as 0812-3456-7890; the address is lower-cased and ASCII only; the hours are one line of up to 80 characters with no control, format
//     (bidi, zero-width ...) or line-separator character. The checks here (core isCsEmail / isCsHours) and the table's CHECKs are the same rules, so a
//     value the form accepts is never refused by the database; if it is, the Owner gets the fixed message below, not an error page.
//   - The CS number may NOT be one of the WhatsApp sending numbers (waha_sessions.phone, active or not): a buyer who writes to it must reach a
//     person, not the pool's robot. Held in the database for every writer (cs_contact_not_a_sending_number / waha_sessions_not_the_cs_number,
//     ET190), and this module says so in words; the WhatsApp settings (waha.ts) map the same refusal when a session is added or edited
//     with the CS number.
//   - Every change is audited (the number and the address as PII references, the hours as a value). Messages are fixed text.
import { CS_HOURS_MAX, type CsContact, csLine, csLocalPhone, isCsEmail, isCsHours, NO_CS_CONTACT, normalizeIdMobile } from "@ebooktrivia/core";
import type { FieldKind } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { formValue, InvalidInput } from "./fields.ts";

export const CS_CONTACT_FIELDS: readonly string[] = ["whatsapp", "email", "hours"];
const AUDIT_FIELDS: Readonly<Record<string, FieldKind>> = { whatsapp: "pii", email: "pii", hours: "value" };

/** What the console says when the database refuses the CS number as a sending number (also used by the WhatsApp settings for the other direction). */
export const CS_NUMBER_IS_SENDING = "This number is one of the WhatsApp sending numbers (Settings > WhatsApp). The customer-service number must be another number, one a person answers.";
export const SENDING_NUMBER_IS_CS = "This number is the customer-service number (Settings > Customer service). A sending number must be another number: customer service has to reach a person, not the robot.";

/** What the console says when a table CHECK refuses a value the form let through. */
export const CS_NOT_VALID = "The number, the e-mail address or the hours are not valid for the customer-service contact. Check them and save again.";

/** The form: a blank field means "none"; the number is normalised, the address lower-cased. Messages are fixed text, never the input. */
export function parseCsContact(form: FormData): CsContact {
  const numberText = formValue(form, "whatsapp").trim();
  const emailText = formValue(form, "email").trim().toLowerCase();
  let whatsapp: string | null = null;
  if (numberText !== "") {
    const parsed = normalizeIdMobile(numberText);
    if (!parsed.ok) throw new InvalidInput("Enter an Indonesian mobile number, e.g. 0812 3456 7890, or leave it empty.");
    whatsapp = parsed.e164;
  }
  if (emailText !== "" && !isCsEmail(emailText)) throw new InvalidInput("Enter a valid e-mail address with letters, digits and . _ % + - only, or leave it empty.");
  const hoursText = formValue(form, "hours").trim();
  if (hoursText !== "" && !isCsHours(hoursText)) {
    throw new InvalidInput(`Enter the hours on one line of up to ${String(CS_HOURS_MAX)} characters, with no line break or invisible character, or leave it empty.`);
  }
  return { whatsapp, email: emailText === "" ? null : emailText, hours: hoursText === "" ? null : hoursText };
}

export async function getCsContact(sql: Sql): Promise<CsContact> {
  const [row] = await sql<{ whatsapp: string | null; email: string | null; hours: string | null }[]>`SELECT whatsapp, email, hours FROM public.cs_contact WHERE id = 1`;
  return row === undefined ? NO_CS_CONTACT : { whatsapp: row.whatsapp, email: row.email, hours: row.hours };
}

export async function saveCsContact(sql: Sql, adminUserId: string, next: CsContact): Promise<void> {
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [row] = await tx<{ whatsapp: string | null; email: string | null; hours: string | null }[]>`SELECT whatsapp, email, hours FROM public.cs_contact WHERE id = 1 FOR UPDATE`;
      const before = row === undefined ? null : { whatsapp: row.whatsapp, email: row.email, hours: row.hours };
      const after = { whatsapp: next.whatsapp, email: next.email, hours: next.hours };
      // No row yet is "nothing set": a first save of an empty form changes nothing, so it writes no row and no audit entry.
      const was = before ?? NO_CS_CONTACT;
      if (was.whatsapp === after.whatsapp && was.email === after.email && was.hours === after.hours) throw new InvalidInput("Nothing changed.");
      await tx`
        INSERT INTO public.cs_contact (id, whatsapp, email, hours, updated_by_admin_user_id, updated_at)
        VALUES (1, ${next.whatsapp}, ${next.email}, ${next.hours}, ${adminUserId}, clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET whatsapp = EXCLUDED.whatsapp, email = EXCLUDED.email, hours = EXCLUDED.hours,
          updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
      audit({ action: "cs_contact.update", entityType: "cs_contact", entityId: "1", fields: AUDIT_FIELDS, before, after });
    },
    // The database decides (cs_contact_not_a_sending_number, also when a session with this number is being added at the same moment). A CHECK that the
    // form's own validation did not catch (the rules are the same, so it should not happen) is still a message, not an error page.
    { ET190: CS_NUMBER_IS_SENDING, "23514": CS_NOT_VALID },
  );
}

/** What the page shows buyers and templates, so the Owner can check the result before anyone reads it. */
export interface CsPreview {
  /** The {cs} of the WhatsApp replies, or null when no number or address is set (the replies then stay as they were). */
  readonly line: string | null;
  readonly csWhatsapp: string;
  readonly csEmail: string;
}

export function csPreview(contact: CsContact): CsPreview {
  return { line: csLine(contact), csWhatsapp: contact.whatsapp === null ? "" : csLocalPhone(contact.whatsapp), csEmail: contact.email ?? "" };
}
