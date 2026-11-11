import type { Metadata } from "next";
import { ChartBarIcon, ChartLineUpIcon, DownloadSimpleIcon, GaugeIcon, ReceiptIcon, TrophyIcon, TruckIcon, WebhooksLogoIcon } from "@phosphor-icons/react/ssr";
import { Button } from "@ebooktrivia/ui/components/button";
import { DataTable } from "../../../../components/data-table.tsx";
import { FilterBar } from "../../../../components/filter-bar.tsx";
import { KpiTiles } from "../../../../components/kpi-tiles.tsx";
import { ThemeToggle } from "../../../../components/theme-toggle.tsx";
import { TrendChart } from "../../../../components/trend-chart.tsx";
import { assertMockupsEnabled } from "../../../../lib/guard.ts";

export const metadata: Metadata = { title: "Overview report | Admin Console" };
// Guard is evaluated per request, so a production build without ENABLE_MOCKUPS=1 serves 404.
export const dynamic = "force-dynamic";

const NAV = [
  { label: "Overview", Icon: GaugeIcon, current: true },
  { label: "Sales", Icon: ReceiptIcon, current: false },
  { label: "Delivery", Icon: TruckIcon, current: false },
  { label: "Postback", Icon: WebhooksLogoIcon, current: false },
  { label: "Profit and ROI", Icon: ChartLineUpIcon, current: false },
  { label: "Trivia", Icon: TrophyIcon, current: false },
];

export default function DashboardMockupPage() {
  assertMockupsEnabled();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-on-primary"
      >
        Skip to main content
      </a>
      <aside className="hidden border-r bg-card lg:block">
        <div className="sticky top-0 flex flex-col gap-4 p-3">
          <p className="flex items-center gap-2 px-2 text-base font-semibold">
            <ChartBarIcon aria-hidden="true" size={20} weight="duotone" className="text-accent" />
            Admin Console
          </p>
          <nav aria-label="Reports">
            <ul className="flex flex-col gap-0.5">
              {NAV.map(({ label, Icon, current }) => (
                <li key={label}>
                  <a
                    href="#main"
                    aria-current={current ? "page" : undefined}
                    className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors duration-150 hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold"
                  >
                    <Icon aria-hidden="true" size={16} weight={current ? "fill" : "regular"} />
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-(--z-sticky) flex h-(--topbar-h) items-center justify-between gap-2 border-b bg-card px-4">
          <p className="flex items-center gap-2 font-semibold lg:hidden">
            <ChartBarIcon aria-hidden="true" size={20} weight="duotone" className="text-accent" />
            Admin Console
          </p>
          <span className="hidden text-xs text-muted-foreground lg:inline">Owner</span>
          <ThemeToggle />
        </header>

        <main id="main" className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold">Overview</h1>
              <p className="text-xs text-muted-foreground">Updated 14:05 WIB. Sample data for the mockup.</p>
            </div>
            <Button variant="secondary" size="sm" className="min-h-9 gap-1.5" title="Exports the current filters">
              <DownloadSimpleIcon aria-hidden="true" size={16} />
              Export CSV
            </Button>
          </div>
          <FilterBar />
          <KpiTiles />
          <TrendChart />
          <DataTable />
        </main>
      </div>
    </div>
  );
}
