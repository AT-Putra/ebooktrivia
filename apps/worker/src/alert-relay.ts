// The alert relay (US-015, plan M4.8: "the worker relays alerts to WhatsApp + e-mail") and its backstop.
//
// RELAY (a sweeper, every minute). The `alerts` table is where the code writes what the Owner must know (payments, deliveries, the
// backups, Valkey, GlitchTip's hook). Each sweep:
//   1. reads the Owner's recipients (alert_recipients, set in the console, Owner only): one WhatsApp number, one e-mail address, the
//      lowest severity sent. No recipient: nothing is sent and nothing is marked (the backstop below then speaks for a critical one);
//   2. is rate limited: at most one digest a minute and MAX_DIGESTS_PER_HOUR an hour (in this process; a restart starts the count
//      again, which only ever lets one extra digest through). A refused sweep changes nothing: the alerts wait;
//   3. claims the unnotified, unresolved alerts at or above the lowest severity (FOR UPDATE SKIP LOCKED, at most CLAIM_LIMIT), the
//      critical ones first, a test alert always (the Owner's "send a test alert" ignores the minimum);
//   4. builds ONE digest: at most MAX_LISTED alerts, each as `[severity] kind: message` with the message cut to MESSAGE_MAX
//      characters, then "+N more" for the rest of the claimed rows;
//   5. sends it by e-mail (the delivery code's SMTP sender) and by WhatsApp (the pool sender: human-like pauses, check-exists before a
//      first contact), side by side, each bounded in time;
//   6. marks the claimed rows notified_at when AT LEAST ONE channel took it. Why per digest and not per channel: a row that one
//      channel carried would otherwise be sent to that channel again every minute until the other one worked, and a down SMTP server
//      would turn into a WhatsApp message a minute (the number of digests is capped, but the Owner's patience is not); the Owner
//      learned of the alert, the console lists it, and the failed channel is logged and counted. When BOTH fail the transaction rolls
//      back, the rows stay unnotified and the next sweep retries them.
//
// NO PII. An alert holds ids, kinds and a fixed or masked message (the code that writes one never adds a name, a phone number or an
// address; GlitchTip's hook masks e-mail addresses and phone numbers before it stores them). The relay sends the kind, the severity
// and the message only, never the payload, and masks e-mail addresses and phone-like numbers once more (maskPii) and drops control
// characters (cleanText), so nothing that slipped into a message leaves the process in the clear.
//
// BACKSTOP (alertsBackstop, pushed by the heartbeat loop to a second Uptime Kuma push monitor, UPTIME_KUMA_ALERTS_PUSH_URL): DOWN while a
// critical alert has stayed unnotified and unresolved for more than BACKSTOP_AFTER_MS, UP otherwise. It is independent of the relay: if
// the relay, the recipients, SMTP or WhatsApp are broken, Kuma (on the other box) tells the Owner by its own WAHA and e-mail channels.
// Kuma tells on a change of state only, which is why the backstop is the second route and not the first.
import type { SafeFetch } from "@ebooktrivia/adapters";
import type postgres from "postgres";
import { cleanText } from "./glitchtip.ts";
import type { Logger } from "./log.ts";
import { maskPii } from "./pii.ts";

export type AlertSeverity = "info" | "warning" | "critical";

export const MAX_LISTED = 10;
export const MESSAGE_MAX = 300;
export const CLAIM_LIMIT = 50;
export const MIN_DIGEST_GAP_MS = 60_000;
export const MAX_DIGESTS_PER_HOUR = 20;
export const CHANNEL_TIMEOUT_MS = 30_000;
export const BACKSTOP_AFTER_MS = 5 * 60_000;

export interface AlertSenders {
  readonly email: (message: { readonly to: string; readonly subject: string; readonly text: string }, signal: AbortSignal) => Promise<void>;
  readonly whatsapp: (message: { readonly to: string; readonly text: string }, signal: AbortSignal) => Promise<void>;
}

export interface AlertRecipients {
  readonly phone: string | null;
  readonly email: string | null;
  readonly minSeverity: AlertSeverity;
}

export interface DigestAlert {
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly message: string;
}

export type ChannelResult = "sent" | "failed" | "off";
export type RelayOutcome = "no_recipients" | "rate_limited" | "idle" | "sent" | "failed";

export interface RelayResult {
  readonly outcome: RelayOutcome;
  /** Rows the digest covered (listed and "+N more"); marked notified only when `outcome` is "sent". */
  readonly included: number;
  readonly email: ChannelResult;
  readonly whatsapp: ChannelResult;
}

const idle = (outcome: RelayOutcome): RelayResult => ({ outcome, included: 0, email: "off", whatsapp: "off" });

const RANK: Readonly<Record<AlertSeverity, number>> = { info: 0, warning: 1, critical: 2 };

/** A message as it may leave the process: control characters dropped, e-mail addresses and phone-like numbers masked, cut. */
export const safeText = (value: string, max: number): string => cleanText(maskPii(value), max);

/** The digest: subject and text of at most `maxListed` alerts, the critical ones first, then "+N more". */
export function buildDigest(alerts: readonly DigestAlert[], maxListed = MAX_LISTED): { readonly subject: string; readonly text: string } {
  const ordered = [...alerts].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const listed = ordered.slice(0, maxListed);
  const lines = listed.map((a) => `[${a.severity}] ${safeText(a.kind, 80)}: ${safeText(a.message, MESSAGE_MAX)}`);
  const more = ordered.length - listed.length;
  if (more > 0) lines.push(`+${String(more)} more`);
  const worst = ordered[0]?.severity ?? "info";
  const count = ordered.length === 1 ? "1 alert" : `${String(ordered.length)} alerts`;
  return { subject: `[${worst}] ${count}: ${listed.map((a) => safeText(a.kind, 40)).slice(0, 3).join(", ")}${listed.length > 3 ? ", ..." : ""}`, text: `${lines.join("\n")}\n` };
}

export interface RelayDeps {
  readonly sql: postgres.Sql;
  readonly log: Logger;
  readonly senders: AlertSenders;
  /** Milliseconds since the epoch (tests). */
  readonly now?: () => number;
  readonly channelTimeoutMs?: number;
}

export interface AlertRelay {
  sweep(): Promise<RelayResult>;
}

interface ClaimedRow {
  readonly id: string;
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly message: string;
}

async function recipientsOf(sql: postgres.Sql): Promise<AlertRecipients | null> {
  const [row] = await sql<{ phone: string | null; email: string | null; min_severity: AlertSeverity }[]>`
    SELECT phone, email, min_severity FROM public.alert_recipients WHERE id = 1`;
  if (row === undefined || (row.phone === null && row.email === null)) return null;
  return { phone: row.phone, email: row.email, minSeverity: row.min_severity };
}

/** One channel, bounded in time, never throwing: "failed" carries no provider text (it may hold an address). */
async function attempt(send: ((signal: AbortSignal) => Promise<void>) | null, timeoutMs: number): Promise<ChannelResult> {
  if (send === null) return "off";
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    await send(controller.signal);
    return "sent";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export function createAlertRelay(deps: RelayDeps): AlertRelay {
  const { sql, log, senders } = deps;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.channelTimeoutMs ?? CHANNEL_TIMEOUT_MS;
  const sentAt: number[] = [];
  return {
    async sweep() {
      const recipients = await recipientsOf(sql);
      if (recipients === null) return idle("no_recipients");
      const t = now();
      while (sentAt.length > 0 && (sentAt[0] ?? 0) <= t - 3_600_000) sentAt.shift();
      const last = sentAt[sentAt.length - 1];
      if ((last !== undefined && t - last < MIN_DIGEST_GAP_MS) || sentAt.length >= MAX_DIGESTS_PER_HOUR) return idle("rate_limited");
      const min = RANK[recipients.minSeverity];
      return sql.begin(async (tx): Promise<RelayResult> => {
        const rows = await tx<ClaimedRow[]>`
          SELECT id, kind, severity, message
            FROM public.alerts
           WHERE notified_at IS NULL AND resolved_at IS NULL
             AND (payload @> '{"test": true}'::jsonb OR (CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) >= ${min})
           ORDER BY (CASE severity WHEN 'critical' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END) DESC, created_at
           LIMIT ${CLAIM_LIMIT}
             FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return idle("idle");
        const digest = buildDigest(rows);
        sentAt.push(t);
        const emailTo = recipients.email;
        const phoneTo = recipients.phone;
        const [email, whatsapp] = await Promise.all([
          attempt(emailTo === null ? null : (signal) => senders.email({ to: emailTo, subject: digest.subject, text: digest.text }, signal), timeoutMs),
          attempt(phoneTo === null ? null : (signal) => senders.whatsapp({ to: phoneTo, text: `${digest.subject}\n${digest.text}` }, signal), timeoutMs),
        ]);
        if (email === "failed") log.warn({ channel: "email", alerts: rows.length }, "alert relay: the e-mail was not sent");
        if (whatsapp === "failed") log.warn({ channel: "whatsapp", alerts: rows.length }, "alert relay: the WhatsApp message was not sent");
        if (email !== "sent" && whatsapp !== "sent") {
          // Both configured channels failed: leave the rows for the next sweep.
          return { outcome: "failed", included: rows.length, email, whatsapp };
        }
        await tx`UPDATE public.alerts SET notified_at = now() WHERE id = ANY (${rows.map((r) => r.id)}::uuid[])`;
        log.info({ alerts: rows.length, email, whatsapp }, "alert relay: digest sent");
        return { outcome: "sent", included: rows.length, email, whatsapp };
      });
    },
  };
}

export interface BackstopStatus {
  readonly status: "up" | "down";
  /** What Kuma shows and sends: a count and the kinds, never a message. */
  readonly msg: string;
}

/** DOWN while a critical alert has stayed unnotified and unresolved for more than `afterMs` (default 5 minutes). */
export async function alertsBackstop(sql: postgres.Sql, afterMs = BACKSTOP_AFTER_MS): Promise<BackstopStatus> {
  const rows = await sql<{ kind: string; n: number }[]>`
    SELECT kind, count(*)::int AS n FROM public.alerts
     WHERE severity = 'critical' AND notified_at IS NULL AND resolved_at IS NULL AND created_at < now() - make_interval(secs => ${afterMs / 1000})
     GROUP BY kind ORDER BY min(created_at) LIMIT 5`;
  if (rows.length === 0) return { status: "up", msg: "OK" };
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  return { status: "down", msg: safeText(`${String(total)} critical alert(s) unsent for over ${String(Math.round(afterMs / 60_000))} min: ${rows.map((r) => r.kind).join(", ")}`, 200) };
}

export interface BackstopPush {
  readonly fetch: SafeFetch;
  readonly url: URL;
}

/** Pushes the backstop's state to Kuma (GET <push url>?status=up|down&msg=...); never throws. Returns whether Kuma took it. */
export async function pushAlertsBackstop(deps: { readonly sql: postgres.Sql; readonly push: BackstopPush; readonly log: Logger; readonly afterMs?: number }): Promise<boolean> {
  let status: BackstopStatus;
  try {
    status = await alertsBackstop(deps.sql, deps.afterMs);
  } catch (err) {
    deps.log.error({ err }, "alerts backstop: PostgreSQL did not answer");
    // The heartbeat push says the worker cannot reach PostgreSQL; this one stays silent rather than invent a state.
    return false;
  }
  const url = new URL(deps.push.url);
  url.searchParams.set("status", status.status);
  url.searchParams.set("msg", status.msg);
  try {
    const response = await deps.push.fetch(url, { method: "GET" });
    await response.cancel();
    if (response.status < 200 || response.status > 299) {
      deps.log.warn({ httpStatus: response.status }, "alerts backstop push rejected");
      return false;
    }
    return true;
  } catch (error) {
    deps.log.warn({ code: (error as { code?: unknown }).code }, "alerts backstop push failed");
    return false;
  }
}
