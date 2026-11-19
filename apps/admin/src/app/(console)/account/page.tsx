import type { Metadata } from "next";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { unusedRecoveryCodes } from "../../../lib/auth/recovery-codes.ts";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../lib/next/runtime.ts";
import { RegenerateForm } from "./regenerate-form.tsx";

export const metadata: Metadata = { title: "Account | Admin Console" };

export default async function AccountPage() {
  const admin = await requireAdmin({ permission: "account.manage_own" });
  const codesLeft = await unusedRecoveryCodes((await getRuntime()).sql, admin.userId);
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="text-xs text-muted-foreground">
          {admin.displayName}, {admin.role === "owner" ? "Owner" : "Staff"}. Sessions end after 30 minutes without activity and 12 hours after sign-in.
        </p>
      </div>
      <Card>
        <CardTitle className="text-base">Recovery codes</CardTitle>
        <CardDescription>
          <span data-testid="codes-left">{codesLeft}</span> of 10 unused. Creating new codes replaces all of them.
        </CardDescription>
        <RegenerateForm />
      </Card>
    </>
  );
}
