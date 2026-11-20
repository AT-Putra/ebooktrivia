import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { CheckboxField, PageHeading, SecretBadge, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { listWahaServers } from "../../../../lib/settings/waha.ts";
import {
  clearWahaApiKeyAction,
  createWahaServerAction,
  createWahaSessionAction,
  setWahaApiKeyAction,
  updateWahaServerAction,
  updateWahaSessionAction,
} from "./actions.ts";

export const metadata: Metadata = { title: "WhatsApp (WAHA) | Admin Console" };

const PRIVATE_HINT = "Only for a WAHA box on your private network (10.x, 172.16-31.x, 192.168.x, 100.64/10). Loopback, link-local and cloud metadata addresses are never allowed. Audited.";

function SessionFields({ prefix, session }: { prefix: string; session?: { sessionName: string; phone: string | null; weight: number; dailyCap: number; active: boolean } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <TextField id={`${prefix}-name`} name="sessionName" label="Session name" defaultValue={session?.sessionName} maxLength={64} />
      <TextField id={`${prefix}-phone`} name="phone" label="Number" defaultValue={session?.phone} required={false} inputMode="tel" maxLength={32} />
      <TextField id={`${prefix}-weight`} name="weight" label="Weight" inputMode="numeric" defaultValue={session?.weight ?? 1} maxLength={3} />
      <TextField id={`${prefix}-cap`} name="dailyCap" label="Daily cap" inputMode="numeric" defaultValue={session?.dailyCap ?? 200} maxLength={5} />
      <CheckboxField id={`${prefix}-active`} name="active" label="Active" defaultChecked={session?.active ?? true} />
    </div>
  );
}

/** Owner only: WAHA servers (https base URL, API key, private-IP allowlist) and their sessions. */
export default async function WahaPage() {
  await requireAdmin({ permission: "waha.edit" });
  const rt = await getRuntime();
  const servers = await listWahaServers(rt.sql);
  const sealing = rt.settings.sealer?.scopes.includes("messaging") === true;
  return (
    <>
      <PageHeading title="WhatsApp (WAHA)" description="Sending numbers for ebook delivery and login codes: weighted round robin with a daily cap per number." />
      <Card>
        <CardTitle className="text-base">New WAHA server</CardTitle>
        <ActionForm action={createWahaServerAction} submitLabel="Add server" testId="waha-create" className="grid gap-3 sm:grid-cols-2">
          <TextField id="new-waha-name" name="name" label="Name" maxLength={100} />
          <TextField id="new-waha-url" name="baseUrl" label="Base URL (https)" type="url" maxLength={300} placeholder="https://waha.example.id/" />
          <CheckboxField id="new-waha-private" name="allowPrivateIp" label="Allow private IP" hint={PRIVATE_HINT} />
          <CheckboxField id="new-waha-active" name="active" label="Active" defaultChecked />
        </ActionForm>
      </Card>
      {servers.map((server) => (
        <Card key={server.id} data-testid={`waha-${server.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{server.name}</CardTitle>
            <SecretBadge status={server.apiKey} testId="waha-key-status" />
            {server.allowPrivateIp ? <Badge variant="warning">Private IP allowed</Badge> : null}
            {server.active ? <Badge variant="success">Active</Badge> : <Badge variant="warning">Inactive</Badge>}
          </div>
          <ActionForm action={updateWahaServerAction} submitLabel="Save server" variant="secondary" className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="serverId" value={server.id} />
            <TextField id={`waha-name-${server.id}`} name="name" label="Name" defaultValue={server.name} maxLength={100} />
            <TextField id={`waha-url-${server.id}`} name="baseUrl" label="Base URL (https)" type="url" defaultValue={server.baseUrl} maxLength={300} hint="Changing the host removes the API key." />
            <CheckboxField id={`waha-private-${server.id}`} name="allowPrivateIp" label="Allow private IP" defaultChecked={server.allowPrivateIp} hint={PRIVATE_HINT} />
            <CheckboxField id={`waha-active-${server.id}`} name="active" label="Active" defaultChecked={server.active} />
          </ActionForm>
          {sealing ? (
            <ActionForm action={setWahaApiKeyAction} submitLabel="Save API key" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <input type="hidden" name="serverId" value={server.id} />
              <TextField id={`waha-key-${server.id}`} name="apiKey" label="API key (write-only)" type="password" autoComplete="new-password" maxLength={4096} />
            </ActionForm>
          ) : (
            <CardDescription>API keys cannot be saved: the messaging sealing key is not configured on the server.</CardDescription>
          )}
          {server.apiKey.set ? (
            <ActionForm action={clearWahaApiKeyAction} submitLabel="Remove API key" variant="ghost">
              <input type="hidden" name="serverId" value={server.id} />
            </ActionForm>
          ) : null}
          <div className="flex flex-col gap-3 border-t pt-4">
            <span className="text-sm font-medium">Sessions</span>
            {server.sessions.map((session) => (
              <ActionForm key={session.id} action={updateWahaSessionAction} submitLabel="Save session" variant="outline">
                <input type="hidden" name="serverId" value={server.id} />
                <input type="hidden" name="sessionId" value={session.id} />
                <SessionFields prefix={`sess-${session.id}`} session={session} />
                <span className="text-xs text-muted-foreground">Last status: {session.status ?? "unknown"}</span>
              </ActionForm>
            ))}
            <ActionForm action={createWahaSessionAction} submitLabel="Add session" variant="secondary">
              <input type="hidden" name="serverId" value={server.id} />
              <SessionFields prefix={`new-sess-${server.id}`} />
            </ActionForm>
          </div>
        </Card>
      ))}
    </>
  );
}
