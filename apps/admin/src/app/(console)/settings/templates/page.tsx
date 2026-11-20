import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading, SelectField, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { listTemplates, listTestRecipients, TEMPLATE_CATALOG, TEST_RECIPIENT_MAX, TEST_SEND_CAPS } from "../../../../lib/settings/templates.ts";
import { activeSessions } from "../../../../lib/settings/waha.ts";
import { addTestRecipientAction, previewTemplateAction, removeTestRecipientAction, testSendTemplateAction, updateTemplateAction } from "./actions.ts";
import { TemplateEditor } from "./template-editor.tsx";

export const metadata: Metadata = { title: "Message templates | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const TEST_STATUS: Readonly<Record<string, "warning" | "info" | "success" | "destructive">> = { pending: "warning", sending: "info", sent: "success", failed: "destructive" };

/** WhatsApp and e-mail templates (Bahasa Indonesia): edit, preview, test-send (a worker job). */
export default async function TemplatesPage() {
  const admin = await requireAdmin({ permission: "message_template.edit" });
  const rt = await getRuntime();
  const [templates, sessions, recipients] = await Promise.all([listTemplates(rt.sql), activeSessions(rt.sql), listTestRecipients(rt.sql)]);
  const testSend = can(admin.role, "message_template.test_send");
  const manageRecipients = can(admin.role, "test_recipient.manage");
  return (
    <>
      <PageHeading
        title="Message templates"
        description={`Variables: {nama} {judul_ebook} {order_id} {link_trivia} {kode_otp}, as each template allows. Test messages use sample values (never a real code or link): e-mail goes to your login address, WhatsApp to the Owner's test numbers; at most ${String(TEST_SEND_CAPS.perAdminHour)} per hour and ${String(TEST_SEND_CAPS.perAdminDay)} per day each.`}
      />
      {manageRecipients ? (
        <Card data-testid="test-recipients">
          <CardTitle className="text-base">WhatsApp test numbers</CardTitle>
          <CardDescription>The only numbers a WhatsApp test-send may go to (at most {TEST_RECIPIENT_MAX}). Every change is audited.</CardDescription>
          <ul className="flex flex-col gap-2">
            {recipients.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3">
                <span className="text-sm">{r.label}</span>
                <span className="font-mono text-xs">{r.masked}</span>
                <ActionForm action={removeTestRecipientAction} submitLabel="Remove" variant="ghost" className="flex items-center gap-2">
                  <input type="hidden" name="testRecipientId" value={r.id} />
                </ActionForm>
              </li>
            ))}
          </ul>
          {recipients.length < TEST_RECIPIENT_MAX ? (
            <ActionForm action={addTestRecipientAction} submitLabel="Add test number" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <TextField id="test-recipient-phone" name="phone" label="WhatsApp number" inputMode="tel" maxLength={32} />
              <TextField id="test-recipient-label" name="label" label="Label" maxLength={60} placeholder="Owner phone" />
            </ActionForm>
          ) : null}
        </Card>
      ) : null}
      {templates.map((template) => {
        const entry = TEMPLATE_CATALOG[template.key];
        return (
          <Card key={template.id} data-testid={`template-${template.key}-${template.channel}`}>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{entry?.label ?? template.key}</CardTitle>
              <Badge variant="secondary">{template.channel === "email" ? "E-mail" : "WhatsApp"}</Badge>
            </div>
            <CardDescription>Allowed: {entry?.variables.map((v) => `{${v}}`).join(" ")}</CardDescription>
            <TemplateEditor template={template} save={updateTemplateAction} previewAction={previewTemplateAction} />
            {testSend ? (
              <div className="flex flex-col gap-2 border-t pt-4">
                <span className="text-sm font-medium">Test-send the saved template</span>
                {template.channel === "whatsapp" && sessions.length === 0 ? (
                  <CardDescription>No active WhatsApp session yet (Settings, WhatsApp).</CardDescription>
                ) : template.channel === "whatsapp" && recipients.length === 0 ? (
                  <CardDescription>No WhatsApp test number yet (the Owner adds them above).</CardDescription>
                ) : (
                  <ActionForm action={testSendTemplateAction} submitLabel="Send test" variant="secondary" testId="template-test-send" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <input type="hidden" name="templateId" value={template.id} />
                    {template.channel === "email" ? (
                      <p className="text-sm sm:col-span-2">Sends to your login e-mail address.</p>
                    ) : (
                      <>
                        <SelectField id={`test-to-${template.id}`} name="testRecipientId" label="Send to" options={recipients.map((r) => ({ value: r.id, label: `${r.label} (${r.masked})` }))} />
                        <SelectField id={`test-from-${template.id}`} name="wahaSessionId" label="Send from" options={sessions.map((s) => ({ value: s.id, label: s.label }))} />
                      </>
                    )}
                  </ActionForm>
                )}
                {template.recentTests.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-xs" data-testid="template-tests">
                    {template.recentTests.map((t) => (
                      <li key={t.id} className="flex items-center gap-2">
                        <Badge variant={TEST_STATUS[t.status] ?? "secondary"}>{t.status}</Badge>
                        <span>{WIB.format(t.createdAt)}</span>
                        {t.error === null ? null : <span className="font-mono">{t.error}</span>}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Card>
        );
      })}
    </>
  );
}
