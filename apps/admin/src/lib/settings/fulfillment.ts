// Prize fulfilment (US-030; plan M10 item 2; the Owner decision under M5a: prize fulfilment is Owner-only) and the Owner's
// revoke and re-award / reinstatement of a winner (plan M2: a chargeback after the confirmation flags the winner and halts
// fulfilment; the Owner re-awards to the next rank, §10 item 17).
//
// The writes are the database's: packages/db sql/fulfillment.sql (fulfillment_step, fulfillment_set_notes,
// fulfillment_set_proof, owned by prize_fulfillment) and sql/contest.sql (revoke_winner, reinstate_winner, owned by
// contest_results). Each checks the actor is an active Owner, enforces the machine (one step at a time, a reasoned correction
// one step back, done final, ET082 while the winner is flagged or revoked) and writes its own audit row (ids and references,
// never a name, phone or e-mail) in the same transaction. This module bounds the transaction (contest.ts bounded), passes the
// mutation scope's actor, request id and IP, and turns the refusals into form messages.
//
// The page lists the winners of a FINALIZED program only (the Owner confirmed them): nothing before. It shows the winner's
// name, phone and e-mail as they are, because the Owner contacts the winner to deliver the prize; the page is Owner-only
// (policy prize_fulfillment.update) and the database is asked for nothing else.
import { insertAudit, currentMutationScope, NoMutationScopeError } from "../audit.ts";
import type { Sql } from "../db.ts";
import { actor, bounded } from "./contest.ts";
import { formValue, InvalidInput, multiLine } from "./fields.ts";
import { parseReason } from "./rescore.ts";
import { BUSY } from "./trivia.ts";

export const FULFILLMENT_STEPS = ["pending", "contacted", "sent", "done"] as const;
export type FulfillmentStep = (typeof FULFILLMENT_STEPS)[number];
export const STEP_LABEL: Readonly<Record<FulfillmentStep, string>> = { pending: "Pending", contacted: "Contacted", sent: "Sent", done: "Done" };
/** What the button that moves a fulfilment out of each step says. */
export const ADVANCE_LABEL: Readonly<Record<Exclude<FulfillmentStep, "done">, string>> = {
  pending: "Mark contacted",
  contacted: "Mark sent",
  sent: "Mark done (prize delivered)",
};
export const NOTES_MAX = 2000;

export const HALTED = "Fulfilment is halted: this winner is flagged (a chargeback or refund) or revoked. Reinstate the winner, or revoke and re-award the prize.";
export const STALE = "This fulfilment changed in the meantime (or is not one step away). Reload the page and try again.";

const COMMON: Readonly<Record<string, string>> = {
  ET170: "The request could not run safely. Try again.",
  ET171: "Only an active Owner can do this, with valid values. Reload the page and check the form.",
  ET082: HALTED,
  "40001": "Someone changed this at the same moment. Try again.",
  "40P01": "Someone changed this at the same moment. Try again.",
  "55P03": BUSY,
  "57014": BUSY,
};
const STEP_MESSAGES: Readonly<Record<string, string>> = { ...COMMON, ET172: STALE };
const REAWARD_MESSAGES: Readonly<Record<string, string>> = {
  ...COMMON,
  ET173: "This winner cannot be changed in its current state (already revoked, not flagged, or the prize was already delivered).",
  ET174: "This winner is no longer eligible (no paid order of the program is left) or asked for their data to be deleted: revoke and re-award instead.",
};

export interface FulfillmentRow {
  readonly id: string;
  readonly status: FulfillmentStep;
  readonly notes: string | null;
  readonly contactedAt: Date | null;
  readonly sentAt: Date | null;
  readonly doneAt: Date | null;
  readonly proof: { readonly uploadId: string; readonly contentType: string; readonly sizeBytes: number; readonly createdAt: Date } | null;
}

export interface FulfillmentWinner {
  readonly winnerId: string;
  readonly rank: number;
  readonly prizeName: string;
  readonly prizeValueIdr: number;
  readonly status: "confirmed" | "flagged" | "revoked" | "awaiting_confirmation";
  /** The first 8 characters of the player id. */
  readonly ref: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  /** The player asked for their data to be deleted (US-030): no contact is left. */
  readonly erased: boolean;
  /** The rank of the revoked winner whose prize this one was re-awarded. */
  readonly replacesRank: number | null;
  readonly flagReason: string | null;
  readonly fulfillment: FulfillmentRow | null;
}

export interface FulfillmentPage {
  readonly programId: string;
  readonly name: string;
  readonly winnersConfirmedAt: Date;
  readonly winners: readonly FulfillmentWinner[];
}

/** Every finalized program (the Owner confirmed its winners), newest first, with its count of prizes not delivered yet. */
export async function listFinalizedPrograms(sql: Sql): Promise<{ readonly programId: string; readonly name: string; readonly winnersConfirmedAt: Date; readonly open: number }[]> {
  const rows = await sql<{ id: string; name: string; winners_confirmed_at: Date; open: number }[]>`
    SELECT p.id, p.name, p.winners_confirmed_at,
           (SELECT count(*)::int FROM public.winners w JOIN public.fulfillments f ON f.winner_id = w.id
             WHERE w.program_id = p.id AND w.status IN ('confirmed', 'flagged') AND f.status <> 'done') AS open
      FROM public.programs p
     WHERE p.status = 'finalized' AND p.winners_confirmed_at IS NOT NULL
     ORDER BY p.winners_confirmed_at DESC`;
  return rows.map((r) => ({ programId: r.id, name: r.name, winnersConfirmedAt: r.winners_confirmed_at, open: r.open }));
}

/** The fulfilment page of a finalized program, or null (unknown program, or its winners not confirmed yet: nothing shows). */
export async function getFulfillmentPage(sql: Sql, programId: string): Promise<FulfillmentPage | null> {
  const [program] = await sql<{ id: string; name: string; winners_confirmed_at: Date | null; status: string }[]>`
    SELECT id, name, winners_confirmed_at, status::text AS status FROM public.programs WHERE id = ${programId}`;
  if (program?.winners_confirmed_at == null || program.status !== "finalized") return null;
  const rows = await sql<
    {
      winner_id: string;
      rank: number;
      prize: string;
      value_idr: string;
      status: FulfillmentWinner["status"];
      player_id: string;
      name: string;
      phone: string | null;
      email: string | null;
      erased: boolean;
      replaces_rank: number | null;
      flag_reason: string | null;
      f_id: string | null;
      f_status: FulfillmentStep | null;
      notes: string | null;
      contacted_at: Date | null;
      sent_at: Date | null;
      done_at: Date | null;
      proof_id: string | null;
      proof_type: string | null;
      proof_size: string | null;
      proof_at: Date | null;
    }[]
  >`
    SELECT w.id AS winner_id, w.rank, t.name AS prize, t.value_idr::text, w.status::text AS status, pl.id AS player_id, pl.name, pl.phone, pl.email,
           pl.anonymized_at IS NOT NULL AS erased, r.rank AS replaces_rank, w.flag_reason,
           f.id AS f_id, f.status::text AS f_status, f.notes, f.contacted_at, f.sent_at, f.done_at,
           u.id AS proof_id, u.content_type AS proof_type, u.size_bytes::text AS proof_size, u.created_at AS proof_at
      FROM public.winners w
      JOIN public.prize_tiers t ON t.id = w.prize_tier_id
      JOIN public.players pl ON pl.id = w.player_id
      LEFT JOIN public.winners r ON r.id = w.replaces_winner_id
      LEFT JOIN public.fulfillments f ON f.winner_id = w.id
      LEFT JOIN public.uploads u ON u.id = f.proof_upload_id
     WHERE w.program_id = ${programId}
     ORDER BY t.rank_from, w.rank`;
  return {
    programId: program.id,
    name: program.name,
    winnersConfirmedAt: program.winners_confirmed_at,
    winners: rows.map((r) => ({
      winnerId: r.winner_id,
      rank: r.rank,
      prizeName: r.prize,
      prizeValueIdr: Number(r.value_idr),
      status: r.status,
      ref: r.player_id.slice(0, 8),
      name: r.name,
      phone: r.phone,
      email: r.email,
      erased: r.erased,
      replacesRank: r.replaces_rank,
      flagReason: r.flag_reason,
      fulfillment:
        r.f_id === null || r.f_status === null
          ? null
          : {
              id: r.f_id,
              status: r.f_status,
              notes: r.notes,
              contactedAt: r.contacted_at,
              sentAt: r.sent_at,
              doneAt: r.done_at,
              proof:
                r.proof_id === null || r.proof_type === null || r.proof_at === null
                  ? null
                  : { uploadId: r.proof_id, contentType: r.proof_type, sizeBytes: Number(r.proof_size ?? 0), createdAt: r.proof_at },
            },
    })),
  };
}

/** A step of the form: the status the Owner saw (the database refuses a stale one). */
export function parseStep(raw: string): FulfillmentStep {
  const step = FULFILLMENT_STEPS.find((s) => s === raw);
  if (step === undefined) throw new InvalidInput(STALE);
  return step;
}

/** One step forward (`advance`) or, with a reason, one step back (`correct`). Returns whether anything changed. */
export async function moveFulfillment(sql: Sql, fulfillmentId: string, from: FulfillmentStep, direction: "advance" | "correct", reason: string | null): Promise<{ readonly to: FulfillmentStep; readonly changed: boolean }> {
  const index = FULFILLMENT_STEPS.indexOf(from) + (direction === "advance" ? 1 : -1);
  const to = FULFILLMENT_STEPS[index];
  if (to === undefined || from === "done") throw new InvalidInput(from === "done" ? "Done is final: a delivered prize is not moved back." : STALE);
  const a = actor();
  const result = await bounded(sql, STEP_MESSAGES, async (tx) => {
    const [row] = await tx<{ s: { changed?: boolean } }[]>`
      SELECT public.fulfillment_step(${fulfillmentId}::uuid, ${from}, ${to}, ${reason}, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS s`;
    return row?.s ?? {};
  });
  return { to, changed: result.changed === true };
}

/** The correction's reason: 10 to 500 characters, no contact details (the database checks the same). */
export const parseCorrectionReason = (form: FormData): string =>
  parseReason(multiLine(formValue(form, "reason").trim(), "Give the reason for the correction (10 to 500 characters).", { min: 10, max: 500 }));

/** The notes: plain text, at most NOTES_MAX characters; empty clears them. */
export function parseNotes(form: FormData): string {
  const notes = formValue(form, "notes").trim();
  // Counted in code points, like the database's char_length. Plain text only: the control characters a textarea never sends (all
  // but tab, line feed, carriage return) are refused, as in the database.
  let length = 0;
  for (const ch of notes) {
    length++;
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) throw new InvalidInput("Notes are plain text.");
  }
  if (length > NOTES_MAX) throw new InvalidInput(`Notes are up to ${String(NOTES_MAX)} characters.`);
  return notes;
}

export async function saveNotes(sql: Sql, fulfillmentId: string, notes: string): Promise<boolean> {
  const a = actor();
  const result = await bounded(sql, STEP_MESSAGES, async (tx) => {
    const [row] = await tx<{ s: { changed?: boolean } }[]>`
      SELECT public.fulfillment_set_notes(${fulfillmentId}::uuid, ${notes}, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS s`;
    return row?.s ?? {};
  });
  return result.changed === true;
}

export interface ReawardResult {
  readonly revoked: boolean;
  readonly reawardedRank: number | null;
}

/** The Owner revokes a winner; the prize goes to the next eligible player of the snapshot (or nobody, when none is left). */
export async function revokeWinner(sql: Sql, winnerId: string, reason: string): Promise<ReawardResult> {
  const a = actor();
  const s = await bounded(sql, REAWARD_MESSAGES, async (tx) => {
    const [row] = await tx<{ s: { revoked?: boolean; reawarded_rank?: number | null } }[]>`
      SELECT public.revoke_winner(${winnerId}::uuid, ${reason}, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS s`;
    return row?.s ?? {};
  });
  return { revoked: s.revoked === true, reawardedRank: typeof s.reawarded_rank === "number" ? s.reawarded_rank : null };
}

/** The Owner reinstates a flagged winner who is still paid. */
export async function reinstateWinner(sql: Sql, winnerId: string, reason: string): Promise<boolean> {
  const a = actor();
  const s = await bounded(sql, REAWARD_MESSAGES, async (tx) => {
    const [row] = await tx<{ s: { reinstated?: boolean } }[]>`
      SELECT public.reinstate_winner(${winnerId}::uuid, ${reason}, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS s`;
    return row?.s ?? {};
  });
  return s.reinstated === true;
}

/** The revoke / reinstate form's reason: 10 to 500 characters, no contact details. */
export const parseWinnerReason = (form: FormData): string =>
  parseReason(multiLine(formValue(form, "reason").trim(), "Give the reason (10 to 500 characters).", { min: 10, max: 500 }));

export interface ProofFile {
  readonly storagePath: string;
  readonly contentType: string;
  /** A download name with no personal data: proof-<winner rank>-<fulfilment ref>.<ext>. */
  readonly filename: string;
}

/**
 * The proof of a fulfilment for the Owner's download, with its audit row (fulfillment.proof_download: ids only), written in the
 * download's own transaction before the file is sent; null when the fulfilment has no proof.
 */
export async function proofForDownload(sql: Sql, fulfillmentId: string): Promise<ProofFile | null> {
  const scope = currentMutationScope();
  if (scope === undefined) throw new NoMutationScopeError();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ storage_path: string; content_type: string; upload_id: string; rank: number }[]>`
      SELECT u.storage_path, u.content_type, u.id AS upload_id, w.rank
        FROM public.fulfillments f JOIN public.uploads u ON u.id = f.proof_upload_id JOIN public.winners w ON w.id = f.winner_id
       WHERE f.id = ${fulfillmentId} AND u.kind = 'proof'`;
    if (row === undefined) return null;
    await insertAudit(tx, scope, { action: "fulfillment.proof_download", entityType: "fulfillment", entityId: fulfillmentId, facts: { upload_id: row.upload_id } });
    const ext = row.content_type === "application/pdf" ? "pdf" : "webp";
    return { storagePath: row.storage_path, contentType: row.content_type, filename: `proof-${String(row.rank)}-${fulfillmentId.slice(0, 8)}.${ext}` };
  });
}
