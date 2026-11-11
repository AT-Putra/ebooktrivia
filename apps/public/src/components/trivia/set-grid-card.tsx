import { CheckCircleIcon, LockSimpleIcon, PlayIcon, SquaresFourIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { formatHms } from "../../lib/format.ts";
import { t } from "../../lib/t.ts";
import type { Program, TriviaSet } from "../../lib/trivia-fixtures.ts";
import { Picture } from "../picture.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

function unlockLabel(set: TriviaSet): string {
  const u = set.unlock;
  if (u === undefined) return t("trivia.grid.locked");
  if (u.kind === "countdown") return t("trivia.grid.unlocksIn", { when: formatHms(u.seconds) });
  if (u.kind === "days") return t("trivia.grid.unlocksIn", { when: t("trivia.grid.inDays", { n: u.n }) });
  return t("trivia.grid.unlocksOn", { date: u.date });
}

function StatusLine({ set }: { set: TriviaSet }) {
  switch (set.state) {
    case "completed":
      return (
        <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
          <CheckCircleIcon aria-hidden="true" size={18} weight="fill" />
          <span>
            {t("trivia.grid.completed")} <span className="tabular">{t("trivia.grid.score", { score: set.score ?? 0, max: 100 })}</span>
          </span>
        </p>
      );
    case "unlocked":
      return (
        <Badge variant="accent" className="px-2.5 py-1 text-sm">
          <PlayIcon aria-hidden="true" weight="fill" />
          {t("trivia.grid.play")}
        </Badge>
      );
    case "in-progress":
      return (
        <Badge variant="warning" className="px-2.5 py-1 text-sm">
          <PlayIcon aria-hidden="true" weight="fill" />
          {t("trivia.grid.resume")}
        </Badge>
      );
    case "locked":
      return (
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <LockSimpleIcon aria-hidden="true" size={16} weight="fill" className="shrink-0" />
          <span className="tabular">{unlockLabel(set)}</span>
        </p>
      );
  }
}

function TileBody({ set }: { set: TriviaSet }) {
  const locked = set.state === "locked";
  const playable = set.state === "unlocked" || set.state === "in-progress";
  return (
    <>
      <span
        className={cn(
          "relative block aspect-[4/5] w-full overflow-hidden rounded-lg bg-muted",
          set.state === "unlocked" && "ring-2 ring-primary",
          set.state === "in-progress" && "ring-2 ring-accent",
        )}
      >
        <Picture
          id={set.art}
          alt=""
          sizes="(min-width: 1280px) 220px, (min-width: 768px) 220px, 45vw"
          className={cn("absolute inset-0 size-full object-cover", locked && "grayscale")}
        />
        {playable ? (
          <Picture
            id="overlay-unlocked-glow"
            alt=""
            sizes="220px"
            className="pointer-events-none absolute inset-0 size-full object-cover"
          />
        ) : null}
        {locked ? (
          <>
            <span aria-hidden="true" className="absolute inset-0 bg-foreground/55" />
            <span className="absolute inset-0 flex items-center justify-center">
              {/* Fixed widths: a % width inside the shrink-to-fit <picture> resolves to 0 before load. */}
              <Picture id="overlay-lock" alt="" sizes="96px" className="h-auto w-18 sm:w-24" />
            </span>
          </>
        ) : null}
        {set.state === "completed" ? (
          <span className="absolute top-1 right-1 block w-1/4 min-w-10">
            <Picture id="overlay-completed-badge" alt="" sizes="64px" className="h-auto w-full" />
          </span>
        ) : null}
      </span>
      <span className="flex flex-col items-start gap-1 text-left">
        <span className="flex w-full flex-wrap items-center justify-between gap-x-2">
          <span className="font-heading text-base">{t("trivia.grid.set", { n: set.n })}</span>
          {set.next ? <Badge variant="outline">{t("trivia.grid.next")}</Badge> : null}
        </span>
        <span className="text-sm text-muted-foreground">{t(`trivia.sets.${set.topic}`)}</span>
        <StatusLine set={set} />
      </span>
    </>
  );
}

function ariaLabel(set: TriviaSet): string {
  switch (set.state) {
    case "locked":
      return t("trivia.grid.ariaLocked", { n: set.n, label: unlockLabel(set) });
    case "unlocked":
    case "in-progress":
      return "";
    case "completed":
      return t("trivia.grid.ariaCompleted", { n: set.n, score: set.score ?? 0, max: 100 });
  }
}

export function SetGridCard({ program }: { program: Program }) {
  return (
    <TriviaCard titleId="grid-title">
      <CardHeading id="grid-title" icon={<SquaresFourIcon size={24} weight="duotone" />}>
        {t("trivia.grid.title")}
      </CardHeading>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-5">
        {program.sets.map((set, i) => {
          const playable = set.state === "unlocked" || set.state === "in-progress";
          const tileClass = "flex min-h-11 w-full flex-col gap-2 rounded-xl";
          return (
            <li key={set.n} style={{ animationDelay: `${i * 40}ms` }} className="tile-in">
              {playable ? (
                <a
                  href={`/mockups/trivia/play?set=${set.n}`}
                  className={cn(tileClass, "transition-opacity duration-(--duration-fast) hover:opacity-90")}
                >
                  <TileBody set={set} />
                </a>
              ) : (
                <div role="group" aria-disabled={set.state === "locked" ? "true" : undefined} aria-label={ariaLabel(set)} className={tileClass}>
                  <TileBody set={set} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </TriviaCard>
  );
}
