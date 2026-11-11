import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react/ssr";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { DAYS, conversion, sum } from "../lib/fixtures.ts";
import { formatInt, formatPercent, formatRupiah } from "../lib/format.ts";

interface Kpi {
  label: string;
  value: string;
  /** Signed percentage change versus the previous 30 days (fixture). */
  delta: number;
}

function buildKpis(): Kpi[] {
  const visits = sum(DAYS, (d) => d.visits);
  const mo = sum(DAYS, (d) => d.mo);
  const mt = sum(DAYS, (d) => d.mt);
  const revenue = sum(DAYS, (d) => d.revenue);
  return [
    { label: "Visits", value: formatInt(visits), delta: 4.2 },
    { label: "MO", value: formatInt(mo), delta: 6.8 },
    { label: "MT", value: formatInt(mt), delta: 5.1 },
    { label: "MO to MT %", value: formatPercent(conversion(mo, mt)), delta: -1.3 },
    { label: "Gross revenue", value: formatRupiah(revenue), delta: 12.0 },
  ];
}

export function KpiTiles() {
  const kpis = buildKpis();
  return (
    <section aria-label="Key metrics, last 30 days">
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {kpis.map((k) => {
          const up = k.delta >= 0;
          const Arrow = up ? ArrowUpIcon : ArrowDownIcon;
          return (
            <li key={k.label} className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground">{k.label}</p>
              <p className="font-mono text-xl leading-tight font-semibold whitespace-nowrap tabular">{k.value}</p>
              <p className={cn("flex flex-wrap items-center gap-x-1 text-xs font-medium", up ? "text-success" : "text-destructive")}>
                <Arrow aria-hidden="true" size={12} weight="bold" />
                <span className="tabular">
                  {up ? "+" : "-"}
                  {Math.abs(k.delta).toFixed(1)}%
                </span>
                <span className="text-muted-foreground">vs prev. 30 days</span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
