// play.<DOMAIN>/login (US-026): the WhatsApp OTP login. The paid order page links here (US-022 PLAY_LOGIN_PATH).
import type { Metadata } from "next";
import { LoginForm } from "../../../components/play/login-form.tsx";
import { t } from "../../../lib/t.ts";

export const metadata: Metadata = {
  title: `${t("login.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <LoginForm />
    </main>
  );
}
