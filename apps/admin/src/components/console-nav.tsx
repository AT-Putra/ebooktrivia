"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpenIcon,
  BrowserIcon,
  ChatCircleDotsIcon,
  ChatTextIcon,
  ClipboardTextIcon,
  CreditCardIcon,
  EnvelopeIcon,
  GaugeIcon,
  MegaphoneIcon,
  TrophyIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";

const ICONS = {
  overview: GaugeIcon,
  programs: TrophyIcon,
  products: BookOpenIcon,
  landing: BrowserIcon,
  adnets: MegaphoneIcon,
  midtrans: CreditCardIcon,
  waha: ChatCircleDotsIcon,
  smtp: EnvelopeIcon,
  templates: ChatTextIcon,
  team: UsersThreeIcon,
  audit: ClipboardTextIcon,
  account: UserCircleIcon,
} as const;
export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: NavIcon;
}

/** The console navigation; the server passes only the items the signed-in role may open. */
export function ConsoleNav({ items, layout }: { items: readonly NavItem[]; layout: "sidebar" | "bar" }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console">
      <ul className={layout === "sidebar" ? "flex flex-col gap-0.5" : "flex gap-1 overflow-x-auto"}>
        {items.map(({ href, label, icon }) => {
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
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
