"use client";

// Card 2, the leaderboard (US-027, AC-Q2; plan M9.2 user decision 2026-11-10): rendered with the page (a page
// load is a refresh), and refreshed only by the "Perbarui" button: no timer polling, no push. "Diperbarui ...
// lalu" is the age of the server's 5 s top-N cache entry plus the time since this browser received it. The
// player's own row is always fresh (play_standing). Names arrive masked from the database.
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { ArrowClockwiseIcon, CircleNotchIcon, RankingIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { formatMs, formatNumber } from "../../../lib/format.ts";
import { collapsedRows } from "../../../lib/play/prize-ranks.ts";
import { t } from "../../../lib/t.ts";
import { type LeaderboardTier, RankCell } from "../rank-cell.tsx";
import { CardHeading, TriviaCard } from "../trivia-card.tsx";

/** The button rests this long after a refresh (the server limits refreshes too). */
const COOLDOWN_MS = 5_000;

export interface BoardRow {
  readonly rank: number;
  readonly name: string;
  readonly score: number;
  readonly totalMs: number;
}

export interface BoardMe {
  readonly rank: number | null;
  readonly name: string;
  readonly score: number;
  readonly totalMs: number;
  readonly ranked: number;
}

export interface BoardData {
  readonly top: readonly BoardRow[];
  readonly me: BoardMe;
  /** The age of the data when the server sent it. */
  readonly ageMs: number;
}

function agoLabel(seconds: number): string {
  if (seconds < 10) return t("leaderboard.justNow");
  if (seconds < 60) return t("leaderboard.secondsAgo", { n: seconds });
  return t("leaderboard.minutesAgo", { n: Math.floor(seconds / 60) });
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** The API's answer (lib/play/trivia.ts handleLeaderboard) as BoardData, or null when it is not one. */
function parseBoard(body: Readonly<Record<string, unknown>>): BoardData | null {
  const top = body["top"];
  const me = body["me"] as Record<string, unknown> | undefined;
  if (!Array.isArray(top) || typeof me !== "object") return null;
  return {
    top: top.map((r: Record<string, unknown>) => ({ rank: num(r["rank"]), name: str(r["name"]), score: num(r["score"]), totalMs: num(r["total_ms"]) })),
    me: { rank: typeof me["rank"] === "number" ? me["rank"] : null, name: str(me["name"]), score: num(me["score"]), totalMs: num(me["total_ms"]), ranked: num(me["ranked"]) },
    ageMs: num(body["age_ms"]),
  };
}

/**
 * `tiers`: the program's prize tiers (the page already has them). They decide how many rows a phone shows before "Lihat semua"
 * (every winner, at least 5) and which ranks wear a medal, in their tier's colour (lib/play/prize-ranks.ts).
 */
export function LiveLeaderboard({ programId, initial, tiers }: { readonly programId: string; readonly initial: BoardData; readonly tiers: readonly LeaderboardTier[] }) {
  const collapsed = collapsedRows(tiers);
  const [data, setData] = useState(initial);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // The label only: re-rendered every 15 s, nothing is fetched.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      clearInterval(id);
      window.clearTimeout(timer.current);
    };
  }, []);

  async function refresh(): Promise<void> {
    setLoading(true);
    setCooldown(true);
    setNotice(null);
    timer.current = window.setTimeout(() => {
      setCooldown(false);
    }, COOLDOWN_MS);
    try {
      const response = await fetch(`/api/v1/play/leaderboard?program=${encodeURIComponent(programId)}`, { credentials: "same-origin", cache: "no-store", redirect: "error" });
      const body: unknown = await response.json().catch(() => ({}));
      const parsed = response.ok && typeof body === "object" && body !== null ? parseBoard(body as Record<string, unknown>) : null;
      if (parsed !== null) {
        setData(parsed);
        const at = Date.now();
        setReceivedAt(at);
        setNow(at);
      } else if (response.status === 429) {
        setNotice(t("leaderboard.rateLimited", { seconds: Number(response.headers.get("retry-after") ?? "10") || 10 }));
      } else if (response.status === 401) {
        window.location.assign("/login");
      } else {
        setNotice(t("leaderboard.failed"));
      }
    } catch {
      setNotice(t("leaderboard.failed"));
    } finally {
      setLoading(false);
    }
  }

  const ageSeconds = Math.max(0, Math.floor((data.ageMs + (now - receivedAt)) / 1000));
  const meOnTop = data.me.rank !== null && data.top.some((r) => r.rank === data.me.rank);

  return (
    <TriviaCard titleId="leaderboard-title">
      <CardHeading
        id="leaderboard-title"
        icon={<RankingIcon size={24} weight="duotone" />}
        action={
          <Button variant="outline" onClick={() => void refresh()} disabled={cooldown} aria-busy={loading}>
            {loading ? <CircleNotchIcon aria-hidden="true" size={18} className="motion-safe:animate-spin" /> : <ArrowClockwiseIcon aria-hidden="true" size={18} weight="bold" />}
            {loading ? t("leaderboard.refreshing") : t("leaderboard.refresh")}
          </Button>
        }
      >
        {t("leaderboard.title")}
      </CardHeading>
      <p aria-live="off" className="-mt-2 text-sm text-muted-foreground">
        {t("leaderboard.updatedAgo", { ago: agoLabel(ageSeconds) })}
      </p>
      {notice === null ? null : (
        <p role="status" className="text-sm font-medium text-destructive">
          {notice}
        </p>
      )}
      {data.top.length === 0 ? (
        <p className="text-base text-muted-foreground">{t("leaderboard.empty")}</p>
      ) : (
        <Table className="text-base tabular">
          <caption className="sr-only">{t("leaderboard.captionTopN", { n: data.top.length })}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-14 text-sm">{t("leaderboard.colRank")}</TableHead>
              <TableHead className="text-sm">{t("leaderboard.colName")}</TableHead>
              <TableHead className="text-right text-sm">{t("leaderboard.colScore")}</TableHead>
              <TableHead className="text-right text-sm">{t("leaderboard.colTime")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.top.map((r, i) => {
              const mine = r.rank === data.me.rank;
              return (
                <TableRow
                  key={r.rank}
                  className={cn(i >= collapsed && !expanded && !mine && "hidden md:table-row", mine && "bg-muted shadow-[inset_4px_0_0_var(--color-primary)] hover:bg-muted")}
                >
                  <TableCell className="h-11 font-heading text-lg">
                    <RankCell rank={r.rank} tiers={tiers} />
                  </TableCell>
                  <TableCell className="h-11 font-medium break-words">
                    <span className="flex flex-wrap items-center gap-2">
                      {r.name}
                      {mine ? <Badge>{t("leaderboard.you")}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="h-11 text-right whitespace-nowrap">{formatNumber(r.score)}</TableCell>
                  <TableCell className="h-11 text-right whitespace-nowrap">{formatMs(r.totalMs)}</TableCell>
                </TableRow>
              );
            })}
            {meOnTop ? null : (
              <>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="h-6 py-0 text-center text-muted-foreground">
                    <span aria-hidden="true">{"⋮"}</span>
                    <span className="sr-only">{t("leaderboard.gap")}</span>
                  </TableCell>
                </TableRow>
                <TableRow className="bg-muted shadow-[inset_4px_0_0_var(--color-primary)] hover:bg-muted">
                  <TableCell className="h-12 font-heading text-lg">
                    <RankCell rank={data.me.rank} tiers={tiers} />
                  </TableCell>
                  <TableCell className="h-12 font-semibold">
                    <span className="flex flex-wrap items-center gap-2">
                      {data.me.name}
                      <Badge>{t("leaderboard.you")}</Badge>
                    </span>
                    <span className="sr-only">{data.me.rank === null ? t("leaderboard.notPlayed") : `${t("leaderboard.myRank")} ${t("leaderboard.ofPlayers", { n: data.me.ranked })}`}</span>
                  </TableCell>
                  <TableCell className="h-12 text-right font-semibold whitespace-nowrap">{formatNumber(data.me.score)}</TableCell>
                  <TableCell className="h-12 text-right font-semibold whitespace-nowrap">{formatMs(data.me.totalMs)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      )}
      {data.top.length === 0 ? null : <p className="text-sm text-muted-foreground">{t("leaderboard.penaltyNote")}</p>}
      {data.top.length > collapsed ? (
        <Button
          variant="ghost"
          className="md:hidden"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((v) => !v);
          }}
        >
          {expanded ? t("leaderboard.showLess") : t("leaderboard.showAll")}
        </Button>
      ) : null}
    </TriviaCard>
  );
}
