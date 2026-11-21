// First-contact delivery (US-025; WAHA docs, Contacts: check-exists, and LIDs). A first WhatsApp message to a phone is NOT addressed `<phone>@c.us` by us:
// since WhatsApp's LID rollout the contact may live at `<lid>@lid`, and a message to a chat id that is not the contact's is silently dropped. So before the
// first message to a phone (an opener, a login code, any send to a chat we have no history with) the worker asks WAHA
//   GET /api/contacts/check-exists?phone=<digits>&session=<name>   ->  {numberExists, chatId, pn}
// and sends to the chat id it RETURNS. The answer is cached per phone (wa_contacts) with a refresh age (core contactCacheFresh: a month when the phone is on
// WhatsApp, a day when it is not), reused by every later send, and the lid -> phone link it carries also answers an inbound @lid sender without asking WAHA.
//   - numberExists false: `no_whatsapp`, final: no failover (no number would change it), no health penalty, no alert; the e-mail has the ebook and the order
//     page's WhatsApp button stays;
//   - a failing lookup (5xx, timeout) throws the adapter's WahaError: nothing was sent, so the caller makes it not_attempted (never maybe_sent).
// The phone and the chat id are personal data: they live in wa_contacts only, never in a log or an alert. UNVERIFIED shapes until US-005.
import { type WahaClient, WahaError } from "@ebooktrivia/adapters";
import { contactCacheFresh } from "@ebooktrivia/core";
import type postgres from "postgres";

type Db = postgres.Sql | postgres.TransactionSql;

/**
 * A lid -> phone link older than this is not trusted on its own: a @lid can be reassigned, so before a login link is issued to a sender the link led to,
 * WAHA is asked again (inbound.ts). Fresh links answer without a WAHA call.
 */
export const LID_LINK_FRESH_MS = 24 * 3_600_000;

/**
 * The contact cache could not be read or written (our database, not WAHA): NOTHING was sent, so the caller makes it `not_attempted` (never `maybe_sent`). Carries a
 * code only (the PostgreSQL SQLSTATE, or `unknown`): the cause is dropped on purpose, it may quote a phone or a chat id.
 */
export class ContactCacheError extends Error {
  readonly code: string;
  constructor(cause: unknown) {
    super("the contact cache could not be read or written");
    this.name = "ContactCacheError";
    this.code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : "unknown";
  }
}

/** Runs `work` in one transaction (a pool connection), or inside the one the caller already holds. */
function atomically<T>(sql: Db, work: (tx: Db) => Promise<T>): Promise<T> {
  return "begin" in sql ? sql.begin((tx) => work(tx)) : work(sql);
}

export type ContactResolution = { readonly kind: "ok"; readonly chatId: string; readonly lid: string | null } | { readonly kind: "no_whatsapp" };

interface ContactRow {
  number_exists: boolean;
  chat_id: string | null;
  lid: string | null;
  checked_at: Date;
}

/**
 * Where a message to `phone` (E.164) goes: the cached chat id while it is fresh, else WAHA's check-exists on `sessionName`, cached. Throws WAHA's own WahaError (the
 * lookup failed) or a ContactCacheError (our database failed): either way nothing was sent.
 */
export async function resolveContact(sql: Db, client: WahaClient, sessionName: string, phone: string, now: Date = new Date()): Promise<ContactResolution> {
  try {
    const [cached] = await sql<ContactRow[]>`SELECT number_exists, chat_id, lid, checked_at FROM public.wa_contacts WHERE phone = ${phone}`;
    if (cached !== undefined && contactCacheFresh({ numberExists: cached.number_exists, checkedAt: cached.checked_at }, now)) {
      return cached.number_exists && cached.chat_id !== null ? { kind: "ok", chatId: cached.chat_id, lid: cached.lid } : { kind: "no_whatsapp" };
    }
    const found = await client.checkExists(sessionName, phone);
    if (!found.numberExists || found.chatId === null) {
      await sql`
        INSERT INTO public.wa_contacts (phone, number_exists) VALUES (${phone}, false)
        ON CONFLICT (phone) DO UPDATE SET number_exists = false, chat_id = NULL, checked_at = now()`;
      return { kind: "no_whatsapp" };
    }
    const { chatId, lid } = found;
    // Taking a lid from the phone that held it and writing it to this one is ONE step: a failure of the second must not leave the lid on nobody. The lid link is
    // confirmed now only when this answer carried a lid; an answer without one refreshes the cache (checked_at) and leaves an old link as old as it was.
    await atomically(sql, async (tx) => {
      if (lid !== null) await clearLidElsewhere(tx, phone, lid);
      await tx`
        INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid, lid_checked_at)
        VALUES (${phone}, true, ${chatId}, ${lid}, CASE WHEN ${lid}::text IS NULL THEN NULL ELSE now() END)
        ON CONFLICT (phone) DO UPDATE SET number_exists = true, chat_id = excluded.chat_id, lid = coalesce(excluded.lid, public.wa_contacts.lid), checked_at = now(),
          lid_checked_at = CASE WHEN excluded.lid IS NULL THEN public.wa_contacts.lid_checked_at ELSE now() END`;
    });
    return { kind: "ok", chatId, lid };
  } catch (error) {
    if (error instanceof WahaError) throw error;
    throw new ContactCacheError(error);
  }
}

/** A lid belongs to ONE phone (the column is unique): pointing it at `phone` first clears it from whichever other row held it (a reassigned lid). */
async function clearLidElsewhere(sql: Db, phone: string, lid: string): Promise<void> {
  await sql`UPDATE public.wa_contacts SET lid = NULL WHERE lid = ${lid} AND phone <> ${phone}`;
}

/** The phone a `<lid>@lid` chat belongs to, from what check-exists and earlier lookups taught us, and when the LINK was last confirmed; null when unknown. */
export async function knownLid(sql: Db, lid: string): Promise<{ readonly phone: string; readonly checkedAt: Date } | null> {
  // The lid is unique, so at most one row; the order only makes the choice deterministic should that ever change. A link that was never confirmed (no timestamp) is
  // as old as can be.
  const [row] = await sql<{ phone: string; lid_checked_at: Date | null }[]>`
    SELECT phone, lid_checked_at FROM public.wa_contacts WHERE lid = ${lid} AND number_exists ORDER BY lid_checked_at DESC NULLS LAST, phone LIMIT 1`;
  return row === undefined ? null : { phone: row.phone, checkedAt: row.lid_checked_at ?? new Date(0) };
}

/** The phone a `<lid>@lid` chat belongs to, whatever the age of the link; null when unknown. */
export async function phoneOfKnownLid(sql: Db, lid: string): Promise<string | null> {
  return (await knownLid(sql, lid))?.phone ?? null;
}

/**
 * Remembers that `lid` belongs to `phone`, confirmed now: the next inbound message from it is matched without asking WAHA, for a day. Only called once a message from
 * that lid matched an order or an opener (a stranger's phone is never stored), and the lid leaves any other phone it was on.
 */
export async function rememberLid(sql: Db, phone: string, lid: string): Promise<void> {
  await atomically(sql, async (tx) => {
    await clearLidElsewhere(tx, phone, lid);
    await tx`
      INSERT INTO public.wa_contacts (phone, number_exists, chat_id, lid, lid_checked_at) VALUES (${phone}, true, ${lid}, ${lid}, now())
      ON CONFLICT (phone) DO UPDATE SET lid = excluded.lid, number_exists = true, chat_id = coalesce(public.wa_contacts.chat_id, excluded.chat_id), lid_checked_at = now()`;
  });
}

/** The chat ids a phone is known by, for the history a number has with it: the one built from the phone (for matching only, never for sending) and what WAHA told us. */
export async function knownChatsOf(sql: Db, phone: string, built: string): Promise<string[]> {
  const [row] = await sql<{ chat_id: string | null; lid: string | null }[]>`SELECT chat_id, lid FROM public.wa_contacts WHERE phone = ${phone}`;
  return [...new Set([built, ...(row?.chat_id == null ? [] : [row.chat_id]), ...(row?.lid == null ? [] : [row.lid])])];
}
