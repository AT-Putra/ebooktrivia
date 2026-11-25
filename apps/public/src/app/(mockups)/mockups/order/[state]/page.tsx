import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isOrderState, OrderCard, type OrderCardData, type OrderCardLinks } from "../../../../../components/order/order-card.tsx";
import { HelpCard } from "../../../../../components/help/help-card.tsx";
import { PollingIndicator } from "../../../../../components/order/order-client.tsx";
import { assertMockupsEnabled } from "../../../../../lib/guard.ts";
import { MOCKUP_CS_CONTACT } from "../../../../../lib/mockups.ts";
import { t } from "../../../../../lib/t.ts";

export const metadata: Metadata = { title: "Status pesanan | Trivia Arena" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ state: string }>;
}

/** Static fixture. Only masked PII ever reaches the DOM. */
const ORDER: OrderCardData = {
  ref: "TA-2611-8K4Q7M",
  product: "Ebook Trivia Nusantara Juara",
  amount: 49_000,
  whatsapp: "0812-3456-****",
  email: "bu***@g***.com",
};

const LINKS: OrderCardLinks = {
  trivia: "/mockups/trivia",
  again: "/",
  whatsapp: `https://wa.me/?text=${encodeURIComponent(t("order.whatsappText", { ref: ORDER.ref, product: ORDER.product }))}`,
  whatsappPaid: `https://wa.me/?text=${encodeURIComponent(t("order.whatsappTextPaid", { ref: ORDER.ref, product: ORDER.product }))}`,
  payment: "#pembayaran",
};

export default async function OrderMockupPage({ params }: PageProps) {
  assertMockupsEnabled();
  const { state } = await params;
  if (!isOrderState(state)) notFound();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <OrderCard state={state} order={ORDER} links={LINKS} pointToHelp polling={state === "pending" ? <PollingIndicator lastCheckedSeconds={10} /> : undefined} />
      <HelpCard contact={MOCKUP_CS_CONTACT} orderCode={ORDER.ref} className="max-w-[480px]" />
    </main>
  );
}
