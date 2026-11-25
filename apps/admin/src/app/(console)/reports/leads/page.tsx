import type { Metadata } from "next";
import { ArrowClockwiseIcon, CurrencyCircleDollarIcon, GameControllerIcon, ShoppingCartIcon, TrendUpIcon, UsersThreeIcon } from "@phosphor-icons/react/ssr";
import { wibDateOf } from "@ebooktrivia/core";
import { Card } from "@ebooktrivia/ui/components/card";
import { TableBody, TableCell, TableFooter, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { SortHeader, StatCard } from "../../../../components/reports/leads-ui.tsx";
import { DateInput, FilterForm, FilterSelect } from "../../../../components/reports/report-ui.tsx";
import { PageHeading } from "../../../../components/settings/fields.tsx";
import { formatBps, formatDayYear, formatInt, formatRupiah, formatWibStamp } from "../../../../lib/format.ts";
import { requireAdmin } from "../../../../lib/next/require-admin.ts";
import { getRuntime } from "../../../../lib/next/runtime.ts";
import type { Query } from "../../../../lib/reports/common.ts";
import {
  LEADS_DEFAULT_DAYS,
  leadsByDay,
  leadsTotals,
  parseLeadsFilters,
  parseSort,
  playRateBps,
  type Sort,
  sortDays,
  successRateBps,
} from "../../../../lib/reports/leads.ts";

export const metadata: Metadata = { title: "Leads Report | Admin Console" };
// Live figures: read from the tables on every open, never a build-time snapshot.
export const dynamic = "force-dynamic";

const NUM = "text-right font-mono tabular";

/**
 * The Leads Report (the Owner's request of 2026-11-25): today's leads, purchases, success rate, revenue, active players and play
 * rate, live, then one row per day of the chosen range (default: the 10 days before today) with a TOTAL row. Owner and Staff
 * (reports.view, like the Sales report): counts and revenue only, no buyer on it. Definitions: lib/reports/leads.ts.
 */
export default async function LeadsReportPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin({ permission: "reports.view" });
  const { sql } = await getRuntime();
  const now = new Date();
  const today = wibDateOf(now);
  const query = await searchParams;
  const { filters, error } = parseLeadsFilters(query, now);
  const sort = parseSort(query);
  const [programs, todayRows, days] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM public.programs ORDER BY created_at DESC LIMIT 200`,
    leadsByDay(sql, { from: today, to: today, programId: filters.programId }),
    leadsByDay(sql, filters),
  ]);
  const t = todayRows[0] ?? { day: today, leads: 0, purchase: 0, revenueIdr: 0, active: 0, waTotal: 0, waSent: 0, waFailed: 0 };
  const total = leadsTotals(days);
  const rows = sortDays(days, sort);
  const programName = filters.programId === null ? "all programs" : (programs.find((p) => p.id === filters.programId)?.name ?? "unknown program");

  const keep: Record<string, string> = {};
  if (!filters.isDefault) {
    keep.from = filters.from;
    keep.to = filters.to;
  }
  if (filters.programId !== null) keep.program = filters.programId;
  const hrefFor = (s: Sort): string => {
    const params = new URLSearchParams(keep);
    if (s.key !== "day" || s.dir !== "desc") {
      params.set("sort", s.key);
      params.set("dir", s.dir);
    }
    const qs = params.toString();
    return qs === "" ? "/reports/leads" : `/reports/leads?${qs}`;
  };
  const self = hrefFor(sort);
  const rangeText = `${formatDayYear(filters.from)} to ${formatDayYear(filters.to)}`;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeading title="Leads Report" description="Leads, purchases, players and WhatsApp ebook sends at a glance." />
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground" data-testid="last-updated">
            Last updated: <span className="tabular">{formatWibStamp(now)}</span>
          </p>
          {/* A plain link: a full reload reads every figure again. */}
          <a href={self} aria-label="Refresh the figures" title="Refresh" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border bg-card transition-colors duration-150 hover:bg-muted" data-testid="refresh">
            <ArrowClockwiseIcon aria-hidden="true" size={18} />
          </a>
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/60 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground" data-testid="filter-error">
          {error} The last {String(LEADS_DEFAULT_DAYS)} days are shown instead.
        </p>
      )}
      <FilterForm label="Leads Report filters" action="/reports/leads" reset="/reports/leads">
        <DateInput id="f-from" name="from" label="From (WIB)" value={filters.from} />
        <DateInput id="f-to" name="to" label="To (WIB)" value={filters.to} />
        <FilterSelect id="f-program" name="program" label="Program" value={filters.programId} all="All programs" options={programs.map((p) => ({ value: p.id, label: p.name }))} />
        {/* Applying the filters keeps the table's order. */}
        {sort.key === "day" && sort.dir === "desc" ? null : (
          <>
            <input type="hidden" name="sort" value={sort.key} />
            <input type="hidden" name="dir" value={sort.dir} />
          </>
        )}
      </FilterForm>

      <section aria-labelledby="today-title" className="flex flex-col gap-2">
        <h2 id="today-title" className="text-sm font-semibold tracking-wide uppercase">
          Today (live) · {formatDayYear(today)} · {programName}
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6" data-testid="today-cards">
          <StatCard icon={UsersThreeIcon} tone="info" label="Leads" value={formatInt(t.leads)} note="Orders that reached the payment page today" testId="today-leads" />
          <StatCard icon={ShoppingCartIcon} tone="success" label="Purchase" value={formatInt(t.purchase)} note="Paid orders today" testId="today-purchase" />
          <StatCard icon={TrendUpIcon} tone="success" label="Success Rate" sublabel="Purchase / Leads" value={formatBps(successRateBps(t))} note="Today" testId="today-success-rate" />
          <StatCard icon={CurrencyCircleDollarIcon} tone="warning" label="Revenue" value={formatRupiah(t.revenueIdr)} note="Paid orders today" testId="today-revenue" />
          <StatCard icon={GameControllerIcon} tone="neutral" label="Active" value={formatInt(t.active)} note="Buyers who started a trivia set today" testId="today-active" />
          <StatCard
            icon={TrendUpIcon}
            tone="neutral"
            label="Play Rate"
            sublabel="Active / Leads"
            value={formatBps(playRateBps(t))}
            note="Can pass 100%: buyers from earlier days play too"
            testId="today-play-rate"
          />
        </ul>
      </section>

      <section aria-labelledby="days-title" className="flex flex-col gap-2">
        <h2 id="days-title" className="text-sm font-semibold tracking-wide uppercase">
          {filters.isDefault ? `Last ${String(LEADS_DEFAULT_DAYS)} days (yesterday and before)` : `Daily performance, ${formatDayYear(filters.from)} to ${formatDayYear(filters.to)}`} · {programName}
        </h2>
        <Card className="gap-0 overflow-hidden p-0 md:p-0" data-testid="days-card">
          <div role="region" aria-labelledby="days-title" tabIndex={0} className="relative w-full overflow-x-auto">
            <table aria-labelledby="days-title" className="w-full text-sm" data-testid="days-table">
              <TableHeader className="bg-muted">
                <TableRow className="hover:bg-transparent">
                  <SortHeader label="Date" sortKey="day" sort={sort} hrefFor={hrefFor} align="left" className="sticky left-0 z-(--z-raised) bg-muted pl-3" />
                  <SortHeader label="Leads" sortKey="leads" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Purchase" sortKey="purchase" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Success Rate" sublabel="Purchase / Leads" sortKey="successRate" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Revenue" sortKey="revenue" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Active" sortKey="active" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Play Rate" sublabel="Active / Leads" sortKey="playRate" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Total WA" sortKey="waTotal" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Sent" sortKey="waSent" sort={sort} hrefFor={hrefFor} />
                  <SortHeader label="Failed" sortKey="waFailed" sort={sort} hrefFor={hrefFor} className="pr-3" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.day} data-testid="leads-day-row">
                    <TableCell className="sticky left-0 bg-card pl-3 whitespace-nowrap">{formatDayYear(d.day)}</TableCell>
                    <TableCell className={NUM}>{formatInt(d.leads)}</TableCell>
                    <TableCell className={NUM}>{formatInt(d.purchase)}</TableCell>
                    <TableCell className={NUM}>{formatBps(successRateBps(d))}</TableCell>
                    <TableCell className={`${NUM} whitespace-nowrap`}>{formatRupiah(d.revenueIdr)}</TableCell>
                    <TableCell className={NUM}>{formatInt(d.active)}</TableCell>
                    <TableCell className={NUM}>{formatBps(playRateBps(d))}</TableCell>
                    <TableCell className={NUM}>{formatInt(d.waTotal)}</TableCell>
                    <TableCell className={NUM}>{formatInt(d.waSent)}</TableCell>
                    <TableCell className={`${NUM} pr-3 ${d.waFailed > 0 ? "font-semibold text-destructive" : ""}`}>{formatInt(d.waFailed)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter className="text-base">
                <TableRow className="hover:bg-transparent" data-testid="leads-total-row">
                  <TableCell className="sticky left-0 bg-muted pl-3 font-bold">TOTAL</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatInt(total.leads)}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatInt(total.purchase)}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatBps(successRateBps(total))}</TableCell>
                  <TableCell className={`${NUM} font-bold whitespace-nowrap`}>{formatRupiah(total.revenueIdr)}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatInt(total.active)}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatBps(playRateBps(total))}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatInt(total.waTotal)}</TableCell>
                  <TableCell className={`${NUM} font-bold`}>{formatInt(total.waSent)}</TableCell>
                  <TableCell className={`${NUM} pr-3 font-bold ${total.waFailed > 0 ? "text-destructive" : ""}`}>{formatInt(total.waFailed)}</TableCell>
                </TableRow>
              </TableFooter>
            </table>
          </div>
          {/* Outside the scrolling table, so it never slides out of view on a phone. */}
          <p className="border-t px-3 py-2.5 text-center text-xs text-muted-foreground" data-testid="days-caption">
            Showing {formatInt(days.length)} day{days.length === 1 ? "" : "s"}, {rangeText}.
          </p>
        </Card>
        <p className="text-xs text-muted-foreground" data-testid="leads-definitions">
          Leads are orders that reached the payment page, purchases are paid orders, and both count on the WIB day the order was created. Active
          counts the buyers who started a trivia set that day, whenever they bought; in the total, a buyer who played on 3 days counts 3 times.
          Total WA counts the WhatsApp ebook sends for the day&apos;s orders (cancelled ones are not counted); a send still waiting for the
          buyer&apos;s reply is in the total but not yet in Sent or Failed.
        </p>
      </section>
    </>
  );
}
