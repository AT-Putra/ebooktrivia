import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isOrderState, OrderCard } from "../../../../../components/order/order-card.tsx";
import { assertMockupsEnabled } from "../../../../../lib/guard.ts";

export const metadata: Metadata = { title: "Status pesanan | Trivia Arena" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ state: string }>;
}

export default async function OrderMockupPage({ params }: PageProps) {
  assertMockupsEnabled();
  const { state } = await params;
  if (!isOrderState(state)) notFound();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 py-6 md:py-10">
      <OrderCard state={state} />
    </main>
  );
}
