import type { Metadata } from "next";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { CheckboxField, PageHeading, SecretBadge, SelectField, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { getSmtp } from "../../../../lib/settings/smtp.ts";
import { clearSmtpPasswordAction, saveSmtpAction, setSmtpPasswordAction } from "./actions.ts";

export const metadata: Metadata = { title: "SMTP | Admin Console" };

/** Owner only: the SMTP server for e-mail delivery and its write-only password. */
export default async function SmtpPage() {
  await requireAdmin({ permission: "smtp.edit" });
  const rt = await getRuntime();
  const { server, password } = await getSmtp(rt.sql);
  const sealing = rt.settings.sealer?.scopes.includes("messaging") === true;
  return (
    <>
      <PageHeading title="SMTP" description="E-mail delivery of the ebook and login link. TLS is always required; the password is bound to the host and removed if the host changes." />
      <Card>
        <CardTitle className="text-base">Server</CardTitle>
        <ActionForm action={saveSmtpAction} submitLabel="Save SMTP server" className="grid gap-3 sm:grid-cols-2" testId="smtp-server">
          <TextField id="smtp-host" name="host" label="Host" defaultValue={server?.host} maxLength={253} placeholder="smtp.example.id" />
          <TextField id="smtp-port" name="port" label="Port" inputMode="numeric" defaultValue={server?.port ?? 587} maxLength={5} />
          <SelectField
            id="smtp-security"
            name="security"
            label="Security"
            defaultValue={server?.security ?? "starttls"}
            options={[
              { value: "starttls", label: "STARTTLS (usually port 587)" },
              { value: "tls", label: "TLS (usually port 465)" },
            ]}
          />
          <TextField id="smtp-user" name="username" label="User name" defaultValue={server?.username} required={false} maxLength={256} />
          <TextField id="smtp-from" name="fromAddress" label="Sender address" type="email" defaultValue={server?.fromAddress} maxLength={254} />
          <TextField id="smtp-from-name" name="fromName" label="Sender name" defaultValue={server?.fromName} required={false} maxLength={64} />
          <CheckboxField id="smtp-private" name="allowPrivateIp" label="Allow private IP" defaultChecked={server?.allowPrivateIp ?? false} hint="Only for an SMTP relay on your private network. Audited." />
        </ActionForm>
      </Card>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Password</CardTitle>
          <SecretBadge status={password} testId="smtp-password-status" />
        </div>
        {server === null ? (
          <CardDescription>Save the server first: the password is bound to its host.</CardDescription>
        ) : sealing ? (
          <ActionForm inlineActions action={setSmtpPasswordAction} submitLabel="Save password" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <TextField id="smtp-password" name="password" label="Password (write-only)" type="password" autoComplete="new-password" maxLength={4096} />
          </ActionForm>
        ) : (
          <CardDescription>The password cannot be saved: the messaging sealing key is not configured on the server.</CardDescription>
        )}
        {password.set ? <ActionForm action={clearSmtpPasswordAction} submitLabel="Remove password" variant="outline" /> : null}
      </Card>
    </>
  );
}
