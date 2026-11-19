import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "../../../../components/auth/auth-card.tsx";
import { TWO_FACTOR_COOKIE } from "../../../../lib/auth/instance.ts";
import { CodeForm } from "../code-form.tsx";

export const metadata: Metadata = { title: "Recovery code | Admin Console" };

/** Public: the second sign-in step with a recovery code (each works once). */
export default async function RecoveryPage() {
  if (!(await cookies()).has(TWO_FACTOR_COOKIE)) redirect("/login");
  return (
    <AuthCard title="Use a recovery code" description="Enter one of the 10 recovery codes you saved when you set up two-factor authentication. Each code works once.">
      <CodeForm kind="recovery" />
    </AuthCard>
  );
}
