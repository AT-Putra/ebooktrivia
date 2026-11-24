import type { Metadata } from "next";
import { Fragment } from "react";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { DeletedNotice } from "../../../../components/settings/deleted-notice.tsx";
import { PageHeading, SelectField, TextArea, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { param, type Query } from "../../../../lib/reports/common.ts";
import { isOpenerKey, listTemplates, listTestRecipients, OPENER_MAX_WORDINGS, OPENER_MIN_WORDINGS, TEST_RECIPIENT_MAX, TEST_SEND_CAPS, templateEntry } from "../../../../lib/settings/templates.ts";
import { activeSessions } from "../../../../lib/settings/waha.ts";
import { addOpenerWordingAction, addTestRecipientAction, previewTemplateAction, removeOpenerWordingAction, removeTestRecipientAction, testSendTemplateAction, updateTemplateAction } from "./actions.ts";
import { TemplateEditor } from "./template-editor.tsx";

export const metadata: Metadata = { title: "Message templates | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const TEST_STATUS: Readonly<Record<string, "warning" | "info" | "success" | "destructive">> = { pending: "warning", sending: "info", sent: "success", failed: "destructive" };

/** What `?deleted=` may say: one fixed text, nothing of the query is ever echoed. */
const deletedText = (asked: string): string | undefined => (asked === "wording" ? "Wording removed." : undefined);

/** WhatsApp and e-mail templates (Bahasa Indonesia): edit, preview, test-send (a worker job); add and remove opener wordings. */
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "message_template.edit" });
  const rt = await getRuntime();
  const [templates, sessions, recipients] = await Promise.all([listTemplates(rt.sql), activeSessions(rt.sql), listTestRecipients(rt.sql)]);
  const testSend = can(admin.role, "message_template.test_send");
  const manageRecipients = can(admin.role, "test_recipient.manage");
  const deleted = deletedText(param(await searchParams, "deleted"));
  const openers = templates.filter((t) => isOpenerKey(t.key));
  return (
    <>
      <PageHeading
        title="Message templates"
        description={`Variables: {nama} {judul_ebook} {order_id} {link_trivia} {kode_otp} {sapaan}, as each template allows. In a WhatsApp text, [[Halo|Hai]] is replaced by one of its 2 to 5 options, picked at random for each message. Test messages use sample values (never a real code or link): e-mail goes to your login address, WhatsApp to the Owner's test numbers; at most ${String(TEST_SEND_CAPS.perAdminHour)} per hour and ${String(TEST_SEND_CAPS.perAdminDay)} per day each.`}
      />
      {deleted === undefined ? null : <DeletedNotice text={deleted} />}
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
        const entry = templateEntry(template.key);
        const opener = isOpenerKey(template.key);
        return (
          <Fragment key={template.id}>
            {template.id === openers[0]?.id ? (
              <Card data-testid="opener-wordings">
                <CardTitle className="text-base">WhatsApp opener wordings</CardTitle>
                <CardDescription>
                  {openers.length} of at most {OPENER_MAX_WORDINGS} (at least {OPENER_MIN_WORDINGS}). Each opener to a new buyer uses one wording at random, and a number never repeats one of its last 3. Use {"{sapaan}"} for a greeting and [[a|b]] for a random choice.
                </CardDescription>
                {openers.length < OPENER_MAX_WORDINGS ? (
                  <ActionForm action={addOpenerWordingAction} submitLabel="Add wording" variant="secondary" testId="opener-add">
                    <TextArea id="new-opener-body" name="body" label="New wording" rows={3} hint="Checked like an edit. It is added as the next delivery_opener_N." />
                  </ActionForm>
                ) : (
                  <CardDescription>That is the most there can be: remove one before adding another.</CardDescription>
                )}
              </Card>
            ) : null}
            <Card data-testid={`template-${template.key}-${template.channel}`}>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{entry?.label ?? template.key}</CardTitle>
                <Badge variant="secondary">{template.channel === "email" ? "E-mail" : "WhatsApp"}</Badge>
              </div>
              <CardDescription>Allowed: {entry?.variables.map((v) => `{${v}}`).join(" ")}</CardDescription>
              <TemplateEditor template={template} save={updateTemplateAction} previewAction={previewTemplateAction} />
              {opener ? (
                <div className="flex flex-col gap-2 border-t pt-4">
                  {openers.length > OPENER_MIN_WORDINGS ? (
                    <ActionForm
                      action={removeOpenerWordingAction}
                      submitLabel="Remove wording"
                      variant="destructive"
                      testId="opener-remove"
                      confirm={{ warning: `Remove this wording (${template.key})? It is no longer used for new openers. This cannot be undone.`, yesLabel: "Yes, remove" }}
                    >
                      <input type="hidden" name="templateId" value={template.id} />
                    </ActionForm>
                  ) : (
                    <p className="text-xs text-muted-foreground" data-testid="opener-remove-hint">
                      At least {OPENER_MIN_WORDINGS} wordings stay: add another before removing this one.
                    </p>
                  )}
                </div>
              ) : null}
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
          </Fragment>
        );
      })}
    </>
  );
}
