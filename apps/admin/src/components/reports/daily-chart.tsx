// The daily series of the dashboard and the sales report (US-029): MO and MT (on screen "Leads" and "Purchase") per WIB day as an SVG line chart, with the
// same numbers in a table right below it (accessible alternative, opened by "View as table"). Server-rendered, no
// client script. The two series differ by colour, line dash AND marker shape (circle / square), so the meaning never
// rests on colour alone; the figcaption states what the chart says in words; every figure is tabular.
import { TableIcon } from "@phosphor-icons/react/ssr";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { formatBps, formatDay, formatDayYear, formatInt, formatRupiah } from "../../lib/format.ts";
import { rateBps } from "@ebooktrivia/core";
import { niceMax } from "../../lib/reports/chart.ts";
import type { SalesDay } from "../../lib/reports/sales.ts";

// The plot is drawn in a 1000 x 1000 box stretched to the chart's size (preserveAspectRatio none) with strokes that do not scale, so its
// lines keep their width; the axis labels and the markers are HTML placed by percentage, so text stays at its CSS size on a phone and on a
// wide screen alike (an SVG scaled as a whole made it 5 px on a phone and 16 px on a desktop).
const BOX = 1000;

function Marker({ shape, left, top }: { shape: "circle" | "square"; left: number; top: number }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute size-[7px] -translate-x-1/2 -translate-y-1/2 bg-current ${shape === "circle" ? "rounded-full" : ""}`}
      style={{ left: `${String(left)}%`, top: `${String(top)}%` }}
    />
  );
}

function LegendMarker({ shape }: { shape: "circle" | "square" }) {
  return shape === "circle" ? <circle cx={13} cy={5} r={3.5} fill="currentColor" /> : <rect x={9.5} y={1.5} width={7} height={7} fill="currentColor" />;
}

export function DailyChart({ days, title, id }: { days: readonly SalesDay[]; title: string; id: string }) {
  const n = days.length;
  const totalMo = days.reduce((s, d) => s + d.mo, 0);
  const totalMt = days.reduce((s, d) => s + d.mt, 0);
  const yMax = niceMax(Math.max(0, ...days.flatMap((d) => [d.mo, d.mt])));
  // Percent of the plot box: x from the first to the last day, y from the top (yMax) to the bottom (0).
  const x = (i: number): number => (n <= 1 ? 50 : (i * 100) / (n - 1));
  const y = (v: number): number => (1 - v / yMax) * 100;
  // niceMax is 5, 10, 25, 50, 100, 250, ...: a fifth of it is a whole number, so the six ticks are whole and evenly spaced.
  const ticks = [0, 1, 2, 3, 4, 5].map((i) => (yMax * i) / 5);
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  // A phone shows at most 4 or 5 day labels. The last day is always labelled, so a regular label closer to it than a full step is left out
  // (on a phone "24 Nov" ran into "25 Nov").
  const phoneEvery = Math.max(1, Math.ceil(n / 4));
  const shown = (i: number, every: number): boolean => i === n - 1 || (i % every === 0 && n - 1 - i >= every);
  const peak = days.reduce<SalesDay | null>((best, d) => (best === null || d.mo > best.mo ? d : best), null);
  const series = [
    { key: "mo" as const, label: "Leads", color: "var(--chart-1)", dash: undefined, shape: "circle" as const },
    { key: "mt" as const, label: "Purchase", color: "var(--chart-2)", dash: "6 4", shape: "square" as const },
  ];
  return (
    <figure className="flex flex-col gap-2 rounded-lg border bg-card p-3" aria-labelledby={`${id}-title`} data-testid={`${id}-chart`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        <ul className="flex items-center gap-3 text-xs font-medium" aria-label="Series">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg width="26" height="10" viewBox="0 0 26 10" aria-hidden="true" style={{ color: s.color }}>
                <line x1="0" y1="5" x2="26" y2="5" stroke="currentColor" strokeWidth="2" strokeDasharray={s.dash} />
                <LegendMarker shape={s.shape} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">No days in this range.</p>
      ) : (
        <div
          role="img"
          aria-label={`Line chart of daily leads and purchases over ${String(n)} days. Leads total ${formatInt(totalMo)} and purchases total ${formatInt(totalMt)}. The same numbers are in the table below.`}
          className="pt-2 pr-5 pb-6 pl-10"
          data-testid={`${id}-plot`}
        >
          <div className="relative h-48 sm:h-56">
            <svg viewBox={`0 0 ${String(BOX)} ${String(BOX)}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
              {ticks.map((t) => (
                <line key={t} x1={0} x2={BOX} y1={(y(t) * BOX) / 100} y2={(y(t) * BOX) / 100} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              ))}
              {series.map((s) => (
                <polyline
                  key={s.key}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeDasharray={s.dash}
                  vectorEffect="non-scaling-stroke"
                  points={days.map((d, i) => `${String((x(i) * BOX) / 100)},${String((y(d[s.key]) * BOX) / 100)}`).join(" ")}
                />
              ))}
            </svg>
            {ticks.map((t) => (
              <span key={t} aria-hidden="true" className="absolute right-full mr-2 -translate-y-1/2 font-mono text-xs text-muted-foreground tabular" style={{ top: `${String(y(t))}%` }}>
                {formatInt(t)}
              </span>
            ))}
            {days.map((d, i) =>
              shown(i, labelEvery) || shown(i, phoneEvery) ? (
                <span
                  key={d.day}
                  aria-hidden="true"
                  className={`absolute top-full mt-1.5 -translate-x-1/2 text-xs whitespace-nowrap text-muted-foreground ${shown(i, phoneEvery) ? "" : "max-sm:hidden"} ${shown(i, labelEvery) ? "" : "sm:hidden"}`}
                  style={{ left: `${String(x(i))}%` }}
                >
                  {formatDay(d.day)}
                </span>
              ) : null,
            )}
            {series.map((s) => (
              <div key={s.key} aria-hidden="true" style={{ color: s.color }}>
                {days.map((d, i) => (n <= 16 || i % labelEvery === 0 || i === n - 1 ? <Marker key={d.day} shape={s.shape} left={x(i)} top={y(d[s.key])} /> : null))}
              </div>
            ))}
          </div>
        </div>
      )}
      <figcaption className="text-xs text-muted-foreground">
        {n === 0
          ? ""
          : `${formatInt(totalMo)} leads and ${formatInt(totalMt)} purchases in ${String(n)} day${n === 1 ? "" : "s"} (success rate ${formatBps(rateBps(totalMt, totalMo))}).${
              peak === null || peak.mo === 0 ? "" : ` The busiest day was ${formatDay(peak.day)} with ${formatInt(peak.mo)} leads.`
            }`}
      </figcaption>
      <details className="rounded-md border" data-testid={`${id}-table`}>
        <summary className="flex min-h-9 cursor-pointer items-center gap-1.5 px-3 text-xs font-medium">
          <TableIcon aria-hidden="true" size={14} />
          View as table
        </summary>
        <div role="region" aria-label={`${title}, data table`} tabIndex={0} className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <TableHeader className="shadow-[0_1px_0_var(--color-border)]">
              <TableRow className="hover:bg-transparent">
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Visits</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Purchase</TableHead>
                <TableHead className="text-right">Success Rate</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((d) => (
                <TableRow key={d.day}>
                  <TableCell className="whitespace-nowrap tabular">{formatDayYear(d.day)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(d.visits)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(d.mo)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(d.mt)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatBps(rateBps(d.mt, d.mo))}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatRupiah(d.revenueIdr)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      </details>
    </figure>
  );
}
