import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { LEGAL_KINDS, LEGAL_LABEL, listLegalPrograms } from "../../../../lib/settings/legal.ts";

export const metadata: Metadata = { title: "Legal pages | Admin Console" };

/** Owner only: each program's S&K and privacy policy, versioned. */
export default async function LegalPagesPage() {
  await requireAdmin({ permission: "legal_page.edit" });
  const { sql } = await getRuntime();
  const programs = await listLegalPrograms(sql);
  return (
    <>
      <PageHeading title="Legal pages" description="Per program: the Terms & Prize Rules (S&K) and the Privacy Policy that checkout links to and buyers consent to. Every save is a new version; published versions never change." />
      {programs.length === 0 ? (
        <Card>
          <CardDescription>No program yet (Settings, Programs).</CardDescription>
        </Card>
      ) : null}
      {programs.map((p) => (
        <Card key={p.id} data-testid={`legal-program-${p.slug}`}>
          <CardTitle className="text-base">
            <Link href={`/settings/legal/${p.id}`} className="underline underline-offset-4">
              {p.name}
            </Link>
          </CardTitle>
          <CardDescription>
            {LEGAL_KINDS.map((kind) => `${LEGAL_LABEL[kind]}: ${p.published[kind] === undefined ? "not published" : `version ${String(p.published[kind])} published`}`).join(" · ")}
          </CardDescription>
        </Card>
      ))}
    </>
  );
}
