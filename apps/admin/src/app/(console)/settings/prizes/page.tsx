import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { Notice, PageHeading, TextArea, TextField } from "../../../../components/settings/fields.tsx";
import { UploadFile } from "../../../../components/settings/upload-file.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { listProgramPrizes, MAX_RANK, PRIZES_FINAL, type PrizeTierRow } from "../../../../lib/settings/prizes.ts";
import { createPrizeTierAction, deletePrizeTierAction, removePrizeImageAction, updatePrizeTierAction } from "./actions.ts";

export const metadata: Metadata = { title: "Prize tiers | Admin Console" };

const rupiah = (n: number): string => `Rp ${n.toLocaleString("id-ID")}`;
const ranks = (t: { rankFrom: number; rankTo: number }): string => (t.rankFrom === t.rankTo ? `Rank ${String(t.rankFrom)}` : `Ranks ${String(t.rankFrom)} to ${String(t.rankTo)}`);

function TierFields({ prefix, tier }: { prefix: string; tier?: PrizeTierRow }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <TextField id={`${prefix}-from`} name="rankFrom" label="First rank" type="number" inputMode="numeric" defaultValue={tier?.rankFrom} />
      <TextField id={`${prefix}-to`} name="rankTo" label="Last rank" type="number" inputMode="numeric" defaultValue={tier?.rankTo} />
      <TextField id={`${prefix}-name`} name="name" label="Prize" defaultValue={tier?.name} maxLength={120} />
      <TextField id={`${prefix}-value`} name="valueIdr" label="Value (IDR)" inputMode="numeric" defaultValue={tier?.valueIdr} hint="Whole rupiah; 0 for a non-cash prize." />
      <div className="sm:col-span-2 lg:col-span-4">
        <TextArea id={`${prefix}-description`} name="description" label="Description (optional)" rows={2} defaultValue={tier?.description} maxLength={500} />
      </div>
    </div>
  );
}

/** Owner only: prize tiers per program (rank ranges never overlap; final after the results snapshot). */
export default async function PrizesPage() {
  await requireAdmin({ permission: "prize_tier.edit" });
  const { sql } = await getRuntime();
  const programs = await listProgramPrizes(sql);
  return (
    <>
      <PageHeading title="Prize tiers" description={`Prizes by final rank (1 to ${String(MAX_RANK)}) per program. Ranges cannot overlap. Every change is audited.`} />
      {programs.length === 0 ? (
        <Card>
          <CardDescription>No program yet (Settings, Programs).</CardDescription>
        </Card>
      ) : null}
      {programs.map((program) => (
        <Card key={program.id} data-testid={`prizes-${program.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{program.name}</CardTitle>
            {program.snapshot ? <Badge variant="info">Results final</Badge> : null}
          </div>
          {program.snapshot ? <Notice tone="info">{PRIZES_FINAL}</Notice> : null}
          {program.tiers.length === 0 ? <CardDescription>No prize tier yet.</CardDescription> : null}
          {program.tiers.map((tier) => (
            <section key={tier.id} className="flex flex-col gap-3 border-t pt-3" data-testid={`tier-${String(tier.rankFrom)}`}>
              <p className="text-sm font-medium">
                {ranks(tier)}: {tier.name} ({rupiah(tier.valueIdr)}){tier.imageUploadId === null ? "" : " · image set"}
              </p>
              {program.snapshot ? null : (
                <>
                  <ActionForm action={updatePrizeTierAction} submitLabel="Save tier" variant="secondary" testId="tier-edit">
                    <input type="hidden" name="programId" value={program.id} />
                    <input type="hidden" name="tierId" value={tier.id} />
                    <TierFields prefix={`tier-${tier.id}`} tier={tier} />
                  </ActionForm>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <UploadFile id={`tier-image-${tier.id}`} url={`/uploads/image/prize?program=${program.id}&tier=${tier.id}`} label="Prize image (JPEG, PNG or WebP, up to 2 MB)" accept="image/jpeg,image/png,image/webp" mode="image" />
                      {tier.imageUploadId === null ? null : (
                        <ActionForm action={removePrizeImageAction} submitLabel="Remove image" variant="ghost">
                          <input type="hidden" name="programId" value={program.id} />
                          <input type="hidden" name="tierId" value={tier.id} />
                        </ActionForm>
                      )}
                    </div>
                    <ActionForm action={deletePrizeTierAction} submitLabel="Delete tier" variant="destructive">
                      <input type="hidden" name="programId" value={program.id} />
                      <input type="hidden" name="tierId" value={tier.id} />
                    </ActionForm>
                  </div>
                </>
              )}
            </section>
          ))}
          {program.snapshot ? null : (
            <ActionForm action={createPrizeTierAction} submitLabel="Add prize tier" testId="tier-create" className="flex flex-col gap-3 border-t pt-3">
              <p className="text-sm font-medium">New prize tier</p>
              <input type="hidden" name="programId" value={program.id} />
              <TierFields prefix={`new-${program.id}`} />
            </ActionForm>
          )}
        </Card>
      ))}
    </>
  );
}
