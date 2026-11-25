import type { ReactNode } from "react";
import { ChartBarIcon, SignOutIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { ConsoleNav, type NavGroup, type NavItem } from "../../components/console-nav.tsx";
import { ThemeToggle } from "../../components/theme-toggle.tsx";
import { requireAdmin } from "../../lib/next/require-admin.ts";
import { getRuntime } from "../../lib/next/runtime.ts";
import { can, type Permission, type QuestionPermission } from "../../lib/policy.ts";
import { reviewCount } from "../../lib/review/review.ts";

type Entry = NavItem & { readonly permission: Exclude<Permission, QuestionPermission> };

/** The menu in groups by what the pages are for (the Owner's choice, 2026-11-25: 7 groups, collapsible). */
const NAV: readonly { readonly id: string; readonly label: string; readonly items: readonly Entry[] }[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    items: [
      { href: "/", label: "Overview", icon: "overview", permission: "dashboard.view" },
      { href: "/reports/leads", label: "Leads Report", icon: "leads", permission: "reports.view" },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    items: [
      // The Owner's review queue for orders (US-033), with the number waiting as its badge.
      { href: "/orders/review", label: "Review queue", icon: "review", permission: "order.review.resolve" },
      // US-030: prize fulfilment and UU PDP deletion requests, Owner-only.
      { href: "/fulfillment", label: "Prize fulfilment", icon: "fulfillment", permission: "prize_fulfillment.update" },
      { href: "/privacy", label: "Data deletion", icon: "privacy", permission: "deletion_request.process" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    // Reports (US-029): Staff view them (reports.view); the profit view and the ad-spend entry are Owner-only.
    items: [
      { href: "/reports/sales", label: "Sales", icon: "sales", permission: "reports.view" },
      { href: "/reports/delivery", label: "Delivery", icon: "delivery", permission: "reports.view" },
      { href: "/reports/postbacks", label: "Postbacks", icon: "postbacks", permission: "reports.view" },
      { href: "/reports/contest", label: "Contest report", icon: "contest", permission: "reports.view" },
      { href: "/reports/roi", label: "Profit and ROI", icon: "roi", permission: "roi.view" },
      { href: "/reports/ad-spend", label: "Ad spend", icon: "adspend", permission: "ad_spend.edit" },
    ],
  },
  {
    id: "program",
    label: "Program setup",
    items: [
      { href: "/settings/programs", label: "Programs", icon: "programs", permission: "program.edit" },
      { href: "/settings/products", label: "Products", icon: "products", permission: "product.content.edit" },
      { href: "/settings/landing-pages", label: "Landing pages", icon: "landing", permission: "landing_page.content.edit" },
      { href: "/settings/trivia", label: "Trivia", icon: "trivia", permission: "trivia_set.edit" },
      { href: "/settings/prizes", label: "Prizes", icon: "prizes", permission: "prize_tier.edit" },
      { href: "/settings/legal", label: "Legal pages", icon: "legal", permission: "legal_page.edit" },
    ],
  },
  {
    id: "messaging",
    label: "Messaging",
    items: [
      { href: "/settings/waha", label: "WhatsApp", icon: "waha", permission: "waha.edit" },
      { href: "/settings/smtp", label: "SMTP (e-mail)", icon: "smtp", permission: "smtp.edit" },
      { href: "/settings/templates", label: "Templates", icon: "templates", permission: "message_template.edit" },
      { href: "/settings/customer-service", label: "Customer service", icon: "cs", permission: "cs_contact.edit" },
    ],
  },
  {
    id: "payments",
    label: "Payments & ads",
    items: [
      { href: "/settings/midtrans", label: "Midtrans", icon: "midtrans", permission: "midtrans.edit" },
      { href: "/settings/adnets", label: "Adnets", icon: "adnets", permission: "adnet.edit" },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { href: "/settings/limits", label: "Limits", icon: "limits", permission: "app_settings.edit" },
      { href: "/settings/alerts", label: "Alerts", icon: "alerts", permission: "alert_recipients.edit" },
      { href: "/team", label: "Team", icon: "team", permission: "admin_user.manage" },
      { href: "/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
      { href: "/account", label: "Account", icon: "account", permission: "account.manage_own" },
    ],
  },
];

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin({ permission: "dashboard.view" });
  const waiting = can(admin.role, "order.review.resolve") ? await reviewCount((await getRuntime()).sql) : 0;
  // Controls the role may not use are not rendered at all (the pages and actions also refuse them).
  const groups: NavGroup[] = NAV.map(({ id, label, items }) => ({
    id,
    label,
    items: items.filter((item) => can(admin.role, item.permission)).map(({ href, label: name, icon }) => ({ href, label: name, icon, ...(icon === "review" ? { badge: waiting } : {}) })),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-toast) focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-on-primary"
      >
        Skip to main content
      </a>
      <aside className="hidden border-r bg-card lg:block">
        <div className="sticky top-0 flex max-h-dvh flex-col gap-4 overflow-y-auto overscroll-contain p-3">
          <p className="flex items-center gap-2 px-2 text-base font-semibold">
            <ChartBarIcon aria-hidden="true" size={20} weight="duotone" className="text-accent" />
            Admin Console
          </p>
          <ConsoleNav groups={groups} layout="sidebar" />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-(--z-sticky) flex flex-col gap-2 border-b bg-card px-4 py-2 lg:h-(--topbar-h) lg:flex-row lg:items-center lg:justify-between lg:py-0">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold lg:hidden">
              <ChartBarIcon aria-hidden="true" size={20} weight="duotone" className="text-accent" />
              Admin Console
            </p>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span data-testid="signed-in-as">{admin.displayName}</span>
              <Badge variant="secondary">{admin.role === "owner" ? "Owner" : "Staff"}</Badge>
            </p>
          </div>
          <div className="lg:hidden">
            <ConsoleNav groups={groups} layout="bar" />
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <form method="post" action="/auth/sign-out">
              <Button type="submit" variant="ghost" size="sm" className="min-h-9 gap-1.5">
                <SignOutIcon aria-hidden="true" size={16} />
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <main id="main" className="flex flex-col gap-3 p-4">
          {children}
        </main>
      </div>
    </div>
  );
}
