// Card 3, the profile (US-027, AC-Q2): the player's masked name, score, total answer time, sets completed, rank
// (fresh, play_standing) and the next unlock in WIB.
import { ClockCountdownIcon, UserCircleIcon } from "@phosphor-icons/react/ssr";
import { formatMs, formatNumber, formatWibDate } from "../../../lib/format.ts";
import type { ProgramView } from "../../../lib/play/grid.ts";
import type { ProgramPage, Standing } from "../../../lib/play/trivia-data.ts";
import { t } from "../../../lib/t.ts";
import { CardHeading, TriviaCard } from "../trivia-card.tsx";
import { UnlockCountdown } from "./unlock-countdown.tsx";

function Stat({ label, value, large = false }: { readonly label: string; readonly value: string; readonly large?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-muted px-3 py-2">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className={large ? "font-heading text-3xl leading-tight tabular" : "text-xl font-semibold tabular"}>{value}</dd>
    </div>
  );
}

export function LiveProfile({ page, view, me }: { readonly page: ProgramPage; readonly view: ProgramView; readonly me: Standing }) {
  const next = view.nextUnlockAt;
  return (
    <TriviaCard titleId="profile-title">
      <CardHeading id="profile-title" icon={<UserCircleIcon size={24} weight="duotone" />}>
        {t("trivia.profile.title")}
      </CardHeading>
      <p className="text-lg font-semibold">{me.name}</p>
      <dl className="grid grid-cols-2 gap-2">
        <Stat label={t("trivia.profile.score")} value={formatNumber(me.score)} />
        <Stat label={t("trivia.profile.totalTime")} value={formatMs(me.totalMs)} />
        <Stat label={t("trivia.profile.setsCompleted")} value={`${String(view.done)}/${String(page.sets.length)}`} />
        <Stat label={t("trivia.profile.rank")} value={me.rank === null ? t("trivia.live.noRank") : `#${String(me.rank)}`} large />
      </dl>
      {view.closed ? null : (
        <div className="flex items-start gap-3 rounded-lg border bg-info-soft px-3 py-3 text-info-soft-foreground">
          <ClockCountdownIcon aria-hidden="true" size={24} weight="duotone" className="mt-0.5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            {next === null ? (
              <p>{t("trivia.live.allUnlocked")}</p>
            ) : (
              <>
                <p>
                  <UnlockCountdown
                    initialSeconds={Math.max(0, Math.ceil((next.getTime() - page.now.getTime()) / 1000))}
                    template={t("trivia.profile.nextUnlock", { countdown: "{countdown}" })}
                  />
                </p>
                <p className="text-sm">{t("trivia.live.nextUnlockOn", { date: formatWibDate(next) })}</p>
              </>
            )}
            <p className="text-sm">{t("trivia.profile.unlockSchedule")}</p>
          </div>
        </div>
      )}
    </TriviaCard>
  );
}
