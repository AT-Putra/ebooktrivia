// A published legal page never injects HTML (US-018's rule, now on the public page): an Owner-authored body
// full of markup is rendered as text, so a <script> or an event-handler attribute in it shows literally.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalDocument } from "./legal-document.tsx";

const PAYLOADS = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(2)">',
  '<a href="javascript:alert(3)">klik</a>',
  "<svg onload=alert(4)>",
  "</p><iframe srcdoc='<script>alert(5)</script>'></iframe>",
];
const render = (title: string, body: string) => renderToStaticMarkup(createElement(LegalDocument, { title, body, version: 3, publishedAt: new Date("2026-11-20T03:00:00Z") }));

describe("LegalDocument", () => {
  it("renders the title, the version and date in Bahasa Indonesia, headings and paragraphs from the plain-text body", () => {
    const html = render("S&K Musim 1", "# Hadiah\nJuara 1: voucher.\n\nBaris dua.");
    expect(html).toContain("<h1");
    expect(html).toContain("S&amp;K Musim 1");
    expect(html).toContain("Versi 3");
    expect(html).toContain("Diterbitkan 20 November 2026");
    expect(html).toContain(">Hadiah</h2>");
    expect(html).toContain(">Juara 1: voucher.</p>");
    expect(html).toContain(">Baris dua.</p>");
  });

  it.each(PAYLOADS)("escapes %s in the body and the title: no element, attribute or URL from it reaches the markup", (payload) => {
    const html = render(payload, `# ${payload}\n${payload}\n\n${payload}`);
    const tags = [...html.matchAll(/<([a-z0-9]+)([^>]*)>/g)];
    expect(tags.map((m) => m[1])).toEqual(["main", "article", "header", "h1", "p", "h2", "p", "p"]);
    expect(new Set(tags.flatMap((m) => [...(m[2] ?? "").matchAll(/\s([a-z-]+)=/g)].map((a) => a[1])))).toEqual(new Set(["class", "data-testid"]));
    expect(html).not.toMatch(/<(script|img|a|svg|iframe)\b/i);
    expect(html).toContain(payload.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;"));
  });
});
