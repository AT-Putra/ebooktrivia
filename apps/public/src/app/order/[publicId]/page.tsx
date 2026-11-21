// order.<DOMAIN>/{publicId} (US-022): the payment status page, server-rendered from the database so it
// shows the order code, the status and the WhatsApp link without JavaScript. src/proxy.ts serves it
// only on the order origin (rewriting /{publicId} here) with the per-vendor CSP and strict-origin
// referrer policy. The id is a capability: an unknown id and a malformed one are the same 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderLive } from "../../../components/order/order-live.tsx";
import { getOrderStatus, isPublicId, poolNumber } from "../../../lib/order/data.ts";
import { toView } from "../../../lib/order/view.ts";
import { getRuntime } from "../../../lib/runtime.ts";
import { t } from "../../../lib/t.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${t("order.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

interface PageProps {
  params: Promise<{ publicId: string }>;
}

export default async function OrderPage({ params }: PageProps) {
  const { publicId } = await params;
  if (!isPublicId(publicId)) notFound();
  const { order } = await getRuntime();
  const record = await getOrderStatus(order.sql, publicId);
  if (record === undefined) notFound();
  return <OrderLive publicId={publicId} view={toView(record, await poolNumber(order.sql), order.domain)} />;
}
