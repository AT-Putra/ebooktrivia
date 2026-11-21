// The root of order.<DOMAIN> (US-022). The order page strips its id from the address (history.replaceState,
// the id stays in sessionStorage), so a reload lands here: the script sends a tab that has an order back
// to it. Anyone else gets "order not found". src/proxy.ts also sends the Midtrans dashboard's unfinish and
// error redirects (/?order_id={publicId}-{n}) to the order's own page, not here.
import type { Metadata } from "next";
import { OrderLive } from "../../components/order/order-live.tsx";
import { t } from "../../lib/t.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${t("order.pageTitle")} | ${t("common.appName")}`,
  robots: { index: false, follow: false },
  referrer: "strict-origin",
};

export default function OrderShellPage() {
  return <OrderLive publicId={null} view={null} />;
}
