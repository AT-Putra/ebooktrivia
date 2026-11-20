// The legal page preview never injects HTML (US-018): an Owner-authored body full of markup is
// rendered as text, so a <script> or an event-handler attribute in it shows literally and cannot run.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalPreview } from "./legal-preview.tsx";

const PAYLOADS = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(2)">',
  "<a href=\"javascript:alert(3)\">klik</a>",
  "<svg onload=alert(4)>",
  "</p><iframe srcdoc='<script>alert(5)</script>'></iframe>",
];

describe("LegalPreview", () => {
  it("renders headings and paragraphs from the plain-text body", () => {
    const html = renderToStaticMarkup(createElement(LegalPreview, { title: "S&K Musim 1", body: "# Hadiah\nJuara 1: voucher.\n\nBaris dua." }));
    expect(html).toContain("<h3");
    expect(html).toContain("S&amp;K Musim 1");
    expect(html).toContain(">Hadiah</h4>");
    expect(html).toContain(">Juara 1: voucher.</p>");
    expect(html).toContain(">Baris dua.</p>");
  });

  it.each(PAYLOADS)("escapes %s in the body and the title: no element, attribute or URL from it reaches the markup", (payload) => {
    const html = renderToStaticMarkup(createElement(LegalPreview, { title: payload, body: `# ${payload}\n${payload}\n\n${payload}` }));
    // The only elements are the preview's own, with only its own attributes (an escaped "onerror="
    // inside the text is fine: it is not inside a tag).
    const tags = [...html.matchAll(/<([a-z0-9]+)([^>]*)>/g)];
    expect(tags.map((m) => m[1])).toEqual(["article", "h3", "h4", "p", "p"]);
    expect(new Set(tags.flatMap((m) => [...(m[2] ?? "").matchAll(/\s([a-z-]+)=/g)].map((a) => a[1])))).toEqual(new Set(["class", "data-testid"]));
    expect(html).not.toMatch(/<(script|img|a|svg|iframe)\b/i);
    expect(html).toContain(payload.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;"));
  });
});
