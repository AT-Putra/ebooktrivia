import type { Metadata } from "next";
import { AuthCard } from "../../../components/auth/auth-card.tsx";
import { requireAdmin } from "../../../lib/next/require-admin.ts";
import { EnrollFlow } from "./enroll-flow.tsx";

export const metadata: Metadata = { title: "Set up two-factor | Admin Console" };

/** The only page an account without TOTP may reach (requireAdmin sends every other request here). */
export default async function EnrollPage() {
  await requireAdmin({ enrollment: true });
  return (
    <AuthCard title="Set up two-factor authentication">
      <EnrollFlow />
      <form method="post" action="/auth/sign-out">
        <button type="submit" className="text-sm text-muted-foreground underline underline-offset-4">
          Sign out
        </button>
      </form>
    </AuthCard>
  );
}
