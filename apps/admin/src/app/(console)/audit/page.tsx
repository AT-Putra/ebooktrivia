import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Card } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";

export const metadata: Metadata = { title: "Audit log | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "medium" });

/** Owner only: the latest audit entries (append-only; PII appears as references only). */
/** An action name that may wrap after each dot ("admin_auth." / "sign_in"), never inside a word. */
const breakAfterDots = (text: string): ReactNode[] => text.split(".").flatMap((part, i) => (i === 0 ? [part] : [".", <wbr key={i} />, part]));

export default async function AuditPage() {
  await requireAdmin({ permission: "audit.view" });
  const { sql } = await getRuntime();
  const rows = await sql<{ id: number; occurred_at: Date; actor_kind: string; actor: string | null; action: string; entity: string; changes: unknown; pii_refs: string[] }[]>`
    SELECT a.id, a.occurred_at, a.actor_kind, p.display_name AS actor, a.action,
           a.entity_type || coalesce(':' || a.entity_id, '') AS entity, a.changes, a.pii_refs
      FROM audit_log a LEFT JOIN admin_profiles p ON p.auth_user_id = a.actor_admin_user_id
     ORDER BY a.id DESC LIMIT 200`;
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-xs text-muted-foreground">Latest 200 entries, times in WIB.</p>
      </div>
      <Card className="p-0 md:p-0">
        <Table aria-label="Audit entries">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Changes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs whitespace-nowrap">{WIB.format(row.occurred_at)}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{row.actor_kind === "admin" ? (row.actor ?? "admin") : row.actor_kind}</TableCell>
                {/* An action may break after a dot ("admin_auth." then "sign_in"), never inside a word; the ids and the changes break anywhere but keep a
                    readable width, so on a phone the table scrolls inside its card instead of breaking every column letter by letter. */}
                <TableCell className="min-w-32 font-mono text-xs">{breakAfterDots(row.action)}</TableCell>
                <TableCell className="min-w-44 font-mono text-xs [overflow-wrap:anywhere]!">{row.entity}</TableCell>
                <TableCell className="min-w-72 font-mono text-xs [overflow-wrap:anywhere]!">
                  {JSON.stringify(row.changes)}
                  {row.pii_refs.length > 0 ? <span className="block text-muted-foreground">{row.pii_refs.join("; ")}</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
