// "Hubungi CS di bawah." is said only while the help block is below it: an error message must never point at nothing. Every place that says it, with a
// contact and without one.
import { NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "../../lib/order/data.ts";
import { toView } from "../../lib/order/view.ts";
import { OrderLive } from "../order/order-live.tsx";
import { errorText } from "../play/login-form.tsx";
import { NoProgram } from "../trivia/live/no-program.tsx";
import { CsContactProvider } from "./cs-context.tsx";

const FULL = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: null };
const ONLY_HOURS = { whatsapp: null, email: null, hours: "Setiap hari" };

describe("the login errors", () => {
  const answer = (status: number, body: Record<string, unknown> = {}) => ({ status, body, retryAfterSeconds: 7 });

  it("point to CS below for a code that does not work and for an outage, only while the block is shown", () => {
    const wrongCode = answer(400, { error: "invalid_code" });
    const outage = answer(503);
    expect(errorText(wrongCode, true, true)).toContain("Masih tidak bisa masuk? Hubungi CS di bawah.");
    expect(errorText(outage, false, true)).toContain("Hubungi CS di bawah.");
    expect(errorText(wrongCode, true, false)).not.toContain("CS");
    expect(errorText(outage, false, false)).not.toContain("CS");
    expect(errorText(wrongCode, true, false)).toBe("Kode salah atau sudah tidak berlaku. Coba lagi atau kirim ulang kode.");
  });

  it("leave the errors a human cannot fix alone (a bad number, a network error, a rate limit, a captcha)", () => {
    for (const helpShown of [true, false]) {
      expect(errorText(answer(0), false, helpShown)).not.toContain("CS");
      expect(errorText(answer(429), false, helpShown)).not.toContain("CS");
      expect(errorText(answer(400, { error: "captcha" }), false, helpShown)).not.toContain("CS");
      expect(errorText(answer(400, { error: "validation" }), false, helpShown)).not.toContain("CS");
      expect(errorText(answer(400, { error: "validation" }), true, helpShown)).not.toContain("CS");
    }
  });
});

describe("the trivia home of a player with no program", () => {
  it("points to the block below it, and shows the block, while a contact is set", () => {
    const html = renderToStaticMarkup(createElement(NoProgram, { contact: FULL }));
    expect(html).toContain("Belum ada program untukmu");
    expect(html).toContain("Sudah membayar tetapi program belum muncul? Hubungi CS di bawah.");
    expect(html.indexOf("Hubungi CS di bawah.")).toBeLessThan(html.indexOf("Butuh bantuan?"));
  });

  it("says neither without a contact (hours alone are no contact)", () => {
    for (const contact of [NO_CS_CONTACT, ONLY_HOURS]) {
      const html = renderToStaticMarkup(createElement(NoProgram, { contact }));
      expect(html).toContain("Belum ada program untukmu");
      expect(html).not.toContain("Hubungi CS");
      expect(html).not.toContain("Butuh bantuan");
    }
  });
});

describe("the order page's script component", () => {
  const record: OrderRecord = { status: "gateway_failed", orderCode: "7K4Q9M2XJ5", maskedName: "B*** S***", maskedPhone: "0812-3456-****", productTitle: "Ebook Trivia", amountIdr: 49_000, pixels: {}, lpHost: "promo.example.test" };
  const page = (status: string, contact: typeof FULL | typeof NO_CS_CONTACT) =>
    renderToStaticMarkup(
      createElement(CsContactProvider, { contact, children: createElement(OrderLive, { publicId: "AbCdEfGhIjKlMnOpQrStUv", view: toView({ ...record, status }, "6281111222333", "example.test") }) }),
    );

  it("points a state with a problem to the block, and renders the block, only while a contact is set", () => {
    for (const status of ["paid", "expired", "gateway_failed", "review", "refunded"]) {
      const withContact = page(status, FULL);
      expect(withContact, status).toContain("Hubungi CS di bawah.");
      expect(withContact, status).toContain("Butuh bantuan?");
      const without = page(status, NO_CS_CONTACT);
      expect(without, status).not.toContain("Hubungi CS");
      expect(without, status).not.toContain("Butuh bantuan");
    }
  });

  it("never points a pending order to it (nothing is wrong yet), but still ends with the block", () => {
    const html = page("pending", FULL);
    expect(html).not.toContain("Hubungi CS di bawah.");
    expect(html).toContain("Butuh bantuan?");
  });
});
