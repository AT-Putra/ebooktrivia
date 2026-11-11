import { TrophyIcon, UserCircleIcon } from "@phosphor-icons/react/ssr";
import { t } from "../../lib/t.ts";
import type { Program } from "../../lib/trivia-fixtures.ts";
import { ProgramSwitcher } from "./program-switcher.tsx";

interface TriviaHeaderProps {
  programs: Program[];
  currentSlug: string;
  basePath: string;
}

export function TriviaHeader({ programs, currentSlug, basePath }: TriviaHeaderProps) {
  return (
    <header className="sticky top-0 z-(--z-sticky) border-b bg-card shadow-sm">
      <div className="mx-auto flex max-w-[720px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 md:px-6 xl:max-w-[1200px]">
        <p className="flex items-center gap-2 font-heading text-lg">
          <TrophyIcon aria-hidden="true" size={28} weight="duotone" className="text-primary" />
          {t("common.appName")}
        </p>
        <div className="order-3 w-full md:order-none md:w-auto">
          <ProgramSwitcher programs={programs} currentSlug={currentSlug} basePath={basePath} />
        </div>
        <button
          type="button"
          className="inline-flex size-11 items-center justify-center rounded-full text-foreground transition-colors duration-(--duration-base) hover:bg-muted"
        >
          <UserCircleIcon aria-hidden="true" size={32} weight="duotone" />
          <span className="sr-only">{t("trivia.account")}</span>
        </button>
      </div>
    </header>
  );
}
