import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { LpZipUpload } from "../../../../components/settings/lp-zip-upload.tsx";
import { CheckboxField, PageHeading, SecretBadge, SelectField, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { CAPI_LABELS, CAPI_PLATFORMS, capiTokenStatuses } from "../../../../lib/settings/conversions.ts";
import { listLandingPages, snippet } from "../../../../lib/settings/landing-pages.ts";
import { LP_VERSION_RETENTION, listLpVersions, type LpVersionRow } from "../../../../lib/settings/lp-hosting.ts";
import {
  activateLpVersionAction,
  clearCapiTokenAction,
  createLandingPageAction,
  registerDomainAction,
  removeDomainAction,
  renameLandingPageAction,
  setCapiTokenAction,
  stopLpHostingAction,
  updateLandingPageSettingsAction,
  updatePixelsAction,
} from "./actions.ts";

export const metadata: Metadata = { title: "Landing pages | Admin Console" };

/**
 * Landing pages: everyone with content rights sees the pages and their snippets and may rename
 * them; program / adnets / pixels / domains are Owner-only and their controls are not rendered for
 * Staff (the actions refuse them too).
 */
export default async function LandingPagesPage() {
  const admin = await requireAdmin({ permission: "landing_page.content.edit" });
  const rt = await getRuntime();
  const [pages, programs, adnets] = await Promise.all([
    listLandingPages(rt.sql),
    rt.sql<{ id: string; name: string }[]>`SELECT id, name FROM public.programs ORDER BY created_at DESC`,
    rt.sql<{ id: string; name: string }[]>`SELECT id, name FROM public.adnets ORDER BY name`,
  ]);
  const settings = can(admin.role, "landing_page.settings.edit");
  const pixels = can(admin.role, "pixel.edit");
  const domains = can(admin.role, "lp_domain.register");
  const programOptions = programs.map((p) => ({ value: p.id, label: p.name }));
  const domain = rt.settings.domain;
  const hosting = can(admin.role, "lp_zip.publish");
  const versions: Map<string, LpVersionRow[]> = hosting ? await listLpVersions(rt.sql) : new Map<string, LpVersionRow[]>();
  const hostingReady = rt.settings.lpDir !== null && rt.settings.dataDir !== null && domain !== null;
  // Write-only CAPI access tokens: only whether each is set (and its last 4), never a sealed column (Owner only).
  const tokens: Awaited<ReturnType<typeof capiTokenStatuses>> = pixels ? await capiTokenStatuses(rt.sql, pages) : new Map();
  const sealing = rt.settings.sealer?.scopes.includes("conversions") === true;
  return (
    <>
      <PageHeading title="Landing pages" description="External landing pages load the SDK snippet; their domains get TLS only once registered here (Owner)." />
      {settings ? (
        <Card>
          <CardTitle className="text-base">New landing page</CardTitle>
          {programOptions.length === 0 ? (
            <CardDescription>Create a program first.</CardDescription>
          ) : (
            <ActionForm action={createLandingPageAction} submitLabel="Create landing page" className="grid gap-3 sm:grid-cols-2" testId="lp-create">
              <TextField id="new-lp-name" name="name" label="Name" maxLength={120} />
              <SelectField id="new-lp-program" name="programId" label="Program" options={programOptions} />
            </ActionForm>
          )}
        </Card>
      ) : null}
      {pages.map((page) => (
        <Card key={page.id} data-testid={`lp-${page.lpKey}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{page.name}</CardTitle>
            <Badge variant="secondary">{page.programName}</Badge>
            {page.active ? <Badge variant="success">Active</Badge> : <Badge variant="warning">Inactive</Badge>}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Snippet</span>
            {domain === null ? (
              <CardDescription>The snippet needs DOMAIN, which is not configured on the server.</CardDescription>
            ) : (
              <code data-testid="lp-snippet" className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
                {snippet(domain, page.lpKey)}
              </code>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ActionForm action={renameLandingPageAction} submitLabel="Save name" variant="secondary">
              <input type="hidden" name="landingPageId" value={page.id} />
              <TextField id={`lp-name-${page.id}`} name="name" label="Name" defaultValue={page.name} maxLength={120} />
            </ActionForm>
            {settings ? (
              <ActionForm action={updateLandingPageSettingsAction} submitLabel="Save settings" variant="secondary">
                <input type="hidden" name="landingPageId" value={page.id} />
                <SelectField id={`lp-program-${page.id}`} name="programId" label="Program" options={programOptions} defaultValue={page.programId} />
                <CheckboxField id={`lp-active-${page.id}`} name="active" label="Active (checkout open)" defaultChecked={page.active} />
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm font-medium">Allowed adnets</legend>
                  {adnets.length === 0 ? <span className="text-xs text-muted-foreground">No adnets yet.</span> : null}
                  {adnets.map((a) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="adnetId" value={a.id} defaultChecked={page.adnetIds.includes(a.id)} className="size-4 accent-primary" />
                      {a.name}
                    </label>
                  ))}
                </fieldset>
              </ActionForm>
            ) : null}
          </div>
          {pixels ? (
            <ActionForm action={updatePixelsAction} submitLabel="Save pixel ids" variant="secondary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="landingPageId" value={page.id} />
              <TextField id={`px-meta-${page.id}`} name="meta" label="Meta pixel id" defaultValue={page.pixels.meta} required={false} inputMode="numeric" maxLength={20} />
              <TextField id={`px-tiktok-${page.id}`} name="tiktok" label="TikTok pixel code" defaultValue={page.pixels.tiktok} required={false} maxLength={32} />
              <TextField id={`px-gtag-${page.id}`} name="gtag" label="Google Ads id (AW-...)" defaultValue={page.pixels.gtag} required={false} maxLength={18} />
              <TextField id={`px-label-${page.id}`} name="gtag_label" label="Google Ads conversion label" defaultValue={page.pixels.gtag_label} required={false} maxLength={64} />
            </ActionForm>
          ) : null}
          {pixels ? (
            <div className="flex flex-col gap-3 border-t pt-4" data-testid="lp-capi">
              <span className="text-sm font-medium">Server-side conversions (access tokens, write-only)</span>
              {CAPI_PLATFORMS.every((platform) => page.pixels[platform] === null) ? <CardDescription>Set a Meta pixel id or a TikTok pixel code above first: an access token belongs to its pixel.</CardDescription> : null}
              {CAPI_PLATFORMS.filter((platform) => page.pixels[platform] !== null).map((platform) => {
                const status = tokens.get(page.id)?.[platform] ?? { set: false, last4: "", updatedAt: null };
                return (
                  <div key={platform} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-sm">{CAPI_LABELS[platform]}</span>
                      <SecretBadge status={status} testId={`capi-${platform}-${page.lpKey}`} />
                      {status.set ? (
                        <ActionForm action={clearCapiTokenAction} submitLabel="Remove" variant="ghost" className="flex items-center gap-2">
                          <input type="hidden" name="landingPageId" value={page.id} />
                          <input type="hidden" name="platform" value={platform} />
                        </ActionForm>
                      ) : null}
                    </div>
                    {sealing ? (
                      <ActionForm action={setCapiTokenAction} submitLabel="Save access token" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                        <input type="hidden" name="landingPageId" value={page.id} />
                        <input type="hidden" name="platform" value={platform} />
                        <TextField id={`capi-${platform}-${page.id}`} name="value" label="Access token (write-only)" type="password" autoComplete="new-password" maxLength={4096} />
                      </ActionForm>
                    ) : (
                      <CardDescription>Tokens cannot be saved: the conversions sealing key is not configured on the server.</CardDescription>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 border-t pt-4" data-testid="lp-domains">
            <span className="text-sm font-medium">Domains</span>
            {page.domains.length === 0 ? <span className="text-xs text-muted-foreground">No domain registered.</span> : null}
            <ul className="flex flex-col gap-2">
              {page.domains.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm">{d.host}</span>
                  {domains ? (
                    <ActionForm action={removeDomainAction} submitLabel="Remove" variant="ghost" className="flex items-center gap-2">
                      <input type="hidden" name="landingPageId" value={page.id} />
                      <input type="hidden" name="domainId" value={d.id} />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
            {domains ? (
              <ActionForm action={registerDomainAction} submitLabel="Register domain" variant="secondary" testId="lp-domain-register" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <input type="hidden" name="landingPageId" value={page.id} />
                <TextField id={`lp-host-${page.id}`} name="host" label="Domain" placeholder="shop.example.id" maxLength={253} hint="Not the app's own domain; IDN in xn-- form." />
              </ActionForm>
            ) : null}
          </div>
          {hosting ? (
            <div className="flex flex-col gap-3 border-t pt-4" data-testid="lp-hosting">
              <span className="text-sm font-medium">Hosted ZIP</span>
              <CardDescription>
                A static site served on this page&apos;s domains: index.html at the top; HTML, CSS, JS, JSON, text, images, SVG, fonts and video only. Every HTML page gets the SDK tag before its
                &lt;/head&gt;. The last {LP_VERSION_RETENTION} versions are kept for rollback.
              </CardDescription>
              {hostingReady ? <LpZipUpload id={`lp-zip-${page.id}`} landingPageId={page.id} /> : <CardDescription>Uploads need ADMIN_LP_DIR, ADMIN_DATA_DIR and DOMAIN on the server.</CardDescription>}
              {(versions.get(page.id) ?? []).length === 0 ? <span className="text-xs text-muted-foreground">No version uploaded.</span> : null}
              <ul className="flex flex-col gap-2" data-testid="lp-versions">
                {(versions.get(page.id) ?? []).map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-medium">Version {v.version}</span>
                    <span className="text-muted-foreground">
                      {v.fileCount} files, {(v.uncompressedBytes / 1024 / 1024).toFixed(1)} MB, {v.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                    {v.live ? (
                      <Badge variant="success">Live</Badge>
                    ) : (
                      <ActionForm action={activateLpVersionAction} submitLabel="Make live" variant="ghost" className="flex items-center gap-2">
                        <input type="hidden" name="landingPageId" value={page.id} />
                        <input type="hidden" name="versionId" value={v.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
              {page.active ? null : <CardDescription>The page is inactive: its domains serve nothing until it is active again.</CardDescription>}
              {page.hosting === "zip" ? (
                <ActionForm action={stopLpHostingAction} submitLabel="Stop hosting (back to external)" variant="ghost" className="flex items-center gap-2">
                  <input type="hidden" name="landingPageId" value={page.id} />
                </ActionForm>
              ) : null}
            </div>
          ) : null}
        </Card>
      ))}
    </>
  );
}
