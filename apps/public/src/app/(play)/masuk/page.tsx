// play.<DOMAIN>/masuk#c=<channel>&t=<token> (US-026): the magic link's confirm page. A GET shows it and
// changes nothing; only the button POSTs the token (components/play/magic-link-confirm.tsx).
import type { Metadata } from "next";
import { HelpBlock } from "../../../components/help/help-block.tsx";
import { MagicLinkConfirm } from "../../../components/play/magic-link-confirm.tsx";
import { t } from "../../../lib/t.ts";

export const metadata: Metadata = {
  title: `${t("magicLink.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function MagicLinkPage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <MagicLinkConfirm />
      <HelpBlock className="max-w-[420px]" />
    </main>
  );
}
