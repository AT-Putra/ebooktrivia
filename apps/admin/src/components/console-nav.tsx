"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BellRingingIcon,
  BookOpenIcon,
  BrowserIcon,
  ChatCircleDotsIcon,
  ChatTextIcon,
  ChartLineUpIcon,
  ClipboardTextIcon,
  CreditCardIcon,
  CurrencyCircleDollarIcon,
  EnvelopeIcon,
  GaugeIcon,
  GiftIcon,
  ListChecksIcon,
  MedalIcon,
  MegaphoneIcon,
  PackageIcon,
  QuestionIcon,
  ReceiptIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  TrophyIcon,
  TruckIcon,
  UserCircleIcon,
  UsersThreeIcon,
  WebhooksLogoIcon,
} from "@phosphor-icons/react";

const ICONS = {
  overview: GaugeIcon,
  review: ListChecksIcon,
  sales: ReceiptIcon,
  delivery: TruckIcon,
  postbacks: WebhooksLogoIcon,
  contest: MedalIcon,
  roi: ChartLineUpIcon,
  adspend: CurrencyCircleDollarIcon,
  fulfillment: PackageIcon,
  privacy: ShieldCheckIcon,
  programs: TrophyIcon,
  products: BookOpenIcon,
  landing: BrowserIcon,
  adnets: MegaphoneIcon,
  midtrans: CreditCardIcon,
  waha: ChatCircleDotsIcon,
  smtp: EnvelopeIcon,
  templates: ChatTextIcon,
  trivia: QuestionIcon,
  prizes: GiftIcon,
  legal: ScalesIcon,
  limits: SlidersHorizontalIcon,
  alerts: BellRingingIcon,
  team: UsersThreeIcon,
  audit: ClipboardTextIcon,
  account: UserCircleIcon,
} as const;
export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: NavIcon;
  /** A count shown next to the label (US-033: the orders waiting in the review queue); none when 0 or absent. */
  readonly badge?: number;
}

/** The console navigation; the server passes only the items the signed-in role may open. */
export function ConsoleNav({ items, layout }: { items: readonly NavItem[]; layout: "sidebar" | "bar" }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console">
      <ul className={layout === "sidebar" ? "flex flex-col gap-0.5" : "flex gap-1 overflow-x-auto"}>
        {items.map(({ href, label, icon, badge }) => {
          const current = href === "/" ? pathname === "/" : pathname.startsWith(href);
          const Icon = ICONS[icon];
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold"
              >
                <Icon aria-hidden="true" size={16} weight={current ? "fill" : "regular"} />
                {label}
                {badge !== undefined && badge > 0 ? (
                  <span className="ml-auto rounded-md bg-warning-soft px-1.5 text-xs font-semibold text-warning-soft-foreground tabular" data-testid={`nav-badge-${icon}`}>
                    {badge}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
