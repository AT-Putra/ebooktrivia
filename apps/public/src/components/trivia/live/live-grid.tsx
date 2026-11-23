// Card 4, the set grid (US-027, AC-Q2, AC-Q12): every set of the program as a locked, open, started or completed
// tile (lib/play/grid.ts: core unlock.ts with the max rule), with the set's uploaded thumbnail (lib/play/images.ts), else the
// AI-generated set art of the asset pipeline, and the state overlays. An open or started set links to its play page /{programSlug}/set/{n}; a locked one says
// when it opens (WIB).
import { Badge } from "@ebooktrivia/ui/components/badge";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { CheckCircleIcon, LockSimpleIcon, PlayIcon, SquaresFourIcon } from "@phosphor-icons/react/ssr";
import { formatWibDate } from "../../../lib/format.ts";
import type { ProgramView, Tile } from "../../../lib/play/grid.ts";
import { setArt } from "../../../lib/play/image-urls.ts";
import { t } from "../../../lib/t.ts";
import { Picture } from "../../picture.tsx";
import { UploadedPicture } from "../../uploaded-picture.tsx";
import { CardHeading, TriviaCard } from "../trivia-card.tsx";

const lockedLabel = (tile: Tile): string =>
  tile.unlocksAt === null ? t("trivia.grid.locked") : t("trivia.grid.unlocksOn", { date: formatWibDate(tile.unlocksAt) });

function StatusLine({ tile, closed }: { readonly tile: Tile; readonly closed: boolean }) {
  switch (tile.state) {
    case "completed":
      return (
        <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
          <CheckCircleIcon aria-hidden="true" size={18} weight="fill" />
          <span>
            {t("trivia.grid.completed")} <span className="tabular">{t("trivia.grid.score", { score: tile.set.attempt?.score ?? 0, max: tile.set.maxScore })}</span>
          </span>
        </p>
      );
    case "unlocked":
    case "in-progress":
      return closed ? (
        <p className="text-sm font-medium text-muted-foreground">{t("trivia.grid.locked")}</p>
      ) : (
        <Badge variant={tile.state === "unlocked" ? "accent" : "warning"} className="px-2.5 py-1 text-sm">
          <PlayIcon aria-hidden="true" weight="fill" />
          {tile.state === "unlocked" ? t("trivia.grid.play") : t("trivia.grid.resume")}
        </Badge>
      );
    case "locked":
      return (
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <LockSimpleIcon aria-hidden="true" size={16} weight="fill" className="shrink-0" />
          <span className="tabular">{lockedLabel(tile)}</span>
        </p>
      );
  }
}

function TileBody({ tile, closed }: { readonly tile: Tile; readonly closed: boolean }) {
  const locked = tile.state === "locked";
  const playable = !closed && (tile.state === "unlocked" || tile.state === "in-progress");
  const art = setArt(tile.set, tile.n);
  const artClass = cn("absolute inset-0 size-full object-cover", (locked || closed) && "grayscale");
  return (
    <>
      <span
        className={cn(
          "relative block aspect-[4/5] w-full overflow-hidden rounded-lg bg-muted",
          playable && tile.state === "unlocked" && "ring-2 ring-primary",
          playable && tile.state === "in-progress" && "ring-2 ring-accent",
        )}
      >
        {art.kind === "upload" ? (
          <UploadedPicture src={art.src} alt="" width={220} height={275} className={artClass} />
        ) : (
          <Picture id={art.id} alt="" sizes="(min-width: 1280px) 220px, (min-width: 768px) 220px, 45vw" className={artClass} />
        )}
        {playable ? <Picture id="overlay-unlocked-glow" alt="" sizes="220px" className="pointer-events-none absolute inset-0 size-full object-cover" /> : null}
        {locked ? (
          <>
            <span aria-hidden="true" className="absolute inset-0 bg-foreground/55" />
            <span className="absolute inset-0 flex items-center justify-center">
              <Picture id="overlay-lock" alt="" sizes="96px" className="h-auto w-18 sm:w-24" />
            </span>
          </>
        ) : null}
        {tile.state === "completed" ? (
          <span className="absolute top-1 right-1 block w-1/4 min-w-10">
            <Picture id="overlay-completed-badge" alt="" sizes="64px" className="h-auto w-full" />
          </span>
        ) : null}
      </span>
      <span className="flex flex-col items-start gap-1 text-left">
        <span className="flex w-full flex-wrap items-center justify-between gap-x-2">
          <span className="font-heading text-base">{t("trivia.grid.set", { n: tile.n })}</span>
          {tile.next ? <Badge variant="outline">{t("trivia.grid.next")}</Badge> : null}
        </span>
        <span className="text-sm break-words text-muted-foreground">{tile.set.title}</span>
        <span className="text-sm text-muted-foreground">{t("trivia.live.questions", { n: tile.set.questionCount })}</span>
        <StatusLine tile={tile} closed={closed} />
      </span>
    </>
  );
}

function ariaLabel(tile: Tile): string | undefined {
  if (tile.state === "locked") return t("trivia.grid.ariaLocked", { n: tile.n, label: lockedLabel(tile) });
  if (tile.state === "completed") return t("trivia.grid.ariaCompleted", { n: tile.n, score: tile.set.attempt?.score ?? 0, max: tile.set.maxScore });
  return undefined;
}

export function LiveGrid({ slug, view }: { readonly slug: string; readonly view: ProgramView }) {
  return (
    <TriviaCard titleId="grid-title">
      <CardHeading id="grid-title" icon={<SquaresFourIcon size={24} weight="duotone" />}>
        {t("trivia.grid.title")}
      </CardHeading>
      {view.closed ? (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-base">
          {t("trivia.live.closedNotice")}
        </p>
      ) : null}
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-5">
        {view.tiles.map((tile, i) => {
          const playable = !view.closed && (tile.state === "unlocked" || tile.state === "in-progress");
          const tileClass = "flex min-h-11 w-full flex-col gap-2 rounded-xl";
          return (
            <li key={tile.set.id} style={{ animationDelay: `${String(Math.min(i, 20) * 40)}ms` }} className="tile-in">
              {playable ? (
                <a href={`/${slug}/set/${String(tile.n)}`} className={cn(tileClass, "transition-opacity duration-(--duration-fast) hover:opacity-90")}>
                  <TileBody tile={tile} closed={view.closed} />
                </a>
              ) : (
                <div role="group" aria-disabled={tile.state === "locked" ? "true" : undefined} aria-label={ariaLabel(tile)} className={tileClass}>
                  <TileBody tile={tile} closed={view.closed} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </TriviaCard>
  );
}
