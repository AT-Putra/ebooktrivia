import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardTitle } from "@ebooktrivia/ui/components/card";
import { PageHeading } from "../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";
import { listFinalizedPrograms } from "../../../lib/settings/fulfillment.ts";

export const metadata: Metadata = { title: "Prize fulfilment | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });

/** Owner only (US-030): the programs whose winners the Owner confirmed, each with the prizes still to deliver. */
export default async function FulfillmentIndexPage() {
  await requireAdmin({ permission: "prize_fulfillment.update" });
  const { sql } = await getRuntime();
  const programs = await listFinalizedPrograms(sql);
  return (
    <>
      <PageHeading
        title="Prize fulfilment"
        description="Programs whose winners you confirmed. Open one to contact each winner, record the delivery step by step, keep notes and the proof of delivery."
      />
      <Card data-testid="fulfillment-programs">
        <CardTitle className="text-base">Finalized programs</CardTitle>
        {programs.length === 0 ? (
          <p className="text-sm">No program has confirmed winners yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {programs.map((p) => (
              <li key={p.programId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/fulfillment/${p.programId}`} className="font-medium underline underline-offset-4">
                  {p.name}
                </Link>
                <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  Winners confirmed {WIB.format(p.winnersConfirmedAt)}
                  <Badge variant={p.open === 0 ? "success" : "warning"}>{p.open === 0 ? "All delivered" : `${String(p.open)} to deliver`}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
