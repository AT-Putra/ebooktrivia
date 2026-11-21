// The magic_link.resend consumer (US-027, Owner decision: "send my login link again" on the play login page, the
// recovery path for a player whose code checks an attacker used up). apps/public answers every phone alike and,
// after the answer, calls enqueue_magic_link_resend (sql/functions.sql), which writes this job only for a player
// who may log in (payload {player_id}; at most 3 a day per player). Per job:
//   1. the player is read again (not anonymized, eligible for a program: the issue_magic_link rule); a player who
//      may no longer log in is DROPPED (processed, nothing sent);
//   2. per channel the player can be reached on (WhatsApp: the phone; e-mail: a stored address), a fresh token
//      (core issueMagicLink, 32 random bytes) is SENT first, as a link (core magicLinkUrl, the token in the
//      fragment of play.<DOMAIN>/masuk) through the MagicLinkSender port, and only once the send succeeded is it
//      registered with public.issue_magic_link, which REPLACES the live link of that channel: the link sent before
//      stops working then, and only then (code review MINOR-10). A link clicked in the few milliseconds between its
//      send and its registration is refused once, like any unknown link; a registration that fails after the send
//      fails the job (its retry sends another link);
//   3. a channel whose send fails is logged by its code and given up, its previous link untouched, as long as
//      another channel got through; when every channel failed the job fails and is retried (at-least-once: a
//      retry after a crash sends a NEW link, and the one sent before the crash may never work). A send that MAY
//      have gone out (WhatsApp's or SMTP's maybe_sent) counts as sent: its link is registered and never sent again
//      (the pool's rule, US-025), so a message that arrived holds a link that works and the player gets no second one;
//   4. a contact at its limit (the pool's 4 an hour or its 30 to 60 s gap) is not written to: that channel waits
//      until the contact may be written to again (OutboxDefer: the job comes back then WITHOUT using up an attempt,
//      and only the channels still to send), at most MAGIC_LINK_RESEND_MAX_DEFERRALS times.
// The token and the link are never logged, nor any phone, address or player id; log lines carry the outbox id,
// the outcome and the count of channels sent.
// The sender is one port. The production sender (createMagicLinkSender) is US-025's: WhatsApp out of the delivery
// pool (delivery/pool-sender.ts: a number picked by weight under its caps and health, the human-like sequence, a
// check-exists lookup before the first message to the phone, no number WhatsApp holds back from new contacts, the
// per-contact limits of 4 an hour and the 30 to 60 s gap, recorded in the send ledger as kind `otp`, a login message
// to a contact who has not written to us), and e-mail through the SMTP settings (delivery/access.ts createMailSender).
// A contact at its limit is not sent to: that channel waits for it (step 4).
import { isIdMobileE164, issueMagicLink, isUuid, type MagicLinkChannel, magicLinkUrl } from "@ebooktrivia/core";
import { SmtpError } from "@ebooktrivia/adapters";
import { openerFromEnv } from "@ebooktrivia/crypto";
import { messages } from "@ebooktrivia/i18n";
import postgres from "postgres";
import { createMailSender, createWahaAccess } from "./delivery/access.ts";
import { loadWarningFactors } from "./delivery/config.ts";
import { createPoolSender, PoolSendError } from "./delivery/pool-sender.ts";
import { MailAccessError, type MailSender, type WahaAccess } from "./delivery/ports.ts";
import { type Env, optional } from "./env.ts";
import type { Logger } from "./log.ts";
import { type OutboxConsumer, OutboxDefer } from "./outbox-consumer.ts";
import { OTP_WAHA_TIMEOUT_MS } from "./otp-senders.ts";
import { ACCESS_CODES } from "./test-send-senders.ts";
import type { WorkerConfig } from "./worker-config.ts";

export const MAGIC_LINK_RESEND_TOPIC = "magic_link.resend";
/** 5 claims with the outbox backoff span about 8 minutes: a link that long late is still useful (72 h life). */
export const MAGIC_LINK_RESEND_MAX_ATTEMPTS = 5;
/** Per-phase SMTP timeout of a resend (a short message, no attachment). */
export const MAGIC_LINK_SMTP_TIMEOUT_MS = 15_000;
/**
 * The claim covers the WhatsApp send (up to 3 numbers, each a lookup, the human-like pauses and a request of
 * OTP_WAHA_TIMEOUT_MS, plus the contact's gap) and then the e-mail's SMTP phases, with a margin.
 */
const LEASE_MS = 180_000;
/** A job waits for a contact at its limit at most this many times (each without using an attempt); then that channel fails like any other. */
export const MAGIC_LINK_RESEND_MAX_DEFERRALS = 6;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,24}$/;

export interface MagicLinkMessage {
  readonly channel: MagicLinkChannel;
  /** The E.164 phone (WhatsApp) or the e-mail address. */
  readonly to: string;
  /** E-mail only. */
  readonly subject: string;
  /** Contains the link: never log it. */
  readonly text: string;
  readonly html: string;
}

/** Sends one login link. Throws MagicLinkSendError (a code only) on failure. */
export interface MagicLinkSender {
  send(message: MagicLinkMessage, signal: AbortSignal): Promise<void>;
}

/** A send failure: `code` only (^[a-z_]{1,64}$), never the recipient or the text. */
export class MagicLinkSendError extends Error {
  readonly code: string;
  /** The message MAY have gone out (a timeout after the request left): its link is registered, never sent again. */
  readonly maybeSent: boolean;
  /** contact_limit: when the contact may be written to again, when known. */
  readonly retryAt: Date | undefined;
  constructor(code: string, options: { readonly maybeSent?: boolean; readonly retryAt?: Date } = {}) {
    const safe = /^[a-z_]{1,64}$/.test(code) ? code : "send_failed";
    super(`magic link send failed: ${safe}`);
    this.name = "MagicLinkSendError";
    this.code = safe;
    this.maybeSent = options.maybeSent === true;
    this.retryAt = options.retryAt;
  }
}

export interface MagicLinkResendPort {
  /** https://play.<DOMAIN>: the links' origin. */
  readonly playOrigin: string;
  /** The sender, given the worker's pool and logger. */
  readonly sender: (sql: postgres.Sql, log: Logger) => MagicLinkSender;
}

const COPY = messages.id.magicLinkMessage;
const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The message of a resent link, from packages/i18n (Bahasa Indonesia; the brand is common.appName): the link rides
 * in the text and, for e-mail, the HTML.
 */
export function magicLinkMessage(url: string): Pick<MagicLinkMessage, "subject" | "text" | "html"> {
  const appName = messages.id.common.appName;
  const html = [
    `<p>${escapeHtml(fill(COPY.htmlIntro, { appName }))}</p>`,
    `<p><a href="${escapeHtml(url)}">${escapeHtml(fill(COPY.htmlLink, { appName }))}</a></p>`,
    `<p>${escapeHtml(fill(COPY.htmlNote, { appName }))}</p>`,
  ].join("\n");
  return { subject: fill(COPY.subject, { appName }), text: fill(COPY.text, { appName, url }), html };
}

export interface MagicLinkResendDeps {
  readonly sql: postgres.Sql;
  readonly playOrigin: string;
  readonly sender: MagicLinkSender;
  readonly log: Logger;
}

export function createMagicLinkResendConsumer(deps: MagicLinkResendDeps): OutboxConsumer {
  return {
    topic: MAGIC_LINK_RESEND_TOPIC,
    leaseMs: LEASE_MS,
    maxAttempts: MAGIC_LINK_RESEND_MAX_ATTEMPTS,
    async perform(row, signal) {
      const playerId = (row.payload as Record<string, unknown>)["player_id"];
      if (!isUuid(playerId)) {
        deps.log.warn({ outboxId: row.id, reason: "bad_payload" }, "magic link resend dropped");
        return undefined;
      }
      const [player] = await deps.sql<{ phone: string | null; email: string | null }[]>`
        SELECT p.phone, p.email FROM public.players p
         WHERE p.id = ${playerId} AND p.anonymized_at IS NULL AND p.phone IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.player_programs pp WHERE pp.player_id = p.id AND pp.eligible)`;
      if (player === undefined) {
        deps.log.info({ outboxId: row.id, reason: "may_not_log_in" }, "magic link resend dropped");
        return undefined;
      }
      // A job a contact limit deferred carries the channels still to send (the others went out the first time).
      const payload = row.payload as Record<string, unknown>;
      const left = Array.isArray(payload["channels"]) ? payload["channels"].filter((c): c is MagicLinkChannel => c === "whatsapp" || c === "email") : undefined;
      const targets: { readonly channel: MagicLinkChannel; readonly to: string }[] = [
        ...(player.phone !== null && isIdMobileE164(player.phone) ? [{ channel: "whatsapp" as const, to: player.phone }] : []),
        ...(player.email !== null && EMAIL.test(player.email) ? [{ channel: "email" as const, to: player.email }] : []),
      ].filter((t) => left === undefined || left.includes(t.channel));
      const failures: { readonly channel: MagicLinkChannel; readonly code: string }[] = [];
      const waiting: MagicLinkChannel[] = [];
      let waitUntil = 0;
      let sent = 0;
      for (const target of targets) {
        const link = issueMagicLink({ channel: target.channel });
        try {
          await deps.sender.send({ channel: target.channel, to: target.to, ...magicLinkMessage(magicLinkUrl(deps.playOrigin, target.channel, link.token)) }, signal);
        } catch (error) {
          const failure = error instanceof MagicLinkSendError ? error : new MagicLinkSendError("send_failed");
          if (failure.maybeSent) {
            // It may have arrived: its link must work (the pool's rule: never sent again, US-025). Registered like a sent one.
            deps.log.warn({ outboxId: row.id, channel: target.channel, code: failure.code }, "magic link resend may have gone out; its link is kept");
          } else if (failure.code === "contact_limit" && failure.retryAt !== undefined && row.deferrals < MAGIC_LINK_RESEND_MAX_DEFERRALS) {
            // The contact may not be written to yet: this channel waits for it, without using up an attempt. Nothing registered.
            waiting.push(target.channel);
            waitUntil = Math.max(waitUntil, failure.retryAt.getTime());
            continue;
          } else {
            // Nothing registered: the channel's previous link keeps working.
            failures.push({ channel: target.channel, code: failure.code });
            deps.log.warn({ outboxId: row.id, channel: target.channel, code: failure.code }, "magic link resend channel failed");
            continue;
          }
        }
        try {
          await deps.sql`SELECT public.issue_magic_link(${playerId}, ${target.channel}, ${link.tokenHash})`;
          sent++;
        } catch (error) {
          // ET121: the player may no longer log in (refunded meanwhile): the link just sent never works.
          if (error instanceof postgres.PostgresError && error.code === "ET121") {
            deps.log.info({ outboxId: row.id, reason: "may_not_log_in" }, "magic link resend dropped");
            return undefined;
          }
          throw error;
        }
      }
      if (waiting.length > 0) {
        // The waiting channels come back when the contact may be written to (with the failed ones too when nothing went out).
        const channels = sent === 0 ? [...waiting, ...failures.map((f) => f.channel)] : waiting;
        deps.log.info({ outboxId: row.id, outcome: "waiting_for_contact", channels: sent }, "magic link resend waits for the contact");
        throw new OutboxDefer("contact_limit", new Date(waitUntil), { channels });
      }
      if (sent === 0 && failures.length > 0) throw new MagicLinkSendError(failures[0]?.code ?? "send_failed");
      deps.log.info({ outboxId: row.id, outcome: sent > 0 ? "sent" : "no_channel", channels: sent }, "magic link resent");
      return undefined;
    },
  };
}

/** A pool refusal as a code (the OTP sender's codes, otp-senders.ts). */
function poolCode(error: PoolSendError): string {
  if (error.code !== "failed" && error.code !== "maybe_sent") return error.code;
  const refusal = error.refusal;
  if (refusal === undefined) return error.code === "maybe_sent" ? "waha_maybe_sent" : "send_failed";
  return refusal.kind === "access" ? ACCESS_CODES[refusal.code] : `waha_${refusal.code}`;
}

/** The production sender (see the top): WhatsApp out of US-025's pool, e-mail through its SMTP path. */
export function createMagicLinkSender(deps: {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly waha: WahaAccess;
  readonly mail: MailSender;
  readonly warningCapFactors?: readonly [number, number];
  readonly random?: () => number;
  readonly humanRandom?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): MagicLinkSender {
  const pool = createPoolSender({
    sql: deps.sql,
    log: deps.log,
    waha: deps.waha,
    ...(deps.warningCapFactors === undefined ? {} : { warningCapFactors: deps.warningCapFactors }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
    ...(deps.humanRandom === undefined ? {} : { humanRandom: deps.humanRandom }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  return {
    async send(message, signal) {
      if (message.channel === "whatsapp") {
        if (!isIdMobileE164(message.to)) throw new MagicLinkSendError("invalid_recipient");
        try {
          await pool.sendText({ to: message.to, text: message.text, signal });
        } catch (error) {
          if (!(error instanceof PoolSendError)) throw new MagicLinkSendError("send_failed");
          throw new MagicLinkSendError(poolCode(error), { maybeSent: error.code === "maybe_sent", ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) });
        }
        return;
      }
      try {
        await deps.mail.send({ to: message.to, subject: message.subject, text: message.text, html: message.html });
      } catch (error) {
        if (error instanceof MailAccessError) throw new MagicLinkSendError(ACCESS_CODES[error.code]);
        throw new MagicLinkSendError(error instanceof SmtpError ? `smtp_${error.code}` : "smtp_failed", { maybeSent: error instanceof SmtpError && error.code === "maybe_sent" });
      }
    },
  };
}

/**
 * The production port: when worker.env holds SECRETS_MESSAGING_PRIVATE_KEY (to open the WAHA key and the SMTP
 * password) and DOMAIN (the links point at https://play.<DOMAIN>), otherwise none (magic_link.resend is then not
 * relayed and the requests wait in the outbox).
 */
export function magicLinkResendFromEnv(env: Env, dev: WorkerConfig["dev"]): MagicLinkResendPort | undefined {
  const domain = optional(env, "DOMAIN");
  if (optional(env, "SECRETS_MESSAGING_PRIVATE_KEY") === undefined || domain === undefined) return undefined;
  const playOrigin = `https://play.${domain.toLowerCase()}`;
  if (new URL(playOrigin).origin !== playOrigin) throw new RangeError("DOMAIN must be a bare host name");
  const opener = openerFromEnv(env);
  const warningCapFactors = loadWarningFactors(env);
  return {
    playOrigin,
    sender: (sql, log) =>
      createMagicLinkSender({
        sql,
        log,
        waha: createWahaAccess({ sql, opener, config: { dev, wahaTimeoutMs: OTP_WAHA_TIMEOUT_MS } }),
        mail: createMailSender({ sql, opener, config: { dev, smtpTimeoutMs: MAGIC_LINK_SMTP_TIMEOUT_MS } }),
        warningCapFactors,
      }),
  };
}
