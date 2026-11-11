"use client";

import { useMemo, useState } from "react";
import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { CHANNELS, conversion, sum, type ChannelRow } from "../lib/fixtures.ts";
import { formatInt, formatPercent, formatRupiah } from "../lib/format.ts";

type SortKey = "landing" | "adnet" | "visits" | "mo" | "mt" | "conv" | "revenue" | "status";
type Dir = "asc" | "desc";

interface Column {
  key: SortKey;
  label: string;
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: "landing", label: "Landing page", numeric: false },
  { key: "adnet", label: "Adnet", numeric: false },
  { key: "visits", label: "Visits", numeric: true },
  { key: "mo", label: "MO", numeric: true },
  { key: "mt", label: "MT", numeric: true },
  { key: "conv", label: "MO to MT %", numeric: true },
  { key: "revenue", label: "Revenue (IDR)", numeric: true },
  { key: "status", label: "Status", numeric: false },
];

type Health = "On track" | "Watch" | "Failing";

function health(row: ChannelRow): Health {
  const c = conversion(row.mo, row.mt);
  if (c >= 62) return "On track";
  if (c >= 52) return "Watch";
  return "Failing";
}

const HEALTH_RANK: Record<Health, number> = { "On track": 0, Watch: 1, Failing: 2 };

function sortValue(row: ChannelRow, key: SortKey): string | number {
  switch (key) {
    case "landing":
      return row.landing;
    case "adnet":
      return row.adnet;
    case "visits":
      return row.visits;
    case "mo":
      return row.mo;
    case "mt":
      return row.mt;
    case "conv":
      return conversion(row.mo, row.mt);
    case "revenue":
      return row.revenue;
    case "status":
      return HEALTH_RANK[health(row)];
  }
}

function HealthBadge({ value }: { value: Health }) {
  if (value === "On track") {
    return (
      <Badge variant="success">
        <CheckCircleIcon aria-hidden="true" weight="fill" />
        {value}
      </Badge>
    );
  }
  if (value === "Watch") {
    return (
      <Badge variant="warning">
        <WarningIcon aria-hidden="true" weight="fill" />
        {value}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <XCircleIcon aria-hidden="true" weight="fill" />
      {value}
    </Badge>
  );
}

function cell(row: ChannelRow, key: SortKey) {
  switch (key) {
    case "landing":
      return row.landing;
    case "adnet":
      return row.adnet;
    case "visits":
      return formatInt(row.visits);
    case "mo":
      return formatInt(row.mo);
    case "mt":
      return formatInt(row.mt);
    case "conv":
      return formatPercent(conversion(row.mo, row.mt));
    case "revenue":
      return formatRupiah(row.revenue);
    case "status":
      return <HealthBadge value={health(row)} />;
  }
}

export function DataTable() {
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir } | null>({ key: "revenue", dir: "desc" });

  const rows = useMemo(() => {
    if (sort === null) return CHANNELS;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...CHANNELS].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    });
  }, [sort]);

  /** Click cycles ascending, descending, none. */
  function cycle(key: SortKey) {
    setSort((s) => {
      if (s?.key !== key) return { key, dir: "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  const totals = {
    visits: sum(CHANNELS, (r) => r.visits),
    mo: sum(CHANNELS, (r) => r.mo),
    mt: sum(CHANNELS, (r) => r.mt),
    revenue: sum(CHANNELS, (r) => r.revenue),
  };

  return (
    <section aria-labelledby="channels-title" className="flex flex-col gap-2 rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
        <h2 id="channels-title" className="text-sm font-semibold">
          Performance by landing page and adnet
        </h2>
        <p className="text-xs text-muted-foreground">Click a column header to sort</p>
      </div>
      <div
        role="region"
        aria-labelledby="channels-title"
        tabIndex={0}
        className="max-h-[22rem] overflow-auto border-y focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <table className="w-full caption-bottom text-sm">
          <TableHeader className="shadow-[0_1px_0_var(--color-border)]">
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((c, i) => {
                const active = sort?.key === c.key;
                const ariaSort = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
                const Icon = active ? (sort.dir === "asc" ? CaretUpIcon : CaretDownIcon) : CaretUpDownIcon;
                return (
                  <TableHead
                    key={c.key}
                    aria-sort={ariaSort}
                    className={cn("p-0", c.numeric && "text-right", i === 0 && "sticky left-0 z-(--z-raised) bg-card")}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        cycle(c.key);
                      }}
                      className={cn(
                        "inline-flex h-9 w-full items-center gap-1 px-2 font-semibold transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                        c.numeric ? "justify-end" : "justify-start",
                        active && "text-foreground",
                      )}
                    >
                      {c.label}
                      <Icon aria-hidden="true" size={12} weight={active ? "bold" : "regular"} />
                      <span className="sr-only">{`, sortable, currently ${ariaSort}`}</span>
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} className="group/row">
                {COLUMNS.map((c, i) => (
                  <TableCell
                    key={c.key}
                    className={cn(
                      c.numeric && "text-right font-mono tabular",
                      i === 0 && "sticky left-0 bg-card group-hover/row:bg-muted",
                    )}
                  >
                    {cell(r, c.key)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="sticky left-0 bg-muted font-semibold">Total</TableCell>
              <TableCell />
              <TableCell className="text-right font-mono tabular">{formatInt(totals.visits)}</TableCell>
              <TableCell className="text-right font-mono tabular">{formatInt(totals.mo)}</TableCell>
              <TableCell className="text-right font-mono tabular">{formatInt(totals.mt)}</TableCell>
              <TableCell className="text-right font-mono tabular">{formatPercent(conversion(totals.mo, totals.mt))}</TableCell>
              <TableCell className="text-right font-mono tabular">{formatRupiah(totals.revenue)}</TableCell>
              <TableCell />
            </TableRow>
          </TableFooter>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 text-xs">
        <label className="flex items-center gap-2 text-muted-foreground">
          Rows per page
          <select
            name="rowsPerPage"
            defaultValue="25"
            className="h-9 rounded-md border border-input bg-card px-2 text-sm text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <option>25</option>
            <option>50</option>
            <option>100</option>
          </select>
        </label>
        <p className="tabular text-muted-foreground">1-{CHANNELS.length} of {CHANNELS.length}</p>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" disabled className="min-h-9 gap-1">
            <CaretLeftIcon aria-hidden="true" size={12} weight="bold" />
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled className="min-h-9 gap-1">
            Next
            <CaretRightIcon aria-hidden="true" size={12} weight="bold" />
          </Button>
        </div>
      </div>
    </section>
  );
}
