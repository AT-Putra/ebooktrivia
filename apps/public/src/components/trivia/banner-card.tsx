import { GiftIcon, MedalIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { formatRupiah } from "../../lib/format.ts";
import { t } from "../../lib/t.ts";
import type { Program } from "../../lib/trivia-fixtures.ts";
import { Countdown } from "../countdown.tsx";
import { Picture } from "../picture.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

const MEDALS = [
  { key: "gold", tone: "text-accent", label: "trivia.banner.gold" },
  { key: "silver", tone: "text-muted-foreground", label: "trivia.banner.silver" },
  { key: "bronze", tone: "text-warning", label: "trivia.banner.bronze" },
] as const;

export function BannerCard({ program }: { program: Program }) {
  const phaseLabel = program.phase === "sales" ? t("trivia.banner.salesEndsIn") : t("trivia.banner.graceEndsIn");
  return (
    <TriviaCard titleId="banner-title">
      <CardHeading id="banner-title" level="h1" icon={<GiftIcon size={24} weight="duotone" />}>
        {program.name}
      </CardHeading>
      <div className="grid items-start gap-4 lg:grid-cols-2 lg:gap-6">
        <div className="overflow-hidden rounded-lg bg-muted">
          <Picture
            id="banner-program"
            alt=""
            priority
            sizes="(min-width: 1280px) 560px, (min-width: 768px) 672px, 100vw"
            className="block h-auto w-full"
          />
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Picture
              id="prize-placeholder"
              alt={t("trivia.banner.prizeArt")}
              sizes="96px"
              className="block h-16 w-24 shrink-0 rounded-lg object-cover"
            />
            <h2 className="font-heading text-lg">{t("trivia.banner.prizes")}</h2>
          </div>
          <ul className="flex flex-col gap-2">
            {MEDALS.map((m) => (
              <li key={m.key} className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-muted px-3">
                <span className="flex items-center gap-2 font-semibold">
                  <MedalIcon aria-hidden="true" size={24} weight="fill" className={m.tone} />
                  {t(m.label)}
                </span>
                <Badge variant="accent" className="text-sm tabular">
                  {formatRupiah(program.prizes[m.key])}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-col items-start justify-between gap-1 rounded-lg bg-linear-to-r from-primary to-secondary px-4 py-3 text-on-primary sm:flex-row sm:items-center">
        <p className="text-sm font-medium">{phaseLabel}</p>
        <Countdown initialSeconds={program.phaseSeconds} className="timer-digits text-3xl leading-none font-bold" />
      </div>
    </TriviaCard>
  );
}
