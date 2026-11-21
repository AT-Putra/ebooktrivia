import {
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  ClockCountdownIcon,
  HourglassIcon,
  WarningCircleIcon,
  WhatsappLogoIcon,
  XCircleIcon,
} from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { formatRupiah } from "../../lib/format.ts";
import type { PageState } from "../../lib/order/contract.ts";
import { t } from "../../lib/t.ts";
import type { AssetId } from "../../lib/assets.ts";
import { Picture } from "../picture.tsx";
import { CopyRefButton } from "./order-client.tsx";

/** The four states of the design mockups (US-006/US-008); the live page also has review and refunded. */
export const ORDER_STATES = ["pending", "paid", "expired", "failed"] as const;
export type OrderState = PageState;

export function isOrderState(value: string): value is (typeof ORDER_STATES)[number] {
  return (ORDER_STATES as readonly string[]).includes(value);
}

interface StateConfig {
  Icon: PhosphorIcon;
  tint: string;
  art?: AssetId;
}

const CONFIG: Record<OrderState, StateConfig> = {
  pending: { Icon: HourglassIcon, tint: "bg-info-soft text-info-soft-foreground", art: "status-pending" },
  paid: { Icon: CheckCircleIcon, tint: "bg-success-soft text-success-soft-foreground", art: "status-paid" },
  expired: { Icon: ClockCountdownIcon, tint: "bg-warning-soft text-warning-soft-foreground", art: "status-expired" },
  failed: { Icon: XCircleIcon, tint: "bg-destructive-soft text-destructive-soft-foreground" },
  review: { Icon: WarningCircleIcon, tint: "bg-warning-soft text-warning-soft-foreground" },
  refunded: { Icon: ArrowUUpLeftIcon, tint: "bg-info-soft text-info-soft-foreground" },
};

/** What the card shows of an order. Only masked personal data ever reaches it; the live page has no e-mail at all. */
export interface OrderCardData {
  readonly ref: string;
  readonly product: string;
  readonly amount: number;
  readonly name?: string;
  readonly whatsapp: string;
  readonly email?: string;
}

/** Where the card's actions lead; a null link leaves its action out. */
export interface OrderCardLinks {
  /** The OTP login (paid): the page itself carries no login token. */
  readonly trivia: string;
  /** Back to the landing page (expired, failed). */
  readonly again: string | null;
  /** wa.me with the order code in its text. */
  readonly whatsapp: string | null;
  /** The pending-state link to the payment page (mockup only: the live page holds no Snap data). */
  readonly payment?: string;
  readonly help: string | null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

interface OrderCardProps {
  readonly state: OrderState;
  readonly order: OrderCardData;
  readonly links: OrderCardLinks;
  /** The polling row (components/order/order-client.tsx), shown under the status text in whatever state the caller passes it for. */
  readonly polling?: ReactNode;
}

export function OrderCard({ state, order, links, polling }: OrderCardProps) {
  const { Icon, tint, art } = CONFIG[state];
  const announce = state === "pending" ? "" : t(`order.${state}.announce`);

  return (
    <article className="flex w-full max-w-[480px] flex-col gap-5 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        {art === undefined ? null : (
          <div className="flex h-44 w-full justify-center">
            <Picture id={art} alt={t(state === "paid" ? "order.paid.art" : state === "expired" ? "order.expired.art" : "order.pending.art")} priority sizes="176px" className="block h-full w-auto max-w-full rounded-xl object-contain" />
          </div>
        )}
        <span className={cn("flex size-12 items-center justify-center rounded-full", tint)}>
          <Icon aria-hidden="true" size={28} weight={state === "pending" ? "duotone" : "fill"} className={state === "paid" ? "check-pop" : undefined} />
        </span>
        <h1 className="font-heading text-2xl leading-tight">{t(`order.${state}.title`)}</h1>
        <p className="max-w-[40ch] text-base">{t(`order.${state}.body`)}</p>
      </header>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="order-announce">
        {announce}
      </p>

      {polling}

      <section aria-labelledby="order-summary">
        <h2 id="order-summary" className="mb-1 font-heading text-base">
          {t("order.orderSummary")}
        </h2>
        <dl className="rounded-xl border px-3">
          <Row label={t("order.product")}>{order.product}</Row>
          <Row label={t("order.amount")}>
            <span className="tabular">{formatRupiah(order.amount)}</span>
          </Row>
          <Row label={t("order.orderRef")}>
            <span className="flex items-center justify-end gap-1">
              <span className="timer-digits" data-testid="order-code">
                {order.ref}
              </span>
              <CopyRefButton value={order.ref} />
            </span>
          </Row>
          {order.name === undefined ? null : <Row label={t("order.name")}>{order.name}</Row>}
          <Row label={t("order.whatsapp")}>
            <span className="tabular">{order.whatsapp}</span>
          </Row>
          {order.email === undefined ? null : <Row label={t("order.email")}>{order.email}</Row>}
        </dl>
      </section>

      <div className="flex flex-col gap-3">
        {state === "paid" ? (
          <>
            <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
              <a href={links.trivia}>{t("order.enterTrivia")}</a>
            </Button>
            <p className="text-center text-sm text-muted-foreground">{t("order.loginSent")}</p>
          </>
        ) : null}
        {state === "pending" ? (
          <div className="flex flex-col gap-1">
            <Button variant="cta" size="lg" className="min-h-13 w-full text-lg" disabled aria-describedby="trivia-disabled-reason">
              {t("order.enterTrivia")}
            </Button>
            <p id="trivia-disabled-reason" className="text-center text-sm text-muted-foreground">
              {t("order.enterTriviaDisabled")}
            </p>
          </div>
        ) : null}
        {state === "expired" && links.again !== null ? (
          <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
            <a href={links.again}>{t("order.orderAgain")}</a>
          </Button>
        ) : null}
        {state === "failed" && links.again !== null ? (
          <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
            <a href={links.again}>{t("order.tryPayAgain")}</a>
          </Button>
        ) : null}

        {(state === "pending" || state === "paid") && links.whatsapp !== null ? (
          <Button asChild variant="outline" size="lg" className="w-full">
            <a href={links.whatsapp} target="_blank" rel="noopener noreferrer" data-testid="order-whatsapp">
              <WhatsappLogoIcon aria-hidden="true" size={22} weight="fill" />
              {t("order.sendWhatsapp")}
            </a>
          </Button>
        ) : null}
        {state === "pending" && links.payment !== undefined ? (
          <Button asChild variant="link" className="w-full">
            <a href={links.payment}>{t("order.openPayment")}</a>
          </Button>
        ) : null}
      </div>

      {links.help === null ? null : (
        <footer className="border-t pt-4 text-center text-sm">
          <p>
            {t("order.help")}{" "}
            <a href={links.help} className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4">
              {t("order.helpLink")}
            </a>
          </p>
        </footer>
      )}
    </article>
  );
}
