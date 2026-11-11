import {
  CheckCircleIcon,
  ClockCountdownIcon,
  HourglassIcon,
  WhatsappLogoIcon,
  XCircleIcon,
} from "@phosphor-icons/react/ssr";
import type { ReactNode } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { Button } from "@ebooktrivia/ui/components/button";
import { cn } from "@ebooktrivia/ui/lib/utils";
import { formatRupiah } from "../../lib/format.ts";
import { t } from "../../lib/t.ts";
import type { AssetId } from "../../lib/assets.ts";
import { Picture } from "../picture.tsx";
import { CopyRefButton, PollingIndicator } from "./order-client.tsx";

export const ORDER_STATES = ["pending", "paid", "expired", "failed"] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export function isOrderState(value: string): value is OrderState {
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
};

/** Static fixture. Only masked PII ever reaches the DOM. */
const ORDER = {
  ref: "TA-2611-8K4Q7M",
  product: "Ebook Trivia Nusantara Juara",
  amount: 49_000,
  whatsapp: "+62 812-****-3456",
  email: "bu***@g***.com",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export function OrderCard({ state }: { state: OrderState }) {
  const { Icon, tint, art } = CONFIG[state];
  const announce = state === "pending" ? "" : t(`order.${state}.announce`);
  const waHref = `https://wa.me/?text=${encodeURIComponent(t("order.whatsappText", { ref: ORDER.ref, product: ORDER.product }))}`;

  return (
    <article className="flex w-full max-w-[480px] flex-col gap-5 rounded-2xl bg-card p-4 text-card-foreground shadow-lg md:p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        {art === undefined ? null : (
          <div className="flex h-44 w-full justify-center">
            <Picture
              id={art}
              alt={t(`order.${state === "failed" ? "pending" : state}.art`)}
              priority
              sizes="176px"
              className="block h-full w-auto max-w-full rounded-xl object-contain"
            />
          </div>
        )}
        <span className={cn("flex size-12 items-center justify-center rounded-full", tint)}>
          <Icon aria-hidden="true" size={28} weight={state === "pending" ? "duotone" : "fill"} className={state === "paid" ? "check-pop" : undefined} />
        </span>
        <h1 className="font-heading text-2xl leading-tight">{t(`order.${state}.title`)}</h1>
        <p className="max-w-[40ch] text-base">{t(`order.${state}.body`)}</p>
      </header>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announce}
      </p>

      {state === "pending" ? <PollingIndicator lastCheckedSeconds={10} /> : null}

      <section aria-labelledby="order-summary">
        <h2 id="order-summary" className="mb-1 font-heading text-base">
          {t("order.orderSummary")}
        </h2>
        <dl className="rounded-xl border px-3">
          <Row label={t("order.product")}>{ORDER.product}</Row>
          <Row label={t("order.amount")}>
            <span className="tabular">{formatRupiah(ORDER.amount)}</span>
          </Row>
          <Row label={t("order.orderRef")}>
            <span className="flex items-center justify-end gap-1">
              <span className="timer-digits">{ORDER.ref}</span>
              <CopyRefButton value={ORDER.ref} />
            </span>
          </Row>
          <Row label={t("order.whatsapp")}>
            <span className="tabular">{ORDER.whatsapp}</span>
          </Row>
          <Row label={t("order.email")}>{ORDER.email}</Row>
        </dl>
      </section>

      <div className="flex flex-col gap-3">
        {state === "paid" ? (
          <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
            <a href="/mockups/trivia">{t("order.enterTrivia")}</a>
          </Button>
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
        {state === "expired" ? (
          <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
            <a href="/">{t("order.orderAgain")}</a>
          </Button>
        ) : null}
        {state === "failed" ? (
          <Button asChild variant="cta" size="lg" className="min-h-13 w-full text-lg">
            <a href="/">{t("order.tryPayAgain")}</a>
          </Button>
        ) : null}

        {state === "pending" || state === "paid" ? (
          <Button asChild variant="outline" size="lg" className="w-full">
            <a href={waHref} target="_blank" rel="noopener noreferrer">
              <WhatsappLogoIcon aria-hidden="true" size={22} weight="fill" />
              {t("order.sendWhatsapp")}
            </a>
          </Button>
        ) : null}
        {state === "pending" ? (
          <Button asChild variant="link" className="w-full">
            <a href="#pembayaran">{t("order.openPayment")}</a>
          </Button>
        ) : null}
      </div>

      <footer className="border-t pt-4 text-center text-sm">
        <p>
          {t("order.help")}{" "}
          <a href="#bantuan" className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4">
            {t("order.helpLink")}
          </a>
        </p>
      </footer>
    </article>
  );
}
