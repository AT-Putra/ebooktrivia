// UU PDP deletion requests (US-030; plan §10 item 6, R9; AC-A10), Owner-only (policy deletion_request.process).
//
//   record   the Owner records a request by the requester's phone, e-mail or order public id, with the request's reason. The
//            lookup resolves it to ONE data subject: a phone (one buyer = one phone = one player, AC-Q1). An e-mail that several
//            phones used is refused (ask for the phone), and so is a lookup that matches nothing (nothing to delete). The request
//            keeps the phone only while it is pending; the audit row keeps only the lookup kind and a reference;
//   review   the Owner sees the matched subject (masked: name, phone, e-mail), every order (public id, status, amount), the
//            consents recorded at checkout (legal page and version, when, and the device recorded), the prizes, and what would
//            block the erasure;
//   execute  with the request's 8-character reference typed as the confirmation, through public.erase_data_subject (packages/db
//            sql/privacy.sql, owner pii_eraser): ONE transaction that anonymizes the subject everywhere and keeps the pseudonymous
//            financial rows; it refuses an undelivered prize (ET177) or an open order or send (ET178), and is a no-op for a
//            completed request. The proof files it frees are removed here after the commit (a missing file is fine; the upload
//            sweeper removes any left behind);
//   reject   with a reason (10-500 characters, no contact details); the phone is dropped from the request.
// Staff never reach any of it: every page, action and query here is behind deletion_request.process.
import { maskName, maskPhone, normalizeIdMobile } from "@ebooktrivia/core";
import { withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { actor, bounded } from "./contest.ts";
import type { SettingsConfig } from "./env.ts";
import { formValue, InvalidInput, multiLine } from "./fields.ts";
import { removeProofFileQuietly } from "./proof-files.ts";
import { parseReason } from "./rescore.ts";
import { BUSY } from "./trivia.ts";

export const LOOKUP_KINDS = ["phone", "email", "order"] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];
export const LOOKUP_LABEL: Readonly<Record<LookupKind, string>> = { phone: "WhatsApp number", email: "E-mail address", order: "Order id (from the order page)" };

export interface DeletionInput {
  readonly kind: LookupKind;
  /** E.164 phone, lower-case e-mail, or an order public id. */
  readonly value: string;
  readonly reason: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_ID = /^[0-9A-Za-z]{16,40}$/;

export function parseDeletionRequest(form: FormData): DeletionInput {
  const kind = LOOKUP_KINDS.find((k) => k === formValue(form, "kind"));
  if (kind === undefined) throw new InvalidInput("Choose how the requester identified themselves.");
  const raw = formValue(form, "value").trim();
  let value: string;
  if (kind === "phone") {
    const phone = normalizeIdMobile(raw);
    if (!phone.ok) throw new InvalidInput("Enter the requester's Indonesian WhatsApp number (e.g. 0812...).");
    value = phone.e164;
  } else if (kind === "email") {
    value = raw.toLowerCase();
    if (value.length > 254 || !EMAIL.test(value)) throw new InvalidInput("Enter the requester's e-mail address.");
  } else {
    if (!PUBLIC_ID.test(raw)) throw new InvalidInput("Enter the order id as the order page shows it (16 to 40 letters and digits).");
    value = raw;
  }
  const reason = parseReason(multiLine(formValue(form, "reason").trim(), "Describe the request (10 to 500 characters, e.g. how and when it arrived).", { min: 10, max: 500 }));
  return { kind, value, reason };
}

export const NO_SUBJECT = "No buyer or player matches this. Nothing is stored about them (or they were deleted already).";
export const SEVERAL_SUBJECTS = "This e-mail address was used with more than one WhatsApp number: record the request by the requester's number instead.";
export const ALREADY_PENDING = "A deletion request for this person is already pending: review that one.";

/** The data subject's phone for a lookup, or why there is none. */
async function subjectPhone(sql: Sql, input: DeletionInput): Promise<string> {
  let phones: string[];
  if (input.kind === "phone") {
    phones = (await sql<{ phone: string }[]>`
      SELECT p.phone FROM public.players p WHERE p.phone = ${input.value}
      UNION SELECT o.buyer_phone FROM public.orders o WHERE o.buyer_phone = ${input.value}`).map((r) => r.phone);
  } else if (input.kind === "email") {
    phones = (await sql<{ phone: string }[]>`
      SELECT p.phone FROM public.players p WHERE lower(p.email) = ${input.value} AND p.phone IS NOT NULL
      UNION SELECT o.buyer_phone FROM public.orders o WHERE lower(o.buyer_email) = ${input.value} AND o.buyer_phone IS NOT NULL`).map((r) => r.phone);
  } else {
    phones = (await sql<{ phone: string }[]>`SELECT o.buyer_phone AS phone FROM public.orders o WHERE o.public_id = ${input.value} AND o.buyer_phone IS NOT NULL`).map((r) => r.phone);
  }
  const [phone, ...more] = phones;
  if (phone === undefined) throw new InvalidInput(NO_SUBJECT);
  if (more.length > 0) throw new InvalidInput(SEVERAL_SUBJECTS);
  return phone;
}

/** Records a pending request for the subject the lookup resolves to; returns its id. Audited (the lookup kind and a reference). */
export async function createDeletionRequest(sql: Sql, input: DeletionInput): Promise<string> {
  const phone = await subjectPhone(sql, input);
  const a = actor();
  return withAudit(sql, async (tx, audit) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`deletion_request:${phone}`}, 0))`;
    const [pending] = await tx`SELECT 1 FROM public.deletion_requests WHERE subject_phone = ${phone} AND status = 'pending'`;
    if (pending !== undefined) throw new InvalidInput(ALREADY_PENDING);
    const [player] = await tx<{ id: string }[]>`SELECT id FROM public.players WHERE phone = ${phone}`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO public.deletion_requests (player_id, subject_phone, lookup_kind, note, requested_by_admin_user_id)
      VALUES (${player?.id ?? null}, ${phone}, ${input.kind}, ${input.reason}, ${a.userId}) RETURNING id`;
    const id = row?.id ?? "";
    // The phone and the request's text (free text may name the person) are kept on the request only; the append-only audit
    // records that they were set.
    audit({
      action: "privacy.deletion_request",
      entityType: "deletion_request",
      entityId: id,
      fields: { subject_phone: "pii", note: "pii" },
      before: null,
      after: { subject_phone: phone, note: input.reason },
      facts: { lookup_kind: input.kind, player_found: player !== undefined },
    });
    return id;
  });
}

export interface DeletionRequestRow {
  readonly id: string;
  readonly ref: string;
  readonly status: "pending" | "completed" | "rejected";
  readonly requestedAt: Date;
  readonly lookupKind: LookupKind | null;
  readonly decidedAt: Date | null;
  readonly note: string | null;
}

export async function listDeletionRequests(sql: Sql, limit = 200): Promise<DeletionRequestRow[]> {
  const rows = await sql<{ id: string; status: DeletionRequestRow["status"]; requested_at: Date; lookup_kind: LookupKind | null; decided_at: Date | null; note: string | null }[]>`
    SELECT id, status, requested_at, lookup_kind, coalesce(completed_at, rejected_at) AS decided_at, note
      FROM public.deletion_requests ORDER BY (status = 'pending') DESC, requested_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, ref: r.id.slice(0, 8), status: r.status, requestedAt: r.requested_at, lookupKind: r.lookup_kind, decidedAt: r.decided_at, note: r.note }));
}

export interface SubjectOrder {
  readonly publicId: string;
  readonly status: string;
  readonly amountIdr: number;
  readonly createdAt: Date;
  readonly program: string;
  readonly consents: readonly { readonly kind: string; readonly version: number; readonly consentedAt: Date; readonly ip: string | null; readonly uaRecorded: boolean }[];
}

export interface DeletionReview {
  readonly id: string;
  readonly ref: string;
  readonly status: DeletionRequestRow["status"];
  readonly requestedAt: Date;
  readonly lookupKind: LookupKind | null;
  readonly note: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
  /** Only while pending: who would be erased. */
  readonly subject: {
    readonly maskedName: string | null;
    readonly maskedPhone: string | null;
    readonly maskedEmail: string | null;
    readonly playerRef: string | null;
    readonly orders: readonly SubjectOrder[];
    readonly prizes: readonly { readonly program: string; readonly rank: number; readonly status: string; readonly fulfillment: string | null }[];
    /** What makes the database refuse the erasure now (ET177 / ET178). */
    readonly blockers: readonly string[];
  } | null;
}

const maskEmail = (email: string | null): string | null => {
  if (email === null || email === "") return null;
  const at = email.indexOf("@");
  return at <= 0 ? "***" : `${email.charAt(0)}***${email.slice(at)}`;
};

export const BLOCK_PRIZE = "Holds a prize that was not delivered yet: forfeit it first (Prize fulfilment: revoke and re-award), or deliver it.";
export const BLOCK_ORDER = "Has an order that is still open (pending) or awaits your review: wait until it expires or decide it.";

export async function getDeletionReview(sql: Sql, id: string): Promise<DeletionReview | null> {
  const [r] = await sql<
    { id: string; status: DeletionReview["status"]; requested_at: Date; lookup_kind: LookupKind | null; note: string | null; decided_at: Date | null; decision_note: string | null; summary: Record<string, unknown>; subject_phone: string | null }[]
  >`
    SELECT id, status, requested_at, lookup_kind, note, coalesce(completed_at, rejected_at) AS decided_at, decision_note, summary, subject_phone
      FROM public.deletion_requests WHERE id = ${id}`;
  if (r === undefined) return null;
  const base = {
    id: r.id,
    ref: r.id.slice(0, 8),
    status: r.status,
    requestedAt: r.requested_at,
    lookupKind: r.lookup_kind,
    note: r.note,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    summary: r.summary,
  };
  if (r.status !== "pending" || r.subject_phone === null) return { ...base, subject: null };
  const phone = r.subject_phone;
  const [player] = await sql<{ id: string; name: string; email: string | null }[]>`SELECT id, name, email FROM public.players WHERE phone = ${phone}`;
  const orders = await sql<{ id: string; public_id: string; status: string; amount_idr: string; created_at: Date; program: string; buyer_name: string; buyer_email: string }[]>`
    SELECT o.id, o.public_id, o.status::text AS status, o.amount_idr::text, o.created_at, p.name AS program, o.buyer_name, o.buyer_email
      FROM public.orders o JOIN public.programs p ON p.id = o.program_id
     WHERE o.buyer_phone = ${phone} OR (${player?.id ?? null}::uuid IS NOT NULL AND o.player_id = ${player?.id ?? null}::uuid)
     ORDER BY o.created_at`;
  const consents =
    orders.length === 0
      ? []
      : await sql<{ order_id: string; kind: string; version: number; consented_at: Date; ip: string | null; ua: boolean }[]>`
          SELECT c.order_id, l.kind, l.version, c.consented_at, host(c.ip) AS ip, c.ua_hash IS NOT NULL AS ua
            FROM public.consents c JOIN public.legal_pages l ON l.id = c.legal_page_id
           WHERE c.order_id = ANY (${orders.map((o) => o.id)}::uuid[]) ORDER BY c.consented_at, l.kind`;
  const prizes =
    player === undefined
      ? []
      : await sql<{ program: string; rank: number; status: string; fulfillment: string | null }[]>`
          SELECT p.name AS program, w.rank, w.status::text AS status, f.status::text AS fulfillment
            FROM public.winners w JOIN public.programs p ON p.id = w.program_id LEFT JOIN public.fulfillments f ON f.winner_id = w.id
           WHERE w.player_id = ${player.id} ORDER BY w.created_at`;
  const blockers: string[] = [];
  if (prizes.some((p) => p.status !== "revoked" && p.fulfillment !== "done")) blockers.push(BLOCK_PRIZE);
  if (orders.some((o) => o.status === "pending" || o.status === "review")) blockers.push(BLOCK_ORDER);
  const name = player?.name ?? orders.at(-1)?.buyer_name ?? null;
  return {
    ...base,
    subject: {
      maskedName: name === null ? null : maskName(name),
      maskedPhone: maskPhone(phone),
      maskedEmail: maskEmail(player?.email ?? orders.at(-1)?.buyer_email ?? null),
      playerRef: player?.id.slice(0, 8) ?? null,
      orders: orders.map((o) => ({
        publicId: o.public_id,
        status: o.status,
        amountIdr: Number(o.amount_idr),
        createdAt: o.created_at,
        program: o.program,
        consents: consents.filter((c) => c.order_id === o.id).map((c) => ({ kind: c.kind, version: c.version, consentedAt: c.consented_at, ip: c.ip, uaRecorded: c.ua })),
      })),
      prizes,
      blockers,
    },
  };
}

const ERASE_MESSAGES: Readonly<Record<string, string>> = {
  ET170: "The request could not run safely. Try again.",
  ET171: "Type the request's reference exactly as shown to confirm (only an active Owner can erase).",
  ET176: "This request was rejected: it is never executed.",
  ET177: BLOCK_PRIZE,
  ET178: "An order of this person is still open or awaits your review, or a message to them is being sent right now. Try again later.",
  "40001": "Someone changed this at the same moment. Try again.",
  "40P01": "Someone changed this at the same moment. Try again.",
  "55P03": BUSY,
  "57014": BUSY,
};

/** Executes the request (see the header); returns the erasure's counts. */
export async function executeDeletionRequest(sql: Sql, settings: SettingsConfig, id: string, confirmation: string): Promise<{ readonly erased: boolean; readonly orders: number }> {
  const a = actor();
  const summary = await bounded(sql, ERASE_MESSAGES, async (tx) => {
    // The erasure touches many tables: more time than a settings change.
    await tx.unsafe("SET LOCAL statement_timeout = '60s'");
    const [row] = await tx<{ s: { erased?: boolean; orders?: number; removed_files?: unknown } }[]>`
      SELECT public.erase_data_subject(${id}::uuid, ${confirmation}, ${a.userId}, ${a.requestId}, ${a.ip}::inet) AS s`;
    return row?.s ?? {};
  });
  const files = Array.isArray(summary.removed_files) ? summary.removed_files.filter((f): f is string => typeof f === "string") : [];
  if (settings.dataDir !== null) for (const file of files) await removeProofFileQuietly(settings.dataDir, file);
  return { erased: summary.erased === true, orders: typeof summary.orders === "number" ? summary.orders : 0 };
}

export const parseConfirmation = (form: FormData): string => formValue(form, "confirmation").trim().toLowerCase();

export const parseRejection = (form: FormData): string =>
  parseReason(multiLine(formValue(form, "reason").trim(), "Give the reason for the rejection (10 to 500 characters).", { min: 10, max: 500 }));

/** Rejects a pending request with a reason; its phone is dropped. Audited. */
export async function rejectDeletionRequest(sql: Sql, id: string, reason: string): Promise<void> {
  const a = actor();
  await withAudit(sql, async (tx, audit) => {
    const [row] = await tx<{ id: string }[]>`
      UPDATE public.deletion_requests
         SET status = 'rejected', rejected_at = clock_timestamp(), decided_by_admin_user_id = ${a.userId}, decision_note = ${reason}, subject_phone = NULL,
             updated_at = clock_timestamp()
       WHERE id = ${id} AND status = 'pending'
      RETURNING id`;
    if (row === undefined) throw new InvalidInput("This request was already decided.");
    audit({
      action: "privacy.deletion_reject",
      entityType: "deletion_request",
      entityId: id,
      fields: { status: "value", subject_phone: "pii", decision_note: "pii" },
      before: { status: "pending", subject_phone: "x", decision_note: null },
      after: { status: "rejected", subject_phone: null, decision_note: reason },
    });
  });
}
