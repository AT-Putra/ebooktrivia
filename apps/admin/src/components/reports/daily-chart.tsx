// The daily series of the dashboard and the sales report (US-029): MO and MT per WIB day as an SVG line chart, with the
// same numbers in a table right below it (accessible alternative, opened by "View as table"). Server-rendered, no
// client script. The two series differ by colour, line dash AND marker shape (circle / square), so the meaning never
// rests on colour alone; the figcaption states what the chart says in words; every figure is tabular.
import { TableIcon } from "@phosphor-icons/react/ssr";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { formatBps, formatDay, formatInt, formatRupiah } from "../../lib/format.ts";
import { rateBps } from "@ebooktrivia/core";
import { niceMax } from "../../lib/reports/chart.ts";
import type { SalesDay } from "../../lib/reports/sales.ts";

const W = 720;
const H = 260;
const M = { l: 44, r: 40, t: 12, b: 28 };

function Marker({ shape, x, y }: { shape: "circle" | "square"; x: number; y: number }) {
  return shape === "circle" ? <circle cx={x} cy={y} r={3.5} fill="currentColor" /> : <rect x={x - 3.5} y={y - 3.5} width={7} height={7} fill="currentColor" />;
}

export function DailyChart({ days, title, id }: { days: readonly SalesDay[]; title: string; id: string }) {
  const n = days.length;
  const totalMo = days.reduce((s, d) => s + d.mo, 0);
  const totalMt = days.reduce((s, d) => s + d.mt, 0);
  const yMax = niceMax(Math.max(0, ...days.flatMap((d) => [d.mo, d.mt])));
  const x = (i: number): number => (n <= 1 ? (M.l + W - M.r) / 2 : M.l + (i * (W - M.l - M.r)) / (n - 1));
  const y = (v: number): number => M.t + (1 - v / yMax) * (H - M.t - M.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const peak = days.reduce<SalesDay | null>((best, d) => (best === null || d.mo > best.mo ? d : best), null);
  const series = [
    { key: "mo" as const, label: "MO", color: "var(--chart-1)", dash: undefined, shape: "circle" as const },
    { key: "mt" as const, label: "MT", color: "var(--chart-2)", dash: "6 4", shape: "square" as const },
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
                <Marker shape={s.shape} x={13} y={5} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      {n === 0 ? (
        <p className="text-sm text-muted-foreground">No days in this range.</p>
      ) : (
        <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="block h-auto w-full" role="img" aria-label={`Line chart of daily MO and MT over ${String(n)} days. MO totals ${formatInt(totalMo)} and MT totals ${formatInt(totalMt)}. The same numbers are in the table below.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth="1" />
              <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[11px]">
                {formatInt(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                {formatDay(d.day)}
              </text>
            ) : null,
          )}
          {series.map((s) => (
            <g key={s.key} style={{ color: s.color }}>
              <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeDasharray={s.dash} points={days.map((d, i) => `${String(x(i))},${String(y(d[s.key]))}`).join(" ")} />
              {days.map((d, i) => (n <= 16 || i % labelEvery === 0 || i === n - 1 ? <Marker key={d.day} shape={s.shape} x={x(i)} y={y(d[s.key])} /> : null))}
            </g>
          ))}
        </svg>
      )}
      <figcaption className="text-xs text-muted-foreground">
        {n === 0
          ? ""
          : `${formatInt(totalMo)} MO and ${formatInt(totalMt)} MT in ${String(n)} day${n === 1 ? "" : "s"} (${formatBps(rateBps(totalMt, totalMo))} MO to MT).${
              peak === null || peak.mo === 0 ? "" : ` The busiest day was ${formatDay(peak.day)} with ${formatInt(peak.mo)} MO.`
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
                <TableHead className="text-right">MO</TableHead>
                <TableHead className="text-right">MT</TableHead>
                <TableHead className="text-right">MO to MT</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((d) => (
                <TableRow key={d.day}>
                  <TableCell>{d.day}</TableCell>
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
