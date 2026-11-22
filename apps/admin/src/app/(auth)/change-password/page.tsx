import type { Metadata } from "next";
import { AuthCard } from "../../../components/auth/auth-card.tsx";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { ChangePasswordForm } from "./change-password-form.tsx";

export const metadata: Metadata = { title: "Change your password | Admin Console" };

/** The only page a session whose password is in a known breach may reach (US-031; requireAdmin sends every other request here). */
export default async function ChangePasswordPage() {
  await requireAdmin({ passwordChange: true });
  return (
    <AuthCard title="Change your password">
      <ChangePasswordForm />
      <form method="post" action="/auth/sign-out">
        <button type="submit" className="text-sm text-muted-foreground underline underline-offset-4">
          Sign out
        </button>
      </form>
    </AuthCard>
  );
}
