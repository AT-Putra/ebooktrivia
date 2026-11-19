import type { Metadata } from "next";
import Link from "next/link";
import { WarningIcon } from "@phosphor-icons/react/ssr";
import { Card, CardContent, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { unusedRecoveryCodes } from "../../lib/auth/recovery-codes.ts";
import { requireAdmin } from "../../lib/next/require-admin.ts";
import { getRuntime } from "../../lib/next/runtime.ts";

export const metadata: Metadata = { title: "Overview | Admin Console" };

export default async function OverviewPage() {
  const admin = await requireAdmin({ permission: "dashboard.view" });
  const codesLeft = await unusedRecoveryCodes((await getRuntime()).sql, admin.userId);
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-xs text-muted-foreground">Signed in as {admin.role === "owner" ? "the Owner" : "Staff"}.</p>
      </div>
      {codesLeft <= 3 ? (
        <Card role="status" className="border-destructive/60">
          <CardTitle className="flex items-center gap-2 text-base">
            <WarningIcon aria-hidden="true" size={18} weight="fill" />
            {codesLeft === 0 ? "No recovery codes left" : `Only ${String(codesLeft)} recovery code${codesLeft === 1 ? "" : "s"} left`}
          </CardTitle>
          <CardDescription>
            Without recovery codes, losing your authenticator locks you out.{" "}
            <Link href="/account" className="underline underline-offset-4">
              Create new codes
            </Link>
            .
          </CardDescription>
        </Card>
      ) : null}
      <Card>
        <CardTitle className="text-base">Your role</CardTitle>
        <CardContent>
          {admin.role === "owner" ? (
            <p className="text-sm">The Owner manages everything, including secrets, prices, exports, LP domains, the team and the audit log.</p>
          ) : (
            <p className="text-sm">
              Staff manage content, trivia and resends, and view reports. Secrets, prices, buyer and winner exports, LP domains and locked question sets are
              Owner-only.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
