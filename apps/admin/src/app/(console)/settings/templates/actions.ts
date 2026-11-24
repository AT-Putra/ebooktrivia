"use server";
// Staff and Owner (AC-A1 content): message_template.edit to save and preview,
// message_template.test_send to request a test message. A test-send is only a worker job (outbox
// row); the admin app never sends. Adding and removing an opener wording is message_template.edit too.
import { redirect } from "next/navigation";
import type { Sql } from "../../../../lib/db.ts";
import type { PreviewState, SaveState } from "../../../../lib/form-state.ts";
import { adminAction } from "../../../../lib/next/actions.ts";
import { saveResult } from "../../../../lib/next/settings-result.ts";
import { formValue, InvalidInput, onlyFields, uuid } from "../../../../lib/settings/fields.ts";
import { addOpenerWording, addTestRecipient, parseTemplate, preview, removeOpenerWording, removeTestRecipient, requestTestSend, type TemplateChannel, updateTemplate } from "../../../../lib/settings/templates.ts";

const PATH = "/settings/templates";

async function stored(sql: Sql, id: string): Promise<{ key: string; channel: TemplateChannel }> {
  const [row] = await sql<{ key: string; channel: TemplateChannel }[]>`SELECT key, channel FROM public.message_templates WHERE id = ${id}`;
  if (row === undefined) throw new InvalidInput("This template no longer exists.");
  return row;
}

export const updateTemplateAction = adminAction({ permission: "message_template.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const id = uuid(formValue(form, "templateId"));
    const template = await stored(rt.sql, id);
    await updateTemplate(rt.sql, id, parseTemplate(template.key, template.channel, { subject: formValue(form, "subject"), body: formValue(form, "body") }));
    return "Template saved.";
  }),
);

export const addOpenerWordingAction = adminAction({ permission: "message_template.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    onlyFields(form, ["body"]);
    const key = await addOpenerWording(rt.sql, formValue(form, "body"));
    return `Wording added as ${key}.`;
  }),
);

// A removed wording takes the card that holds its form with it, so the form cannot show "Wording removed.": on success the action sends the browser to the
// page with ?deleted=wording, which shows the fixed text once (DeletedNotice). A refusal stays a form message.
export const removeOpenerWordingAction = adminAction({ permission: "message_template.edit" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> => {
  const result = await saveResult(PATH, async () => {
    onlyFields(form, ["templateId"]);
    await removeOpenerWording(rt.sql, uuid(formValue(form, "templateId")));
    return "Wording removed.";
  });
  if (result.status === "saved") redirect(`${PATH}?deleted=wording`);
  return result;
});

/** Renders the edited (unsaved) text with sample values; changes nothing. */
export const previewTemplateAction = adminAction({ permission: "message_template.edit" }, async ({ rt }, _previous: PreviewState, form: FormData): Promise<PreviewState> => {
  try {
    const template = await stored(rt.sql, uuid(formValue(form, "templateId")));
    const text = parseTemplate(template.key, template.channel, { subject: formValue(form, "subject"), body: formValue(form, "body") });
    return { status: "preview", at: Date.now(), ...preview(template.key, template.channel, text, formValue(form, "sampleName")) };
  } catch (error) {
    if (error instanceof InvalidInput) return { status: "error", at: Date.now(), error: error.message };
    throw error;
  }
});

export const testSendTemplateAction = adminAction({ permission: "message_template.test_send" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    const id = uuid(formValue(form, "templateId"));
    const template = await stored(rt.sql, id);
    const whatsapp = template.channel === "whatsapp";
    await requestTestSend(rt.sql, admin.userId, {
      templateId: id,
      testRecipientId: whatsapp ? uuid(formValue(form, "testRecipientId"), "Choose a test number.") : null,
      wahaSessionId: whatsapp ? uuid(formValue(form, "wahaSessionId"), "Choose the WhatsApp session to send from.") : null,
    });
    return whatsapp ? "Test message queued: the worker sends the saved template with sample values." : "Test message queued to your login e-mail: the worker sends the saved template with sample values.";
  }),
);

export const addTestRecipientAction = adminAction({ permission: "test_recipient.manage" }, async ({ rt, admin }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await addTestRecipient(rt.sql, admin.userId, { phone: formValue(form, "phone"), label: formValue(form, "label") });
    return "Test number added.";
  }),
);

export const removeTestRecipientAction = adminAction({ permission: "test_recipient.manage" }, async ({ rt }, _previous: SaveState, form: FormData): Promise<SaveState> =>
  saveResult(PATH, async () => {
    await removeTestRecipient(rt.sql, uuid(formValue(form, "testRecipientId")));
    return "Test number removed.";
  }),
);
