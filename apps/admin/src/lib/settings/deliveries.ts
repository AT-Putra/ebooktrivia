// The explicit resend of a delivery in the console (US-025, completed in US-029's report; AC-A1: Staff may manage resends).
//
// The database function public.resend_delivery (packages/db/sql/delivery-resend.sql, owned by the NOLOGIN role delivery_resend) is the console's only
// write to deliveries (admin_rw holds no INSERT, UPDATE or DELETE on them): it puts a `failed` delivery back to `pending`, due now, and refuses what no
// caller may do (a delivery that is not failed or unknown: ET133; an `unknown` one, a send that MAY have gone out, without p_confirm_unknown: ET132; a delivery
// whose lease has not ended, so a send may still be running: ET134; an order that is not paid: ET080). WHO may ask is this layer's rule, and the server actions enforce it:
//   Staff and Owner (delivery.resend):          a FAILED delivery (nothing reached the buyer for sure);
//   Owner only (delivery.resend_unknown):       an UNKNOWN delivery, only with the explicit confirmation that the buyer may already have it.
// Every resend is audited in the same transaction, with the status it had and the error as a code, never a message or a buyer's detail.
import { DELIVERED_WRONG_FILE } from "@ebooktrivia/core";
import type { FieldKind } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { InvalidInput } from "./fields.ts";

const RESEND_FIELDS: Readonly<Record<string, FieldKind>> = { status: "value" };

export const RESEND_MESSAGES: Readonly<Record<string, string>> = {
  ET010: "This delivery no longer exists.",
  ET132: "This delivery may already have reached the buyer: only the Owner can resend it, after confirming that.",
  ET133: "Only a failed delivery (or, for the Owner, an unknown one) can be resent.",
  ET134: "A send of this delivery may still be running: try again after its lease has ended (a few minutes).",
  ET080: "The order of this delivery is not paid, so nothing is sent for it.",
};

/** Puts a failed delivery (or, with `confirmUnknown`, an unknown one) back on the send path; audited. */
export async function resendDelivery(sql: Sql, id: string, options: { readonly confirmUnknown?: boolean } = {}): Promise<void> {
  const confirmUnknown = options.confirmUnknown === true;
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [before] = await tx<{ channel: string; order_id: string; attempts: number; error_code: string | null }[]>`
        SELECT channel::text AS channel, order_id, attempts,
               CASE WHEN last_error IS NULL THEN NULL WHEN last_error ~ '^[a-z0-9_]{1,64}$' THEN last_error ELSE 'other' END AS error_code
          FROM public.deliveries WHERE id = ${id}`;
      if (before === undefined) throw new InvalidInput(RESEND_MESSAGES["ET010"] ?? "");
      const [result] = await tx<{ was: string }[]>`SELECT public.resend_delivery(${id}::uuid, ${confirmUnknown}::boolean) AS was`;
      if (result === undefined) throw new Error("resend_delivery returned nothing");
      audit({
        action: "delivery.resend",
        entityType: "delivery",
        entityId: id,
        fields: RESEND_FIELDS,
        before: { status: result.was },
        after: { status: "pending" },
        facts: { channel: before.channel, order_id: before.order_id, attempts: before.attempts, error_code: before.error_code, confirmed_unknown: result.was === "unknown" },
      });
    },
    RESEND_MESSAGES,
  );
}

/** The audit action of "mark handled": the delivery report leaves a delivery with such an entry out of "Needs attention" (lib/reports/delivery-source.ts). */
export const WRONG_FILE_HANDLED_ACTION = "delivery.wrong_file_handled";

const HANDLED_FIELDS: Readonly<Record<string, FieldKind>> = { attention: "value" };

/**
 * The Owner has seen a `sent` delivery whose WhatsApp file arrived wrong (last_error delivered_wrong_file, US-005 R11) and dealt with it (or decided to leave it): it
 * leaves "Needs attention". DISPLAY ONLY: nothing about the delivery changes (a `sent` row stays final, admin_rw has no write on deliveries), the only record is the audit
 * entry, written in the same transaction, which the report reads. Refused for anything else, and for a delivery already handled.
 */
export async function markWrongFileHandled(sql: Sql, id: string): Promise<void> {
  await auditedChange(sql, async (tx, audit) => {
    const [row] = await tx<{ channel: string; order_id: string; status: string; last_error: string | null; handled: boolean }[]>`
      SELECT d.channel::text AS channel, d.order_id, d.status::text AS status, d.last_error,
             EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = ${WRONG_FILE_HANDLED_ACTION} AND a.entity_type = 'delivery' AND a.entity_id = d.id::text) AS handled
        FROM public.deliveries d WHERE d.id = ${id}`;
    if (row === undefined) throw new InvalidInput(RESEND_MESSAGES["ET010"] ?? "");
    if (row.status !== "sent" || row.last_error !== DELIVERED_WRONG_FILE) throw new InvalidInput("Only a delivery that WhatsApp delivered as a wrong file can be marked as handled.");
    if (row.handled) throw new InvalidInput("This delivery is already marked as handled.");
    audit({
      action: WRONG_FILE_HANDLED_ACTION,
      entityType: "delivery",
      entityId: id,
      fields: HANDLED_FIELDS,
      before: { attention: "wrong_file" },
      after: { attention: "handled" },
      facts: { channel: row.channel, order_id: row.order_id },
    });
  });
}
