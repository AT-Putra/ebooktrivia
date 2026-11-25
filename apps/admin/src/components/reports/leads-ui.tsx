// The pieces of the Leads Report (2026-11-25, after the Owner's reference picture, in the console's own theme): the "Today"
// stat cards and the sortable column headers. Server components; a sort is a plain link (works without JavaScript and keeps
// the filters in the URL). The colour of a card only repeats what its label says.
import type { ComponentType } from "react";
import Link from "next/link";
import type { IconProps } from "@phosphor-icons/react";
import { ArrowDownIcon, ArrowUpIcon, CaretUpDownIcon } from "@phosphor-icons/react/ssr";
import type { Sort, SortKey } from "../../lib/reports/leads.ts";

export type Tone = "info" | "success" | "warning" | "neutral";

const TONES: Readonly<Record<Tone, { readonly chip: string; readonly bar: string }>> = {
  info: { chip: "bg-info-soft text-info-soft-foreground", bar: "bg-info" },
  success: { chip: "bg-success-soft text-success-soft-foreground", bar: "bg-success" },
  warning: { chip: "bg-warning-soft text-warning-soft-foreground", bar: "bg-warning" },
  neutral: { chip: "bg-muted text-foreground", bar: "bg-muted-foreground" },
};

export function StatCard({
  icon: Icon,
  tone,
  label,
  sublabel,
  value,
  note,
  testId,
}: {
  icon: ComponentType<IconProps>;
  tone: Tone;
  label: string;
  sublabel?: string;
  value: string;
  note: string;
  testId: string;
}) {
  const t = TONES[tone];
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 md:p-4" data-testid={testId}>
      <div className="flex items-start gap-2.5">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${t.chip}`}>
          <Icon aria-hidden="true" size={18} weight="duotone" />
        </span>
        <div className="min-w-0">
          <p className="text-sm leading-tight font-semibold">{label}</p>
          {sublabel === undefined ? null : <p className="text-xs text-muted-foreground">{sublabel}</p>}
        </div>
      </div>
      <p className="text-lg leading-tight font-bold tabular [overflow-wrap:anywhere] sm:text-xl md:text-2xl" data-testid={`${testId}-value`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{note}</p>
      <span aria-hidden="true" className={`h-1 w-10 rounded-full ${t.bar}`} />
    </li>
  );
}

/** A column header that sorts the table: the first click sorts high to low (newest first for the day), the next one flips it. */
export function SortHeader({
  label,
  sublabel,
  sortKey,
  sort,
  hrefFor,
  align = "right",
  className = "",
}: {
  label: string;
  sublabel?: string;
  sortKey: SortKey;
  sort: Sort;
  hrefFor: (s: Sort) => string;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === sortKey;
  const next: Sort = { key: sortKey, dir: active && sort.dir === "desc" ? "asc" : "desc" };
  const Icon = !active ? CaretUpDownIcon : sort.dir === "asc" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`h-11 px-2 align-middle text-xs font-semibold whitespace-nowrap text-muted-foreground ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      <Link
        href={hrefFor(next)}
        scroll={false}
        className={`inline-flex min-h-11 items-center gap-1 rounded-md px-1 hover:text-foreground lg:min-h-9 ${active ? "text-foreground" : ""}`}
      >
        <span className="flex flex-col leading-tight">
          <span>{label}</span>
          {sublabel === undefined ? null : <span className="font-normal">{sublabel}</span>}
        </span>
        <Icon aria-hidden="true" size={12} weight="bold" className="shrink-0" />
        <span className="sr-only">{active ? `, sorted ${sort.dir === "asc" ? "low to high" : "high to low"}` : ", sort"}</span>
      </Link>
    </th>
  );
}
