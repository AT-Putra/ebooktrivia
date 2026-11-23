import type { Metadata } from "next";
import { LockIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { Notice, PageHeading, SelectField, TextField } from "../../../../components/settings/fields.tsx";
import { UploadFile } from "../../../../components/settings/upload-file.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { bannerPreviewSrc } from "../../../../lib/settings/image-preview.ts";
import { leaderboardHint } from "../../../../lib/settings/prizes.ts";
import { listProducts } from "../../../../lib/settings/products.ts";
import { graceEndDay, lastSalesDay, listPrograms, type ProgramListRow, wibDay } from "../../../../lib/settings/programs.ts";
import { cloneProgramAction, createProgramAction, removeProgramBannerAction, rescheduleProgramAction, setProgramStatusAction, updateProgramAction } from "./actions.ts";

export const metadata: Metadata = { title: "Programs | Admin Console" };

const STATUS_LABEL: Readonly<Record<string, string>> = { draft: "Draft", published: "Published", awaiting_confirmation: "Awaiting winners", finalized: "Finalized" };

function ProgramFields({ prefix, program, products }: { prefix: string; program?: ProgramListRow; products: readonly { value: string; label: string }[] }) {
  const locked = program !== undefined && (program.lockedAt !== null || program.paidOrders > 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {locked ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Ebook (product)</span>
          <span className="min-h-11 py-2 text-sm">{program.productTitle}</span>
          <input type="hidden" name="productId" value={program.productId} />
        </div>
      ) : (
        <SelectField id={`${prefix}-product`} name="productId" label="Ebook (product)" options={products} defaultValue={program?.productId} />
      )}
      <TextField id={`${prefix}-name`} name="name" label="Name" defaultValue={program?.name} maxLength={120} />
      <TextField id={`${prefix}-slug`} name="slug" label="Slug" defaultValue={program?.slug} maxLength={64} readOnly={locked} hint={locked ? "Locked after the first paid order." : "play.<domain>/<slug>; lowercase, digits, hyphens."} />
      <TextField id={`${prefix}-first`} name="firstDay" label="First sales day (WIB)" type="date" defaultValue={program === undefined ? undefined : wibDay(program.salesStartAt)} readOnly={locked} />
      <TextField id={`${prefix}-last`} name="lastDay" label="Last sales day (WIB)" type="date" defaultValue={program === undefined ? undefined : lastSalesDay(program.salesEndAt)} readOnly={locked} />
      <TextField id={`${prefix}-grace`} name="graceDays" label="Grace days" type="number" inputMode="numeric" defaultValue={program?.graceDays ?? 30} readOnly={locked} />
      <TextField id={`${prefix}-points`} name="defaultPoints" label="Default points" type="number" inputMode="numeric" defaultValue={program?.defaultPoints ?? 10} />
      <TextField id={`${prefix}-timer`} name="defaultTimerSeconds" label="Default timer (seconds)" type="number" inputMode="numeric" defaultValue={program?.defaultTimerSeconds ?? 20} />
      <TextField id={`${prefix}-top`} name="leaderboardTopN" label="Leaderboard size" type="number" inputMode="numeric" defaultValue={program?.leaderboardTopN ?? 10} />
    </div>
  );
}

/** Owner only: programs (dates, grace, clone), the field lock and the extend-only reschedule. */
export default async function ProgramsPage() {
  await requireAdmin({ permission: "program.edit" });
  const { sql, settings } = await getRuntime();
  const [programs, products] = await Promise.all([listPrograms(sql), listProducts(sql)]);
  // The picture is embedded in the page, so only programs still in play get one (a finalized program shows "uploaded", without the image).
  const previews = new Map(await Promise.all(programs.flatMap((p) => (p.bannerUploadId === null || p.status === "finalized" ? [] : [bannerPreviewSrc(settings.dataDir, p.bannerUploadId).then((src) => [p.id, src] as const)]))));
  const productOptions = products.map((p) => ({ value: p.id, label: p.title }));
  return (
    <>
      <PageHeading title="Programs" description="One program per ebook season: sales window and grace in WIB, trivia defaults. Every change is audited." />
      <Card>
        <CardTitle className="text-base">New program</CardTitle>
        {productOptions.length === 0 ? (
          <CardDescription>Create a product first (Settings, Products).</CardDescription>
        ) : (
          <ActionForm action={createProgramAction} submitLabel="Create program" testId="program-create">
            <ProgramFields prefix="new" products={productOptions} />
          </ActionForm>
        )}
      </Card>
      {programs.map((program) => {
        const locked = program.lockedAt !== null || program.paidOrders > 0;
        const preview = previews.get(program.id) ?? null;
        const hint = leaderboardHint(program.leaderboardTopN, program.prizeRanks);
        return (
          <Card key={program.id} data-testid={`program-${program.slug}`}>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">{program.name}</CardTitle>
              <Badge variant="secondary">{STATUS_LABEL[program.status] ?? program.status}</Badge>
              {locked ? (
                <Badge variant="warning" data-testid="program-locked">
                  <LockIcon aria-hidden="true" />
                  Locked: {program.paidOrders} paid order{program.paidOrders === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            <CardDescription>
              {program.productTitle} · sales {wibDay(program.salesStartAt)} to {lastSalesDay(program.salesEndAt)} · grace ends {graceEndDay(program.salesEndAt, program.graceDays)} · {program.sets} trivia set
              {program.sets === 1 ? "" : "s"}
            </CardDescription>
            <ActionForm action={updateProgramAction} submitLabel="Save program" variant="secondary" testId="program-edit">
              <input type="hidden" name="programId" value={program.id} />
              <ProgramFields prefix={`edit-${program.id}`} program={program} products={productOptions} />
            </ActionForm>
            {hint === null ? null : (
              <Notice tone="warning" testId="program-leaderboard-hint">
                {hint}
              </Notice>
            )}
            <div className="grid gap-4 border-t pt-4 lg:grid-cols-2" data-testid="program-banner">
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Banner program (ditampilkan ke pemain)</p>
                <p className="text-xs text-muted-foreground">
                  Gambar lebar dengan rasio 3:1, misalnya 1500 x 500 piksel. Jika bentuknya lain, bagian tengah yang dipakai dan tepinya terpotong. Tanpa gambar, pemain melihat gambar bawaan.
                </p>
                {program.bannerUploadId === null ? (
                  <p className="text-xs text-muted-foreground">Belum ada gambar banner: pemain melihat gambar bawaan.</p>
                ) : preview === null ? (
                  <p className="text-xs text-muted-foreground" data-testid="program-banner-set">Gambar banner sudah diunggah (pratinjau tidak tersedia).</p>
                ) : (
                  // The same 3:1 box and centred crop as the play page.
                  <img src={preview} alt="Pratinjau banner program" width={600} height={200} className="aspect-[3/1] w-full max-w-xl rounded-lg border object-cover" data-testid="program-banner-preview" />
                )}
              </div>
              <div className="flex flex-col gap-2">
                <UploadFile
                  id={`banner-${program.id}`}
                  url={`/uploads/image/banner?program=${program.id}`}
                  label={program.bannerUploadId === null ? "Unggah gambar banner (JPEG, PNG, atau WebP, maks. 2 MB)" : "Ganti gambar banner (JPEG, PNG, atau WebP, maks. 2 MB)"}
                  accept="image/jpeg,image/png,image/webp"
                  mode="image"
                />
                {program.bannerUploadId === null ? null : (
                  <ActionForm action={removeProgramBannerAction} submitLabel="Hapus gambar banner" variant="ghost" testId="program-banner-remove">
                    <input type="hidden" name="programId" value={program.id} />
                  </ActionForm>
                )}
              </div>
            </div>
            <div className="grid gap-4 border-t pt-4 lg:grid-cols-3">
              <ActionForm action={rescheduleProgramAction} submitLabel="Reschedule" variant="outline" testId="program-reschedule">
                <p className="text-sm font-medium">Reschedule (extend only)</p>
                <input type="hidden" name="programId" value={program.id} />
                <TextField id={`resched-last-${program.id}`} name="lastDay" label="New last sales day (WIB)" type="date" defaultValue={lastSalesDay(program.salesEndAt)} />
                <TextField id={`resched-grace-${program.id}`} name="graceDays" label="New grace days" type="number" inputMode="numeric" defaultValue={program.graceDays} />
              </ActionForm>
              <ActionForm action={setProgramStatusAction} submitLabel={program.status === "published" ? "Move back to draft" : "Publish"} variant="outline" testId="program-status">
                <p className="text-sm font-medium">Status</p>
                <p className="text-xs text-muted-foreground">Published programs are on sale in their window. A program with paid orders stays published.</p>
                <input type="hidden" name="programId" value={program.id} />
                <input type="hidden" name="status" value={program.status === "published" ? "draft" : "published"} />
              </ActionForm>
              <ActionForm action={cloneProgramAction} submitLabel="Clone" variant="outline" testId="program-clone">
                <p className="text-sm font-medium">Clone (settings, trivia sets, questions, prize tiers)</p>
                <input type="hidden" name="programId" value={program.id} />
                <TextField id={`clone-slug-${program.id}`} name="slug" label="New slug" maxLength={64} />
                <TextField id={`clone-name-${program.id}`} name="name" label="New name" maxLength={120} />
              </ActionForm>
            </div>
          </Card>
        );
      })}
    </>
  );
}
