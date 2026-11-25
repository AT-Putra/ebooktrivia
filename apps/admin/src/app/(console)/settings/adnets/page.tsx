import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { CheckboxField, PageHeading, SecretBadge, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { type AdnetRow, listAdnets } from "../../../../lib/settings/adnets.ts";
import { clearAdnetSecretAction, createAdnetAction, setAdnetSecretAction, updateAdnetAction } from "./actions.ts";

export const metadata: Metadata = { title: "Adnets | Admin Console" };

const MACROS = "{clickid} {txid} {payout} {status} {sub_id} {pub} {secret:name}";

function AdnetFields({ prefix, adnet }: { prefix: string; adnet?: AdnetRow }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField id={`${prefix}-name`} name="name" label="Name" defaultValue={adnet?.name} maxLength={100} />
      <TextField id={`${prefix}-slug`} name="slug" label="Slug" defaultValue={adnet?.slug} maxLength={64} />
      <TextField id={`${prefix}-click`} name="clickidParam" label="Click id URL parameter" defaultValue={adnet?.clickidParam} maxLength={64} placeholder="clickid" />
      <TextField id={`${prefix}-payout`} name="payoutIdr" label="Payout per MT (IDR)" inputMode="numeric" defaultValue={adnet?.payoutIdr ?? 0} maxLength={14} />
      <TextField id={`${prefix}-mo`} name="mo" label="MO postback URL" defaultValue={adnet?.moUrlTemplate} required={false} maxLength={2048} hint={`Macros: ${MACROS}`} />
      <TextField id={`${prefix}-mt`} name="mt" label="MT postback URL" defaultValue={adnet?.mtUrlTemplate} required={false} maxLength={2048} />
      <TextField id={`${prefix}-rev`} name="reversal" label="Reversal postback URL (optional)" defaultValue={adnet?.reversalUrlTemplate} required={false} maxLength={2048} />
      <CheckboxField id={`${prefix}-active`} name="active" label="Active" defaultChecked={adnet?.active ?? true} />
    </div>
  );
}

/** Owner only: adnets, their postback templates and {secret:name} values (write-only). */
export default async function AdnetsPage() {
  await requireAdmin({ permission: "adnet.edit" });
  const rt = await getRuntime();
  const adnets = await listAdnets(rt.sql);
  const sealing = rt.settings.sealer?.scopes.includes("conversions") === true;
  return (
    <>
      <PageHeading
        title="Adnets"
        description="S2S postbacks: all templates of an adnet share one https host; {secret:name} values are bound to that adnet and host and are removed if the host changes."
      />
      <Card>
        <CardTitle className="text-base">New adnet</CardTitle>
        <ActionForm action={createAdnetAction} submitLabel="Create adnet" testId="adnet-create">
          <AdnetFields prefix="new-adnet" />
        </ActionForm>
      </Card>
      {adnets.map((adnet) => (
        <Card key={adnet.id} data-testid={`adnet-${adnet.slug}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{adnet.name}</CardTitle>
            {adnet.endpointHost === null ? <Badge variant="warning">No postback host</Badge> : <Badge variant="secondary">{adnet.endpointHost}</Badge>}
            {adnet.active ? <Badge variant="success">Active</Badge> : <Badge variant="warning">Inactive</Badge>}
          </div>
          <ActionForm action={updateAdnetAction} submitLabel="Save adnet" variant="secondary">
            <input type="hidden" name="adnetId" value={adnet.id} />
            <AdnetFields prefix={`adnet-${adnet.id}`} adnet={adnet} />
          </ActionForm>
          <div className="flex flex-col gap-3 border-t pt-4">
            <span className="text-sm font-medium">Secrets</span>
            {adnet.secrets.length === 0 ? <CardDescription>No template uses a secret.</CardDescription> : null}
            <ul className="flex flex-col gap-2">
              {adnet.secrets.map((s) => (
                <li key={s.name} className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm">{`{secret:${s.name}}`}</span>
                  <SecretBadge status={s} />
                  {s.referenced ? null : <Badge variant="outline">Not used by a template</Badge>}
                  {s.set ? (
                    <ActionForm action={clearAdnetSecretAction} submitLabel="Remove" variant="outline" className="flex items-center gap-2">
                      <input type="hidden" name="adnetId" value={adnet.id} />
                      <input type="hidden" name="name" value={s.name} />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
            {sealing ? (
              <ActionForm inlineActions action={setAdnetSecretAction} submitLabel="Save secret" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                <input type="hidden" name="adnetId" value={adnet.id} />
                <TextField id={`sec-name-${adnet.id}`} name="name" label="Secret name" maxLength={64} placeholder="api_key" defaultValue={adnet.secrets.find((s) => !s.set)?.name} />
                <TextField id={`sec-value-${adnet.id}`} name="value" label="Value (write-only)" type="password" autoComplete="new-password" maxLength={4096} />
              </ActionForm>
            ) : (
              <CardDescription>Secrets cannot be saved: the conversions sealing key is not configured on the server.</CardDescription>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}
