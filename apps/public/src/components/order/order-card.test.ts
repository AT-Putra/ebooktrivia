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
  { status: "pending", orderCode: "7K4Q9M2XJ5", maskedName: "B*** S***", maskedPhone: "0812-3456-****", productTitle: "Ebook Trivia", amountIdr: 49_000, pixels: {}, lpHost: "promo.example.test" },
  "6281111222333",
  "example.test",
);

function render(state: (typeof PAGE_STATES)[number], overrides: Partial<typeof view> = {}) {
  const v = { ...view, ...overrides };
  return renderToStaticMarkup(
    createElement(OrderCard, {
      state,
      order: { ref: v.code, product: v.product, amount: v.amountIdr, name: v.name, whatsapp: v.phone },
      links: { trivia: v.loginHref, again: v.orderAgainHref, whatsapp: v.whatsappHref, whatsappPaid: v.whatsappPaidHref },
      paidWording: v.paidWording,
    }),
  );
}

describe("OrderCard (server render)", () => {
  it.each(PAGE_STATES)("shows the order code and the masked summary for a %s order", (state) => {
    const html = render(state);
    expect(html).toContain(">7K4Q9M2XJ5<");
    expect(html).toContain("B*** S***");
    expect(html).toContain("0812-3456-****");
    expect(html).toContain("Rp 49.000");
    for (const secret of ["Budi", "Santoso", "81234567890"]) expect(html, secret).not.toContain(secret);
    // No e-mail address anywhere (the art's file names, "status-paid@1x.webp", are not addresses).
    expect(html.replace(/\/assets\/[^"\s,]+/g, "")).not.toContain("@");
  });

  it("has the WhatsApp button for a pending and a paid order, with the order code in the link", () => {
    for (const state of ["pending", "paid"] as const) {
      const html = render(state);
      const hrefs = [...html.matchAll(/href="(https:\/\/wa\.me\/[^"]+)"/g)].map((m) => m[1] ?? "");
      expect(hrefs, state).toHaveLength(1);
      expect(decodeURIComponent(hrefs[0] ?? "")).toContain("7K4Q9M2XJ5");
    }
    expect(render("pending")).toContain("Kirim via WhatsApp");
    expect(render("pending", { whatsappHref: null })).not.toContain("wa.me");
  });

  it("makes WhatsApp the paid page's one big button (asking for the ebook and the trivia access), with the login as a small link under it", () => {
    const html = render("paid");
    const href = /href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1] ?? "";
    expect(decodeURIComponent(href)).toBe("https://wa.me/6281111222333?text=Halo, saya mau ambil ebook Ebook Trivia dan akses trivia. Kode pesanan saya 7K4Q9M2XJ5.");
    // The WhatsApp button comes first, then the note, then the small login link.
    const wa = html.indexOf('data-testid="order-whatsapp"');
    const note = html.indexOf('data-testid="order-whatsapp-note"');
    const login = html.indexOf('data-testid="order-trivia-link"');
    expect(wa).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(wa);
    expect(login).toBeGreaterThan(note);
    expect(html).toContain("Ambil Ebook &amp; Akses Trivia via WhatsApp");
    expect(html).toContain("Langkah terakhir: chat kami di WhatsApp.");
    expect(html).toContain("Sudah dapat akses?");
    expect(html).toContain('href="https://play.example.test/login"');
    expect(html).not.toContain("Kirim via WhatsApp");
    expect(html).not.toMatch(/token|magic|[?&]t=|[?&]code=/i);
  });

  it("shows the Owner's wording on the paid page; an empty note shows nothing", () => {
    const html = render("paid", { paidWording: { body: "Satu langkah lagi, chat kami ya.", button: "Chat WhatsApp sekarang", note: "" } });
    expect(html).toContain("Satu langkah lagi, chat kami ya.");
    expect(html).toContain("Chat WhatsApp sekarang");
    expect(html).not.toContain('data-testid="order-whatsapp-note"');
  });

  it("keeps the login as the paid page's big button when no WhatsApp number is known", () => {
    const html = render("paid", { whatsappHref: null, whatsappPaidHref: null });
    expect(html).not.toContain("wa.me");
    expect(html).toMatch(/<a[^>]*href="https:\/\/play\.example\.test\/login"[^>]*data-testid="order-trivia-link"/);
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
          links: { trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref },
          polling: createElement(PollingStopped, { onRetry: () => undefined }),
        }),
      );
      expect(html, state).toContain("Pemeriksaan otomatis berhenti");
      expect(html, state).toContain("Periksa lagi");
    }
  });

  it("has no help area of its own (the shared help block under it is the one help on the page)", () => {
    for (const state of PAGE_STATES) {
      const html = render(state);
      expect(html, state).not.toContain("Butuh bantuan");
      expect(html, state).not.toContain("Hubungi kami");
      expect(html, state).not.toContain("order-help-pointer");
    }
  });

  it("points every state but pending to the help block when the page shows one (each says what to do about its own problem)", () => {
    const pointed = (state: (typeof PAGE_STATES)[number]) =>
      renderToStaticMarkup(
        createElement(OrderCard, {
          state,
          order: { ref: view.code, product: view.product, amount: view.amountIdr, name: view.name, whatsapp: view.phone },
          links: { trivia: view.loginHref, again: view.orderAgainHref, whatsapp: view.whatsappHref },
          pointToHelp: true,
        }),
      );
    expect(pointed("pending")).not.toContain("order-help-pointer");
    for (const state of PAGE_STATES.filter((s) => s !== "pending")) {
      const html = pointed(state);
      expect(html, state).toContain("order-help-pointer");
      expect(html, state).toContain("Hubungi CS di bawah.");
    }
    expect(pointed("paid")).toContain("Ebook belum sampai?");
    expect(pointed("failed")).toContain("Tetap gagal setelah dicoba lagi?");
    expect(pointed("expired")).toContain("Sudah membayar tetapi halaman ini bilang kedaluwarsa?");
  });

  it("leads an expired or failed order back to the landing page, and offers nothing when it has none", () => {
    expect(render("expired")).toContain('href="https://promo.example.test/"');
    expect(render("failed")).toContain('href="https://promo.example.test/"');
    expect(render("expired", { orderAgainHref: null })).not.toContain("Pesan lagi");
    expect(render("review")).not.toContain("promo.example.test");
  });
});
