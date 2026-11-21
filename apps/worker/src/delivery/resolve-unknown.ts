// Resolving `unknown` deliveries (US-025; plan M8.2; spec AC-D4): a send that MAY have gone out (a timeout, a reset, a 5xx, or a
// worker that died holding the claim: the lease sweeper) is never sent again by itself. After its lease has expired this sweep looks at
// what the number actually sent: the session's recent outgoing messages to the order's chat. A message with the same file name inside
// the lease window means the send happened: the row becomes `sent` (core resolveUnknownDelivery). Anything else, and always an e-mail,
// stays for the Owner: its alert is raised once the lookup has had its chance (UNRESOLVED_AFTER_MS), and the row stays `unknown` and
// visible in the failed deliveries. Nothing here ever moves a row back onto the send path (the database refuses it too, ET130).
//
// A buyer-first reply that went to another chat than the order's phone chat (a verified @lid sender) is found too: the chat the reply was sent to is stored on
// the delivery (reply_chat_id), and the lookup asks there as well as in the order's own chat.
import { type DeliveryDecision, type DeliveryRow, type OutgoingMessage, resolveUnknownDelivery } from "@ebooktrivia/core";
import type postgres from "postgres";
import type { Logger } from "../log.ts";
import { raiseAlert } from "../sweepers.ts";
import type { DeliveryConfig } from "./config.ts";
import { applyDecision, type ClaimRow } from "./deliver.ts";
import type { WahaAccess } from "./ports.ts";

/** A WhatsApp lookup is tried for this long after the lease expired; past it the row is the Owner's (and raises its alert). */
export const LOOKUP_WINDOW_MS = 30 * 60_000;
export const UNRESOLVED_AFTER_MS = LOOKUP_WINDOW_MS;
/** Rows older than a day no longer raise an alert (the failed deliveries list still shows them). */
const ALERT_HORIZON_MS = 24 * 3_600_000;
const BATCH = 50;
/** The page size of the lookup; it pages on (adapters recentOutgoing) until the send's own time is covered, whatever the buyer wrote since. */
const LOOKUP_MESSAGES = 50;

export interface ResolveDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  readonly config: Pick<DeliveryConfig, "leaseMs" | "unknownSkewMs">;
}

interface UnknownRow {
  id: string;
  channel: DeliveryRow["channel"];
  status: ClaimRow["status"];
  not_before: Date;
  lease_until: Date;
  attempts: number;
  session_id: string;
  tried_session_ids: string[];
  wa_chat_id: string;
  reply_chat_id: string | null;
  filename: string;
  now: Date;
}

const asRow = (row: UnknownRow): DeliveryRow => ({
  channel: row.channel,
  status: row.status,
  notBefore: row.not_before,
  leaseUntil: row.lease_until,
  attempts: row.attempts,
  sessionId: row.session_id,
  triedSessionIds: row.tried_session_ids,
  waChatId: row.wa_chat_id,
  filename: row.filename,
});

export async function resolveUnknownDeliveries(deps: ResolveDeps): Promise<{ resolved: number; left: number; alerts: number }> {
  const { sql, log } = deps;
  const rows = await sql<UnknownRow[]>`
    SELECT id, channel, status, not_before, lease_until, attempts, session_id, tried_session_ids, wa_chat_id, reply_chat_id, filename, clock_timestamp() AS now
      FROM public.deliveries
     WHERE status = 'unknown' AND channel = 'whatsapp' AND session_id IS NOT NULL AND wa_chat_id IS NOT NULL AND filename IS NOT NULL
       AND lease_until < clock_timestamp() AND lease_until > clock_timestamp() - ${LOOKUP_WINDOW_MS} * interval '1 millisecond'
     ORDER BY lease_until LIMIT ${BATCH}`;
  let resolved = 0;
  let left = 0;
  for (const row of rows) {
    // The order's own chat, and the chat the reply went to when that was another one (a @lid).
    const chats = row.reply_chat_id !== null && row.reply_chat_id !== row.wa_chat_id ? [row.wa_chat_id, row.reply_chat_id] : [row.wa_chat_id];
    // The send happened inside the lease (core resolveUnknownDelivery): ask back to the start of that window, with the clock skew.
    const since = new Date(row.lease_until.getTime() - deps.config.leaseMs - deps.config.unknownSkewMs);
    let decision: DeliveryDecision | undefined;
    let failed = false;
    for (const chat of chats) {
      let outgoing: OutgoingMessage[];
      try {
        const found = await deps.waha.withSession(row.session_id, ({ sessionName, client }) => client.recentOutgoing(sessionName, chat, LOOKUP_MESSAGES, since), { timeoutMs: 30_000 });
        // The lookup asked for this chat only, so every answer is a message to it.
        outgoing = found.map((m) => ({ id: m.id, chatId: chat, fromMe: true, filename: m.filename ?? null, timestamp: new Date(m.timestamp * 1000) }));
      } catch (error) {
        // WAHA could not be asked: the next sweep asks again (the window is half an hour).
        log.warn({ deliveryId: row.id, code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed" }, "the outgoing-message lookup failed; retried at the next sweep");
        failed = true;
        break;
      }
      const attempt = resolveUnknownDelivery({ ...asRow(row), waChatId: chat }, { now: row.now, leaseMs: deps.config.leaseMs, skewMs: deps.config.unknownSkewMs, outgoing });
      if (attempt.ok) {
        decision = attempt;
        break;
      }
    }
    if (failed || decision === undefined || !decision.ok) {
      left++;
      continue;
    }
    const settled = decision;
    const applied = await sql.begin(async (tx) => {
      // Re-read under the lock: the late outcome of the original job may have settled it meanwhile.
      const [current] = await tx<{ status: string; attempts: number }[]>`SELECT status::text AS status, attempts FROM public.deliveries WHERE id = ${row.id} FOR UPDATE`;
      if (current?.status !== "unknown" || current.attempts !== settled.expect.attempts) return false;
      await applyDecision(tx, row.id, settled, row.now);
      return true;
    });
    if (applied) {
      resolved++;
      log.info({ deliveryId: row.id }, "an unknown delivery was found in the number's outgoing messages: sent");
    }
  }
  return { resolved, left, alerts: await alertUnresolved(sql) };
}

/**
 * One alert per row that no lookup settled: an e-mail, or a WhatsApp send the number's messages do not show. Raised through the shared
 * raiseAlertIn (its advisory lock on the dedupe key), so two worker replicas sweeping at once raise one; a row that was ever alerted
 * (even when the Owner resolved the alert) is not alerted again.
 */
async function alertUnresolved(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ id: string; order_id: string; channel: string }[]>`
    SELECT d.id, d.order_id, d.channel
      FROM public.deliveries d
     WHERE d.status = 'unknown'
       AND d.lease_until < clock_timestamp() - ${UNRESOLVED_AFTER_MS} * interval '1 millisecond'
       AND d.lease_until > clock_timestamp() - ${ALERT_HORIZON_MS} * interval '1 millisecond'
       AND NOT EXISTS (SELECT 1 FROM public.alerts a WHERE a.dedupe_key = 'delivery_unknown:' || d.id::text)
     ORDER BY d.lease_until
     LIMIT ${BATCH}`;
  let raised = 0;
  for (const row of rows) {
    const created = await raiseAlert(sql, {
      kind: "delivery_unknown",
      severity: "warning",
      dedupeKey: `delivery_unknown:${row.id}`,
      message: "a delivery may or may not have gone out: it is never resent automatically, and the Owner decides (see the failed deliveries)",
      payload: { delivery_id: row.id, order_id: row.order_id, channel: row.channel },
    });
    if (created) raised++;
  }
  return raised;
}
