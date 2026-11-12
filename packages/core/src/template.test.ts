import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  postbackSecretNames,
  renderMessage,
  renderMessageRedacted,
  renderPostbackUrl,
  renderPostbackUrlRedacted,
  TemplateError,
  type PostbackValues,
  type ResolvedSecret,
  type SecretResolver,
  type TemplateErrorCode,
} from "./template.ts";

const LINK = "https://play.ebook.example/masuk/aB3_x-Yz9";
const PLAY = { linkOrigin: "https://play.ebook.example" };
const values = {
  nama: "Budi Santoso",
  judul_ebook: "Belajar Node.js",
  order_id: "K7M2Q9XR",
  link_trivia: LINK,
  kode_otp: "042917",
};

function codeOf(fn: () => unknown): TemplateErrorCode | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TemplateError) return error.code;
    throw error;
  }
  return undefined;
}

describe("message templates (AC-A10 variables)", () => {
  const wa = "Halo {nama}, terima kasih telah membeli {judul_ebook}.\nPesanan: {order_id}\nMain trivia: {link_trivia}";

  it("renders WhatsApp text, keeping template line breaks and system values unchanged", () => {
    expect(renderMessage(wa, "whatsapp", values, PLAY)).toBe(
      `Halo Budi Santoso, terima kasih telah membeli Belajar Node\u{2024}js.\nPesanan: K7M2Q9XR\nMain trivia: ${LINK}`,
    );
    expect(renderMessage("Kode OTP: {kode_otp}", "whatsapp", values)).toBe("Kode OTP: 042917");
  });

  it("neutralises WhatsApp markup, line and bidi injection, and links in buyer-supplied text", () => {
    const nama = "*GRATIS* _hadiah_ ~x~ `y`\r\nKlik evil.example\u{202E}\u{200B}foo\u0007 a\u{FF0E}b";
    expect(renderMessage("Halo {nama}!", "whatsapp", { nama })).toBe(
      "Halo GRATIS hadiah x y Klik evil\u{2024}examplefoo a\u{2024}b!",
    );
    expect(renderMessage("{nama}", "whatsapp", { nama: "Dr. Budi, S.Kom." })).toBe("Dr. Budi, S\u{2024}Kom.");
  });

  it("HTML-escapes every value in email bodies", () => {
    const html = '<p>Halo {nama}</p><a href="{link_trivia}">Main</a>';
    expect(
      renderMessage(html, "email_html", {
        nama: `<script>alert("x")</script> & 'y'`,
        link_trivia: "https://play.ebook.example/m?t=a&u=b",
      }, PLAY),
    ).toBe(
      '<p>Halo &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p><a href="https://play.ebook.example/m?t=a&amp;u=b">Main</a>',
    );
  });

  it("never lets CR/LF into an email subject", () => {
    const subject = renderMessage("Ebook {judul_ebook}\r\nBcc: attacker@example.com", "email_subject", {
      judul_ebook: "Seri 1\r\nBcc: x@y\u{2028}z",
    });
    expect(subject).toBe("Ebook Seri 1 Bcc: x@y z Bcc: attacker@example.com");
  });

  it("keeps braces that are not variable tokens", () => {
    expect(renderMessage("a { color: red } {nama} {}", "email_html", { nama: "B" })).toBe("a { color: red } B {}");
  });

  it("fails closed on unknown variables and secrets", () => {
    expect(codeOf(() => renderMessage("Hi {name}", "whatsapp", values))).toBe("unknown_variable");
    expect(codeOf(() => renderMessage("Hi {NAMA}", "whatsapp", values))).toBe("unknown_variable");
    expect(codeOf(() => renderMessage("a{color:red}", "email_html", values))).toBe("unknown_variable");
    expect(codeOf(() => renderMessage("x {secret:smtp_pass}", "email_html", values))).toBe("secret_not_allowed");
    expect(codeOf(() => renderMessage("{payout}", "whatsapp", values))).toBe("unknown_variable");
  });

  it("fails closed on missing or invalid values", () => {
    expect(codeOf(() => renderMessage("{nama}", "whatsapp", {}))).toBe("missing_value");
    expect(codeOf(() => renderMessage("{kode_otp}", "whatsapp", { kode_otp: "12345" }))).toBe("invalid_value");
    expect(codeOf(() => renderMessage("{kode_otp}", "whatsapp", { kode_otp: "1234567" }))).toBe("invalid_value");
    expect(codeOf(() => renderMessage("{order_id}", "whatsapp", { order_id: "K7 M2" }))).toBe("invalid_value");
    for (const link of ["http://play.ebook.example/m", "javascript:alert(1)", "not a url", "https://u:p@play.ebook.example/"]) {
      expect(codeOf(() => renderMessage("{link_trivia}", "whatsapp", { link_trivia: link }, PLAY))).toBe("invalid_value");
    }
  });

  it("normalises the link so embedded tabs/newlines cannot break lines", () => {
    expect(renderMessage("{link_trivia}", "whatsapp", { link_trivia: "https://play.ebook.example/m\n/x\t" }, PLAY)).toBe(
      "https://play.ebook.example/m/x",
    );
  });

  it("redacts the login code and link in previews and logs", () => {
    expect(renderMessageRedacted("Kode OTP Anda: {kode_otp}", "whatsapp", {})).toBe("Kode OTP Anda: [kode_otp]");
    expect(renderMessageRedacted(wa, "whatsapp", values)).toBe(
      "Halo Budi Santoso, terima kasih telah membeli Belajar Node\u{2024}js.\nPesanan: K7M2Q9XR\nMain trivia: [link_trivia]",
    );
    expect(renderMessageRedacted("{kode_otp}", "email_html", values)).not.toContain(values.kode_otp);
    expect(codeOf(() => renderMessageRedacted("{nama}", "whatsapp", {}))).toBe("missing_value");
  });

  it("property: no control, markup or HTML-special characters survive in values", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (nama) => {
        const waOut = renderMessage("[{nama}]", "whatsapp", { nama });
        expect(waOut).not.toMatch(/[*_~`\r\n\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u);
        const htmlOut = renderMessage("[{nama}]", "email_html", { nama });
        expect(htmlOut).not.toMatch(/[<>"']/);
        expect(htmlOut.replace(/&(amp|lt|gt|quot|#39);/g, "")).not.toContain("&");
        const subject = renderMessage("S {nama}", "email_subject", { nama });
        expect(subject).not.toMatch(/[\r\n]/);
      }),
    );
  });
});

describe("postback URL templates ({secret:name} endpoint binding)", () => {
  const binding = { adnetId: "adnet-1", host: "track.adnet.example" };
  const pb: PostbackValues = { clickid: "abc123", txid: "TX-9", payout: "15000", status: "approved", sub_id: "s1" };
  const bound: ResolvedSecret = {
    value: "s3cr3t/+&=",
    scope: "conversions",
    adnetId: "adnet-1",
    boundHost: "track.adnet.example",
  };
  const template =
    "https://track.adnet.example/pb?cid={clickid}&tx={txid}&p={payout}&st={status}&sub={sub_id}&pub={pub}&key={secret:api_key}";

  it("renders macros percent-encoded and resolves the bound secret", () => {
    const resolve = vi.fn<SecretResolver>(() => bound);
    expect(renderPostbackUrl(template, pb, binding, resolve)).toBe(
      "https://track.adnet.example/pb?cid=abc123&tx=TX-9&p=15000&st=approved&sub=s1&pub=&key=s3cr3t%2F%2B%26%3D",
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ name: "api_key", adnetId: "adnet-1", host: "track.adnet.example" });
  });

  it("keeps attacker-supplied values inside their parameter", () => {
    const url = renderPostbackUrl(
      "https://track.adnet.example/pb?cid={clickid}&tx={txid}",
      { ...pb, clickid: "x&tx=forged#@evil.example/?" },
      binding,
      () => bound,
    );
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("track.adnet.example");
    expect(parsed.searchParams.get("cid")).toBe("x&tx=forged#@evil.example/?");
    expect(parsed.searchParams.getAll("tx")).toEqual(["TX-9"]);
    expect(parsed.hash).toBe("");
  });

  it("encodes !'()* as well", () => {
    expect(renderPostbackUrlRedacted("https://track.adnet.example/?c={clickid}", { ...pb, clickid: "a!'()*~" }, binding)).toBe(
      "https://track.adnet.example/?c=a%21%27%28%29%2A~",
    );
  });

  it("refuses variables in the scheme or host", () => {
    for (const t of [
      "https://{clickid}.evil.example/pb",
      "https://track.adnet.example{clickid}/pb",
      "{clickid}://track.adnet.example/",
      "track.adnet.example/pb?c={clickid}",
      "ftp://track.adnet.example/pb",
      "https:///pb",
    ]) {
      expect(codeOf(() => renderPostbackUrlRedacted(t, pb, binding))).toBe("invalid_url");
    }
    expect(codeOf(() => renderPostbackUrlRedacted("https://u:p@track.adnet.example/", pb, binding))).toBe("invalid_url");
  });

  it("refuses a template whose host is not the adnet endpoint host, before resolving anything", () => {
    const resolve = vi.fn<SecretResolver>(() => bound);
    expect(codeOf(() => renderPostbackUrl("https://evil.example/?k={secret:api_key}", pb, binding, resolve))).toBe(
      "host_mismatch",
    );
    expect(codeOf(() => renderPostbackUrl("https://track.adnet.example.evil.example/?k={secret:api_key}", pb, binding, resolve))).toBe(
      "host_mismatch",
    );
    expect(resolve).not.toHaveBeenCalled();
    // Host comparison is case-insensitive (URL hosts are lowercased).
    expect(renderPostbackUrl("https://TRACK.adnet.example/?c={clickid}", pb, { ...binding, host: "Track.Adnet.Example" }, resolve)).toBe(
      "https://track.adnet.example/?c=abc123",
    );
  });

  it("requires https to send a secret, allows http without one", () => {
    expect(codeOf(() => renderPostbackUrl("http://track.adnet.example/?k={secret:api_key}", pb, binding, () => bound))).toBe(
      "insecure_scheme",
    );
    expect(renderPostbackUrl("http://track.adnet.example/?c={clickid}", pb, binding, () => bound)).toBe(
      "http://track.adnet.example/?c=abc123",
    );
  });

  it("rejects secrets that are missing or not bound to this adnet and host", () => {
    const t = "https://track.adnet.example/?k={secret:api_key}";
    expect(codeOf(() => renderPostbackUrl(t, pb, binding, () => undefined))).toBe("secret_unresolved");
    for (const wrong of [
      { ...bound, adnetId: "adnet-2" },
      { ...bound, adnetId: null },
      { ...bound, boundHost: "other.example" },
      { ...bound, boundHost: null },
      { ...bound, scope: "messaging" },
    ]) {
      expect(codeOf(() => renderPostbackUrl(t, pb, binding, () => wrong))).toBe("secret_binding");
    }
  });

  it("redacted render shows [secret:name] and never contains the secret", () => {
    const out = renderPostbackUrlRedacted(template, pb, binding);
    expect(out).toBe(
      "https://track.adnet.example/pb?cid=abc123&tx=TX-9&p=15000&st=approved&sub=s1&pub=&key=[secret:api_key]",
    );
    expect(out).not.toContain(bound.value);
    expect(out).not.toContain(encodeURIComponent(bound.value));
  });

  it("fails closed on unknown macros, bad secret names and missing required values", () => {
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/?n={nama}", pb, binding))).toBe(
      "unknown_variable",
    );
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/?k={secret:Bad-Name}", pb, binding))).toBe(
      "unknown_variable",
    );
    const noClickid = { txid: "TX-9", payout: "15000", status: "approved" } as unknown as PostbackValues;
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/?c={clickid}", noClickid, binding))).toBe(
      "missing_value",
    );
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/?c={clickid}", { ...pb, clickid: "\uD800" }, binding))).toBe(
      "invalid_value",
    );
  });

  it("lists referenced secret names once", () => {
    expect(postbackSecretNames("https://h.example/?a={secret:a.b}&b={secret:c_d}&c={secret:a.b}&x={clickid}")).toEqual(["a.b", "c_d"]);
    expect(postbackSecretNames("https://h.example/?x={clickid}")).toEqual([]);
  });

  it("property: any clickid round-trips inside its parameter and never changes the host", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (clickid) => {
        const render = () =>
          renderPostbackUrl("https://track.adnet.example/pb?cid={clickid}&tx={txid}", { ...pb, clickid }, binding, () => bound);
        if (!clickid.isWellFormed()) {
          expect(codeOf(render)).toBe("invalid_value");
          return;
        }
        const url = render();
        const parsed = new URL(url);
        expect(parsed.hostname).toBe("track.adnet.example");
        expect(parsed.searchParams.get("cid")).toBe(clickid);
        expect(parsed.searchParams.get("tx")).toBe("TX-9");
      }),
    );
  });
});

describe("review fixes: template items 6-9", () => {
  const origin = { linkOrigin: "https://play.ebook.example" };
  const pbBinding = { adnetId: "adnet-1", host: "track.adnet.example" };
  const pbValues: PostbackValues = { clickid: "abc", txid: "TX-9", payout: "15000", status: "approved" };
  const bound: ResolvedSecret = { value: "k", scope: "conversions", adnetId: "adnet-1", boundHost: "track.adnet.example" };

  it("item 6: strips line-leading WhatsApp markup (quote, bullets, numbered list) from free text", () => {
    for (const nama of ["> Budi", "- Budi", "* Budi", "1. Budi", "12. Budi", ">> 3. - Budi", "  > Budi"]) {
      expect(renderMessage("Halo\n{nama}", "whatsapp", { nama })).toBe("Halo\nBudi");
    }
    expect(renderMessage("{nama}", "whatsapp", { nama: "Budi - Santoso 2. x" })).toBe("Budi - Santoso 2. x");
    expect(renderMessage("{nama}", "whatsapp", { nama: "-Budi" })).toBe("-Budi");
  });

  it("item 7: email_html neutralises linkable dots in free text", () => {
    expect(renderMessage("<p>{nama}</p>", "email_html", { nama: "evil.example" })).toBe("<p>evil\u{2024}example</p>");
  });

  it("item 7: email_html refuses variables in attribute values, except {link_trivia} as a whole quoted href", () => {
    const v = { nama: "Budi", order_id: "K7M2Q9XR", link_trivia: LINK };
    expect(renderMessage('<a href="{link_trivia}">Main</a>', "email_html", v, origin)).toBe(`<a href="${LINK}">Main</a>`);
    expect(renderMessage("<A HREF='{link_trivia}' title=\"x\">{nama}</A>", "email_html", v, origin)).toBe(
      `<A HREF='${LINK}' title="x">Budi</A>`,
    );
    for (const t of [
      '<a title="{nama}">x</a>',
      '<img src="{link_trivia}">',
      "<a href={link_trivia}>x</a>",
      '<a href="https://x.example/?o={order_id}">x</a>',
      '<a href="{link_trivia}#x">x</a>',
      "<div {nama}>x</div>",
      "<style>p { content: '{nama}' }</style>",
      '<script>var n = "{nama}";</script>',
      "<!-- {nama} -->",
    ]) {
      expect(codeOf(() => renderMessage(t, "email_html", v, origin))).toBe("unsafe_html_context");
    }
    // Variables in text after such blocks are fine again.
    expect(renderMessage("<style>p { color: red }</style><!-- c --><p>{nama}</p>", "email_html", v)).toBe(
      "<style>p { color: red }</style><!-- c --><p>Budi</p>",
    );
  });

  it("item 8: rejects leftover brace tokens instead of silently dropping a value", () => {
    for (const t of ["https://track.adnet.example/?c={ clickid }", "https://track.adnet.example/?c={clickid", "https://track.adnet.example/?c=}"]) {
      expect(codeOf(() => renderPostbackUrlRedacted(t, pbValues, pbBinding))).toBe("malformed_token");
    }
    for (const [t, channel] of [
      ["Halo { nama }", "whatsapp"],
      ["Halo {nama", "whatsapp"],
      ["Halo {", "whatsapp"],
      ["Ebook { judul_ebook }", "email_subject"],
      ["<p>{ nama }</p>", "email_html"],
      ["<p>{nama</p>", "email_html"],
      ["<p>{secret:x</p>", "email_html"],
    ] as const) {
      expect(codeOf(() => renderMessage(t, channel, { nama: "B", judul_ebook: "J" }))).toBe("malformed_token");
    }
    // CSS blocks in email HTML stay allowed.
    expect(renderMessage("<style>a {color: red} p { margin: 0 }</style>", "email_html", {})).toBe(
      "<style>a {color: red} p { margin: 0 }</style>",
    );
  });

  it("item 8: the binding covers host and port", () => {
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example:8443/?c={clickid}", pbValues, pbBinding))).toBe(
      "host_mismatch",
    );
    expect(renderPostbackUrlRedacted("https://track.adnet.example:443/?c={clickid}", pbValues, pbBinding)).toBe(
      "https://track.adnet.example:443/?c=abc",
    );
    const withPort = { ...pbBinding, host: "track.adnet.example:8443" };
    expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/?c={clickid}", pbValues, withPort))).toBe("host_mismatch");
    const resolve = vi.fn<SecretResolver>(() => ({ ...bound, boundHost: "track.adnet.example:8443" }));
    expect(renderPostbackUrl("https://track.adnet.example:8443/?k={secret:api_key}", pbValues, withPort, resolve)).toBe(
      "https://track.adnet.example:8443/?k=k",
    );
    expect(resolve).toHaveBeenCalledWith({ name: "api_key", adnetId: "adnet-1", host: "track.adnet.example:8443" });
    expect(
      codeOf(() => renderPostbackUrl("https://track.adnet.example:8443/?k={secret:api_key}", pbValues, withPort, () => bound)),
    ).toBe("secret_binding");
  });

  it("item 9: link_trivia must be on the expected play origin", () => {
    expect(renderMessage("{link_trivia}", "whatsapp", { link_trivia: LINK }, origin)).toBe(LINK);
    for (const link of ["https://evil.example/masuk/aB3", "https://play.ebook.example:8443/masuk/aB3", "https://play.ebook.example.evil.example/x"]) {
      expect(codeOf(() => renderMessage("{link_trivia}", "whatsapp", { link_trivia: link }, origin))).toBe("invalid_value");
    }
    expect(codeOf(() => renderMessage("{link_trivia}", "whatsapp", { link_trivia: LINK }))).toBe("invalid_value");
    expect(codeOf(() => renderMessage("{link_trivia}", "whatsapp", { link_trivia: LINK }, { linkOrigin: "http://play.ebook.example" }))).toBe(
      "invalid_value",
    );
    expect(codeOf(() => renderMessage("{link_trivia}", "whatsapp", { link_trivia: LINK }, { linkOrigin: "not a url" }))).toBe(
      "invalid_value",
    );
  });
});

describe("review item 7: HTML context scanner edge cases", () => {
  const v = { nama: "Budi", link_trivia: LINK };
  const opts = { linkOrigin: "https://play.ebook.example" };

  it("allows variables in text after unquoted attributes, declarations, comments and a bare <", () => {
    for (const [t, out] of [
      ["<td width=10>{nama}</td>", "<td width=10>Budi</td>"],
      ["<td width=10 >{nama}</td>", "<td width=10 >Budi</td>"],
      ["<!DOCTYPE html><br/><p>{nama}</p>", "<!DOCTYPE html><br/><p>Budi</p>"],
      ["a < b {nama}", "a < b Budi"],
      ['<A HREF = "{link_trivia}">{nama}</A>', `<A HREF = "${LINK}">Budi</A>`],
      ['<p title="a">{nama}</p></P>', '<p title="a">Budi</p></P>'],
      ["<STYLE>p{}</STYLE>{nama}", "<STYLE>p{}</STYLE>Budi"],
    ] as const) {
      expect(renderMessage(t, "email_html", v, opts)).toBe(out);
    }
  });

  it("still rejects variables in attributes that follow an unquoted one", () => {
    expect(codeOf(() => renderMessage('<a href=https://x.example/ title="{nama}">x</a>', "email_html", v, opts))).toBe(
      "unsafe_html_context",
    );
    expect(codeOf(() => renderMessage("<a {link_trivia}>x</a>", "email_html", v, opts))).toBe("unsafe_html_context");
  });
});

describe("review round 3, L1: postback values cannot form dot path segments", () => {
  const binding = { adnetId: "adnet-1", host: "track.adnet.example" };
  const pb: PostbackValues = { clickid: "abc", txid: "TX-9", payout: "15000", status: "approved" };
  const bound: ResolvedSecret = { value: "k", scope: "conversions", adnetId: "adnet-1", boundHost: "track.adnet.example" };
  const render = (template: string, over: Partial<PostbackValues>) =>
    renderPostbackUrl(template, { ...pb, ...over }, binding, () => bound);

  it("rejects a clickid of . or .. in a path segment (it would pop the static path)", () => {
    for (const clickid of ["..", "."]) {
      expect(codeOf(() => render("https://track.adnet.example/a/{clickid}/pb", { clickid }))).toBe("invalid_value");
      expect(codeOf(() => renderPostbackUrlRedacted("https://track.adnet.example/a/{clickid}/pb", { ...pb, clickid }, binding))).toBe(
        "invalid_value",
      );
      expect(codeOf(() => render("https://track.adnet.example/{clickid}", { clickid }))).toBe("invalid_value");
    }
  });

  it("rejects dot segments that values form together with static text or each other", () => {
    for (const [template, over] of [
      ["https://track.adnet.example/a/.{clickid}/pb", { clickid: "." }],
      ["https://track.adnet.example/a/{clickid}./pb", { clickid: "." }],
      ["https://track.adnet.example/a/%2e{clickid}/pb", { clickid: "." }],
      ["https://track.adnet.example/a/%2E%2{clickid}/pb", { clickid: "e" }],
      ["https://track.adnet.example/a/%2{clickid}/pb", { clickid: "E" }],
      ["https://track.adnet.example/a/{clickid}{txid}/pb", { clickid: ".", txid: "." }],
      ["https://track.adnet.example/a\\{clickid}\\pb", { clickid: ".." }],
      ["https://track.adnet.example/a/{clickid}\t/pb", { clickid: ".." }],
      ["https://track.adnet.example/a/.\n{clickid}?x=1", { clickid: "." }],
      ["https://track.adnet.example/a/{clickid} ", { clickid: ".." }],
      ["https://track.adnet.example/a/{clickid}#{txid}", { clickid: ".." }],
    ] as const) {
      expect(codeOf(() => render(template, over)), template).toBe("invalid_value");
    }
  });

  it("rejects a template whose static path already has a dot segment", () => {
    for (const t of ["https://track.adnet.example/a/../pb?c={clickid}", "https://track.adnet.example/a/%2E/pb?c={clickid}"]) {
      expect(codeOf(() => renderPostbackUrlRedacted(t, pb, binding))).toBe("invalid_url");
    }
  });

  it("keeps dots that are not whole segments, and any value in the query or fragment", () => {
    expect(render("https://track.adnet.example/a/{clickid}/pb", { clickid: "..." })).toBe("https://track.adnet.example/a/.../pb");
    expect(render("https://track.adnet.example/a/{clickid}/pb", { clickid: "%2e%2e" })).toBe(
      "https://track.adnet.example/a/%252e%252e/pb",
    );
    expect(render("https://track.adnet.example/a/{clickid}/pb", { clickid: "../x" })).toBe("https://track.adnet.example/a/..%2Fx/pb");
    expect(render("https://track.adnet.example/v1.{clickid}/pb", { clickid: "." })).toBe("https://track.adnet.example/v1../pb");
    expect(render("https://track.adnet.example/pb?c={clickid}#{txid}", { clickid: "..", txid: "." })).toBe(
      "https://track.adnet.example/pb?c=..#.",
    );
  });

  it("property: a clickid in a path segment keeps the template's path structure or fails closed", () => {
    const clickid = fc.oneof(fc.constantFrom(".", "..", "...", "%2e", ".%2E", "/", "\\", "a/../b"), fc.string({ maxLength: 12 }));
    fc.assert(
      fc.property(clickid, (value) => {
        const code = codeOf(() => render("https://track.adnet.example/a/{clickid}/pb", { clickid: value }));
        if (value === "." || value === "..") {
          expect(code).toBe("invalid_value");
          return;
        }
        expect(code).toBeUndefined();
        const segments = new URL(render("https://track.adnet.example/a/{clickid}/pb", { clickid: value })).pathname.split("/");
        expect(segments).toHaveLength(4);
        expect([segments[1], segments[3]]).toEqual(["a", "pb"]);
        expect(decodeURIComponent(segments[2] ?? "")).toBe(value);
      }),
    );
  });
});
