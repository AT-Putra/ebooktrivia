"use server";
// Owner only (cs_contact.edit): the customer-service contact buyers are shown (Owner decision 2026-11-24), audited.
import type { SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { CS_CONTACT_FIELDS, parseCsContact, saveCsContact } from "../../../../lib/settings/cs-contact.ts";
import { onlyFields } from "../../../../lib/settings/fields.ts";

const PATH = "/settings/customer-service";

export const saveCsContactAction = adminAction({ permission: "cs_contact.edit" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, CS_CONTACT_FIELDS);
    await saveCsContact(rt.sql, admin.userId, parseCsContact(form));
    return "Customer service contact saved. Buyers see it within a minute.";
  }),
);
