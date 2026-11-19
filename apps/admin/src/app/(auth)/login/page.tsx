import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthCard } from "../../../components/auth/auth-card.tsx";
import { currentSession } from "../../../lib/next/require-admin.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Sign in | Admin Console" };

/** Public: the first sign-in step. A signed-in user is sent on. */
export default async function LoginPage() {
  const session = await currentSession();
  if (session.status === "active") redirect("/");
  if (session.status === "unenrolled") redirect("/enroll");
  return (
    <AuthCard title="Sign in" description="Owner and Staff accounts only. A second factor follows.">
      <LoginForm />
    </AuthCard>
  );
}
