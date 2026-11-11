"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChartLineIcon, TableIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ebooktrivia/ui/components/table";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { DAYS, sum } from "../lib/fixtures.ts";
import { formatInt } from "../lib/format.ts";

type SeriesKey = "mo" | "mt";

interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  dash: string | undefined;
  shape: "circle" | "square";
}

/** Two series, one y-axis. Differ by colour, dash pattern AND marker shape. */
const SERIES: SeriesDef[] = [
  { key: "mo", label: "MO", color: "var(--chart-1)", dash: undefined, shape: "circle" },
  { key: "mt", label: "MT", color: "var(--chart-2)", dash: "6 4", shape: "square" },
];

const W = 720;
const H = 280;
const M = { l: 44, r: 44, t: 12, b: 28 };

function niceMax(v: number): number {
  const step = v > 200 ? 50 : 25;
  return Math.ceil(v / step) * step;
}

function Marker({ shape, x, y, color, r }: { shape: SeriesDef["shape"]; x: number; y: number; color: string; r: number }) {
  return shape === "circle" ? (
    <circle cx={x} cy={y} r={r} fill={color} />
  ) : (
    <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill={color} />
  );
}

export function TrendChart() {
  const uid = useId();
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({ mo: true, mt: true });
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const shown = SERIES.filter((s) => visible[s.key]);
  const yMax = niceMax(Math.max(...shown.flatMap((s) => DAYS.map((d) => d[s.key]))));
  const n = DAYS.length;
  const x = (i: number) => M.l + (i * (W - M.l - M.r)) / (n - 1);
  const y = (v: number) => M.t + (1 - v / yMax) * (H - M.t - M.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));

  const totalMo = sum(DAYS, (d) => d.mo);
  const totalMt = sum(DAYS, (d) => d.mt);
  const first = DAYS.slice(0, 15);
  const second = DAYS.slice(15);
  const moRise = ((sum(second, (d) => d.mo) - sum(first, (d) => d.mo)) / sum(first, (d) => d.mo)) * 100;

  const activeDay = active === null ? undefined : DAYS[active];

  function toggle(key: SeriesKey) {
    setVisible((v) => {
      const next = { ...v, [key]: !v[key] };
      return next.mo || next.mt ? next : v;
    });
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight") setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(n - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  }

  function onPointer(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r)) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  }

  return (
    <figure className="flex flex-col gap-2 rounded-lg border bg-card p-3" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          Daily MO and MT, Oct 13 to Nov 11
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <ul className="flex items-center gap-1" aria-label="Series">
            {SERIES.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  aria-pressed={visible[s.key]}
                  onClick={() => {
                    toggle(s.key);
                  }}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors duration-150 hover:bg-muted",
                    visible[s.key] ? "border-input" : "border-border text-muted-foreground",
                  )}
                >
                  <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
                    <line x1="0" y1="5" x2="22" y2="5" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} opacity={visible[s.key] ? 1 : 0.35} />
                    <Marker shape={s.shape} x={11} y={5} r={3} color={s.color} />
                  </svg>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={asTable}
            onClick={() => {
              setAsTable((v) => !v);
            }}
            className="min-h-9 gap-1.5"
          >
            {asTable ? <ChartLineIcon aria-hidden="true" size={14} /> : <TableIcon aria-hidden="true" size={14} />}
            {asTable ? "View as chart" : "View as table"}
          </Button>
        </div>
      </div>

      {asTable ? (
        <div role="region" aria-label="Daily MO and MT data" tabIndex={0} className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <TableHeader className="shadow-[0_1px_0_var(--color-border)]">
              <TableRow className="hover:bg-transparent">
                <TableHead>Date</TableHead>
                <TableHead className="text-right">MO</TableHead>
                <TableHead className="text-right">MT</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DAYS.map((d) => (
                <TableRow key={d.label}>
                  <TableCell>{d.label}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(d.mo)}</TableCell>
                  <TableCell className="text-right font-mono tabular">{formatInt(d.mt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </table>
        </div>
      ) : (
        <>
          <p aria-live="polite" className="min-h-5 text-xs font-medium text-muted-foreground tabular">
            {activeDay === undefined
              ? "Hover the chart or focus it and use the left and right arrow keys to read exact values."
              : `${activeDay.label}: ${shown.map((s) => `${s.label} ${formatInt(activeDay[s.key])}`).join(", ")}`}
          </p>
          <div
            role="group"
            tabIndex={0}
            aria-label="Daily MO and MT line chart. Use left and right arrow keys to move between days."
            onKeyDown={onKey}
            onBlur={() => {
              setActive(null);
            }}
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="block h-auto w-full"
              role="img"
              aria-label={`Line chart of daily MO and MT over 30 days. MO totals ${formatInt(totalMo)} and MT totals ${formatInt(totalMt)}.`}
              onPointerMove={onPointer}
              onPointerLeave={() => {
                setActive(null);
              }}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth="1" />
                  <text x={M.l - 8} y={y(t) + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[11px]">
                    {formatInt(t)}
                  </text>
                </g>
              ))}
              {DAYS.map((d, i) =>
                i % 5 === 0 || i === n - 1 ? (
                  <text key={d.label} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                    {d.label}
                  </text>
                ) : null,
              )}
              {shown.map((s) => (
                <g key={s.key}>
                  <polyline
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeDasharray={s.dash}
                    points={DAYS.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")}
                  />
                  {DAYS.map((d, i) =>
                    i % 5 === 0 || i === n - 1 ? <Marker key={d.label} shape={s.shape} x={x(i)} y={y(d[s.key])} r={3.5} color={s.color} /> : null,
                  )}
                  <text
                    x={x(n - 1) + 8}
                    y={y(DAYS[n - 1]?.[s.key] ?? 0) + 4}
                    className="fill-foreground text-[11px] font-semibold"
                  >
                    {s.label}
                  </text>
                </g>
              ))}
              {active === null ? null : (
                <g>
                  <line x1={x(active)} x2={x(active)} y1={M.t} y2={H - M.b} className="stroke-foreground" strokeWidth="1" strokeDasharray="2 3" />
                  {shown.map((s) => (
                    <Marker key={s.key} shape={s.shape} x={x(active)} y={y(DAYS[active]?.[s.key] ?? 0)} r={5} color={s.color} />
                  ))}
                </g>
              )}
            </svg>
          </div>
        </>
      )}
      <figcaption className="text-xs text-muted-foreground">
        MO rose {moRise.toFixed(0)}% in the second half of the period, to {formatInt(sum(second, (d) => d.mo))}. MT totaled{" "}
        {formatInt(totalMt)} over 30 days.
      </figcaption>
    </figure>
  );
}
