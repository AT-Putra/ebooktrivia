// US-023: SVG in an LP ZIP is refused unless every construct is allowed (svg.ts).
import { describe, expect, it } from "vitest";
import { svgProblem } from "./svg.ts";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (inner: string, attrs = ""): string => `<svg ${NS} ${XLINK}${attrs}>${inner}</svg>`;

describe("svgProblem: accepted", () => {
  it("accepts what design tools export: declaration, comments, doctype without subset, metadata namespaces, styles, gradients, fragment refs, data images", () => {
    const illustrator = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 27.0 -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" ${NS} ${XLINK} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xml:space="preserve" viewBox="0 0 10 10">
  <style type="text/css"><![CDATA[ .st0{fill:#FFF;} .st1{fill:url(#g)} ]]></style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>
  <inkscape:grid id="grid1" inkscape:label="Grid &amp; more"/>
  <g class="st0" style="fill: url( '#g' )"><use xlink:href="#p"/><path id="p" d="M0 0 L1 1" fill="url(#g)"/></g>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <a href="#p"><text>&lt;Promo&gt; &#169; &#x2122;</text></a>
  <animate attributeName="opacity" from="0" to="1" dur="1s"/>
</svg>
`;
    expect(svgProblem(illustrator)).toBeNull();
    expect(svgProblem(`<svg ${NS}/>`)).toBeNull();
  });
});

describe("svgProblem: refused", () => {
  const cases: [string, string, string][] = [
    ["script", svg("<script>alert(1)</script>"), "the element <script>"],
    ["foreignObject", svg("<foreignObject><div/></foreignObject>"), "the element <foreignObject>"],
    ["iframe / embed / object / handler", svg("<handler/>"), "the element <handler>"],
    ["event handler", svg('<rect onclick="alert(1)"/>'), "an event handler attribute (onclick) on <rect>"],
    ["event handler, upper case", svg('<rect ONLOAD="alert(1)"/>'), "an event handler attribute (ONLOAD) on <rect>"],
    ["event handler on the root", `<svg ${NS} onload="alert(1)"/>`, "an event handler attribute (onload) on <svg>"],
    ["javascript: href", svg('<a href="javascript:alert(1)"><text>x</text></a>'), "a script URL in href on <a>"],
    ["encoded javascript: href", svg('<a xlink:href="&#106;ava&#x09;script:alert(1)"><text>x</text></a>'), "a script URL in xlink:href on <a>"],
    ["external href", svg('<use href="https://evil.example/x.svg#a"/>'), "an external reference in href on <use> (only #id or a data: PNG, JPEG, GIF or WebP image)"],
    ["external image", svg('<image xlink:href="//evil.example/a.png"/>'), "an external reference in xlink:href on <image> (only #id or a data: PNG, JPEG, GIF or WebP image)"],
    ["nested svg data", svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'), "an external reference in href on <image> (only #id or a data: PNG, JPEG, GIF or WebP image)"],
    ["external url()", svg('<rect fill="url(https://evil.example/#g)"/>'), "fill on <rect> refers to an external resource (url() may only point to #id)"],
    ["style @import", svg("<style>@import url(#a);</style>"), "a <style> element contains @import"],
    ["style external url", svg("<style>.a{background:url(https://evil.example/x.png)}</style>"), "a <style> element refers to an external resource (url() may only point to #id)"],
    ["style escape", svg("<style>.a{background:u\\72l(https://evil.example/x)}</style>"), "a <style> element contains \\"],
    ["style image-set", svg('<rect style="fill:image-set(&quot;https://evil.example/x.png&quot; 1x)"/>'), "the style attribute on <rect> contains image-set("],
    ["style attribute expression", svg('<rect style="width:expression(alert(1))"/>'), "the style attribute on <rect> contains expression("],
    ["animated href", svg('<a href="#x"><set attributeName="href" to="#y"/></a>'), "an animation of href on <set>"],
    ["animated handler", svg('<animate attributeName="onbegin" to="x"/>'), "an animation of onbegin on <animate>"],
    ["javascript in animation values", svg('<animate attributeName="x" values="javascript:alert(1)"/>'), "a script URL in values on <animate>"],
    ["XHTML namespace by prefix", svg('<h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script>'), "the namespace http://www.w3.org/1999/xhtml bound to h"],
    ["SVG namespace by another prefix", svg('<s:script xmlns:s="http://www.w3.org/2000/svg"/>'), "the namespace http://www.w3.org/2000/svg bound to s"],
    ["another default namespace", svg('<div xmlns="http://www.w3.org/1999/xhtml"/>'), "the default namespace http://www.w3.org/1999/xhtml (only SVG's)"],
    ["undeclared prefix", svg("<x:thing/>"), "the element <x:thing>"],
    ["xml:base", svg('<g xml:base="https://evil.example/"/>'), "the attribute xml:base on <g>"],
    ["internal DTD subset (entities)", `<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg ${NS}>&a;</svg>`, "a DOCTYPE with an internal subset (entity declarations); export the SVG without a DOCTYPE"],
    ["unknown entity", svg("<text>&nbsp;</text>"), "the entity &nbsp; (only &lt; &gt; &amp; &quot; &apos; and numeric references)"],
    ["bare ampersand", svg("<text>a & b</text>"), "a bare & (escape it as &amp;)"],
    ["xml-stylesheet", `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/x.xsl"?><svg ${NS}/>`, "a processing instruction (only the <?xml ...?> declaration at the start)"],
    ["root is not svg", '<html xmlns="http://www.w3.org/2000/svg"/>', "the root element <html> (an SVG starts with <svg>)"],
    ["two roots", `<svg ${NS}/><svg ${NS}/>`, "a second root element"],
    ["text outside", `<svg ${NS}/>junk`, "text outside the <svg> element"],
    ["mismatched end tag", svg("<g></a>"), "a mismatched end tag </a>"],
    ["unclosed", `<svg ${NS}><g>`, "an unclosed <g>"],
    ["duplicate attribute", svg('<rect x="1" x="2"/>'), "the attribute x twice in <rect>"],
    ["< in attribute", svg('<rect title="<script>"/>'), "a < inside an attribute value of <rect>"],
    ["element in style", svg("<style><rect/></style>"), "an element inside a <style>"],
    ["empty", "", "no <svg> element"],
  ];
  for (const [title, text, reason] of cases) {
    it(title, () => {
      expect(svgProblem(text)).toBe(reason);
    });
  }
});
