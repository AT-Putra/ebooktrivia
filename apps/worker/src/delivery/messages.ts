// What a delivery says (US-025): the Owner's templates (message_templates, edited in the console) rendered with core's
// renderMessage, plus the few fixed sentences from packages/i18n (Bahasa Indonesia; the buyer-facing locale). Every value goes
// through core's channel encoders, so a buyer's name cannot inject markup: HTML-escaped (& < > " ') in e-mail, markup and
// control characters neutralised in WhatsApp, and the angle brackets of a buyer's name dropped from every plain-text part
// (plainValues). {link_trivia} is only ever a login link on the play origin (core checks it).
// The login link and the download URL are bearer credentials: they are rendered into the message and returned to the sender,
// never logged and never stored.
//
//   whatsapp   key `delivery`; the rendered text is the caption of the PDF.
//   e-mail     key `delivery`: subject and HTML body, and a plain-text alternative made from the SAME template (so an Owner's edit reaches
//              both parts). When the PDF is not attached (too large, or refused for its size) a notice and a download link are added
//              to both parts.
import { type CsContact, csLine, escapeHtml, isCsEmail, isCsHours, isIdMobileE164, type MessageValues, NO_CS_CONTACT, OPENER_KEY_PATTERN, OPENER_NO_REPEAT, pickOpenerWording, renderMessage, sapaan } from "@ebooktrivia/core";
import { messages } from "@ebooktrivia/i18n";
import type postgres from "postgres";
import type { Logger } from "../log.ts";

export class TemplateMissing extends Error {
  constructor(key: string, channel: string) {
    super(`message template ${key} (${channel}) is missing`);
    this.name = "TemplateMissing";
  }
}

export type TemplateKey = "delivery";

export interface StoredTemplate {
  readonly subject: string | null;
  readonly body: string;
}

export async function loadTemplate(db: postgres.Sql | postgres.TransactionSql, key: TemplateKey, channel: "whatsapp" | "email"): Promise<StoredTemplate> {
  const [row] = await db<StoredTemplate[]>`SELECT subject, body FROM public.message_templates WHERE key = ${key} AND channel = ${channel} AND locale = 'id'`;
  if (row === undefined) throw new TemplateMissing(key, channel);
  return row;
}

/**
 * The Owner's customer-service contact (public.cs_contact, one row; worker_rw reads whatsapp, email and hours only), as it is NOW: read each time a
 * message is built, so a change in the console is used by the next message without a restart. A value the table's checks would have refused is dropped.
 */
export async function loadCsContact(db: postgres.Sql | postgres.TransactionSql): Promise<CsContact> {
  const [row] = await db<{ whatsapp: string | null; email: string | null; hours: string | null }[]>`SELECT whatsapp, email, hours FROM public.cs_contact LIMIT 1`;
  if (row === undefined) return NO_CS_CONTACT;
  return {
    whatsapp: row.whatsapp !== null && isIdMobileE164(row.whatsapp) ? row.whatsapp : null,
    email: row.email !== null && isCsEmail(row.email) ? row.email : null,
    hours: row.hours !== null && isCsHours(row.hours) ? row.hours : null,
  };
}

/**
 * The CS contact for a message that must go out whatever happens to the read: a failure (the database, a timeout) gives no contact, so the message goes
 * out as it was before the CS line existed, and is reported by a code (cs_contact_read_failed), never with the error text.
 */
export async function loadCsContactOrNone(db: postgres.Sql | postgres.TransactionSql, log: Logger): Promise<CsContact> {
  try {
    return await loadCsContact(db);
  } catch (error) {
    log.warn({ code: "cs_contact_read_failed", errorType: error instanceof Error ? error.name : typeof error }, "the customer-service contact could not be read; the message goes out without it");
    return NO_CS_CONTACT;
  }
}

/** What the delivery templates may say about the order. */
export interface DeliveryValues {
  readonly nama: string;
  readonly judul_ebook: string;
  /** The order code the buyer sees (orders.order_code). */
  readonly order_id: string;
  /** The login link; absent for a message without it. */
  readonly link_trivia?: string;
  /** {cs_whatsapp} and {cs_email} (core csTemplateValues): "" when not set. Absent for a text that does not have them (an opener). */
  readonly cs_whatsapp?: string;
  readonly cs_email?: string;
}

const values = (v: DeliveryValues): MessageValues => ({
  nama: v.nama,
  judul_ebook: v.judul_ebook,
  order_id: v.order_id,
  ...(v.link_trivia === undefined ? {} : { link_trivia: v.link_trivia }),
  ...(v.cs_whatsapp === undefined ? {} : { cs_whatsapp: v.cs_whatsapp }),
  ...(v.cs_email === undefined ? {} : { cs_email: v.cs_email }),
});

/**
 * The values of a plain-text part (a WhatsApp caption, the e-mail's text alternative): a buyer's name or an ebook title without its
 * angle brackets, so no `<tag>` reaches a client that might render the text as markup. (Quotes are inert in plain text; in the HTML
 * part core escapes all five of & < > " '.)
 */
const plainValues = (v: DeliveryValues): MessageValues => ({ ...values(v), nama: v.nama.replace(/[<>]/g, ""), judul_ebook: v.judul_ebook.replace(/[<>]/g, "") });

export function whatsappCaption(template: StoredTemplate, v: DeliveryValues, playOrigin: string): string {
  return renderMessage(template.body, "whatsapp", plainValues(v), { linkOrigin: playOrigin });
}

/**
 * The opener wordings (Owner decision D7): `delivery_opener_N` WhatsApp templates, 3 to 20 of them, added and removed by the Owner in the console. The proactive
 * WhatsApp message to a buyer who has not written first is ONE short text from one of them: text only (no file, no login link: an opener cannot even render
 * {link_trivia}), with the buyer's FIRST name, asking them to reply. The ebook and the link follow the reply.
 *
 * Which wording a given opener uses is decided when it is claimed (pickOpenerVariant, under the pool's lock) and recorded on the opener row (variant_key): a
 * number never repeats a wording it used for its last 3 openers. The text is rendered when it is sent (openerMessage): {sapaan} from the clock in Jakarta and
 * each [[a|b]] choice are drawn then, with the same random source.
 */
export interface OpenerWording extends StoredTemplate {
  readonly key: string;
}

export async function loadOpenerTemplates(db: postgres.Sql | postgres.TransactionSql): Promise<OpenerWording[]> {
  const rows = await db<OpenerWording[]>`
    SELECT key, subject, body FROM public.message_templates
     WHERE key ~ ${OPENER_KEY_PATTERN} AND channel = 'whatsapp' AND locale = 'id' ORDER BY substring(key from '[0-9]+$')::int`;
  if (rows.length === 0) throw new TemplateMissing("delivery_opener", "whatsapp");
  return rows;
}

/**
 * The wording the next opener of this number uses: random among the wordings it did not use for its last 3 openers (core pickOpenerWording), or null when there is
 * no wording at all (the send then fails as a missing template). Call it after the pool's lock is taken (claimSession), in the claim's transaction: a claim that
 * starts later for the same number waits for the lock, and then sees this one's recorded wording. What counts as "used": the opener went out, may have (unknown), or
 * is in flight; a claim that never sent (back to pending) used nothing. Served by delivery_openers_variant_idx (session, time, delivery), read backwards.
 */
export async function pickOpenerVariant(db: postgres.Sql | postgres.TransactionSql, sessionId: string, random: () => number): Promise<string | null> {
  const keys = await db<{ key: string }[]>`
    SELECT key FROM public.message_templates
     WHERE key ~ ${OPENER_KEY_PATTERN} AND channel = 'whatsapp' AND locale = 'id' ORDER BY substring(key from '[0-9]+$')::int`;
  const recent = await db<{ variant_key: string }[]>`
    SELECT variant_key FROM public.delivery_openers
     WHERE session_id = ${sessionId} AND variant_key IS NOT NULL AND (sent_at IS NOT NULL OR status IN ('sending', 'unknown'))
     ORDER BY coalesce(sent_at, updated_at) DESC, delivery_id DESC
     LIMIT ${OPENER_NO_REPEAT}`;
  return pickOpenerWording(keys.map((r) => r.key), recent.map((r) => r.variant_key), random) ?? null;
}

/**
 * The wording an opener was claimed with. When it is gone (the Owner removed it between the claim and the send, or the claim found none) another one is drawn:
 * a removed wording a row mentions never breaks the send. No wording at all is a missing template.
 */
export function openerWording(variants: readonly OpenerWording[], key: string | null, random: () => number): OpenerWording {
  const wording = variants.find((w) => w.key === key) ?? variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))];
  if (wording === undefined) throw new TemplateMissing("delivery_opener", "whatsapp");
  return wording;
}

/** The text of an opener: {nama} is the buyer's first name, {sapaan} the greeting of `now` in Jakarta (or a casual one), each [[a|b]] one of its options. */
export function openerMessage(wording: StoredTemplate, v: { readonly firstName: string; readonly title: string; readonly code: string }, now: Date, random: () => number): string {
  // A buyer without a usable first name is greeted without one ("Halo ," is not a greeting): the name becomes a neutral address.
  const nama = v.firstName === "" ? "Kak" : v.firstName;
  return renderMessage(wording.body, "whatsapp", { ...plainValues({ nama, judul_ebook: v.title, order_id: v.code }), sapaan: sapaan(now, random) }, { random });
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const STATIC_ENTITIES: Readonly<Record<string, string>> = { "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };

/**
 * The plain-text reading of an HTML template's SOURCE (the Owner's own markup, before any buyer value is put in): blocks end a line,
 * a link reads `label (address)`, other tags and the head, styles and comments go, and the few entities the author may have used are
 * decoded. The {variables} stay in it, to be rendered for plain text.
 */
export function htmlSourceToText(source: string): string {
  const text = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_whole, href: string, label: string) => `${label.replace(/<[^>]*>/g, "")} (${href})`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|table|ul|ol|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (entity) => STATIC_ENTITIES[entity] ?? entity);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Puts `fragment` before the closing </body> (the last one, any case), or at the end of a body that has none. */
function insertInBody(html: string, fragment: string): string {
  const close = html.toLowerCase().lastIndexOf("</body>");
  return close < 0 ? html + fragment : html.slice(0, close) + fragment + html.slice(close);
}

export function emailMessage(template: StoredTemplate, v: DeliveryValues, playOrigin: string, downloadUrl?: string): RenderedEmail {
  const m = messages.id.delivery;
  const subject = renderMessage(template.subject ?? "", "email_subject", values(v));
  let html = renderMessage(template.body, "email_html", values(v), { linkOrigin: playOrigin });
  let text = renderMessage(htmlSourceToText(template.body), "whatsapp", plainValues(v), { linkOrigin: playOrigin });
  if (downloadUrl !== undefined) {
    html = insertInBody(html, `<p>${escapeHtml(m.emailDownloadNotice)}</p><p><a href="${escapeHtml(downloadUrl)}">${escapeHtml(m.emailDownloadLabel)}</a></p>`);
    text += `\n\n${m.emailDownloadNotice}\n${downloadUrl}`;
  }
  return { subject, html, text };
}

/**
 * The fixed text replies of the buyer-first path. They say nothing about the order beyond what the sender already wrote, and a reply that
 * speaks about the order's STATE (sent, not paid, refunded, failed) goes only to a sender whose number matched the order's phone:
 *   mismatch       another number than the buyer's: the delivery goes to the buyer's number
 *   generic        a sender we could not confirm and have nothing to give: neutral
 *   already_sent   (verified) the delivery is in flight, sent or unknown
 *   not_paid       (verified) the payment has not been received yet
 *   not_available  (verified) the order is refunded, in review or cancelled: nothing is sent
 *   needs_help     (verified) the delivery failed: the Owner is told
 *
 * Four of them carry a customer-service line when the Owner has set a CS contact (Settings > Customer service), and are exactly as they were when none is
 * set: mismatch and generic get one more sentence after the old text (csMismatch / csGeneric); not_available and needs_help say "hubungi CS kami di {cs}"
 * where they said "hubungi penyelenggara" (csNotAvailable / csNeedsHelp). {cs} is core csLine: the number as plain text in the local format with dashes
 * (no wa.me link: the WAHA anti-blocking guide warns about links in WhatsApp messages), the address, and the hours. The line adds no order and no buyer
 * data, so a stranger learns nothing from it.
 */
export type ReplyKind = "mismatch" | "generic" | "already_sent" | "not_paid" | "not_available" | "needs_help";

export function replyText(kind: ReplyKind, cs: CsContact = NO_CS_CONTACT): string {
  const m = messages.id.delivery;
  const line = csLine(cs);
  const withLine = (sentence: string): string | null => (line === null ? null : sentence.replace("{cs}", () => line));
  switch (kind) {
    case "mismatch": {
      const extra = withLine(m.csMismatch);
      return extra === null ? m.replyMismatch : `${m.replyMismatch} ${extra}`;
    }
    case "generic": {
      const extra = withLine(m.csGeneric);
      return extra === null ? m.replyGeneric : `${m.replyGeneric} ${extra}`;
    }
    case "already_sent":
      return m.replyAlreadySent;
    case "not_paid":
      return m.replyNotPaid;
    case "not_available":
      return withLine(m.csNotAvailable) ?? m.replyNotAvailable;
    case "needs_help":
      return withLine(m.csNeedsHelp) ?? m.replyNeedsHelp;
  }
}

/** The caption of the PDF an unconfirmed @lid sender gets (Owner decision D6): no name, no order, no link. */
export const pdfOnlyCaption = (): string => messages.id.delivery.replyPdfOnly;
