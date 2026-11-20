// Sentinel test for email_html (review round 2, NEW-1): every rendered template is parsed with a
// real HTML parser (parse5), and each variable's unique marker must land only in text nodes
// outside script/style/raw-text elements, comments and attributes. The single exception is
// {link_trivia} as the whole value of an href attribute.
// Mail clients parse a body as a whole document or insert it as a fragment, so every check runs
// under three parse modes (review round 3, M1): parse(html), parseFragment(html) (default
// <template> context, where a leading <col> switches to "in column group" and ignores <title>,
// <textarea> and <style>) and parseFragment(<body>, html).
import fc from "fast-check";
import { defaultTreeAdapter, html as parse5Html, parse, parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
import { renderMessage, TemplateError } from "./template.ts";

const LINK = "https://play.ebook.example/m/zqxLINKqz";
const VALUES = {
  nama: "zqxNAMAqz",
  judul_ebook: "zqxJUDULqz",
  order_id: "zqxORDERqz",
  kode_otp: "915273",
  link_trivia: LINK,
};
const MARKERS = ["zqxNAMAqz", "zqxJUDULqz", "zqxORDERqz", "915273", "zqxLINKqz"];
const OPTIONS = { linkOrigin: "https://play.ebook.example" };
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Elements whose text is not rendered as plain text (raw text, scripts, templates). */
const NON_TEXT_PARENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext", "template"]);

interface PNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly namespaceURI?: string;
  readonly value?: string;
  readonly data?: string;
  readonly name?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly PNode[];
  readonly content?: PNode;
}

const BODY_CONTEXT = defaultTreeAdapter.createElement("body", parse5Html.NS.HTML, []);
const PARSE_MODES: Readonly<Record<string, (html: string) => PNode>> = {
  document: (html) => parse(html),
  fragment: (html) => parseFragment(html),
  body: (html) => parseFragment(BODY_CONTEXT, html, {}),
};

const hasMarker = (s: string | undefined): boolean => s !== undefined && MARKERS.some((m) => s.includes(m));

/** Where markers ended up that they must not be, as "mode: placement" for every parse mode. */
function badPlacements(html: string): string[] {
  return Object.entries(PARSE_MODES).flatMap(([mode, parseAs]) => placements(parseAs(html)).map((p) => `${mode}: ${p}`));
}

function placements(root: PNode): string[] {
  const bad: string[] = [];
  const walk = (node: PNode, ancestors: readonly PNode[]): void => {
    if (node.nodeName === "#text") {
      const unsafeParent = ancestors.find(
        (a) => a.tagName !== undefined && (NON_TEXT_PARENTS.has(a.tagName) || (a.namespaceURI ?? HTML_NS) !== HTML_NS),
      );
      if (hasMarker(node.value) && unsafeParent !== undefined) bad.push(`text inside <${unsafeParent.tagName ?? "?"}>`);
    } else if (node.nodeName === "#comment") {
      if (hasMarker(node.data)) bad.push("comment");
    } else if (node.nodeName === "#documentType") {
      if (hasMarker(node.name)) bad.push("doctype");
    } else if (node.tagName !== undefined) {
      if (hasMarker(node.tagName)) bad.push(`tag name ${node.tagName}`);
      for (const attr of node.attrs ?? []) {
        if (hasMarker(attr.name)) bad.push(`attribute name ${attr.name}`);
        if (hasMarker(attr.value) && !(attr.name === "href" && attr.value === LINK)) {
          bad.push(`attribute ${attr.name}="${attr.value}"`);
        }
      }
    }
    for (const child of node.childNodes ?? []) walk(child, [...ancestors, node]);
    if (node.content !== undefined) walk(node.content, [...ancestors, node]);
  };
  walk(root, []);
  return bad;
}

/** Renders, or returns null when the template is rejected (fail closed). */
function renderOrReject(template: string): string | null {
  try {
    return renderMessage(template, "email_html", VALUES, OPTIONS);
  } catch (error) {
    if (error instanceof TemplateError) return null;
    throw error;
  }
}

describe("email_html sentinel (parse5)", () => {
  it.each([
    "<p>Kepada: <{nama}></p>", // (a) the template's "<" + value would open a tag
    '<p a"b style=">{nama}">', // (b) a quote not right after "=" does not open a value
    "<!-- x --!><style>p{} --> {nama}</style>", // (c) --!> also ends a comment
    "<!--><style>p{} --> {nama}</style>", // (c) <!--> is an empty comment
    "<!---><style>p{} --> {nama}</style>", // (c) <!---> is an empty comment
    "<script>x</scriptx>{nama}</script>", // (d)
    "<script><!--<script></script>{nama}</script>", // (d)
    "<svg><style><![CDATA[</style>{nama}]]></style></svg>", // (e)
    "<math><mtext>{nama}</mtext></math>", // (e)
    "<svg><text>{nama}</text></svg>", // (e) foreign content
    '<svg><style><a title="</style>{nama}">x</a></style></svg>', // (e) <style> is not raw text inside SVG
    "<p><![CDATA[{nama}]]></p>", // (e)
    "<title><!--</title><style>-->{nama}</style>", // RCDATA ends at </title>, not at -->
    // M1: in parseFragment(html) a leading <col> means "in column group", which ignores
    // <title> / <textarea> / <style>, so their content is parsed as markup.
    '<col><title><col onmouseover="{nama}"></title>',
    '<col><textarea><col style="{nama}">',
    "<col><textarea><!--{nama}",
    '<col><style><col title="</style>{nama}">',
    '<COL ><title><col title="{nama}"></title>',
    'x</p><col/><textarea><col title="{nama}">', // text and end tags do not leave "in template"
  ])("rejects the review repro %j", (template) => {
    expect(renderOrReject(template)).toBeNull();
  });

  it.each([
    '<p>Halo {nama}, ebook {judul_ebook} ({order_id}), kode {kode_otp}</p><a href="{link_trivia}">{link_trivia}</a>',
    "<style>p {margin:0} a{color:red} .x{}</style><p>{nama}</p>",
    "<STYLE>p{margin:0}</STYLE ><p>{nama}</p>",
    "<title>{judul_ebook}</title><textarea><b>{nama}</b></textarea>",
    '<!-- note --><!--><!---><p title="t" data-x=1>{nama}</p>',
    "<p>a < b {nama} </p><br/><img src=x alt='y'>",
    "<p>{nama}</></p>", // "</>" is no tag (HTML ignores it); a fixed case, not only a random one, keeps that branch covered

    '<A HREF = "{link_trivia}">x</A>',
    // Layout tables stay allowed: table modes hand <title> / <textarea> / <style> to the
    // "in body" / "in head" rules, so the tokenizer switches as the scanner assumes.
    '<table role="presentation" width="100%"><tr><td align="center">{nama}</td></tr></table>',
    "<thead><tr><th>{judul_ebook}</th></tr></thead><tbody><tr><td><title>{nama}</title></td></tr></tbody>",
    "<tr><title><b>{nama}</b></title></tr><td><textarea><i>{order_id}</i></textarea></td>",
    '<caption><style>p{}</style>{nama}</caption><tfoot><td><a href="{link_trivia}">{kode_otp}</a></td></tfoot>',
  ])("renders %j with every marker in plain text", (template) => {
    const html = renderOrReject(template);
    expect(html).not.toBeNull();
    expect(badPlacements(html ?? "")).toEqual([]);
  });

  it("keeps variables out of <style> while allowing CSS braces there", () => {
    expect(renderOrReject("<style>p{margin:0}</style>")).toBe("<style>p{margin:0}</style>");
    for (const t of ["<style>p{content:'{nama}'}</style>", "<style>{ nama }</style>", "<style>{secret:x}</style>"]) {
      expect(renderOrReject(t)).toBeNull();
    }
  });

  it("property: fragments of tags, quotes, comments and raw text never leak a marker", () => {
    const fragment = fc.constantFrom(
      "<p>",
      "</p>",
      "<a ",
      "href=",
      'href="',
      "title=",
      '"',
      "'",
      "=",
      " ",
      ">",
      "<",
      "</",
      "/",
      "x",
      "<!--",
      "-->",
      "--!>",
      "<!-->",
      "<!--->",
      "<!",
      "<?",
      "<style>",
      "</style>",
      "</style ",
      "<title>",
      "</title>",
      "<textarea>",
      "</textarea>",
      "p{}",
      "{margin:0}",
      "<br/>",
      "<img src=x ",
      "{nama}",
      "{judul_ebook}",
      "{link_trivia}",
      "{order_id}",
      "<a title='",
      "\t",
      "\n",
      "<b/",
      "<!DOCTYPE x>",
      "</title ",
      "<textarea",
      "</textarea ",
      "<STYLE",
      "--",
      "!",
      "-",
      // M1: table structure under fragment parsing; <col> / <colgroup> must always be rejected.
      "<table>",
      "</table>",
      "<tr>",
      "</tr>",
      "<td>",
      "</td>",
      "<th>",
      "<thead>",
      "<tbody>",
      "<caption>",
      "<col>",
      "<colgroup>",
    );
    const runs = Number(process.env.SENTINEL_RUNS ?? "3000");
    let rendered = 0;
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 24 }), (parts) => {
        const html = renderOrReject(parts.join(""));
        if (html === null) return;
        rendered++;
        expect(badPlacements(html)).toEqual([]);
      }),
      // SENTINEL_RUNS=100000 for a longer local fuzz; CI runs 3000.
      { numRuns: runs },
    );
    // The generator must mostly produce renderable templates, or the sentinel proves little.
    expect(rendered / runs).toBeGreaterThan(0.3);
  });
});
