import type { Metadata } from "next";
import Link from "next/link";
import { LockIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { listTriviaPrograms } from "../../../../lib/settings/trivia.ts";

export const metadata: Metadata = { title: "Trivia | Admin Console" };

const STATUS_LABEL: Readonly<Record<string, string>> = { draft: "Draft", published: "Published", awaiting_confirmation: "Awaiting winners", finalized: "Finalized" };

/** Manage trivia (Staff and Owner): pick a program, then its sets and questions. */
export default async function TriviaPage() {
  await requireAdmin({ permission: "trivia_set.edit" });
  const { sql } = await getRuntime();
  const programs = await listTriviaPrograms(sql);
  return (
    <>
      <PageHeading
        title="Trivia"
        description="Sets and questions per program. A set with attempts is locked: Staff cannot change it, the Owner can fix text or override scoring (re-scored at once). Every change is audited."
      />
      {programs.length === 0 ? (
        <Card>
          <CardDescription>No program yet (Settings, Programs).</CardDescription>
        </Card>
      ) : null}
      {programs.map((p) => (
        <Card key={p.id} data-testid={`trivia-program-${p.slug}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">
              <Link href={`/settings/trivia/${p.id}`} className="underline underline-offset-4">
                {p.name}
              </Link>
            </CardTitle>
            <Badge variant="secondary">{STATUS_LABEL[p.status] ?? p.status}</Badge>
            {p.paid ? (
              <Badge variant="warning">
                <LockIcon aria-hidden="true" />
                Set order locked
              </Badge>
            ) : null}
            {p.snapshot ? <Badge variant="info">Results final</Badge> : null}
          </div>
          <CardDescription>
            {p.slug} · {p.sets} set{p.sets === 1 ? "" : "s"} · defaults {p.defaultPoints} points, {p.defaultTimerSeconds} s
          </CardDescription>
        </Card>
      ))}
    </>
  );
}
