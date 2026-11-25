import type { Metadata } from "next";
import Link from "next/link";
import { InfoIcon, WarningIcon, WarningOctagonIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { EmptyState } from "../../../components/reports/report-ui.tsx";
import { ActionForm } from "../../../components/settings/action-form.tsx";
import { Notice, PageHeading } from "../../../components/settings/fields.tsx";
import { type AlertGroup, type AlertSeverity, loadOpenAlerts } from "../../../lib/alerts/open-alerts.ts";
import { formatInt, formatWibTime } from "../../../lib/format.ts";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";
import { can } from "../../../lib/policy.ts";
import { resolveAlertsAction } from "./actions.ts";

export const metadata: Metadata = { title: "Alerts | Admin Console" };

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  if (severity === "critical") {
    return (
      <Badge variant="destructive">
        <WarningOctagonIcon aria-hidden="true" weight="fill" />
        Critical
      </Badge>
    );
  }
  if (severity === "warning") {
    return (
      <Badge variant="warning">
        <WarningIcon aria-hidden="true" weight="fill" />
        Warning
      </Badge>
    );
  }
  return (
    <Badge variant="info">
      <InfoIcon aria-hidden="true" weight="fill" />
      Info
    </Badge>
  );
}

function GroupCard({ group, canResolve }: { group: AlertGroup; canResolve: boolean }) {
  const id = `alert-${group.kind}-${group.severity}`;
  const plural = group.open === 1 ? "alert" : "alerts";
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-testid="alert-group" data-kind={group.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={group.severity} />
        <h3 id={id} className="font-mono text-sm font-semibold [overflow-wrap:anywhere]">
          {group.kind}
        </h3>
        <span className="ml-auto text-sm font-semibold tabular" data-testid="alert-open">
          {`${formatInt(group.open)} open`}
        </span>
      </div>
      <p className="text-sm [overflow-wrap:anywhere]" data-testid="alert-message">
        {group.message}
      </p>
      <dl className="grid gap-x-4 gap-y-1 text-sm text-muted-foreground sm:grid-cols-3">
        <div>
          <dt className="inline">First: </dt>
          <dd className="inline tabular">{formatWibTime(group.firstAt)}</dd>
        </div>
        <div>
          <dt className="inline">Newest: </dt>
          <dd className="inline tabular">{formatWibTime(group.lastAt)}</dd>
        </div>
        <div>
          <dt className="inline">Never sent: </dt>
          <dd className="inline tabular" data-testid="alert-unsent">
            {formatInt(group.unsent)}
          </dd>
        </div>
      </dl>
      {canResolve ? (
        <ActionForm
          action={resolveAlertsAction}
          submitLabel={group.open === 1 ? "Resolve" : `Resolve all ${formatInt(group.open)}`}
          variant="outline"
          testId={`resolve-${group.kind}-${group.severity}`}
          describedBy={id}
          className="flex flex-col gap-2"
          confirm={{
            warning: `Mark ${formatInt(group.open)} open ${group.kind} ${plural} as resolved? Do this once the cause is handled; a new one is raised again if it happens again.`,
            yesLabel: "Yes, resolve",
          }}
        >
          <input type="hidden" name="kind" value={group.kind} />
          <input type="hidden" name="severity" value={group.severity} />
          <input type="hidden" name="through" value={group.through} />
        </ActionForm>
      ) : null}
    </li>
  );
}

/** Owner only: the open alerts by kind and severity, each group with a Resolve button (lib/alerts/open-alerts.ts). */
export default async function AlertsPage() {
  const admin = await requireAdmin({ permission: "alerts.view" });
  const { sql } = await getRuntime();
  const { groups, total, recipientsSet } = await loadOpenAlerts(sql);
  const canResolve = can(admin.role, "alerts.resolve");
  return (
    <>
      <PageHeading
        title="Alerts"
        description="What the worker, the database and the monitors raised that nobody has marked resolved yet, grouped by kind and severity, with the newest message of each group (masked). Resolve a group once its cause is handled: only the alerts listed close, a new one is raised again if it happens again, and every resolve is audited."
      />
      {recipientsSet ? null : (
        <Notice tone="warning" testId="alerts-no-recipients">
          <WarningIcon aria-hidden="true" weight="fill" className="mt-0.5 shrink-0" size={16} />
          <span>
            <strong className="font-semibold">No alert recipients are set.</strong> None of these alerts can reach you by WhatsApp or e-mail until a number or an
            address is set in{" "}
            <Link href="/settings/alerts" className="font-medium underline underline-offset-4">
              Alert recipients
            </Link>
            . The relay then sends every open one at or above the lowest severity there, so resolve the ones already handled first.
          </span>
        </Notice>
      )}
      <Card>
        <CardTitle className="text-base">Open alerts</CardTitle>
        <CardDescription data-testid="alerts-total">{`${formatInt(total)} open ${total === 1 ? "alert" : "alerts"} in ${formatInt(groups.length)} ${groups.length === 1 ? "group" : "groups"}.`}</CardDescription>
        {groups.length === 0 ? (
          <EmptyState testId="alerts-empty">No open alerts.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Open alerts by kind">
            {groups.map((g) => (
              <GroupCard key={`${g.kind}:${g.severity}`} group={g} canResolve={canResolve} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
