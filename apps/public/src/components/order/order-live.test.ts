// The order page's script component rendered on the server, i.e. what a browser without JavaScript (and every
// browser before its script ran) gets: no polling row that claims a check is happening, and a note that says
// how to check by hand.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "../../lib/order/data.ts";
import { toView } from "../../lib/order/view.ts";
import { OrderLive } from "./order-live.tsx";

const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv";
const RECORD: OrderRecord = {
  status: "pending",
  orderCode: "7K4Q9M2XJ5",
  maskedName: "B*** S***",
  maskedPhone: "0812-3456-****",
  productTitle: "Ebook Trivia",
  amountIdr: 49_000,
  pixels: {},
  lpHost: "promo.example.test",
};
const render = (status: string) => renderToStaticMarkup(createElement(OrderLive, { publicId: PUBLIC_ID, view: toView({ ...RECORD, status }, "6281111222333", "example.test") }));

describe("OrderLive (server render, before any script runs)", () => {
  it("does not claim a check is going on: no 'checked N seconds ago' row for a pending order", () => {
    const html = render("pending");
    expect(html).not.toContain("Dicek terakhir");
    expect(html).not.toContain("Memeriksa pembayaran");
  });

  it("tells a browser without JavaScript to reload to check the status, in a <noscript>", () => {
    const html = render("pending");
    expect(html).toMatch(/<noscript><p[^>]*>Muat ulang halaman untuk memeriksa status pembayaran\.<\/p><\/noscript>/);
  });

  it("has the order code, the status and the WhatsApp link regardless", () => {
    const html = render("pending");
    expect(html).toContain(">7K4Q9M2XJ5<");
    expect(html).toContain("Menunggu pembayaran");
    expect(html).toContain("https://wa.me/6281111222333?text=");
  });

  it("has no polling note or row for a state that is not pending", () => {
    for (const status of ["paid", "expired", "gateway_failed", "review", "refunded"]) {
      const html = render(status);
      expect(html, status).not.toContain("Muat ulang halaman");
      expect(html, status).not.toContain("Dicek terakhir");
    }
  });

  it("shows the resume state of the origin's root as 'loading' with the not-found text only inside <noscript>", () => {
    const html = renderToStaticMarkup(createElement(OrderLive, { publicId: null, view: null }));
    expect(html).toContain("Memuat…");
    expect(html).toMatch(/<noscript>.*Pesanan tidak ditemukan.*<\/noscript>/);
    expect(html.replace(/<noscript>.*<\/noscript>/, "")).not.toContain("Pesanan tidak ditemukan");
  });
});
