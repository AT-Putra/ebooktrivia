// The message, read again from WAHA by its id (US-025): the webhook is untrusted input, so what the worker acts on (the inbound consumer's decision, the read mark of
// read-marks.ts) is never the webhook's own words but what WAHA itself says about that message id, on the session (and server) it arrived on.
import { WahaError } from "@ebooktrivia/adapters";
import type postgres from "postgres";
import { type WahaAccess, WahaAccessError } from "./ports.ts";

export interface Fetched {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly fromMe: boolean;
  readonly body: string;
  readonly chat: { readonly kind: "phone"; readonly chatId: string; readonly phone: string } | { readonly kind: "lid"; readonly chatId: string; readonly lid: string } | { readonly kind: "other"; readonly chatId: string };
}

/**
 * Re-reads the message from WAHA on the session it arrived on (a name may exist on two servers: the one that knows the id wins). "unverified" when WAHA does not know it
 * or the id is not even shaped like WAHA's (a forgery, not an outage); throws when WAHA could not be asked (the caller decides whether that is a retry or a skip).
 */
export async function refetchMessage(deps: { readonly sql: postgres.Sql; readonly waha: WahaAccess }, sessionName: string, messageId: string, timeoutMs: number): Promise<Fetched | "unverified"> {
  const candidates = await deps.sql<{ id: string }[]>`
    SELECT s.id FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
     WHERE s.session_name = ${sessionName} AND s.active AND w.active ORDER BY s.id`;
  let failed = false;
  for (const { id } of candidates) {
    try {
      const found = await deps.waha.withSession(id, async ({ sessionName: name, client }) => ({ name, message: await client.getMessage(name, messageId) }), { timeoutMs });
      if (found.message === null) continue;
      const { message } = found;
      return { sessionId: id, sessionName: found.name, fromMe: message.fromMe, body: message.body, chat: message.chat };
    } catch (error) {
      // A message id that is not even shaped like WAHA's is a forgery, not an outage.
      if (error instanceof RangeError) return "unverified";
      if (error instanceof WahaError || error instanceof WahaAccessError) {
        failed = true;
        continue;
      }
      throw error;
    }
  }
  // WAHA could not be asked (or not on every candidate): try again later instead of calling the message forged.
  if (failed) throw new Error("WAHA could not be asked about an inbound message");
  return "unverified";
}
