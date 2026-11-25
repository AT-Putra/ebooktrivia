"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BellRingingIcon,
  BookOpenIcon,
  BrowserIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  ChatTextIcon,
  ChartLineUpIcon,
  ClipboardTextIcon,
  CreditCardIcon,
  CurrencyCircleDollarIcon,
  EnvelopeIcon,
  GaugeIcon,
  GiftIcon,
  HeadsetIcon,
  ListChecksIcon,
  ListIcon,
  MedalIcon,
  MegaphoneIcon,
  PackageIcon,
  PresentationChartIcon,
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
  leads: PresentationChartIcon,
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
  cs: HeadsetIcon,
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
/** A group of the menu by what its pages are for (Dashboard, Orders, Reports, ...). */
export interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

const isCurrent = (href: string, pathname: string): boolean => (href === "/" ? pathname === "/" : pathname.startsWith(href));

function WaitingBadge({ count, testId }: { count: number; testId: string }) {
  return (
    <span className="ml-auto rounded-md bg-warning-soft px-1.5 text-xs font-semibold tracking-normal text-warning-soft-foreground normal-case tabular" data-testid={testId}>
      {count}
      <span className="sr-only"> waiting</span>
    </span>
  );
}

/**
 * The console navigation in collapsible groups; the server passes only the groups and items the signed-in role may open.
 * The group of the open page starts open, and opening another page opens its group without closing the ones the reader
 * opened. Native <details>, so the groups open and close without JavaScript too. On a phone the whole menu sits behind a
 * "Menu" button, which closes again when a page is chosen.
 */
export function ConsoleNav({ groups, layout }: { groups: readonly NavGroup[]; layout: "sidebar" | "bar" }) {
  const pathname = usePathname();
  const currentGroup = groups.find((g) => g.items.some((i) => isCurrent(i.href, pathname)))?.id ?? null;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(currentGroup === null ? [] : [currentGroup]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    // A new page (state adjusted during render, not in an effect): open its group, close the phone menu.
    setSeenPath(pathname);
    if (currentGroup !== null && !open.has(currentGroup)) setOpen(new Set([...open, currentGroup]));
    setMenuOpen(false);
  }
  const toggle = (id: string, now: boolean) => {
    setOpen((prev) => {
      if (prev.has(id) === now) return prev;
      const next = new Set(prev);
      if (now) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  // A group or the menu opened before the page was interactive fired its toggle event before React listened: read the real state once.
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menuRef.current?.open === true) setMenuOpen(true);
    const opened = [...(navRef.current?.querySelectorAll<HTMLDetailsElement>("details[data-group]") ?? [])].filter((d) => d.open).map((d) => d.dataset["group"] ?? "");
    if (opened.length > 0) setOpen((prev) => (opened.every((id) => prev.has(id)) ? prev : new Set([...prev, ...opened])));
  }, []);
  const waitingTotal = groups.reduce((n, g) => n + g.items.reduce((m, i) => m + (i.badge ?? 0), 0), 0);
  const currentLabel = groups.flatMap((g) => g.items).find((i) => isCurrent(i.href, pathname))?.label;

  const menu = (
    <nav aria-label="Console" ref={navRef}>
      <ul className="flex flex-col gap-1">
        {groups.map((g) => {
          const isOpen = open.has(g.id);
          const waiting = g.items.reduce((n, i) => n + (i.badge ?? 0), 0);
          return (
            <li key={g.id}>
              <details
                open={isOpen}
                onToggle={(e) => {
                  toggle(g.id, e.currentTarget.open);
                }}
                className="group/nav"
                data-group={g.id}
                data-testid={`nav-group-${g.id}`}
              >
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase transition-colors duration-150 select-none hover:bg-muted hover:text-foreground lg:min-h-9 [&::-webkit-details-marker]:hidden">
                  <CaretRightIcon aria-hidden="true" size={12} weight="bold" className="shrink-0 transition-transform duration-150 group-open/nav:rotate-90 motion-reduce:transition-none" />
                  {g.label}
                  {!isOpen && waiting > 0 ? <WaitingBadge count={waiting} testId={`nav-group-badge-${g.id}`} /> : null}
                </summary>
                <ul className="flex flex-col gap-0.5 pt-0.5 pb-1.5">
                  {g.items.map(({ href, label, icon, badge }) => {
                    const current = isCurrent(href, pathname);
                    const Icon = ICONS[icon];
                    return (
                      <li key={href}>
                        <Link
                          href={href}
                          aria-current={current ? "page" : undefined}
                          className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold lg:min-h-9"
                          onClick={() => {
                            // A tap on the page already open changes no path: close the phone menu here too.
                            setMenuOpen(false);
                          }}
                        >
                          <Icon aria-hidden="true" size={16} weight={current ? "fill" : "regular"} />
                          {label}
                          {badge !== undefined && badge > 0 ? <WaitingBadge count={badge} testId={`nav-badge-${icon}`} /> : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  if (layout === "sidebar") return menu;
  return (
    <details
      ref={menuRef}
      open={menuOpen}
      onToggle={(e) => {
        setMenuOpen(e.currentTarget.open);
      }}
      className="group/menu"
      data-testid="nav-menu"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors duration-150 select-none hover:bg-muted [&::-webkit-details-marker]:hidden">
        <ListIcon aria-hidden="true" size={18} />
        Menu
        {currentLabel === undefined ? null : <span className="min-w-0 truncate font-normal text-muted-foreground">· {currentLabel}</span>}
        {waitingTotal > 0 ? <WaitingBadge count={waitingTotal} testId="nav-menu-badge" /> : null}
        <CaretRightIcon aria-hidden="true" size={14} weight="bold" className={`${waitingTotal > 0 ? "" : "ml-auto "}shrink-0 rotate-90 transition-transform duration-150 group-open/menu:-rotate-90 motion-reduce:transition-none`} />
      </summary>
      <div className="mt-2 max-h-[70dvh] overflow-y-auto overscroll-contain rounded-md border bg-card p-1">{menu}</div>
    </details>
  );
}
