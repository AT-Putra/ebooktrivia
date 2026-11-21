// The order card rendered on the server, with no script at all (AC-S10: "renders safely without JS"):
// the order code, the status, the WhatsApp link and the login call to action are in the markup, and no
// login token and no unmasked personal data is.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAGE_STATES } from "../../lib/order/contract.ts";
import { toView } from "../../lib/order/view.ts";
import { OrderCard } from "./order-card.tsx";
import { PollingStopped } from "./order-client.tsx";

const view = toView(
  { status: "pending", orderCode: "7K4Q9M2XJ5", maskedName: "B*** S***", maskedPhone: "****890", productTitle: "Ebook Trivia", amountIdr: 49_000, pixels: {}, lpHost: "promo.example.test" },
  "6281111222333",
  "example.test",
);

function render(state: (typeof PAGE_STATES)[number], overrides: Partial<typeof view> = {}) {
  const v = { ...view, ...overrides };
  return renderToStaticMarkup(
    createElement(OrderCard, {
      state,
      order: { ref: v.code, product: v.product, amount: v.amountIdr, name: v.name, whatsapp: v.phone },
      links: { trivia: v.loginHref, again: v.orderAgainHref, whatsapp: v.whatsappHref, help: v.whatsappHref },
    }),
  );
}

describe("OrderCard (server render)", () => {
  it.each(PAGE_STATES)("shows the order code and the masked summary for a %s order", (state) => {
    const html = render(state);
    expect(html).toContain(">7K4Q9M2XJ5<");
    expect(html).toContain("B*** S***");
    expect(html).toContain("****890");
    expect(html).toContain("Rp 49.000");
    for (const secret of ["Budi", "Santoso", "81234567890"]) expect(html, secret).not.toContain(secret);
    // No e-mail address anywhere (the art's file names, "status-paid@1x.webp", are not addresses).
    expect(html.replace(/\/assets\/[^"\s,]+/g, "")).not.toContain("@");
  });

  it("has the WhatsApp button for a pending and a paid order, with the order code in the link", () => {
    for (const state of ["pending", "paid"] as const) {
      const html = render(state);
      const href = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1];
      expect(href, state).toBeDefined();
      expect(decodeURIComponent(href ?? "")).toContain("7K4Q9M2XJ5");
      expect(html).toContain("Kirim via WhatsApp");
    }
    expect(render("pending", { whatsappHref: null })).not.toContain("wa.me");
  });

  it("shows the paid call to action as a plain link to OTP login on the play origin, and says the link was sent", () => {
    const html = render("paid");
    expect(html).toContain('href="https://play.example.test/login"');
    expect(html).toContain("Masuk ke Trivia");
    expect(html).toContain("WhatsApp dan email");
    expect(html).not.toMatch(/token|magic|[?&]t=|[?&]code=/i);
  });

  it("disables the trivia button while pending and has no login link", () => {
    const html = render("pending");
    expect(html).toContain("disabled");
    expect(html).not.toContain("play.example.test");
  });

  it("announces a state change to screen readers in a polite live region, empty while pending", () => {
    expect(render("pending")).toMatch(/<p role="status" aria-live="polite" aria-atomic="true" class="sr-only"[^>]*><\/p>/);
    expect(render("paid")).toMatch(/aria-live="polite"[^>]*>Pembayaran berhasil\./);
  });

  it("shows the polling slot in whatever state the caller passes it for: the manual check of an expired, failed or review order that ran out of automatic checks", () => {
    for (const state of ["expired", "failed", "review"] as const) {
      const html = renderToStaticMarkup(
        createElement(OrderCard, {
          state,
          order: { ref: view.code, product: view.product, amount: view.amountIdr, name: view.name, whatsapp: view.phone },
          links: { trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref, help: view.whatsappHref },
          polling: createElement(PollingStopped, { onRetry: () => undefined }),
        }),
      );
      expect(html, state).toContain("Pemeriksaan otomatis berhenti");
      expect(html, state).toContain("Periksa lagi");
    }
  });

  it("leads an expired or failed order back to the landing page, and offers nothing when it has none", () => {
    expect(render("expired")).toContain('href="https://promo.example.test/"');
    expect(render("failed")).toContain('href="https://promo.example.test/"');
    expect(render("expired", { orderAgainHref: null })).not.toContain("Pesan lagi");
    expect(render("review")).not.toContain("promo.example.test");
  });
});
