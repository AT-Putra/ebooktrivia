import { ClockCountdownIcon, EnvelopeSimpleIcon, UserCircleIcon, WhatsappLogoIcon } from "@phosphor-icons/react/ssr";
import { formatMinSec, formatNumber, formatPhoneLocal } from "../../lib/format.ts";
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
      <div className="flex flex-col gap-1">
        <p className="text-lg font-semibold [overflow-wrap:anywhere]">{p.name}</p>
        <dl className="flex flex-col gap-1 text-base">
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-muted-foreground">
              <WhatsappLogoIcon aria-hidden="true" size={20} weight="duotone" />
              <span className="sr-only">{t("trivia.profile.whatsapp")}</span>
            </dt>
            <dd className="tabular">{formatPhoneLocal(p.phone)}</dd>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <dt className="shrink-0 text-muted-foreground">
              <EnvelopeSimpleIcon aria-hidden="true" size={20} weight="duotone" />
              <span className="sr-only">{t("trivia.profile.email")}</span>
            </dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{p.email}</dd>
          </div>
        </dl>
      </div>
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
