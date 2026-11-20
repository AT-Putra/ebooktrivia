import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../../components/settings/action-form.tsx";
import { PageHeading, TextArea, TextField } from "../../../../../components/settings/fields.tsx";
import { LegalPreview } from "../../../../../components/settings/legal-preview.tsx";
import { requireAdmin } from "../../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../../lib/next/runtime.ts";
import { getLegalProgram, LEGAL_BODY_MAX, LEGAL_KINDS, LEGAL_LABEL, listLegalVersions } from "../../../../../lib/settings/legal.ts";
import { publishLegalPageAction, saveLegalDraftAction } from "../actions.ts";

export const metadata: Metadata = { title: "Legal pages | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });

/** Owner only: write a new version, preview it as buyers will see it, publish it. */
export default async function LegalProgramPage({ params }: { params: Promise<{ programId: string }> }) {
  await requireAdmin({ permission: "legal_page.edit" });
  const { programId } = await params;
  if (!isUuid(programId)) notFound();
  const { sql } = await getRuntime();
  const program = await getLegalProgram(sql, programId);
  if (program === null) notFound();
  const versions = await listLegalVersions(sql, programId);
  return (
    <>
      <p className="text-sm">
        <Link href="/settings/legal" className="underline underline-offset-4">
          Legal pages
        </Link>
      </p>
      <PageHeading
        title={`${program.name}: legal pages`}
        description="Plain text: a blank line starts a new paragraph, a line starting with '# ' is a heading. Saving creates a new draft version; publish the latest version to make it the one buyers see and consent to."
      />
      {LEGAL_KINDS.map((kind) => {
        const history = versions.filter((v) => v.kind === kind);
        const latest = history[0];
        return (
          <Card key={kind} data-testid={`legal-${kind}`}>
            <CardTitle className="text-base">{LEGAL_LABEL[kind]}</CardTitle>
            <ActionForm action={saveLegalDraftAction} submitLabel="Save as new version" testId="legal-save">
              <input type="hidden" name="programId" value={programId} />
              <input type="hidden" name="kind" value={kind} />
              <TextField id={`${kind}-title`} name="title" label="Title" defaultValue={latest?.title} maxLength={120} />
              <TextArea id={`${kind}-body`} name="body" label="Text" rows={12} defaultValue={latest?.body} maxLength={LEGAL_BODY_MAX} />
            </ActionForm>
            {latest !== undefined && latest.publishedAt === null ? (
              <div className="flex flex-col gap-2 border-t pt-3">
                <p className="text-sm font-medium">Preview of draft version {latest.version}</p>
                <LegalPreview title={latest.title} body={latest.body} />
                <ActionForm action={publishLegalPageAction} submitLabel={`Publish version ${String(latest.version)}`} variant="secondary" testId="legal-publish">
                  <input type="hidden" name="programId" value={programId} />
                  <input type="hidden" name="kind" value={kind} />
                  <input type="hidden" name="pageId" value={latest.id} />
                </ActionForm>
              </div>
            ) : null}
            {history.length === 0 ? <CardDescription>No version yet.</CardDescription> : null}
            <ul className="flex flex-col gap-2 border-t pt-3" data-testid={`legal-${kind}-versions`}>
              {history.map((v) => (
                <li key={v.id}>
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                      Version {v.version} · saved {WIB.format(v.createdAt)}
                      {v.publishedAt === null ? <Badge variant="outline">Draft</Badge> : <Badge variant="success">Published {WIB.format(v.publishedAt)}</Badge>}
                    </summary>
                    <div className="mt-2">
                      <LegalPreview title={v.title} body={v.body} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </>
  );
}
