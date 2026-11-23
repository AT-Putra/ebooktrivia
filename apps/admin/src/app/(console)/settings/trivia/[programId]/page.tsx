import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LockIcon } from "@phosphor-icons/react/ssr";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../../components/settings/action-form.tsx";
import { Notice, PageHeading, TextField } from "../../../../../components/settings/fields.tsx";
import { UploadFile } from "../../../../../components/settings/upload-file.tsx";
import { requireAdmin } from "../../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../../lib/next/runtime.ts";
import { can } from "../../../../../lib/policy.ts";
import { getTriviaProgram, listSets, PROGRAM_PAID, TRIVIA_LIMITS } from "../../../../../lib/settings/trivia.ts";
import { createSetAction, deleteSetAction, moveSetAction, removeSetThumbnailAction, renameSetAction } from "../actions.ts";

export const metadata: Metadata = { title: "Trivia sets | Admin Console" };

/** A program's trivia sets: title, position (unlock order), thumbnail. */
export default async function TriviaSetsPage({ params }: { params: Promise<{ programId: string }> }) {
  const admin = await requireAdmin({ permission: "trivia_set.edit" });
  const { programId } = await params;
  if (!isUuid(programId)) notFound();
  const { sql } = await getRuntime();
  const program = await getTriviaProgram(sql, programId);
  if (program === null) notFound();
  const sets = await listSets(sql, programId);
  return (
    <>
      <p className="text-sm">
        <Link href="/settings/trivia" className="underline underline-offset-4">
          Trivia
        </Link>
      </p>
      <PageHeading
        title={`${program.name}: trivia sets`}
        description={`Sets unlock in this order. New questions default to ${String(program.defaultPoints)} points and ${String(program.defaultTimerSeconds)} seconds (the program's defaults).`}
      />
      <p className="text-sm">
        <Link href={`/settings/trivia/${program.id}/results`} className="underline underline-offset-4" data-testid="contest-results-link">
          Contest results: winners, anti-cheat flags, deadline extension
        </Link>
      </p>
      {program.paid ? (
        <Notice tone="warning" testId="program-paid">
          <LockIcon aria-hidden="true" className="mt-0.5 shrink-0" />
          {PROGRAM_PAID}
        </Notice>
      ) : null}
      {program.paid ? null : (
        <Card>
          <CardTitle className="text-base">New set</CardTitle>
          <ActionForm action={createSetAction} submitLabel="Add set" testId="set-create" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <input type="hidden" name="programId" value={program.id} />
            <TextField id="new-set-title" name="title" label="Title" maxLength={TRIVIA_LIMITS.title} />
          </ActionForm>
        </Card>
      )}
      {sets.length === 0 ? (
        <Card>
          <CardDescription>No set yet.</CardDescription>
        </Card>
      ) : null}
      {sets.map((set, index) => {
        const locked = set.attempts > 0;
        const editable = can(admin.role, "question.content.edit", { setLocked: locked });
        return (
          <Card key={set.id} data-testid={`set-${String(set.position)}`}>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">
                {index + 1}.{" "}
                <Link href={`/settings/trivia/${program.id}/${set.id}`} className="underline underline-offset-4">
                  {set.title}
                </Link>
              </CardTitle>
              {locked ? (
                <Badge variant="warning" data-testid="set-locked">
                  <LockIcon aria-hidden="true" />
                  Locked: {set.attempts} attempt{set.attempts === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            <CardDescription>
              {set.questionCount} question{set.questionCount === 1 ? "" : "s"} · {set.thumbnailUploadId === null ? "no thumbnail" : "thumbnail set (shown to players)"}
            </CardDescription>
            {editable ? (
              <div className="grid gap-4 border-t pt-4 lg:grid-cols-2">
                <ActionForm action={renameSetAction} submitLabel="Save title" variant="secondary" testId="set-rename">
                  <input type="hidden" name="programId" value={program.id} />
                  <input type="hidden" name="setId" value={set.id} />
                  <TextField id={`set-title-${set.id}`} name="title" label="Title" defaultValue={set.title} maxLength={TRIVIA_LIMITS.title} />
                </ActionForm>
                <div className="flex flex-col gap-2">
                  <UploadFile id={`set-thumb-${set.id}`} url={`/uploads/image/trivia?program=${program.id}&set=${set.id}`} label="Thumbnail (JPEG, PNG or WebP, up to 2 MB)" accept="image/jpeg,image/png,image/webp" mode="image" />
                  {set.thumbnailUploadId === null ? null : (
                    <ActionForm action={removeSetThumbnailAction} submitLabel="Remove thumbnail" variant="ghost">
                      <input type="hidden" name="programId" value={program.id} />
                      <input type="hidden" name="setId" value={set.id} />
                    </ActionForm>
                  )}
                </div>
                {program.paid ? null : (
                  <div className="flex flex-wrap items-start gap-2 lg:col-span-2">
                    {(["up", "down"] as const).map((direction) => (
                      <ActionForm key={direction} action={moveSetAction} submitLabel={direction === "up" ? "Move up" : "Move down"} variant="outline">
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="setId" value={set.id} />
                        <input type="hidden" name="direction" value={direction} />
                      </ActionForm>
                    ))}
                    {locked ? null : (
                      <ActionForm action={deleteSetAction} submitLabel="Delete set" variant="destructive">
                        <input type="hidden" name="programId" value={program.id} />
                        <input type="hidden" name="setId" value={set.id} />
                      </ActionForm>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="set-readonly">
                This set has attempts: only the Owner can change it.
              </p>
            )}
          </Card>
        );
      })}
    </>
  );
}
