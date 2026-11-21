// The small pieces every report page shares (US-029): the "as of" line, the KPI tiles, the filter form controls, the pager and the
// export button. Server components only: a filter is a plain GET form (works without JavaScript, shareable by URL), an
// export is a plain POST form, and numbers are tabular. Meaning never rests on colour alone: every state has a word.
import type { ReactNode } from "react";
import Link from "next/link";
import { CaretLeftIcon, CaretRightIcon, ClockIcon, DownloadSimpleIcon, WarningIcon } from "@phosphor-icons/react/ssr";
import { Button } from "@ebooktrivia/ui/components/button";
import { Label } from "@ebooktrivia/ui/components/label";
import { PAGE_SIZE } from "../../lib/reports/common.ts";
import { formatWibTime } from "../../lib/format.ts";

const CONTROL =
  "min-h-11 w-full min-w-0 rounded-lg border-2 border-input bg-card px-3 py-2 text-base text-card-foreground focus-visible:border-ring focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** "Figures as of 14:35 WIB": when the rollups were computed; a warning when they are behind (the worker refreshes them every 5 minutes). */
export function AsOf({ asOf, stale, live }: { asOf: Date | null; stale: boolean; live?: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="as-of">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ClockIcon aria-hidden="true" size={14} />
        {asOf === null ? "The rollups have not run yet." : `Figures as of ${formatWibTime(asOf)}, refreshed every 5 minutes.`}
        {live === undefined ? null : ` ${live}`}
      </p>
      {stale ? (
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" data-testid="stale-warning">
          <WarningIcon aria-hidden="true" size={16} weight="fill" className="mt-0.5 shrink-0" />
          {asOf === null ? "No figures yet: the worker computes them every 5 minutes once it runs." : "The figures are older than 15 minutes: the worker may be stopped."}
        </p>
      ) : null}
    </div>
  );
}

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly note?: string | undefined;
  readonly testId: string;
}

export function KpiGrid({ title, tiles }: { title: string; tiles: readonly Tile[] }) {
  return (
    <section aria-label={title}>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
        {tiles.map((t) => (
          <li key={t.label} className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3" data-testid={t.testId}>
            <p className="text-xs font-medium text-muted-foreground">{t.label}</p>
            <p className="font-mono text-xl leading-tight font-semibold tabular [overflow-wrap:anywhere]">{t.value}</p>
            {t.note === undefined ? null : <p className="text-xs text-muted-foreground">{t.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A GET form: the filters live in the URL. `reset` is the page without any query. */
export function FilterForm({ label, action, reset, children }: { label: string; action: string; reset: string; children: ReactNode }) {
  return (
    <form method="get" action={action} aria-label={label} className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3" data-testid="filters">
      {children}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" className="min-h-11">
          Apply
        </Button>
        <Link href={reset} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium underline underline-offset-4">
          Reset
        </Link>
      </div>
    </form>
  );
}

export function DateInput({ id, name, label, value }: { id: string; name: string; label: string; value: string }) {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <input id={id} name={name} type="date" defaultValue={value} required className={CONTROL} />
    </div>
  );
}

export function FilterSelect({
  id,
  name,
  label,
  value,
  options,
  all,
}: {
  id: string;
  name: string;
  label: string;
  value: string | null;
  options: readonly { readonly value: string; readonly label: string }[];
  all: string;
}) {
  return (
    <div className="flex min-w-36 flex-1 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} defaultValue={value ?? ""} className={CONTROL}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Previous / next links for a list of `count` rows, `PAGE_SIZE` per page, keeping the other query values. */
export function Pager({ path, query, page, count }: { path: string; query: Readonly<Record<string, string>>; page: number; count: number }) {
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const href = (p: number): string => {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ""));
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs === "" ? path : `${path}?${qs}`;
  };
  const first = count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(count, page * PAGE_SIZE);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <p className="tabular text-muted-foreground" data-testid="pager-range">
        {count === 0 ? "No rows" : `${String(first)}-${String(last)} of ${String(count)}`}
      </p>
      <div className="flex gap-1">
        {page > 1 ? (
          <Link href={href(page - 1)} className="inline-flex min-h-9 items-center gap-1 rounded-md border px-3 font-medium">
            <CaretLeftIcon aria-hidden="true" size={12} weight="bold" />
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link href={href(page + 1)} className="inline-flex min-h-9 items-center gap-1 rounded-md border px-3 font-medium">
            Next
            <CaretRightIcon aria-hidden="true" size={12} weight="bold" />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

/** A POST form carrying the filters of the page to an Owner-only export route (an export is audited, so it is never a GET). */
export function ExportForm({ action, fields, label, note, testId }: { action: string; fields: Readonly<Record<string, string>>; label: string; note: string; testId: string }) {
  return (
    <form method="post" action={action} className="flex flex-wrap items-center gap-3" data-testid={testId}>
      {Object.entries(fields)
        .filter(([, v]) => v !== "")
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      <Button type="submit" variant="secondary" size="sm" className="min-h-11 gap-1.5">
        <DownloadSimpleIcon aria-hidden="true" size={16} />
        {label}
      </Button>
      <p className="text-xs text-muted-foreground">{note}</p>
    </form>
  );
}

export function EmptyState({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="rounded-lg border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}
