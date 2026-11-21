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
import { escapeHtml, type MessageValues, renderMessage } from "@ebooktrivia/core";
import { messages } from "@ebooktrivia/i18n";
import type postgres from "postgres";

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

/** What the delivery templates may say about the order. */
export interface DeliveryValues {
  readonly nama: string;
  readonly judul_ebook: string;
  /** The order code the buyer sees (orders.order_code). */
  readonly order_id: string;
  /** The login link; absent for a message without it. */
  readonly link_trivia?: string;
}

const values = (v: DeliveryValues): MessageValues => ({ nama: v.nama, judul_ebook: v.judul_ebook, order_id: v.order_id, ...(v.link_trivia === undefined ? {} : { link_trivia: v.link_trivia }) });

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
 * The opener variants (Owner decision D7): `delivery_opener_*` WhatsApp templates. The proactive WhatsApp message to a buyer who has not written first is
 * ONE short text from one of them, picked at random for each buyer: text only (no file, no login link: an opener cannot even render {link_trivia}), with the
 * buyer's FIRST name, asking them to reply. The ebook and the link follow the reply.
 */
export async function loadOpenerTemplates(db: postgres.Sql | postgres.TransactionSql): Promise<StoredTemplate[]> {
  const rows = await db<StoredTemplate[]>`
    SELECT subject, body FROM public.message_templates WHERE key LIKE 'delivery\_opener\_%' AND channel = 'whatsapp' AND locale = 'id' ORDER BY key`;
  if (rows.length === 0) throw new TemplateMissing("delivery_opener", "whatsapp");
  return rows;
}

export function openerMessage(variants: readonly StoredTemplate[], v: { readonly firstName: string; readonly title: string; readonly code: string }, random: () => number): string {
  const variant = variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))];
  if (variant === undefined) throw new TemplateMissing("delivery_opener", "whatsapp");
  // A buyer without a usable first name is greeted without one ("Halo ," is not a greeting): the name becomes a neutral address.
  const nama = v.firstName === "" ? "Kak" : v.firstName;
  return renderMessage(variant.body, "whatsapp", plainValues({ nama, judul_ebook: v.title, order_id: v.code }), {});
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
 */
export type ReplyKind = "mismatch" | "generic" | "already_sent" | "not_paid" | "not_available" | "needs_help";

export function replyText(kind: ReplyKind): string {
  const m = messages.id.delivery;
  switch (kind) {
    case "mismatch":
      return m.replyMismatch;
    case "generic":
      return m.replyGeneric;
    case "already_sent":
      return m.replyAlreadySent;
    case "not_paid":
      return m.replyNotPaid;
    case "not_available":
      return m.replyNotAvailable;
    case "needs_help":
      return m.replyNeedsHelp;
  }
}

/** The caption of the PDF an unconfirmed @lid sender gets (Owner decision D6): no name, no order, no link. */
export const pdfOnlyCaption = (): string => messages.id.delivery.replyPdfOnly;
