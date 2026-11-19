import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "../../../../components/auth/auth-card.tsx";
import { TWO_FACTOR_COOKIE } from "../../../../lib/auth/instance.ts";
import { CodeForm } from "../code-form.tsx";

export const metadata: Metadata = { title: "Two-factor | Admin Console" };

/** Public: the second sign-in step; only reachable with a pending challenge from the password step. */
export default async function TwoFactorPage() {
  if (!(await cookies()).has(TWO_FACTOR_COOKIE)) redirect("/login");
  return (
    <AuthCard title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app.">
      <CodeForm kind="totp" />
    </AuthCard>
  );
}
