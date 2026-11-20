import type { Metadata } from "next";
import { Card, CardDescription } from "@ebooktrivia/ui/components/card";
import { ActionForm } from "../../../../components/settings/action-form.tsx";
import { PageHeading, TextField } from "../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { getLimits, LIMITS } from "../../../../lib/settings/limits.ts";
import { saveLimitsAction } from "./actions.ts";

export const metadata: Metadata = { title: "OTP and rate limits | Admin Console" };

/** Owner only: OTP and rate-limit parameters (bounded, audited per key). */
export default async function LimitsPage() {
  await requireAdmin({ permission: "app_settings.edit" });
  const { sql } = await getRuntime();
  const limits = await getLimits(sql);
  return (
    <>
      <PageHeading title="OTP and rate limits" description="Player sign-in codes (WhatsApp OTP), checkout expiry and closing, the checkout and captcha rate limits, and the longest outage the trivia deadline extension covers. A shorter code validity applies to codes sent from now on. Every change is audited." />
      <Card>
        <CardDescription>Each value is a whole number within the range shown under it.</CardDescription>
        <ActionForm action={saveLimitsAction} submitLabel="Save limits" testId="limits-form">
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMITS.map((l) => (
              <TextField
                key={l.key}
                id={`limit-${l.field}`}
                name={l.field}
                label={l.label}
                type="number"
                inputMode="numeric"
                defaultValue={limits[l.key]}
                hint={`${l.min.toLocaleString("en-US")} to ${l.max.toLocaleString("en-US")} ${l.unit} (${l.key})`}
              />
            ))}
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
