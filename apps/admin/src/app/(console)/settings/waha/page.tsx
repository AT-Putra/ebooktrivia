import type { Metadata } from "next";
import { newContactLimit, WARMUP_DAYS, warmupDay } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { DeletedNotice } from "../../../../components/settings/deleted-notice.tsx";
import { CheckboxField, PageHeading, SecretBadge, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { param, type Query } from "../../../../lib/reports/common.ts";
import { listWahaServers } from "../../../../lib/settings/waha.ts";
import {
  clearWahaApiKeyAction,
  createWahaServerAction,
  createWahaSessionAction,
  deleteWahaServerAction,
  deleteWahaSessionAction,
  setWahaApiKeyAction,
  updateWahaServerAction,
  updateWahaSessionAction,
} from "./actions.ts";

export const metadata: Metadata = { title: "WhatsApp (WAHA) | Admin Console" };

const PRIVATE_HINT = "Only for a WAHA box on your private network (10.x, 172.16-31.x, 192.168.x, 100.64/10). Loopback, link-local and cloud metadata addresses are never allowed. Audited.";

const ESTABLISHED_HINT = "Tick only for a number that has already been writing to new people for weeks. A new number warms up for 21 days. Unticking it on an established number restarts the warm-up from today. Audited.";

function SessionFields({ prefix, session }: { prefix: string; session?: { sessionName: string; phone: string | null; weight: number; dailyCap: number; active: boolean; warmupStartedAt: Date | null } }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <TextField id={`${prefix}-name`} name="sessionName" label="Session name" defaultValue={session?.sessionName} maxLength={64} />
        <TextField id={`${prefix}-phone`} name="phone" label="Number" defaultValue={session?.phone} required={false} inputMode="tel" maxLength={32} />
        <TextField id={`${prefix}-weight`} name="weight" label="Weight" inputMode="numeric" defaultValue={session?.weight ?? 1} maxLength={3} />
        <TextField id={`${prefix}-cap`} name="dailyCap" label="Daily cap" inputMode="numeric" defaultValue={session?.dailyCap ?? 200} maxLength={5} />
        <CheckboxField id={`${prefix}-active`} name="active" label="Active" defaultChecked={session?.active ?? true} />
      </div>
      <CheckboxField id={`${prefix}-established`} name="established" label="Established number (skip warm-up)" defaultChecked={session !== undefined && session.warmupStartedAt === null} hint={ESTABLISHED_HINT} />
    </>
  );
}

/** "Warm-up: day 3 of 21 - today's new-people limit 5", or that the number is established / has finished its warm-up. */
function warmupLine(session: { newContactCap: number; warmupStartedAt: Date | null }, now: Date): string {
  if (session.warmupStartedAt === null) return "Established number";
  const day = warmupDay(session.warmupStartedAt, now);
  const limit = newContactLimit(session, now);
  if (day >= WARMUP_DAYS) return `Warm-up finished - today's new-people limit ${String(limit)}`;
  return `Warm-up: day ${String(day + 1)} of ${String(WARMUP_DAYS)} - today's new-people limit ${String(limit)}`;
}

/** Why a delete button is not shown: used ones keep only the Active switch; an unused one must be inactive first. */
function DeleteHint({ used, active, what }: { used: boolean; active: boolean; what: "server" | "session" }) {
  const text = used
    ? active
      ? "Has message history: untick Active to stop using it."
      : "Has message history, so it cannot be deleted."
    : what === "server"
      ? "Untick Active on its sessions and save before deleting."
      : "Untick Active and save before deleting.";
  return (
    <p className="text-xs text-muted-foreground" data-testid={`waha-${what}-delete-hint`}>
      {text}
    </p>
  );
}

/** What `?deleted=` may say: two fixed texts, nothing of the query is ever echoed. */
const deletedText = (asked: string): string | undefined => (asked === "server" ? "Server deleted." : asked === "session" ? "Session deleted." : undefined);

/** Owner only: WAHA servers (https base URL, API key, private-IP allowlist) and their sessions. */
export default async function WahaPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin({ permission: "waha.edit" });
  const rt = await getRuntime();
  const servers = await listWahaServers(rt.sql);
  const sealing = rt.settings.sealer?.scopes.includes("messaging") === true;
  const deleted = deletedText(param(await searchParams, "deleted"));
  const now = new Date();
  return (
    <>
      <PageHeading title="WhatsApp (WAHA)" description="Sending numbers for ebook delivery and login codes: weighted round robin with a daily cap per number." />
      {deleted === undefined ? null : <DeletedNotice text={deleted} />}
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
            {server.sessions.length === 0 ? <CardDescription>No session yet.</CardDescription> : null}
            {server.sessions.map((session) => (
              <div
                key={session.id}
                role="group"
                aria-label={`Session ${session.sessionName}`}
                className="flex flex-col gap-3 rounded-lg border p-3"
                data-testid={`waha-session-${session.id}`}
              >
                <ActionForm action={updateWahaSessionAction} submitLabel="Save session" variant="outline">
                  <input type="hidden" name="serverId" value={server.id} />
                  <input type="hidden" name="sessionId" value={session.id} />
                  <SessionFields prefix={`sess-${session.id}`} session={session} />
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <span data-testid="waha-warmup">{warmupLine(session, now)}</span>
                    <span>Last status: {session.status ?? "unknown"}</span>
                  </div>
                </ActionForm>
                {session.used || session.active ? (
                  <DeleteHint used={session.used} active={session.active} what="session" />
                ) : (
                  <ActionForm
                    action={deleteWahaSessionAction}
                    submitLabel="Delete session"
                    variant="destructive"
                    testId="waha-session-delete"
                    confirm={{ warning: `Delete session ${session.sessionName}? This cannot be undone.` }}
                  >
                    <input type="hidden" name="sessionId" value={session.id} />
                  </ActionForm>
                )}
              </div>
            ))}
            <div role="group" aria-labelledby={`new-sess-${server.id}-title`} className="flex flex-col gap-2 pt-1">
              <span id={`new-sess-${server.id}-title`} className="text-sm font-medium">
                New session
              </span>
              <ActionForm action={createWahaSessionAction} submitLabel="Add session" variant="secondary">
                <input type="hidden" name="serverId" value={server.id} />
                <SessionFields prefix={`new-sess-${server.id}`} />
              </ActionForm>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            {server.used || server.sessions.some((s) => s.active) ? (
              <DeleteHint used={server.used} active={server.sessions.some((s) => s.active)} what="server" />
            ) : (
              <ActionForm
                action={deleteWahaServerAction}
                submitLabel="Delete server"
                variant="destructive"
                testId="waha-server-delete"
                confirm={{ warning: `Delete server ${server.name}? Its unused sessions and saved API key are removed. This cannot be undone.` }}
              >
                <input type="hidden" name="serverId" value={server.id} />
              </ActionForm>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}
