import type { ReactNode } from "react";
import { ChartBarIcon, SignOutIcon } from "@phosphor-icons/react/ssr";
import { Badge } from "@ebooktrivia/ui/components/badge";
import { Button } from "@ebooktrivia/ui/components/button";
import { ConsoleNav, type NavItem } from "../../components/console-nav.tsx";
import { ThemeToggle } from "../../components/theme-toggle.tsx";
import { requireAdmin } from "../../lib/next/require-admin.ts";
import { can, type Permission, type QuestionPermission } from "../../lib/policy.ts";

const NAV: readonly (NavItem & { readonly permission: Exclude<Permission, QuestionPermission> })[] = [
  { href: "/", label: "Overview", icon: "overview", permission: "dashboard.view" },
  { href: "/settings/programs", label: "Programs", icon: "programs", permission: "program.edit" },
  { href: "/settings/products", label: "Products", icon: "products", permission: "product.content.edit" },
  { href: "/settings/landing-pages", label: "Landing pages", icon: "landing", permission: "landing_page.content.edit" },
  { href: "/settings/adnets", label: "Adnets", icon: "adnets", permission: "adnet.edit" },
  { href: "/settings/midtrans", label: "Midtrans", icon: "midtrans", permission: "midtrans.edit" },
  { href: "/settings/waha", label: "WhatsApp", icon: "waha", permission: "waha.edit" },
  { href: "/settings/smtp", label: "SMTP", icon: "smtp", permission: "smtp.edit" },
  { href: "/settings/templates", label: "Templates", icon: "templates", permission: "message_template.edit" },
  { href: "/settings/trivia", label: "Trivia", icon: "trivia", permission: "trivia_set.edit" },
  { href: "/settings/prizes", label: "Prizes", icon: "prizes", permission: "prize_tier.edit" },
  { href: "/settings/legal", label: "Legal pages", icon: "legal", permission: "legal_page.edit" },
  { href: "/settings/limits", label: "Limits", icon: "limits", permission: "app_settings.edit" },
  { href: "/team", label: "Team", icon: "team", permission: "admin_user.manage" },
  { href: "/audit", label: "Audit log", icon: "audit", permission: "audit.view" },
  { href: "/account", label: "Account", icon: "account", permission: "account.manage_own" },
];

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin({ permission: "dashboard.view" });
  // Controls the role may not use are not rendered at all (the pages and actions also refuse them).
  const items = NAV.filter((item) => can(admin.role, item.permission)).map(({ href, label, icon }) => ({ href, label, icon }));
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
          <ConsoleNav items={items} layout="sidebar" />
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
            <ConsoleNav items={items} layout="bar" />
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
