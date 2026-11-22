import type { Metadata } from "next";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading, SelectField, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { getAlertRecipients, maskedPhone } from "../../../../lib/settings/alert-recipients.ts";
import { saveAlertRecipientsAction, sendTestAlertAction } from "./actions.ts";

export const metadata: Metadata = { title: "Alert recipients | Admin Console" };

/** Owner only: who the worker's alert relay sends alerts to, and from which severity. */
export default async function AlertRecipientsPage() {
  await requireAdmin({ permission: "alert_recipients.edit" });
  const { sql } = await getRuntime();
  const recipients = await getAlertRecipients(sql);
  return (
    <>
      <PageHeading
        title="Alert recipients"
        description="The worker sends one digest a minute at most, by WhatsApp and by e-mail, of the alerts at or above the lowest severity: the kind, the severity and a short masked message, never a buyer's name, phone number or e-mail. Uptime Kuma on the other box is a second, independent route for a critical alert that stays unsent. Every change is audited."
      />
      <Card>
        <CardTitle className="text-base">Recipients</CardTitle>
        <CardDescription>
          {recipients.phone === null ? "No WhatsApp number is set." : `WhatsApp: ${maskedPhone(recipients.phone)}.`} {recipients.email === null ? "No e-mail address is set." : "An e-mail address is set."} The WhatsApp message comes
          from the pool: write to a pool number once from this phone, so that WhatsApp lets it answer (docs/runbooks/alerts.md).
        </CardDescription>
        <ActionForm action={saveAlertRecipientsAction} submitLabel="Save recipients" className="grid gap-3 sm:grid-cols-2" testId="alert-recipients-form">
          <TextField id="alert-phone" name="phone" label="WhatsApp number" inputMode="tel" required={false} maxLength={24} placeholder="0812 3456 7890" hint="An Indonesian mobile number. Leave empty for no WhatsApp alerts." />
          <TextField id="alert-email" name="email" label="E-mail address" type="email" defaultValue={recipients.email ?? undefined} required={false} maxLength={254} hint="Leave empty for no e-mail alerts." />
          <SelectField
            id="alert-min-severity"
            name="minSeverity"
            label="Lowest severity sent"
            defaultValue={recipients.minSeverity}
            options={[
              { value: "info", label: "Info and above" },
              { value: "warning", label: "Warning and above (default)" },
              { value: "critical", label: "Critical only" },
            ]}
          />
        </ActionForm>
      </Card>
      <Card>
        <CardTitle className="text-base">Test</CardTitle>
        <CardDescription>Writes an info alert that is sent whatever the lowest severity is, so you can see the whole path work.</CardDescription>
        <ActionForm action={sendTestAlertAction} submitLabel="Send a test alert" variant="secondary" testId="alert-test-form" />
      </Card>
    </>
  );
}
