// Message templates (AC-A10; US-017): WhatsApp and e-mail texts in Bahasa Indonesia, editable by
// Staff (message_template.edit), with a preview and a test-send (message_template.test_send).
//
//   - Each template key allows a fixed set of variables; a template is checked with the renderer the
//     worker uses (@ebooktrivia/core renderMessageRedacted), so one the worker would refuse cannot be
//     saved. The OTP template must contain {kode_otp}.
//   - Opener wordings (the short WhatsApp text that asks a buyer to reply): `delivery_opener_N`, 3 to 20 of
//     them. Staff add one (the next N) and remove one here, under one lock so the limits hold for parallel
//     requests; both are audited. Only these keys can be added or removed; every other template can only
//     be edited. {sapaan} (a greeting for the time of day in Jakarta) is for openers.
//   - Choices: `[[Halo|Hai]]` in a WhatsApp template is replaced at send time by one of its 2 to 5 options
//     (core template.ts); the length limit counts the longest option of each. E-mail refuses `[[` and `]]`
//     (an option is free text and could break out of an HTML tag).
//   - Preview: the stored or edited template rendered with sample values, the sample buyer name
//     taken from the form. Values are encoded by core (WhatsApp markup neutralised, HTML escaped);
//     {kode_otp} and {link_trivia} show as [kode_otp] / [link_trivia]; a choice shows one pick, and a note
//     says it is random. The console shows a WhatsApp
//     preview as text and an e-mail preview inside a sandboxed iframe (no scripts, no same origin).
//   - Test-send: the admin app NEVER sends. It writes a template_test_sends row and an outbox row
//     (topic template.test_send, payload { test_send_id }) in one audited transaction; the worker
//     sends the stored template rendered with the same redacted sample values (never a real code
//     or link) and records sent / failed. The button is not a relay (security review US-017 S4):
//     an e-mail test goes to the requesting admin's own login address, a WhatsApp test only to a
//     number on the Owner-managed test-recipient list (at most TEST_RECIPIENT_MAX, audited), and
//     test-sends are capped per admin (hour, day) and in total per hour, under one advisory lock so
//     parallel requests cannot exceed a cap. The recipient is PII: the audit log gets a reference.
import { randomUUID } from "node:crypto";
import {
  longestChoiceExpansion,
  type MessageVariable,
  normalizeIdMobile,
  renderMessageRedacted,
  TEST_SEND_SAMPLE_VALUES,
  TEST_SEND_TOPIC,
  TemplateError,
  type TemplateErrorCode,
} from "@ebooktrivia/core";
import { type FieldKind, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import { FIELD_MAX_CODE_POINTS, InvalidInput, multiLine, singleLine } from "./fields.ts";

export { TEST_SEND_TOPIC };
export const TEST_SEND_CAPS = { perAdminHour: 10, perAdminDay: 30, allAdminsHour: 30 } as const;
export const TEST_SEND_HOURLY_CAP = TEST_SEND_CAPS.perAdminHour;
export const TEST_RECIPIENT_MAX = 5;

export type TemplateChannel = "whatsapp" | "email";

interface CatalogEntry {
  readonly label: string;
  readonly variables: readonly MessageVariable[];
  readonly required: readonly MessageVariable[];
}

const FIXED_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  delivery: { label: "Ebook delivery (file + trivia link)", variables: ["nama", "judul_ebook", "order_id", "link_trivia"], required: [] },
  otp: { label: "Trivia login code", variables: ["kode_otp"], required: ["kode_otp"] },
};

// The short opener (Owner decision D7): the one WhatsApp message to a buyer who has not written first. Text only: no file and no login link (it cannot have
// {link_trivia}); {nama} is the buyer's FIRST name; {sapaan} a greeting for the time of day; it asks the buyer to reply, and the ebook follows the reply. The worker
// picks one wording at random for each opener (never one the number used for its last 3).
const OPENER_VARIABLES: readonly MessageVariable[] = ["nama", "judul_ebook", "order_id", "sapaan"];
const OPENER_KEY = /^delivery_opener_([1-9][0-9]*)$/;
const OPENER_PREFIX = "delivery_opener_";
export const OPENER_MIN_WORDINGS = 3;
export const OPENER_MAX_WORDINGS = 20;

/** The template keys the console knows: the fixed ones and any `delivery_opener_N`. Undefined for anything else. */
export function templateEntry(key: string): CatalogEntry | undefined {
  const opener = OPENER_KEY.exec(key);
  if (opener !== null) return { label: `WhatsApp opener, wording ${opener[1] ?? ""} (short, asks the buyer to reply; no file, no link)`, variables: OPENER_VARIABLES, required: [] };
  return FIXED_CATALOG[key];
}

export const isOpenerKey = (key: string): boolean => OPENER_KEY.test(key);

/** Sample values for previews and test-sends (core, shared with the worker); the buyer name may come from the preview form. */
export const SAMPLE_VALUES = TEST_SEND_SAMPLE_VALUES;

const TEMPLATE_FIELDS: Readonly<Record<string, FieldKind>> = { subject: "value", body: "value" };
const BODY_MAX: Readonly<Record<TemplateChannel, number>> = { whatsapp: 4000, email: 50_000 };
const SIZE_MESSAGE: Readonly<Record<TemplateChannel, string>> = {
  whatsapp: `The text is 1 to ${BODY_MAX.whatsapp.toLocaleString("en-US")} characters (a [[...]] choice counts as its longest option).`,
  email: `The text is 1 to ${BODY_MAX.email.toLocaleString("en-US")} characters.`,
};

const ERROR_MESSAGES: Readonly<Partial<Record<TemplateErrorCode, string>>> = {
  unknown_variable: "uses a variable that does not exist",
  missing_value: "uses a variable this template cannot have",
  malformed_token: "has a { or } that is not part of a variable (write variables like {nama})",
  unsafe_html_context: "puts a variable inside an HTML tag, attribute, comment, script or style (only href=\"{link_trivia}\" is allowed)",
};

function allowedValues(key: string, buyerName?: string): Partial<Record<MessageVariable, string>> {
  const entry = templateEntry(key);
  if (entry === undefined) throw new InvalidInput("Unknown template.");
  const values: Partial<Record<MessageVariable, string>> = {};
  for (const name of entry.variables) values[name] = name === "nama" && buyerName !== undefined ? buyerName : SAMPLE_VALUES[name];
  return values;
}

function render(text: string, channel: "whatsapp" | "email_html" | "email_subject", values: Partial<Record<MessageVariable, string>>, label: string): string {
  try {
    return renderMessageRedacted(text, channel, values);
  } catch (error) {
    // A choice says what is wrong with it (core's message is fixed text, never a piece of the template).
    if (error instanceof TemplateError && error.code === "invalid_choice") throw new InvalidInput(`The ${label} is not valid: ${error.message}.`);
    if (error instanceof TemplateError) throw new InvalidInput(`The ${label} ${ERROR_MESSAGES[error.code] ?? "is not valid"}.`);
    throw error;
  }
}

export interface TemplateText {
  readonly subject: string | null;
  readonly body: string;
}

/** Parses and checks an edited template; returns what to store. */
export function parseTemplate(key: string, channel: TemplateChannel, raw: { readonly subject: string; readonly body: string }): TemplateText {
  const entry = templateEntry(key);
  if (entry === undefined) throw new InvalidInput("Unknown template.");
  // A WhatsApp text may hold [[a|b]] choices: its limit is on the text with each choice at its longest option (checked below), so the raw text only has the form's own bound.
  const body = multiLine(raw.body, SIZE_MESSAGE[channel], { max: channel === "email" ? BODY_MAX.email : FIELD_MAX_CODE_POINTS });
  const subject = channel === "email" ? singleLine(raw.subject, "Enter a subject (up to 200 characters).", { max: 200 }) : null;
  const values = allowedValues(key);
  if (subject !== null) render(subject, "email_subject", values, "subject");
  render(body, channel === "email" ? "email_html" : "whatsapp", values, "text");
  // The choices are well formed (rendered above): the longest text the template can come out as must fit WhatsApp's limit.
  if (channel === "whatsapp" && Array.from(longestChoiceExpansion(body)).length > BODY_MAX.whatsapp) throw new InvalidInput(SIZE_MESSAGE.whatsapp);
  // The redacted render does not need values for {kode_otp} / {link_trivia}, so check every
  // variable against the key's list explicitly (a login link must not reach the no-link template).
  for (const text of [subject ?? "", body]) {
    for (const [, name] of text.matchAll(/\{([A-Za-z0-9_.:-]+)\}/g)) {
      if (!(entry.variables as readonly string[]).includes(name ?? "")) throw new InvalidInput(`The text ${ERROR_MESSAGES.missing_value ?? ""}: {${name ?? ""}}.`);
    }
  }
  for (const name of entry.required) if (!body.includes(`{${name}}`)) throw new InvalidInput(`This template must contain {${name}}.`);
  return { subject, body };
}

export interface Preview {
  readonly channel: TemplateChannel;
  readonly subject: string | null;
  /** WhatsApp: plain text. E-mail: an HTML document for a sandboxed iframe's srcdoc. */
  readonly body: string;
  /** Said under the preview when part of it is random or time-bound ([[a|b]] choices, {sapaan}); null otherwise. */
  readonly note: string | null;
}

const CHOICE_NOTE = "Each [[...]] choice shows one of its options, picked at random for this preview. Every message gets its own pick.";
const SAPAAN_NOTE = "{sapaan} shows a sample greeting here. Real messages use the time of day in Jakarta (WIB), and one message in three a casual Halo or Hai instead.";

/** The preview of an (edited) template with the sample buyer name. */
export function preview(key: string, channel: TemplateChannel, text: TemplateText, sampleName: string): Preview {
  const name = singleLine(sampleName === "" ? SAMPLE_VALUES.nama : sampleName, "The sample name is up to 100 characters.", { max: 100 });
  const values = allowedValues(key, name);
  if (channel === "whatsapp") {
    const notes = [text.body.includes("[[") ? CHOICE_NOTE : "", text.body.includes("{sapaan}") ? SAPAAN_NOTE : ""].filter((note) => note !== "");
    return { channel, subject: null, body: render(text.body, "whatsapp", values, "text"), note: notes.length === 0 ? null : notes.join(" ") };
  }
  const html = render(text.body, "email_html", values, "text");
  return {
    channel,
    subject: render(text.subject ?? "", "email_subject", values, "subject"),
    note: null,
    // Its own CSP as well (the iframe also has an empty sandbox): nothing loads, nothing runs.
    body: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"></head><body>${html}</body></html>`,
  };
}

export async function updateTemplate(sql: Sql, id: string, text: TemplateText): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const [before] = await tx<{ subject: string | null; body: string }[]>`SELECT subject, body FROM public.message_templates WHERE id = ${id} FOR UPDATE`;
    if (before === undefined) throw new InvalidInput("This template no longer exists.");
    await tx`UPDATE public.message_templates SET subject = ${text.subject}, body = ${text.body}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({ action: "message_template.update", entityType: "message_template", entityId: id, fields: TEMPLATE_FIELDS, before, after: { subject: text.subject, body: text.body } });
  });
}

const OPENER_FIELDS: Readonly<Record<string, FieldKind>> = { key: "value", body: "value" };
const OPENER_LOCK = "opener_wordings";

/**
 * Adds an opener wording as the next `delivery_opener_N` (one more than the highest N there is), checked like an edit. At most OPENER_MAX_WORDINGS: the count is
 * taken under a lock that remove also takes, so parallel requests cannot pass the limit. Returns the new key.
 */
export function addOpenerWording(sql: Sql, rawBody: string): Promise<string> {
  return auditedChange(
    sql,
    async (tx, audit) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${OPENER_LOCK}, 0))`;
      const keys = await tx<{ key: string }[]>`SELECT key FROM public.message_templates WHERE key ~ '^delivery_opener_[1-9][0-9]*$' AND channel = 'whatsapp' AND locale = 'id'`;
      if (keys.length >= OPENER_MAX_WORDINGS) throw new InvalidInput(`There are already ${String(OPENER_MAX_WORDINGS)} opener wordings, the most there can be. Remove one first.`);
      const next = Math.max(0, ...keys.map((k) => Number(k.key.slice(OPENER_PREFIX.length)))) + 1;
      const key = `${OPENER_PREFIX}${String(next)}`;
      const text = parseTemplate(key, "whatsapp", { subject: "", body: rawBody });
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.message_templates (key, channel, locale, subject, body) VALUES (${key}, 'whatsapp', 'id', NULL, ${text.body}) RETURNING id`;
      audit({ action: "message_template.create", entityType: "message_template", entityId: row?.id ?? null, fields: OPENER_FIELDS, after: { key, body: text.body } });
      return key;
    },
    { "23505": CONCURRENT_SAVE },
  );
}

/**
 * Removes one opener wording; at least OPENER_MIN_WORDINGS stay (counted under the same lock). Opener rows that mention the removed key keep it as plain text
 * (delivery_openers.variant_key has no foreign key), and the worker draws another wording for an opener that was claimed with it. Its test-send history goes with it.
 */
export function removeOpenerWording(sql: Sql, id: string): Promise<void> {
  return auditedChange(sql, async (tx, audit) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${OPENER_LOCK}, 0))`;
    const [row] = await tx<{ key: string; body: string }[]>`SELECT key, body FROM public.message_templates WHERE id = ${id} FOR UPDATE`;
    if (row === undefined) throw new InvalidInput("This wording no longer exists.");
    if (!isOpenerKey(row.key)) throw new InvalidInput("Only opener wordings can be removed.");
    const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.message_templates WHERE key ~ '^delivery_opener_[1-9][0-9]*$' AND channel = 'whatsapp' AND locale = 'id'`;
    if ((count?.n ?? 0) <= OPENER_MIN_WORDINGS) throw new InvalidInput(`Keep at least ${String(OPENER_MIN_WORDINGS)} opener wordings: add another before removing this one.`);
    await tx`DELETE FROM public.message_templates WHERE id = ${id}`;
    audit({ action: "message_template.delete", entityType: "message_template", entityId: id, fields: OPENER_FIELDS, before: { key: row.key, body: row.body }, after: null });
  });
}

export interface TestSendRequest {
  readonly templateId: string;
  /** WhatsApp only: a test_recipients id. E-mail always goes to the requester's login address. */
  readonly testRecipientId: string | null;
  readonly wahaSessionId: string | null;
}

const TEST_RECIPIENT_FIELDS: Readonly<Record<string, FieldKind>> = { phone: "pii", label: "value" };

/** Owner: adds a WhatsApp test recipient (an Indonesian mobile number and a label); at most TEST_RECIPIENT_MAX. */
export async function addTestRecipient(sql: Sql, adminUserId: string, input: { readonly phone: string; readonly label: string }): Promise<void> {
  const phone = normalizeIdMobile(input.phone);
  if (!phone.ok) throw new InvalidInput("Enter an Indonesian mobile number, e.g. 0812 3456 7890.");
  const label = singleLine(input.label, "Enter a label (up to 60 characters), e.g. Owner phone.", { max: 60 });
  await auditedChange(
    sql,
    async (tx, audit) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('test_recipients', 0))`;
      const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.test_recipients`;
      if ((count?.n ?? 0) >= TEST_RECIPIENT_MAX) throw new InvalidInput(`At most ${String(TEST_RECIPIENT_MAX)} test numbers. Remove one first.`);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.test_recipients (phone, label, created_by_admin_user_id) VALUES (${phone.e164}, ${label}, ${adminUserId}) RETURNING id`;
      audit({ action: "test_recipient.add", entityType: "test_recipient", entityId: row?.id ?? null, fields: TEST_RECIPIENT_FIELDS, after: { phone: phone.e164, label } });
    },
    { "23505": "This number is already a test recipient." },
  );
}

export async function removeTestRecipient(sql: Sql, id: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const [row] = await tx<{ phone: string; label: string }[]>`DELETE FROM public.test_recipients WHERE id = ${id} RETURNING phone, label`;
    if (row === undefined) throw new InvalidInput("This test recipient no longer exists.");
    audit({ action: "test_recipient.remove", entityType: "test_recipient", entityId: id, fields: TEST_RECIPIENT_FIELDS, before: row, after: null });
  });
}

/** "+62 812-****-7890": enough to tell numbers apart in the console. */
export const maskPhone = (e164: string): string => `${e164.slice(0, 3)} ${e164.slice(3, 6)}-****-${e164.slice(-4)}`;

export async function listTestRecipients(sql: Sql): Promise<{ readonly id: string; readonly label: string; readonly masked: string }[]> {
  const rows = await sql<{ id: string; phone: string; label: string }[]>`SELECT id, phone, label FROM public.test_recipients ORDER BY label`;
  return rows.map((r) => ({ id: r.id, label: r.label, masked: maskPhone(r.phone) }));
}

/** Writes the test-send and its outbox row (the worker job); returns the test-send id. */
export async function requestTestSend(sql: Sql, adminUserId: string, request: TestSendRequest): Promise<string> {
  return withAudit(sql, async (tx, audit) => {
    const [template] = await tx<{ key: string; channel: TemplateChannel }[]>`SELECT key, channel FROM public.message_templates WHERE id = ${request.templateId}`;
    if (template === undefined) throw new InvalidInput("This template no longer exists.");
    let recipient: string;
    if (template.channel === "whatsapp") {
      if (request.wahaSessionId === null) throw new InvalidInput("Choose the WhatsApp session to send from.");
      const [session] = await tx`
        SELECT 1 FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
         WHERE s.id = ${request.wahaSessionId} AND s.active AND w.active`;
      if (session === undefined) throw new InvalidInput("Choose an active WhatsApp session.");
      if (request.testRecipientId === null) throw new InvalidInput("Choose a test number (the Owner manages the list).");
      const [to] = await tx<{ phone: string }[]>`SELECT phone FROM public.test_recipients WHERE id = ${request.testRecipientId}`;
      if (to === undefined) throw new InvalidInput("Choose a number from the test-recipient list.");
      recipient = to.phone;
    } else {
      const [me] = await tx<{ email: string }[]>`SELECT email FROM admin_auth."user" WHERE id = ${adminUserId}`;
      if (me === undefined) throw new InvalidInput("Your account has no e-mail address.");
      recipient = me.email;
    }
    // One lock for every test-send, so no cap can be exceeded by parallel requests.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('template_test_send', 0))`;
    const [counts] = await tx<{ mine_hour: number; mine_day: number; all_hour: number }[]>`
      SELECT count(*) FILTER (WHERE requested_by_admin_user_id = ${adminUserId} AND created_at > clock_timestamp() - interval '1 hour')::int AS mine_hour,
             count(*) FILTER (WHERE requested_by_admin_user_id = ${adminUserId})::int AS mine_day,
             count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour')::int AS all_hour
        FROM public.template_test_sends WHERE created_at > clock_timestamp() - interval '1 day'`;
    if ((counts?.mine_hour ?? 0) >= TEST_SEND_CAPS.perAdminHour) throw new InvalidInput(`At most ${String(TEST_SEND_CAPS.perAdminHour)} test messages per hour. Try again later.`);
    if ((counts?.mine_day ?? 0) >= TEST_SEND_CAPS.perAdminDay) throw new InvalidInput(`At most ${String(TEST_SEND_CAPS.perAdminDay)} test messages per day. Try again tomorrow.`);
    if ((counts?.all_hour ?? 0) >= TEST_SEND_CAPS.allAdminsHour) throw new InvalidInput("The console has sent its hourly maximum of test messages. Try again later.");
    const id = randomUUID();
    const outboxId = randomUUID();
    await tx`
      INSERT INTO public.template_test_sends (id, template_id, channel, recipient, waha_session_id, requested_by_admin_user_id)
      VALUES (${id}, ${request.templateId}, ${template.channel}, ${recipient},
              ${template.channel === "whatsapp" ? request.wahaSessionId : null}, ${adminUserId})`;
    await tx`
      INSERT INTO public.outbox (id, topic, dedupe_key, payload)
      VALUES (${outboxId}, ${TEST_SEND_TOPIC}, ${`${TEST_SEND_TOPIC}:${id}`}, ${tx.json({ test_send_id: id })})`;
    audit({
      action: "message_template.test_send",
      entityType: "template_test_send",
      entityId: id,
      fields: { recipient: "pii" },
      after: { recipient },
      facts: { template_id: request.templateId, template_key: template.key, channel: template.channel, waha_session_id: request.wahaSessionId, test_recipient_id: request.testRecipientId, outbox_id: outboxId },
    });
    return id;
  });
}

export interface TemplateRow {
  readonly id: string;
  readonly key: string;
  readonly channel: TemplateChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly updatedAt: Date;
  readonly recentTests: readonly { readonly id: string; readonly status: string; readonly error: string | null; readonly createdAt: Date }[];
}

export async function listTemplates(sql: Sql): Promise<TemplateRow[]> {
  const rows = await sql<Omit<TemplateRow, "recentTests">[]>`
    SELECT id, key, channel, subject, body, updated_at AS "updatedAt" FROM public.message_templates
     WHERE locale = 'id'
     ORDER BY regexp_replace(key, '[0-9]+$', ''), coalesce(substring(key from '[0-9]+$')::int, 0), channel`;
  const tests = await sql<{ id: string; template_id: string; status: string; error: string | null; created_at: Date }[]>`
    SELECT id, template_id, status, error, created_at FROM (
      SELECT t.*, row_number() OVER (PARTITION BY template_id ORDER BY created_at DESC) AS n FROM public.template_test_sends t) x
     WHERE n <= 3 ORDER BY created_at DESC`;
  return rows
    .filter((r) => templateEntry(r.key) !== undefined)
    .map((r) => ({
      ...r,
      recentTests: tests.filter((t) => t.template_id === r.id).map((t) => ({ id: t.id, status: t.status, error: t.error, createdAt: t.created_at })),
    }));
}
