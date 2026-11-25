// The open alerts (resolved_at IS NULL) on the Owner's Alerts page, and marking a group of them resolved (Owner decision 2026-11-25: once an alert's
// cause was handled there was no way to close it). Alerts are written by the worker, the internal process, the database and the console; the relay
// sends the open ones to the recipients (Settings > Alert recipients), and Uptime Kuma's backstop reports a critical one that stays unsent.
//
// A group is one kind at one severity. Resolving it sets resolved_at on the group's open alerts up to the newest one the page showed (`through`),
// never on one raised after the page was read, so nothing the Owner has not seen is closed. Nothing else changes: the rows stay, the relay and the
// backstop stop counting them, and a new alert of the same kind is raised again as usual. Audited, with the kind, severity, count and cut-off only.
//
// Messages are shown masked (lib/log.ts maskText: e-mail addresses, digit runs and token-like strings), as the relay masks what it sends: an alert's
// text may quote a GlitchTip event or a provider's answer.
import type { Sql } from "../db.ts";
import { maskText } from "../log.ts";
import { auditedChange } from "../settings/audited.ts";
import { formValue, InvalidInput } from "../settings/fields.ts";

export const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const RESOLVE_ALERTS_ACTION = "alerts.resolve";
export const RESOLVE_ALERT_FIELDS = ["kind", "severity", "through"] as const;

/** At most this many groups are listed (there are a few dozen kinds; the rest would be a bug). */
const MAX_GROUPS = 200;
/** A kind as the writers name them (snake_case). */
const KIND = /^[a-z0-9_]{1,64}$/;
/** The cut-off as the page renders it: UTC with microseconds, so the newest alert of the group is included exactly. */
const THROUGH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface AlertGroup {
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly open: number;
  /** Open alerts the relay never sent (no recipients, or every send failed). */
  readonly unsent: number;
  readonly firstAt: Date;
  readonly lastAt: Date;
  /** created_at of the newest open alert, UTC with microseconds: the resolve cut-off. */
  readonly through: string;
  /** The newest open alert's message, masked. */
  readonly message: string;
}

export interface OpenAlerts {
  readonly groups: readonly AlertGroup[];
  readonly total: number;
  /** Whether a WhatsApp number or an e-mail address is set for the relay. */
  readonly recipientsSet: boolean;
}

const isSeverity = (value: string): value is AlertSeverity => (ALERT_SEVERITIES as readonly string[]).includes(value);

export async function loadOpenAlerts(sql: Sql): Promise<OpenAlerts> {
  const rows = await sql<{ kind: string; severity: string; open: number; unsent: number; first_at: Date; last_at: Date; through: string; message: string }[]>`
    SELECT kind, severity, count(*)::int AS open, (count(*) FILTER (WHERE notified_at IS NULL))::int AS unsent,
           min(created_at) AS first_at, max(created_at) AS last_at,
           to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS through,
           (array_agg(message ORDER BY created_at DESC))[1] AS message
      FROM public.alerts
     WHERE resolved_at IS NULL
     GROUP BY kind, severity
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, max(created_at) DESC
     LIMIT ${MAX_GROUPS}`;
  const [recipients] = await sql<{ set: boolean }[]>`SELECT EXISTS (SELECT 1 FROM public.alert_recipients WHERE phone IS NOT NULL OR email IS NOT NULL) AS set`;
  const groups = rows.map((r) => ({
    kind: r.kind,
    severity: isSeverity(r.severity) ? r.severity : "info",
    open: r.open,
    unsent: r.unsent,
    firstAt: r.first_at,
    lastAt: r.last_at,
    through: r.through,
    message: maskText(r.message),
  }));
  return { groups, total: groups.reduce((n, g) => n + g.open, 0), recipientsSet: recipients?.set ?? false };
}

/** The open alerts at warning or above: the count next to "Alerts" in the menu. */
export async function openAlertCount(sql: Sql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.alerts WHERE resolved_at IS NULL AND severity IN ('critical', 'warning')`;
  return row?.n ?? 0;
}

export interface ResolveRequest {
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly through: string;
}

const UNKNOWN_GROUP = "The request refers to an unknown group of alerts.";

export function parseResolveRequest(form: FormData): ResolveRequest {
  const kind = formValue(form, "kind");
  const severity = formValue(form, "severity");
  const through = formValue(form, "through");
  if (!KIND.test(kind) || !isSeverity(severity) || !THROUGH.test(through) || Number.isNaN(Date.parse(through))) throw new InvalidInput(UNKNOWN_GROUP);
  return { kind, severity, through };
}

/** Marks the group's open alerts up to `through` resolved, audited in the same transaction; the number resolved. */
export async function resolveAlertGroup(sql: Sql, request: ResolveRequest): Promise<number> {
  return auditedChange(sql, async (tx, audit) => {
    const rows = await tx<{ id: string }[]>`
      UPDATE public.alerts SET resolved_at = now()
       WHERE kind = ${request.kind} AND severity = ${request.severity} AND resolved_at IS NULL AND created_at <= ${request.through}::timestamptz
      RETURNING id`;
    if (rows.length === 0) throw new InvalidInput("Nothing to resolve: these alerts are already resolved.");
    audit({
      action: RESOLVE_ALERTS_ACTION,
      entityType: "alert",
      entityId: null,
      facts: { kind: request.kind, severity: request.severity, count: rows.length, through: request.through },
    });
    return rows.length;
  });
}
