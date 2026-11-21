import type { Metadata } from "next";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading, SecretBadge, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { bpsToPercent, getMidtransSettings, MIDTRANS_ENVIRONMENTS, MIDTRANS_METHODS, serverKeyStatuses } from "../../../../lib/settings/midtrans.ts";
import { clearMidtransKeyAction, setMidtransEnvironmentAction, setMidtransKeyAction, updateMidtransMethodsAction } from "./actions.ts";

export const metadata: Metadata = { title: "Midtrans | Admin Console" };

/** Owner only: environment, payment methods, per-method fees, the per-environment server keys. */
export default async function MidtransPage() {
  await requireAdmin({ permission: "midtrans.edit" });
  const rt = await getRuntime();
  const [settings, keys] = await Promise.all([getMidtransSettings(rt.sql), serverKeyStatuses(rt.sql)]);
  const other = settings.environment === "sandbox" ? "production" : "sandbox";
  const sealing = rt.settings.sealer?.scopes.includes("payment") === true;
  return (
    <>
      <PageHeading title="Midtrans" description="Snap redirect payments. Sandbox and production keys are kept apart; switching environments is audited." />
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Environment</CardTitle>
          <Badge variant={settings.environment === "production" ? "success" : "warning"} data-testid="midtrans-env">
            {settings.environment === "production" ? "Production" : "Sandbox"}
          </Badge>
        </div>
        <ActionForm action={setMidtransEnvironmentAction} submitLabel={`Switch to ${other}`} variant="outline" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <input type="hidden" name="environment" value={other} />
          <TextField id="mt-confirm" name="confirm" label={`Type "${other}" to confirm`} maxLength={20} />
        </ActionForm>
      </Card>
      <Card>
        <CardTitle className="text-base">Server keys</CardTitle>
        <CardDescription>Write-only: the console can never show a saved key, only that it is set and its last 4 characters.</CardDescription>
        {MIDTRANS_ENVIRONMENTS.map((env) => (
          <div key={env} className="flex flex-col gap-2 border-t pt-3" data-testid={`midtrans-key-${env}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{env === "sandbox" ? "Sandbox" : "Production"} server key</span>
              <SecretBadge status={keys[env]} testId={`midtrans-key-${env}-status`} />
            </div>
            {sealing ? (
              <ActionForm action={setMidtransKeyAction} submitLabel="Save key" variant="secondary" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <input type="hidden" name="environment" value={env} />
                <TextField id={`mt-key-${env}`} name="serverKey" label={`New ${env} server key`} type="password" autoComplete="new-password" maxLength={200} placeholder={env === "sandbox" ? "SB-Mid-server-..." : "Mid-server-..."} />
              </ActionForm>
            ) : (
              <CardDescription>Keys cannot be saved: the payment sealing key is not configured on the server.</CardDescription>
            )}
            {keys[env].set && env !== settings.environment ? (
              <ActionForm action={clearMidtransKeyAction} submitLabel="Remove key" variant="ghost">
                <input type="hidden" name="environment" value={env} />
              </ActionForm>
            ) : null}
          </div>
        ))}
      </Card>
      <Card className="p-0 md:p-0">
        <ActionForm action={updateMidtransMethodsAction} submitLabel="Save methods and fees" className="flex flex-col gap-3 p-4 md:p-6" testId="midtrans-methods">
          <CardTitle className="text-base">Payment methods and fees</CardTitle>
          <CardDescription>
            Tick a method to offer it in Snap; the checkout sends only the ticked ones (and refuses to take orders when none is ticked). A method that is not active
            on your Midtrans account is simply not shown to buyers: ShopeePay, BRI VA, CIMB VA and Kredivo start switched off for that reason. The fee is what Midtrans
            charges the seller (used in the ROI report); a method you switch off keeps its saved fee, so older orders still count it. Buyers always pay the product price.
          </CardDescription>
          <Table aria-label="Payment methods">
            <TableHeader>
              <TableRow>
                <TableHead>Enabled</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Flat fee (IDR)</TableHead>
                <TableHead>Fee (%)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MIDTRANS_METHODS.map((m) => {
                const fee = settings.fees[m.code];
                return (
                  <TableRow key={m.code}>
                    <TableCell>
                      <input
                        id={`method-${m.code}`}
                        type="checkbox"
                        name={`method:${m.code}`}
                        defaultChecked={settings.enabledMethods.includes(m.code)}
                        className="size-4 accent-primary"
                        aria-label={`Enable ${m.label}`}
                      />
                    </TableCell>
                    <TableCell>
                      <label htmlFor={`method-${m.code}`}>{m.label}</label>
                    </TableCell>
                    <TableCell>
                      <input name={`flat:${m.code}`} inputMode="numeric" defaultValue={fee?.flat_idr ?? 0} aria-label={`${m.label} flat fee in rupiah`} className="min-h-9 w-28 rounded-md border-2 border-input bg-card px-2 text-sm" />
                    </TableCell>
                    <TableCell>
                      <input name={`percent:${m.code}`} inputMode="decimal" defaultValue={bpsToPercent(fee?.percent_bps ?? 0)} aria-label={`${m.label} fee percentage`} className="min-h-9 w-20 rounded-md border-2 border-input bg-card px-2 text-sm" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ActionForm>
      </Card>
    </>
  );
}
