// The trivia page's header (US-027, AC-Q3): the app name, the program switcher over the player's programs (all
// four cards follow the selected one: each program is its own page, /{programSlug}) and the account menu.
import { TrophyIcon } from "@phosphor-icons/react/ssr";
import { t } from "../../../lib/t.ts";
import type { ProgramSummary } from "../../../lib/play/trivia-data.ts";
import { ProgramSwitcher } from "../program-switcher.tsx";
import { AccountMenu } from "./account-menu.tsx";

export function LiveHeader({ programs, currentSlug }: { readonly programs: readonly ProgramSummary[]; readonly currentSlug: string | null }) {
  return (
    <header className="sticky top-0 z-(--z-sticky) border-b bg-card shadow-sm">
      <div className="mx-auto flex max-w-[720px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 md:px-6 xl:max-w-[1200px]">
        <p className="flex items-center gap-2 font-heading text-lg">
          <TrophyIcon aria-hidden="true" size={28} weight="duotone" className="text-primary" />
          {t("common.appName")}
        </p>
        {currentSlug === null || programs.length === 0 ? null : (
          <div className="order-3 w-full md:order-none md:w-auto">
            <ProgramSwitcher
              programs={programs.map((p) => ({ slug: p.slug, name: p.name, done: p.done, total: p.setCount }))}
              currentSlug={currentSlug}
              basePath=""
              linkStyle="path"
            />
          </div>
        )}
        <AccountMenu />
      </div>
    </header>
  );
}
