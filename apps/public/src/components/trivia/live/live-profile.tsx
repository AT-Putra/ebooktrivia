// Card 3, the profile (US-027, AC-Q2): the player's OWN name, WhatsApp number and e-mail in full (Owner decision 2026-11-25; only this
// player sees them, player_profile_contact), score, total answer time, sets completed, rank (fresh, play_standing) and the countdown
// to the next unlock.
import { ClockCountdownIcon, EnvelopeSimpleIcon, UserCircleIcon, WhatsappLogoIcon } from "@phosphor-icons/react/ssr";
import { formatMs, formatNumber, formatPhoneLocal } from "../../../lib/format.ts";
import type { ProgramView } from "../../../lib/play/grid.ts";
import type { PlayerContact, ProgramPage, Standing } from "../../../lib/play/trivia-data.ts";
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

export function LiveProfile({
  page,
  view,
  me,
  contact,
}: {
  readonly page: ProgramPage;
  readonly view: ProgramView;
  readonly me: Standing;
  /** The player's own contact; null only for a player who may no longer log in (then the board's label stands in for the name). */
  readonly contact: PlayerContact | null;
}) {
  const next = view.nextUnlockAt;
  return (
    <TriviaCard titleId="profile-title">
      <CardHeading id="profile-title" icon={<UserCircleIcon size={24} weight="duotone" />}>
        {t("trivia.profile.title")}
      </CardHeading>
      <div className="flex flex-col gap-1">
        <p className="text-lg font-semibold [overflow-wrap:anywhere]" data-testid="profile-name">
          {contact?.name ?? me.name}
        </p>
        {contact === null ? null : (
          <dl className="flex flex-col gap-1 text-base" data-testid="profile-contact">
            <div className="flex min-w-0 items-center gap-2">
              <dt className="shrink-0 text-muted-foreground">
                <WhatsappLogoIcon aria-hidden="true" size={20} weight="duotone" />
                <span className="sr-only">{t("trivia.profile.whatsapp")}</span>
              </dt>
              <dd className="tabular" data-testid="profile-phone">
                {formatPhoneLocal(contact.phone)}
              </dd>
            </div>
            {contact.email === null ? null : (
              <div className="flex min-w-0 items-center gap-2">
                <dt className="shrink-0 text-muted-foreground">
                  <EnvelopeSimpleIcon aria-hidden="true" size={20} weight="duotone" />
                  <span className="sr-only">{t("trivia.profile.email")}</span>
                </dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]" data-testid="profile-email">
                  {contact.email}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
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
              <p>
                <UnlockCountdown
                  initialSeconds={Math.max(0, Math.ceil((next.getTime() - page.now.getTime()) / 1000))}
                  template={t("trivia.profile.nextUnlock", { countdown: "{countdown}" })}
                />
              </p>
            )}
            <p className="text-sm">{t("trivia.profile.unlockSchedule")}</p>
          </div>
        </div>
      )}
    </TriviaCard>
  );
}
