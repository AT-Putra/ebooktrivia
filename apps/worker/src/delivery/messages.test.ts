import { escapeHtml, TemplateError } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { emailMessage, htmlSourceToText, openerMessage, pdfOnlyCaption, replyText, type ReplyKind, type StoredTemplate, TemplateMissing, whatsappCaption } from "./messages.ts";

const PLAY = "https://play.example.test";
const LINK = "https://play.example.test/masuk#c=email&t=abcDEF0123456789abcDEF0123456789abcDEF01234";
const values = { nama: "Budi Santoso", judul_ebook: "Ebook Nusantara", order_id: "7K3M9XQ2PA", link_trivia: LINK };
const email: StoredTemplate = {
  subject: "Ebook {judul_ebook} untuk {nama}",
  body: '<html><body><p>Halo {nama}, ebook {judul_ebook} ({order_id}).</p><p><a href="{link_trivia}">Masuk</a></p></body></html>',
};

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and in a quoted attribute", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("whatsappCaption", () => {
  it("renders the template with the order, and the login link only on the play origin", () => {
    const caption = whatsappCaption({ subject: null, body: "Halo {nama}, {judul_ebook} {order_id}: {link_trivia}" }, { ...values, link_trivia: `${PLAY}/masuk#c=whatsapp&t=x` }, PLAY);
    expect(caption).toBe(`Halo Budi Santoso, Ebook Nusantara 7K3M9XQ2PA: ${PLAY}/masuk#c=whatsapp&t=x`);
    expect(() => whatsappCaption({ subject: null, body: "{link_trivia}" }, { ...values, link_trivia: "https://evil.example/masuk" }, PLAY)).toThrow(TemplateError);
    expect(() => whatsappCaption({ subject: null, body: "{link_trivia}" }, { nama: "a", judul_ebook: "b", order_id: "c" }, PLAY)).toThrow(TemplateError);
  });

  it("neutralises a buyer's markup and links (plain text, no line injection)", () => {
    const caption = whatsappCaption({ subject: null, body: "Halo {nama}" }, { ...values, nama: "*Budi*\n> evil.example _x_" }, PLAY);
    expect(caption).not.toContain("*");
    expect(caption).not.toContain("\n");
    expect(caption).not.toContain("evil.example");
  });
});

describe("openerMessage (the short text of the WhatsApp opener, Owner decision D7)", () => {
  const variants: StoredTemplate[] = [
    { subject: null, body: "Halo {nama}, ebook {judul_ebook} sudah siap. Balas ya." },
    { subject: null, body: "Hai {nama}! Pesanan {order_id} sudah dibayar, balas pesan ini." },
  ];
  const v = { firstName: "Budi", title: "Ebook Nusantara", code: "7K3M9XQ2PA" };

  it("picks one of the variants by the random draw and puts the first name, the title and the code in it, as plain text", () => {
    expect(openerMessage(variants, v, () => 0)).toBe("Halo Budi, ebook Ebook Nusantara sudah siap. Balas ya.");
    expect(openerMessage(variants, v, () => 0.99)).toBe("Hai Budi! Pesanan 7K3M9XQ2PA sudah dibayar, balas pesan ini.");
    // A draw of exactly 1 (or more) never runs off the list.
    expect(openerMessage(variants, v, () => 1)).toContain("Hai Budi");
  });

  it("greets a buyer without a usable first name with a neutral address, never an empty one", () => {
    expect(openerMessage(variants, { ...v, firstName: "" }, () => 0)).toBe("Halo Kak, ebook Ebook Nusantara sudah siap. Balas ya.");
  });

  it("with no variant at all it is a missing template, never a blank message", () => {
    expect(() => openerMessage([], v, () => 0)).toThrow(TemplateMissing);
  });
});

describe("emailMessage", () => {
  it("escapes every value in the HTML, and puts the link in the href and the text part", () => {
    const rendered = emailMessage(email, { ...values, nama: `<script>alert(1)</script> "Budi" & 'Co'` }, PLAY);
    expect(rendered.subject).toContain("Ebook Ebook Nusantara untuk");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered.html).toContain("&quot;Budi&quot; &amp; &#39;Co&#39;");
    expect(rendered.html).toContain(`href="${LINK}"`.replace("&", "&amp;"));
    expect(rendered.text).toContain("7K3M9XQ2PA");
    expect(rendered.text).toContain(LINK);
    expect(rendered.text).not.toContain("<script>");
  });

  it("adds a download notice and link before </body> when the PDF is not attached, to both parts", () => {
    const url = "https://api.example.test/files/deliverables/x.pdf?exp=1&sig=a_b-c";
    const rendered = emailMessage(email, values, PLAY, url);
    expect(rendered.html).toContain(`<a href="https://api.example.test/files/deliverables/x.pdf?exp=1&amp;sig=a_b-c">`);
    expect(rendered.html.indexOf("Unduh ebook")).toBeLessThan(rendered.html.indexOf("</body>"));
    expect(rendered.text).toContain(url);
    expect(rendered.text).toContain("terlalu besar");
    // A body without </body> gets it at the end; the match is case-insensitive.
    expect(emailMessage({ subject: "s", body: "<p>{nama}</p>" }, values, PLAY, url).html).toMatch(/<\/p><p>.*Unduh ebook.*<\/p>$/);
    expect(emailMessage({ subject: "s", body: "<BODY>{nama}</BODY>" }, values, PLAY, url).html).toMatch(/Unduh ebook<\/a><\/p><\/BODY>$/);
  });

  it("has no login line without a link, and tolerates a template without a subject", () => {
    const rendered = emailMessage({ subject: null, body: "<p>{nama}</p>" }, { nama: "A", judul_ebook: "B", order_id: "C" }, PLAY);
    expect(rendered.subject).toBe("");
    expect(rendered.text).not.toContain("tautan");
    expect(() => emailMessage({ subject: "s", body: "<p>{link_trivia}</p>" }, { nama: "A", judul_ebook: "B", order_id: "C" }, PLAY)).toThrow(TemplateError);
  });
});

describe("the e-mail's text part is the Owner's template, not a fixed sentence", () => {
  it("follows an edit of the template (a changed sentence, link and variable reach the text part)", () => {
    const edited: StoredTemplate = {
      subject: "s",
      body: '<html><head><title>x</title><style>p{color:red}</style></head><body><h1>Terima kasih {nama}</h1><p>Kode {order_id} &amp; ebook {judul_ebook}.</p><p>Mulai di <a href="{link_trivia}">sini</a></p><br>Salam<!-- hidden --></body></html>',
    };
    const text = emailMessage(edited, values, PLAY).text;
    expect(text).toBe(`Terima kasih Budi Santoso\nKode 7K3M9XQ2PA & ebook Ebook Nusantara.\nMulai di sini (${LINK})\n\nSalam`);
    // another edit, another text: nothing of the first is left over
    const other = emailMessage({ subject: "s", body: "<p>Ebook {judul_ebook} sudah terkirim.</p>" }, values, PLAY).text;
    expect(other).toBe("Ebook Ebook Nusantara sudah terkirim.");
  });

  it("says the PDF is not attached (and where to get it) only when it is not, and keeps the buyer's markup out of the text", () => {
    const attached = emailMessage(email, { ...values, nama: "<b>Budi</b>" }, PLAY);
    expect(attached.text).not.toContain("terlalu besar");
    expect(attached.text).not.toContain("<b>");
    const url = "https://api.example.test/files/deliverables/x.pdf?exp=1&sig=abc";
    const detached = emailMessage(email, values, PLAY, url);
    expect(detached.text).toContain("terlalu besar");
    expect(detached.text.endsWith(url)).toBe(true);
  });

  it("reads a template's HTML source as plain text: blocks end a line, links read label (address), entities are decoded", () => {
    expect(htmlSourceToText("<div>A&nbsp;B</div><ul><li>x &lt;y&gt;</li><li>&quot;z&quot; &#39;w&#39;</li></ul>")).toBe('A B\nx <y>\n"z" \'w\'');
    expect(htmlSourceToText('<p>Lihat <a class="x" href="https://a.test/p?q=1">tautan <b>ini</b></a>.</p>')).toBe("Lihat tautan ini (https://a.test/p?q=1).");
    expect(htmlSourceToText("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
  });
});

describe("replyText", () => {
  const kinds: readonly ReplyKind[] = ["mismatch", "generic", "already_sent", "not_paid", "not_available", "needs_help"];

  it("is Bahasa Indonesia, fixed, and has a distinct sentence for each kind", () => {
    for (const kind of kinds) {
      const text = replyText(kind);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/[{}]/);
    }
    expect(replyText("mismatch")).toMatch(/nomor pembeli/);
    expect(new Set(kinds.map((k) => replyText(k))).size).toBe(kinds.length);
  });

  it("the neutral texts (the ones a sender who is not the buyer can get) say nothing about the order's state", () => {
    for (const kind of ["mismatch", "generic"] as const) {
      expect(replyText(kind)).not.toMatch(/sudah (atau sedang )?kami kirim|sedang kami kirim|belum|dibayar|pembayaran|dikembalikan|gagal/i);
    }
  });

  it("the PDF-only caption of an unconfirmed sender has no variable, no name and no link", () => {
    const caption = pdfOnlyCaption();
    expect(caption.length).toBeGreaterThan(5);
    expect(caption).not.toMatch(/[{}]|https?:|masuk/i);
  });
});
