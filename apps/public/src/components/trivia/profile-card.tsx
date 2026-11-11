import { ClockCountdownIcon, UserCircleIcon } from "@phosphor-icons/react/ssr";
import { formatMinSec, formatNumber } from "../../lib/format.ts";
import { t } from "../../lib/t.ts";
import type { Program } from "../../lib/trivia-fixtures.ts";
import { CountdownText } from "../countdown.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

function Stat({ label, value, large = false }: { label: string; value: string; large?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-muted px-3 py-2">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className={large ? "font-heading text-3xl leading-tight tabular" : "text-xl font-semibold tabular"}>{value}</dd>
    </div>
  );
}

export function ProfileCard({ program }: { program: Program }) {
  const p = program.profile;
  return (
    <TriviaCard titleId="profile-title">
      <CardHeading id="profile-title" icon={<UserCircleIcon size={24} weight="duotone" />}>
        {t("trivia.profile.title")}
      </CardHeading>
      <p className="text-lg font-semibold">{p.name}</p>
      <dl className="grid grid-cols-2 gap-2">
        <Stat label={t("trivia.profile.score")} value={formatNumber(p.score)} />
        <Stat label={t("trivia.profile.totalTime")} value={formatMinSec(p.seconds)} />
        <Stat label={t("trivia.profile.setsCompleted")} value={`${program.done}/${program.total}`} />
        <Stat label={t("trivia.profile.rank")} value={`#${p.rank}`} large />
      </dl>
      <div className="flex items-start gap-3 rounded-lg border bg-info-soft px-3 py-3 text-info-soft-foreground">
        <ClockCountdownIcon aria-hidden="true" size={24} weight="duotone" className="mt-0.5 shrink-0" />
        <div className="flex flex-col gap-0.5">
          <p>
            <CountdownText
              initialSeconds={p.nextUnlockSeconds}
              template={t("trivia.profile.nextUnlock", { countdown: "{countdown}" })}
            />
          </p>
          <p className="text-sm">{t("trivia.profile.unlockSchedule")}</p>
        </div>
      </div>
    </TriviaCard>
  );
}
