// The bar at the foot of the banner card (live and mockup): the countdown to the QUIZ DEADLINE (the grace end: lib/play/grid.ts
// quizEndsAt), the exact deadline in WIB under the label, and the time left as days and hh:mm:ss. Everyone on the play page has
// bought already, so the sales end is not shown.
import { formatWibDeadline } from "../../lib/format.ts";
import { t } from "../../lib/t.ts";
import { Countdown } from "../countdown.tsx";

export function QuizDeadline({ quizEndsAt, secondsLeft }: { readonly quizEndsAt: Date; readonly secondsLeft: number }) {
  return (
    <div className="flex flex-col items-start justify-between gap-2 rounded-lg bg-linear-to-r from-primary to-secondary px-4 py-3 text-on-primary sm:flex-row sm:items-center sm:gap-4" data-testid="quiz-deadline">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{t("trivia.banner.quizEndsIn")}</p>
        <p className="text-sm">{t("trivia.banner.deadline", formatWibDeadline(quizEndsAt))}</p>
      </div>
      <Countdown initialSeconds={secondsLeft} dayLabel={t("trivia.banner.days")} className="timer-digits text-3xl leading-none font-bold whitespace-nowrap" />
    </div>
  );
}
