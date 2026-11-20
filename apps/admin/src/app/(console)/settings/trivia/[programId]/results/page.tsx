import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FlagIcon, LockIcon } from "@phosphor-icons/react/ssr";
import { isUuid } from "@ebooktrivia/core";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Card, CardDescription, CardTitle } from "@ebooktrivia/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { ActionForm } from "../../../../../../components/settings/action-form.tsx";
import { CheckboxField, Notice, PageHeading, TextArea, TextField } from "../../../../../../components/settings/fields.tsx";
import { requireAdmin } from "../../../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../../../lib/next/runtime.ts";
import { can } from "../../../../../../lib/policy.ts";
import { FLAG_LABELS, getContestResults, WINNER_BLOCKED, wibLocal } from "../../../../../../lib/settings/contest.ts";
import { confirmWinnersAction, extendDeadlinesAction } from "../../actions.ts";

export const metadata: Metadata = { title: "Contest results | Admin Console" };

const WIB = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" });
const STATUS_LABEL: Readonly<Record<string, string>> = { draft: "Draft", published: "Published", awaiting_confirmation: "Awaiting winners", finalized: "Finalized" };
const WINNER_LABEL: Readonly<Record<string, string>> = { awaiting_confirmation: "Awaiting confirmation", confirmed: "Confirmed", flagged: "Flagged", revoked: "Revoked" };

/**
 * A program's contest results (US-028): the frozen results snapshot and its winners, the anti-cheat
 * flags (never acted on automatically), the Owner's winner confirmation and the Owner's deadline
 * extension for outages. Reports permission (Staff see it); the two forms are Owner-only. Players
 * appear masked, with a short reference. Times in WIB.
 */
export default async function ContestResultsPage({ params }: { params: Promise<{ programId: string }> }) {
  const admin = await requireAdmin({ permission: "reports.view" });
  const { programId } = await params;
  if (!isUuid(programId)) notFound();
  const { sql } = await getRuntime();
  const results = await getContestResults(sql, programId);
  if (results === null) notFound();
  const now = new Date();
  const canConfirm = can(admin.role, "winners.confirm") && results.snapshot !== null && results.status === "awaiting_confirmation";
  const canExtend = can(admin.role, "contest.extend_deadlines") && results.snapshot === null && results.status === "published" && now < results.graceEnd;
  return (
    <>
      <p className="text-sm">
        <Link href="/settings/trivia" className="underline underline-offset-4">
          Trivia
        </Link>
        {" / "}
        <Link href={`/settings/trivia/${results.programId}`} className="underline underline-offset-4">
          {results.name}
        </Link>
      </p>
      <PageHeading
        title={`${results.name}: contest results`}
        description="At the end of grace the worker freezes the leaderboard (eligible players only) and writes the winners per prize tier. The Owner confirms them before they appear, masked, on the banner card. Times in WIB."
      />
      <Card data-testid="contest-status">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Status</CardTitle>
          <Badge variant="secondary">{STATUS_LABEL[results.status] ?? results.status}</Badge>
          {results.snapshot === null ? null : (
            <Badge variant="info">
              <LockIcon aria-hidden="true" />
              Results final
            </Badge>
          )}
        </div>
        <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
          <dt className="text-muted-foreground">Grace period ends</dt>
          <dd>{WIB.format(results.graceEnd)}</dd>
          <dt className="text-muted-foreground">Results snapshot</dt>
          <dd data-testid="snapshot-summary">
            {results.snapshot === null
              ? "Not yet: written by the worker once the grace period has ended and every running question has ended (usually within about 2 minutes)."
              : `Frozen at ${WIB.format(results.snapshot.frozenAt)} (written ${WIB.format(results.snapshot.createdAt)}), ${String(results.snapshot.ranked)} eligible player${results.snapshot.ranked === 1 ? "" : "s"} ranked.`}
          </dd>
          <dt className="text-muted-foreground">Winners confirmed</dt>
          <dd>{results.winnersConfirmedAt === null ? "No" : WIB.format(results.winnersConfirmedAt)}</dd>
        </dl>
      </Card>

      <Card data-testid="contest-winners">
        <CardTitle className="text-base">Winners</CardTitle>
        <CardDescription>
          Ranked by score, then total answer time, then the earliest finish (unfinished last); an exact tie goes to the earlier first payment. Flags are information only.
        </CardDescription>
        {results.winners.length === 0 ? (
          <p className="text-sm">{results.snapshot === null ? "No winners yet." : "No player ranked inside a prize tier."}</p>
        ) : (
          <Table aria-label="Winners">
            <TableHeader>
              <TableRow>
                <TableHead>Rank</TableHead>
                <TableHead>Prize</TableHead>
                <TableHead>Player</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.winners.map((w) => (
                <TableRow key={w.rank} data-testid={`winner-${String(w.rank)}`}>
                  <TableCell>{w.rank}</TableCell>
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
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">{w.flags.length === 0 ? "None" : w.flags.map((f) => FLAG_LABELS[f]).join("; ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canConfirm ? (
          results.winners.some((w) => !w.eligible || w.status === "flagged") ? (
            <Notice tone="warning" testId="confirm-blocked">
              {WINNER_BLOCKED}
            </Notice>
          ) : (
            <ActionForm action={confirmWinnersAction} submitLabel="Confirm winners" testId="confirm-winners" className="flex flex-col gap-3 border-t pt-4">
              <input type="hidden" name="programId" value={results.programId} />
              <CheckboxField
                id="confirm-winners-check"
                name="confirm"
                label="I checked the winners and their flags. Publish them, masked, on the banner card."
                hint="This cannot be undone: the winner list is frozen."
              />
            </ActionForm>
          )
        ) : null}
      </Card>

      <Card data-testid="contest-flags">
        <div className="flex flex-wrap items-center gap-2">
          <FlagIcon aria-hidden="true" />
          <CardTitle className="text-base">Anti-cheat flags</CardTitle>
        </div>
        <CardDescription>
          {`For review only: nothing happens to a flagged player automatically. Late picks (slower than the timer) do not count as fast. ${
            results.flaggedTotal > results.flagged.length ? `Showing ${String(results.flagged.length)} of ${String(results.flaggedTotal)} flagged players, most flags first.` : ""
          }`}
        </CardDescription>
        {results.flagged.length === 0 ? (
          <p className="text-sm">No flagged player.</p>
        ) : (
          <Table aria-label="Flagged players">
            <TableHeader>
              <TableRow>
                <TableHead>Player</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead>Median answer time</TableHead>
                <TableHead>Players on the same IP / browser</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.flagged.map((f) => (
                <TableRow key={f.playerId} data-testid={`flagged-${f.ref}`}>
                  <TableCell>
                    {f.maskedName}
                    <span className="block text-xs text-muted-foreground">ref {f.ref}</span>
                  </TableCell>
                  <TableCell className="text-xs">{f.flags.map((k) => FLAG_LABELS[k]).join("; ")}</TableCell>
                  <TableCell>{f.medianMs === null ? "No answers" : `${String(Math.round(f.medianMs))} ms over ${String(f.pickedAnswers)}`}</TableCell>
                  <TableCell>
                    {f.ipPlayers} / {f.uaPlayers}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {canExtend ? (
        <Card data-testid="contest-extension">
          <CardTitle className="text-base">Extend deadlines after an outage</CardTitle>
          <CardDescription>
            {`Gives each open question served before the outage ended, whose deadline passed during the outage, back the time it lost (from the outage start, at most its timer), counted from now. A question is extended at most once; an answer inside the extension counts, charged the question's full timer. ${String(results.openQuestions)} question${results.openQuestions === 1 ? " is" : "s are"} open now. Audited.`}
          </CardDescription>
          <ActionForm action={extendDeadlinesAction} submitLabel="Extend deadlines" variant="destructive" testId="extend-deadlines" className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="programId" value={results.programId} />
            <TextField
              id="extend-started"
              name="outageStartedAt"
              label="Outage started (WIB)"
              type="datetime-local"
              defaultValue={wibLocal(new Date(now.getTime() - 15 * 60_000))}
              hint={`Within the last ${String(results.extensionMaxMinutes)} minutes (Settings, OTP and rate limits).`}
            />
            <TextField
              id="extend-ended"
              name="outageEndedAt"
              label="Outage ended (WIB)"
              type="datetime-local"
              defaultValue={wibLocal(now)}
              hint="After it started, not in the future. Only questions served before this are extended."
            />
            <div className="sm:col-span-2">
              <TextArea id="extend-reason" name="reason" label="Reason" rows={2} minLength={10} maxLength={500} required hint="10 to 500 characters, no personal data." />
            </div>
            <div className="sm:col-span-2">
              <CheckboxField id="extend-confirm" name="confirm" label="I understand this changes the contest's timing for the affected players now." />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
