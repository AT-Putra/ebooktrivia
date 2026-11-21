import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { ActionForm } from "../../../components/settings/action-form.tsx";
import { PageHeading, SelectField, TextArea, TextField } from "../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";
import { listDeletionRequests, LOOKUP_KINDS, LOOKUP_LABEL } from "../../../lib/settings/privacy.ts";
import { createDeletionRequestAction } from "./actions.ts";

export const metadata: Metadata = { title: "Data deletion | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const STATUS: Readonly<Record<string, { readonly label: string; readonly variant: "warning" | "success" | "secondary" }>> = {
  pending: { label: "Pending", variant: "warning" },
  completed: { label: "Erased", variant: "success" },
  rejected: { label: "Rejected", variant: "secondary" },
};

/**
 * Owner only (US-030, UU PDP): record a deletion request by the requester's WhatsApp number, e-mail or order id, then review and
 * execute or reject it. Deletion = anonymization: the person's data is removed everywhere, the anonymous order and play records
 * stay, so revenue and reports do not change. Backups age out within their retention window.
 */
export default async function PrivacyPage() {
  await requireAdmin({ permission: "deletion_request.process" });
  const { sql } = await getRuntime();
  const requests = await listDeletionRequests(sql);
  return (
    <>
      <PageHeading
        title="Data deletion requests"
        description="UU PDP: a buyer or player may ask for their personal data to be deleted. Deletion anonymizes them everywhere and keeps the anonymous order and play records, so revenue and reports stay the same. Encrypted backups age out within their retention window."
      />
      <Card data-testid="deletion-new">
        <CardTitle className="text-base">Record a request</CardTitle>
        <CardDescription>Identify the person the way they asked (a WhatsApp number, an e-mail address or an order id). You review what matches before anything is deleted.</CardDescription>
        <ActionForm action={createDeletionRequestAction} submitLabel="Record request" className="grid gap-3 sm:grid-cols-2">
          <SelectField id="deletion-kind" name="kind" label="Identified by" options={LOOKUP_KINDS.map((k) => ({ value: k, label: LOOKUP_LABEL[k] }))} />
          <TextField id="deletion-value" name="value" label="Number, e-mail or order id" maxLength={254} />
          <div className="sm:col-span-2">
            <TextArea id="deletion-reason" name="reason" label="The request" rows={2} minLength={10} maxLength={500} required hint="How and when it arrived, 10 to 500 characters, with no names, phone numbers or e-mail addresses." />
          </div>
        </ActionForm>
      </Card>
      <Card data-testid="deletion-requests">
        <CardTitle className="text-base">Requests</CardTitle>
        {requests.length === 0 ? (
          <p className="text-sm">No request yet.</p>
        ) : (
          <Table aria-label="Deletion requests">
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Recorded</TableHead>
                <TableHead>Identified by</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow key={r.id} data-testid={`deletion-${r.ref}`}>
                  <TableCell>
                    <Link href={`/privacy/${r.id}`} className="font-mono underline underline-offset-4">
                      {r.ref}
                    </Link>
                  </TableCell>
                  <TableCell>{WIB.format(r.requestedAt)}</TableCell>
                  <TableCell>{r.lookupKind === null ? "-" : LOOKUP_LABEL[r.lookupKind]}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS[r.status]?.variant ?? "secondary"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                    {r.decidedAt === null ? null : <span className="ml-2 text-xs text-muted-foreground">{WIB.format(r.decidedAt)}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
