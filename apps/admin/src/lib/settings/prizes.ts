// Prize tiers per program (AC-A3; US-018). Owner only (prize_tier.edit, owner decision 2026-11-18),
// every change audited with before / after values (none of these fields is PII).
//   - a tier covers ranks rank_from..rank_to (1-1000); the ranges of one program never overlap;
//   - value_idr is a whole number of rupiah (0 for a non-monetary prize);
//   - once the program's results snapshot exists the tiers are final: the grace-end sweeper
//     awards winners from them.
// This module refuses first with a message for the form; the database refuses the same for every
// writer (sql/triggers.sql prize_tiers_guard: ET071 overlap, ET072 after the snapshot), under the
// program's contest lock, so two concurrent saves cannot both pass.
import type { AuditRecorder, FieldKind, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { formValue, InvalidInput, multiLine, singleLine, wholeNumber } from "./fields.ts";
import { insertImageRow, linkImage, type StoredImage } from "./image-link.ts";

export const PRIZE_FIELDS: Readonly<Record<string, FieldKind>> = {
  rank_from: "value",
  rank_to: "value",
  name: "value",
  description: "value",
  value_idr: "value",
  image_upload_id: "value",
};

export const MAX_RANK = 1000;
export const MAX_PRIZE_IDR = 1_000_000_000;
export const PRIZES_FINAL = "This program's results snapshot exists: its prize tiers are final.";
const OVERLAP = "These ranks overlap another prize tier of this program.";

const MESSAGES: Readonly<Record<string, string>> = {
  ET071: OVERLAP,
  ET072: PRIZES_FINAL,
  "55P03": "The program is busy (a re-score or a results snapshot is running). Try again in a minute.",
};
const audited = <T>(sql: Sql, mutate: (tx: Tx, audit: AuditRecorder) => Promise<T>): Promise<T> => auditedChange(sql, mutate, MESSAGES);

export interface PrizeTierInput {
  readonly rankFrom: number;
  readonly rankTo: number;
  readonly name: string;
  readonly description: string | null;
  readonly valueIdr: number;
}

export function parsePrizeTier(form: FormData): PrizeTierInput {
  const rankFrom = wholeNumber(formValue(form, "rankFrom"), `The first rank is 1 to ${String(MAX_RANK)}.`, { min: 1, max: MAX_RANK });
  const rankTo = wholeNumber(formValue(form, "rankTo"), `The last rank is from the first rank to ${String(MAX_RANK)}.`, { min: rankFrom, max: MAX_RANK });
  const description = formValue(form, "description").trim();
  return {
    rankFrom,
    rankTo,
    name: singleLine(formValue(form, "name"), "Enter the prize name (up to 120 characters).", { max: 120 }),
    description: description === "" ? null : multiLine(description, "The description is up to 500 characters.", { max: 500 }),
    valueIdr: wholeNumber(formValue(form, "valueIdr").replace(/[.\s]/g, ""), `Enter the value in whole rupiah (0 to ${MAX_PRIZE_IDR.toLocaleString("id-ID")}).`, { min: 0, max: MAX_PRIZE_IDR }),
  };
}

interface TierRow {
  readonly rank_from: number;
  readonly rank_to: number;
  readonly name: string;
  readonly description: string | null;
  readonly value_idr: number;
  readonly image_upload_id: string | null;
}

const values = (t: PrizeTierInput) => ({ rank_from: t.rankFrom, rank_to: t.rankTo, name: t.name, description: t.description, value_idr: t.valueIdr });

/** Program row lock + the friendly checks (the database re-checks under the contest lock). */
async function checkProgram(tx: Tx, programId: string): Promise<void> {
  await tx`SELECT public.lock_program_contest(${programId})`;
  const [program] = await tx<{ snapshot: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p.id) AS snapshot FROM public.programs p WHERE p.id = ${programId}`;
  if (program === undefined) throw new InvalidInput("This program no longer exists.");
  if (program.snapshot) throw new InvalidInput(PRIZES_FINAL);
}

async function checkOverlap(tx: Tx, programId: string, tier: PrizeTierInput, exceptId: string | null): Promise<void> {
  const [overlap] = await tx`
    SELECT 1 FROM public.prize_tiers
     WHERE program_id = ${programId} AND rank_from <= ${tier.rankTo} AND ${tier.rankFrom} <= rank_to
       AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)`;
  if (overlap !== undefined) throw new InvalidInput(OVERLAP);
}

async function lockTier(tx: Tx, programId: string, tierId: string): Promise<TierRow> {
  const [row] = await tx<TierRow[]>`
    SELECT rank_from, rank_to, name, description, value_idr::float8 AS value_idr, image_upload_id
      FROM public.prize_tiers WHERE id = ${tierId} AND program_id = ${programId} FOR UPDATE`;
  if (row === undefined) throw new InvalidInput("This prize tier no longer exists.");
  return row;
}

export async function createPrizeTier(sql: Sql, programId: string, tier: PrizeTierInput): Promise<string> {
  return audited(sql, async (tx, audit) => {
    await checkProgram(tx, programId);
    await checkOverlap(tx, programId, tier, null);
    const [row] = await tx<{ id: string }[]>`INSERT INTO public.prize_tiers ${tx({ program_id: programId, ...values(tier) })} RETURNING id`;
    const id = row?.id ?? "";
    audit({ action: "prize_tier.create", entityType: "prize_tier", entityId: id, fields: PRIZE_FIELDS, after: values(tier), facts: { program_id: programId } });
    return id;
  });
}

export async function updatePrizeTier(sql: Sql, programId: string, tierId: string, tier: PrizeTierInput): Promise<void> {
  await audited(sql, async (tx, audit) => {
    await checkProgram(tx, programId);
    const current = await lockTier(tx, programId, tierId);
    await checkOverlap(tx, programId, tier, tierId);
    const before = { rank_from: current.rank_from, rank_to: current.rank_to, name: current.name, description: current.description, value_idr: current.value_idr };
    if (JSON.stringify(before) === JSON.stringify(values(tier))) throw new InvalidInput("Nothing changed.");
    await tx`UPDATE public.prize_tiers SET ${tx(values(tier))}, updated_at = clock_timestamp() WHERE id = ${tierId} AND program_id = ${programId}`;
    audit({ action: "prize_tier.update", entityType: "prize_tier", entityId: tierId, fields: PRIZE_FIELDS, before, after: values(tier), facts: { program_id: programId } });
  });
}

export async function deletePrizeTier(sql: Sql, programId: string, tierId: string): Promise<void> {
  await audited(sql, async (tx, audit) => {
    await checkProgram(tx, programId);
    const current = await lockTier(tx, programId, tierId);
    await tx`DELETE FROM public.prize_tiers WHERE id = ${tierId} AND program_id = ${programId}`;
    audit({ action: "prize_tier.delete", entityType: "prize_tier", entityId: tierId, fields: PRIZE_FIELDS, before: { ...current }, facts: { program_id: programId } });
  });
}

/** Pre-check before an image is re-encoded and written (code review US-018 F8); the link checks again. */
export async function checkPrizeImageTarget(sql: Sql, programId: string, tierId: string): Promise<void> {
  const [row] = await sql<{ snapshot: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = t.program_id) AS snapshot
      FROM public.prize_tiers t WHERE t.id = ${tierId} AND t.program_id = ${programId}`;
  if (row === undefined) throw new InvalidInput("This prize tier no longer exists.");
  if (row.snapshot) throw new InvalidInput(PRIZES_FINAL);
}

/** Links a stored image (lib/settings/images.ts storeImage) as the tier's image, or clears it (null). */
export async function setPrizeImage(sql: Sql, adminUserId: string, programId: string, tierId: string, image: StoredImage | null): Promise<void> {
  const link = () =>
    audited(sql, async (tx, audit) => {
      await checkProgram(tx, programId);
      const current = await lockTier(tx, programId, tierId);
      if (image === null && current.image_upload_id === null) throw new InvalidInput("This prize tier has no image.");
      if (image !== null) await insertImageRow(tx, image, adminUserId);
      const next = image?.uploadId ?? null;
      await tx`UPDATE public.prize_tiers SET image_upload_id = ${next}, updated_at = clock_timestamp() WHERE id = ${tierId} AND program_id = ${programId}`;
      audit({
        action: "prize_tier.image",
        entityType: "prize_tier",
        entityId: tierId,
        fields: PRIZE_FIELDS,
        before: { image_upload_id: current.image_upload_id },
        after: { image_upload_id: next },
        facts: { program_id: programId, ...(image === null ? {} : { size_bytes: image.sizeBytes }) },
      });
    });
  await (image === null ? link() : linkImage(image, link));
}

/** The highest rank any prize tier of `p` (a programs row in the query) covers, 0 with none: the one definition both admin pages' leaderboard hints read. */
export const PRIZE_RANKS_SQL = (sql: Sql) => sql`(SELECT coalesce(max(pt.rank_to), 0)::int FROM public.prize_tiers pt WHERE pt.program_id = p.id)`;

/**
 * The hint for the Owner (Bahasa Indonesia; read-only, no schema): the play page's leaderboard shows the top `topN`
 * (programs.leaderboard_top_n), so when a prize tier reaches a lower rank (`prizeRanks`: the highest rank_to of the program's
 * tiers, 0 with none) some prize winners would not appear on it. null when every prize rank fits.
 */
export function leaderboardHint(topN: number, prizeRanks: number): string | null {
  return prizeRanks > topN
    ? `Papan peringkat hanya menampilkan ${String(topN)} pemain teratas, padahal hadiah mencakup peringkat 1 sampai ${String(prizeRanks)}: sebagian pemenang hadiah tidak akan tampil di papan peringkat. Naikkan "Leaderboard size" program ini (halaman Programs) menjadi minimal ${String(prizeRanks)}.`
    : null;
}

export interface PrizeTierRow {
  readonly id: string;
  readonly rankFrom: number;
  readonly rankTo: number;
  readonly name: string;
  readonly description: string | null;
  readonly valueIdr: number;
  readonly imageUploadId: string | null;
}

export interface ProgramPrizes {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly snapshot: boolean;
  /** programs.leaderboard_top_n: how many players the play page's leaderboard shows. */
  readonly leaderboardTopN: number;
  /** The highest rank any tier covers (PRIZE_RANKS_SQL). */
  readonly prizeRanks: number;
  readonly tiers: readonly PrizeTierRow[];
}

export async function listProgramPrizes(sql: Sql): Promise<ProgramPrizes[]> {
  const rows = await sql<(Omit<ProgramPrizes, "tiers"> & { tiers: PrizeTierRow[] | null })[]>`
    SELECT p.id, p.name, p.status::text AS status, p.leaderboard_top_n AS "leaderboardTopN", ${PRIZE_RANKS_SQL(sql)} AS "prizeRanks",
           EXISTS (SELECT 1 FROM public.leaderboard_snapshots l WHERE l.program_id = p.id) AS snapshot,
           (SELECT json_agg(json_build_object('id', t.id, 'rankFrom', t.rank_from, 'rankTo', t.rank_to, 'name', t.name, 'description', t.description,
                                              'valueIdr', t.value_idr, 'imageUploadId', t.image_upload_id) ORDER BY t.rank_from)
              FROM public.prize_tiers t WHERE t.program_id = p.id) AS tiers
      FROM public.programs p ORDER BY p.created_at DESC`;
  return rows.map((r) => ({ ...r, tiers: r.tiers ?? [] }));
}
