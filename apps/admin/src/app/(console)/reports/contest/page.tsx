import type { Metadata } from "next";
import Link from "next/link";
import { FlagIcon, LockIcon } from "@phosphor-icons/react/ssr";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { EmptyState, ExportForm, FilterForm, FilterSelect, KpiGrid } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatBps, formatInt, formatWibTime } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import { can } from "../../../../lib/policy.ts";
import { param, type Query } from "../../../../lib/reports/common.ts";
import { leaderboard, LEADERBOARD_LIMIT, participation, programChoices } from "../../../../lib/reports/contest-report.ts";
import { FLAG_LABELS, getContestResults } from "../../../../lib/settings/contest.ts";

export const metadata: Metadata = { title: "Contest report | Admin Console" };
export const dynamic = "force-dynamic";

const WINNER_LABEL: Readonly<Record<string, string>> = { awaiting_confirmation: "Awaiting confirmation", confirmed: "Confirmed", flagged: "Flagged", revoked: "Revoked" };
const secondsOf = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * The trivia report (AC-A9): players and completion per set, the leaderboard, the anti-cheat flags and the winners of a program.
 * Staff view it (reports.view) with every player masked; the winners export (names, phones, e-mails for prize fulfillment) is
 * Owner-only (winners.export), a POST form to an audited route. Confirming winners and the outage tool stay on the results page.
 */
export default async function ContestReportPage({ searchParams }: { searchParams: Promise<Query> }) {
  const admin = await requireAdmin({ permission: "reports.view" });
  const { sql } = await getRuntime();
  const programs = await programChoices(sql);
  const asked = param(await searchParams, "program");
  const program = programs.find((p) => isUuid(asked) && p.id === asked) ?? programs.find((p) => p.status !== "draft") ?? programs[0];
  const filter = (
    <FilterForm label="Program" action="/reports/contest" reset="/reports/contest">
      <FilterSelect id="c-program" name="program" label="Program" value={program?.id ?? null} all="Latest program" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
    </FilterForm>
  );
  if (program === undefined) {
    return (
      <>
        <PageHeading title="Contest report" description="Players, completion per set, the leaderboard, flags and winners of a program." />
        <EmptyState testId="contest-empty">There is no program yet.</EmptyState>
      </>
    );
  }
  const [people, board, results] = await Promise.all([participation(sql, program.id), leaderboard(sql, program.id), getContestResults(sql, program.id)]);
  return (
    <>
      <PageHeading title="Contest report" description={`${program.name}: who plays, how far they get, who leads, which players look suspicious and who wins. Players are masked.`} />
      {filter}
      <KpiGrid
        title="Participation"
        tiles={[
          { label: "Eligible players", value: formatInt(people.eligiblePlayers), note: "A paid, not refunded order", testId: "kpi-eligible" },
          { label: "Started playing", value: formatInt(people.playersStarted), testId: "kpi-started" },
          { label: "Finished every set", value: formatInt(people.playersCompletedAll), testId: "kpi-completed" },
        ]}
      />
      <Card data-testid="contest-sets">
        <CardTitle className="text-base">Completion per set</CardTitle>
        {people.sets.length === 0 ? (
          <EmptyState testId="sets-empty">This program has no sets yet.</EmptyState>
        ) : (
          <Table aria-label="Completion per set">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Set</TableHead>
                <TableHead className="text-right">Started</TableHead>
                <TableHead className="text-right">Finished</TableHead>
                <TableHead className="text-right">Completion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.sets.map((s) => (
                <TableRow key={s.setId} data-testid="set-row">
                  <TableCell>{`${String(s.position)}. ${s.title}`}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(s.started)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(s.completed)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatBps(s.completionBps)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="contest-leaderboard">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Leaderboard</CardTitle>
          {board.frozen ? (
            <Badge variant="info">
              <LockIcon aria-hidden="true" />
              Final
            </Badge>
          ) : (
            <Badge variant="secondary">Live</Badge>
          )}
        </div>
        <CardDescription>
          {board.frozen && board.frozenAt !== null
            ? `Frozen at ${formatWibTime(board.frozenAt)}: the results snapshot, eligible players only.`
            : "Standings now, eligible players only: score, then total answer time, then the earliest finish."}{" "}
          {board.total > board.rows.length ? `Showing the first ${String(LEADERBOARD_LIMIT)} of ${formatInt(board.total)}.` : ""}
        </CardDescription>
        {board.rows.length === 0 ? (
          <EmptyState testId="leaderboard-empty">Nobody is ranked yet.</EmptyState>
        ) : (
          <Table aria-label="Leaderboard">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Rank</TableHead>
                <TableHead>Player</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right">Answer time</TableHead>
                <TableHead>Finished</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {board.rows.map((r) => (
                <TableRow key={`${String(r.rank)}:${r.ref}`} data-testid="leaderboard-row">
                  <TableCell className="tabular">{r.rank}</TableCell>
                  <TableCell>
                    {r.name}
                    <span className="block text-xs text-muted-foreground">
                      {r.phone ?? "no phone"} · ref {r.ref}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(r.score)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{secondsOf(r.totalMs)}</TableCell>
                  <TableCell className="tabular whitespace-nowrap">{r.finishedAt === null ? "Not finished" : formatWibTime(r.finishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="contest-flags">
        <div className="flex flex-wrap items-center gap-2">
          <FlagIcon aria-hidden="true" />
          <CardTitle className="text-base">Anti-cheat flags</CardTitle>
        </div>
        <CardDescription>For review only: nothing happens to a flagged player automatically.</CardDescription>
        {results === null || results.flagged.length === 0 ? (
          <EmptyState testId="flags-empty">No flagged player.</EmptyState>
        ) : (
          <Table aria-label="Flagged players">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Player</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead>Median answer time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.flagged.map((f) => (
                <TableRow key={f.playerId} data-testid="flag-row">
                  <TableCell>
                    {f.maskedName}
                    <span className="block text-xs text-muted-foreground">ref {f.ref}</span>
                  </TableCell>
                  <TableCell className="text-xs">{f.flags.map((k) => FLAG_LABELS[k]).join("; ")}</TableCell>
                  <TableCell>{f.medianMs === null ? "No answers" : `${String(Math.round(f.medianMs))} ms over ${String(f.pickedAnswers)}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card data-testid="contest-winners">
        <CardTitle className="text-base">Winners</CardTitle>
        {results === null || results.winners.length === 0 ? (
          <EmptyState testId="winners-empty">{board.frozen ? "No player ranked inside a prize tier." : "No winners yet: they are drawn from the frozen leaderboard at the end of the grace period."}</EmptyState>
        ) : (
          <Table aria-label="Winners">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Rank</TableHead>
                <TableHead>Prize</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.winners.map((w) => (
                <TableRow key={w.rank} data-testid="winner-row">
                  <TableCell className="tabular">{w.rank}</TableCell>
                  <TableCell>{w.prizeName}</TableCell>
                  <TableCell>
                    {w.maskedName}
                    <span className="block text-xs text-muted-foreground">
                      {w.maskedPhone ?? "no phone"} · ref {w.ref}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant={w.status === "confirmed" ? "success" : "secondary"}>{WINNER_LABEL[w.status] ?? w.status}</Badge>
                      {w.eligible ? null : <Badge variant="destructive">Refunded since the snapshot</Badge>}
                      {w.flags.length === 0 ? null : <Badge variant="warning">{w.flags.length === 1 ? "1 flag" : `${String(w.flags.length)} flags`}</Badge>}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Winners are confirmed by the Owner on the{" "}
          <Link href={`/settings/trivia/${program.id}/results`} className="underline underline-offset-4">
            contest results page
          </Link>
          .
        </p>
        {can(admin.role, "winners.export") ? (
          <ExportForm
            action="/reports/contest/export"
            fields={{ program: program.id }}
            label="Download winners CSV"
            note="Winners with their name, phone and e-mail for prize fulfillment. Owner only; every download is recorded in the audit log."
            testId="winners-export"
          />
        ) : null}
      </Card>
    </>
  );
}
