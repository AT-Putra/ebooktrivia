// The shared help block rendered on the server, with no script: nothing without a contact, the right links with one, the order code (and
// nothing personal) in the prefilled text, the hours when set, and the same block through the context a client component reads.
import { NO_CS_CONTACT } from "@ebooktrivia/core/cs-contact";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PageError from "../../app/error.tsx";
import { ContextHelpBlock, CsContactProvider } from "./cs-context.tsx";
import { HelpCard } from "./help-card.tsx";

const FULL = { whatsapp: "+6281234567890", email: "cs@contoh.id", hours: "Senin–Jumat 09.00–17.00 WIB" };
/** The opening tag of the link with this data-testid. */
const anchor = (html: string, testId: string): string => [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`data-testid="${testId}"`)) ?? "";

describe("HelpCard", () => {
  it("renders nothing when no CS contact is set: no empty card, no dead button", () => {
    expect(renderToStaticMarkup(createElement(HelpCard, { contact: NO_CS_CONTACT }))).toBe("");
    // The hours alone are no contact.
    expect(renderToStaticMarkup(createElement(HelpCard, { contact: { whatsapp: null, email: null, hours: "Setiap hari" } }))).toBe("");
  });

  it("has the heading, one line of context, the hours and the two buttons with their links", () => {
    const html = renderToStaticMarkup(createElement(HelpCard, { contact: FULL }));
    expect(html).toContain("Butuh bantuan?");
    expect(html).toContain("Ada kendala dengan pesanan, login, atau akses trivia?");
    expect(html).toContain("Jam layanan: Senin–Jumat 09.00–17.00 WIB");
    expect(html).toContain("Chat CS via WhatsApp");
    expect(html).toContain("Email CS");
    const whatsapp = anchor(html, "help-whatsapp");
    expect(whatsapp).toContain('href="https://wa.me/6281234567890?text=Halo%20CS%2C%20saya%20butuh%20bantuan."');
    expect(whatsapp).toContain('target="_blank"');
    expect(whatsapp).toContain('rel="noopener noreferrer"');
    expect(anchor(html, "help-email")).toContain('href="mailto:cs@contoh.id?subject=Butuh%20bantuan"');
  });

  it("shows only the button of what is set, and no hours line without hours", () => {
    const onlyWhatsapp = renderToStaticMarkup(createElement(HelpCard, { contact: { whatsapp: FULL.whatsapp, email: null, hours: null } }));
    expect(onlyWhatsapp).toContain("Chat CS via WhatsApp");
    expect(onlyWhatsapp).not.toContain("Email CS");
    expect(onlyWhatsapp).not.toContain("Jam layanan");
    const onlyEmail = renderToStaticMarkup(createElement(HelpCard, { contact: { whatsapp: null, email: FULL.email, hours: null } }));
    expect(onlyEmail).toContain("Email CS");
    expect(onlyEmail).not.toContain("wa.me");
    expect(onlyEmail).not.toContain("Chat CS via WhatsApp");
  });

  it("carries the order code in the prefilled text and the subject on the order page, and nothing else about the order or the buyer", () => {
    const html = renderToStaticMarkup(createElement(HelpCard, { contact: FULL, orderCode: "7K4Q9M2XJ5" }));
    expect(decodeURIComponent(/href="(https:\/\/wa\.me\/[^"]+)"/.exec(html)?.[1] ?? "")).toBe("https://wa.me/6281234567890?text=Halo CS, saya butuh bantuan untuk pesanan 7K4Q9M2XJ5.");
    expect(decodeURIComponent(/href="(mailto:[^"]+)"/.exec(html)?.[1] ?? "")).toBe("mailto:cs@contoh.id?subject=Butuh bantuan untuk pesanan 7K4Q9M2XJ5");
    expect(html).toContain("Kode pesananmu ikut terkirim");
  });

  it("has no order code, name, e-mail or phone of the buyer in any URL on a page that does not know an order", () => {
    const html = renderToStaticMarkup(createElement(HelpCard, { contact: FULL }));
    const urls = [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeURIComponent(m[1] ?? ""));
    expect(urls).toHaveLength(2);
    expect(urls.join(" ")).not.toMatch(/pesanan|order|@gmail|\+62812|0812/);
  });

  it("is one landmark with its own heading, and every control is a link of at least 44px (min-h-12)", () => {
    const html = renderToStaticMarkup(createElement(HelpCard, { contact: FULL }));
    expect(html).toContain('aria-labelledby="help-title"');
    expect(html).toContain('id="help-title"');
    expect(html.match(/min-h-12/g)).toHaveLength(2);
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("closes the error page too (a client boundary that reads the contact from the layout's provider), with the retry button above it", () => {
    const page = (contact: typeof FULL | typeof NO_CS_CONTACT) =>
      renderToStaticMarkup(createElement(CsContactProvider, { contact, children: createElement(PageError, { error: new Error("x"), reset: () => undefined }) }));
    const withContact = page(FULL);
    expect(withContact).toContain("Halaman tidak dapat dimuat");
    expect(withContact.indexOf("Coba lagi")).toBeLessThan(withContact.indexOf("Butuh bantuan?"));
    expect(withContact).toContain("https://wa.me/6281234567890");
    expect(page(NO_CS_CONTACT)).not.toContain("Butuh bantuan");
  });

  it("is the same block through the context a client component reads, and nothing outside a provider", () => {
    const through = renderToStaticMarkup(createElement(CsContactProvider, { contact: FULL, children: createElement(ContextHelpBlock, { orderCode: "7K4Q9M2XJ5" }) }));
    expect(through).toBe(renderToStaticMarkup(createElement(HelpCard, { contact: FULL, orderCode: "7K4Q9M2XJ5" })));
    expect(renderToStaticMarkup(createElement(ContextHelpBlock, {}))).toBe("");
  });
});
