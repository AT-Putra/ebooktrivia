"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowClockwiseIcon, CircleNotchIcon, RankingIcon } from "@phosphor-icons/react";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { formatMinSec, formatNumber } from "../../lib/format.ts";
import { collapsedRows } from "../../lib/play/prize-ranks.ts";
import { t } from "../../lib/t.ts";
import type { LeaderRow } from "../../lib/trivia-fixtures.ts";
import { type LeaderboardTier, RankCell } from "./rank-cell.tsx";
import { CardHeading, TriviaCard } from "./trivia-card.tsx";

function agoLabel(seconds: number): string {
  if (seconds < 10) return t("leaderboard.justNow");
  if (seconds < 60) return t("leaderboard.secondsAgo", { n: seconds });
  return t("leaderboard.minutesAgo", { n: Math.floor(seconds / 60) });
}

interface LeaderboardCardProps {
  rows: LeaderRow[];
  me: LeaderRow;
  /** The program's prize tiers: the medals and the rows shown first follow them, as on the live page. */
  tiers: readonly LeaderboardTier[];
  initialAgeSeconds?: number;
}

export function LeaderboardCard({ rows, me, tiers, initialAgeSeconds = 120 }: LeaderboardCardProps) {
  const collapsed = collapsedRows(tiers);
  const [expanded, setExpanded] = useState(false);
  const [age, setAge] = useState(initialAgeSeconds);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const timers = useRef<number[]>([]);

  // "Diperbarui X lalu" re-renders at most every 30 s, derived from the fetch timestamp.
  useEffect(() => {
    const id = setInterval(() => {
      setAge((a) => a + 30);
    }, 30_000);
    return () => {
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((id) => {
        clearTimeout(id);
      });
    };
  }, []);

  function refresh() {
    setLoading(true);
    setCooldown(true);
    timers.current.push(
      window.setTimeout(() => {
        setLoading(false);
        setAge(0);
      }, 700),
      window.setTimeout(() => {
        setCooldown(false);
      }, 3000),
    );
  }

  return (
    <TriviaCard titleId="leaderboard-title">
      <CardHeading
        id="leaderboard-title"
        icon={<RankingIcon size={24} weight="duotone" />}
        action={
          <Button variant="outline" size="default" onClick={refresh} disabled={cooldown} aria-busy={loading}>
            {loading ? (
              <CircleNotchIcon aria-hidden="true" size={18} className="motion-safe:animate-spin" />
            ) : (
              <ArrowClockwiseIcon aria-hidden="true" size={18} weight="bold" />
            )}
            {loading ? t("leaderboard.refreshing") : t("leaderboard.refresh")}
          </Button>
        }
      >
        {t("leaderboard.title")}
      </CardHeading>
      <p aria-live="off" className="-mt-2 text-sm text-muted-foreground">
        {t("leaderboard.updatedAgo", { ago: agoLabel(age) })}
      </p>

      <Table className="text-base tabular max-sm:[&_td]:px-1 max-sm:[&_th]:px-1">
        <caption className="sr-only">{t("leaderboard.captionTop")}</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14 text-sm">{t("leaderboard.colRank")}</TableHead>
            <TableHead className="text-sm whitespace-normal">{t("leaderboard.colName")}</TableHead>
            <TableHead className="text-right text-sm">{t("leaderboard.colScore")}</TableHead>
            <TableHead className="text-right text-sm">{t("leaderboard.colTime")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => {
            // The player's own row is never folded away on a phone.
            const mine = r.rank === me.rank;
            return (
              <TableRow key={r.rank} className={cn(i >= collapsed && !expanded && !mine && "hidden md:table-row")}>
                <TableCell className="h-11 font-heading text-lg">
                  <RankCell rank={r.rank} tiers={tiers} />
                </TableCell>
                <TableCell className="h-11 font-medium">{r.name}</TableCell>
                <TableCell className="h-11 text-right whitespace-nowrap">{formatNumber(r.score)}</TableCell>
                <TableCell className="h-11 text-right whitespace-nowrap">{formatMinSec(r.seconds)}</TableCell>
              </TableRow>
            );
          })}
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="h-6 py-0 text-center text-muted-foreground">
              <span aria-hidden="true">{"⋮"}</span>
              <span className="sr-only">{t("leaderboard.gap")}</span>
            </TableCell>
          </TableRow>
          <TableRow className="bg-muted shadow-[inset_4px_0_0_var(--color-primary)] hover:bg-muted">
            <TableCell className="h-12 font-heading text-lg">
              <RankCell rank={me.rank} tiers={tiers} />
            </TableCell>
            <TableCell className="h-12 font-semibold">
              <span className="flex flex-wrap items-center gap-2">
                <span>{me.name}</span>
                <Badge>{t("leaderboard.you")}</Badge>
              </span>
              <span className="sr-only">{t("leaderboard.myRank")}</span>
            </TableCell>
            <TableCell className="h-12 text-right font-semibold whitespace-nowrap">{formatNumber(me.score)}</TableCell>
            <TableCell className="h-12 text-right font-semibold whitespace-nowrap">{formatMinSec(me.seconds)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {rows.length > collapsed ? (
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
