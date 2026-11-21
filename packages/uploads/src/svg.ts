// SVG files inside a landing-page ZIP (US-023, the US-011 caller contract "lp_zip SVGs must be
// sanitised"; unsafe SVGs are refused, never rewritten). An SVG is accepted only when every construct in it is on an allowlist, and is then
// stored byte for byte; anything else is REFUSED with the reason, never rewritten (a rewrite would
// need a full XML serializer, and a refused file is fixed by its author in seconds). Caddy also
// serves every .svg of an LP host with `Content-Security-Policy: sandbox` (infra/caddy/Caddyfile),
// so a script that got past this check still would not run when the file is opened directly; as
// an <img> an SVG never runs script at all.
//
// The check runs on a small XML tokenizer (no parser dependency): the file must be well-formed,
// with an <svg> root, and
//   - elements: SVG elements from SVG_ELEMENTS (case-sensitive, as XML is), or any element of a
//     known editor-metadata namespace (Inkscape, Sodipodi, RDF, Creative Commons, Dublin Core,
//     Adobe, Sketch, Serif), which browsers never render. Never script, foreignObject, iframe,
//     embed, object, handler or listener;
//   - namespaces: the default namespace is SVG's; xlink is bound to XLink; any other prefix only to
//     one of the metadata namespaces (so no prefix can name XHTML, SVG or MathML: a prefixed
//     element can never be a script);
//   - attributes: no event handler (on*), no xml:base; href / xlink:href only to a fragment of the
//     same file (#id) or a data: PNG / JPEG / GIF / WebP image; url(...) only to a fragment; no
//     javascript: / vbscript: anywhere (after decoding character references and dropping
//     whitespace); no animation of href or of a handler (attributeName);
//   - <style> text and style attributes: no @import, no url() but fragments, no image-set(), no
//     expression(), behavior or -moz-binding, and no backslash (a CSS escape could spell any of these);
//   - markup: one optional <?xml ...?> declaration at the very start and no other processing
//     instruction (no xml-stylesheet); a DOCTYPE without an internal subset (no entities: no
//     billion laughs, no external entities); only the five predefined entities and numeric
//     character references.

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Editor metadata namespaces: elements in them are inert in every browser. */
const INERT_NAMESPACES = new Set([
  "http://www.inkscape.org/namespaces/inkscape",
  "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://creativecommons.org/ns#",
  "http://purl.org/dc/elements/1.1/",
  "http://purl.org/dc/terms/",
  "http://ns.adobe.com/AdobeIllustrator/10.0/",
  "http://ns.adobe.com/Extensibility/1.0/",
  "http://ns.adobe.com/Graphs/1.0/",
  "http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/",
  "http://ns.adobe.com/Variables/1.0/",
  "http://ns.adobe.com/SaveForWeb/1.0/",
  "http://ns.adobe.com/ImageReplacement/1.0/",
  "http://ns.adobe.com/Flows/1.0/",
  "http://www.bohemiancoding.com/sketch/ns",
  "http://www.serif.com/",
]);

export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "desc", "title", "metadata", "symbol", "use", "switch", "a", "view",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "image", "style",
  "filter", "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
  "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
  "animate", "animateMotion", "animateTransform", "set", "mpath",
]);

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const PREDEFINED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const FRAGMENT = /^#[A-Za-z_][\w.:-]*$/;

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

/** Decodes the predefined entities and numeric character references; anything else is refused. */
function decode(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (whole, ref: string) => {
    if (!whole.endsWith(";")) refuse("a bare & (escape it as &amp;)");
    const named = PREDEFINED[ref];
    if (named !== undefined) return named;
    const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(ref);
    if (numeric === null) return refuse(`the entity &${ref}; (only &lt; &gt; &amp; &quot; &apos; and numeric references)`);
    const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 16) : Number(numeric[2]);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return refuse("an invalid character reference");
    return String.fromCodePoint(code);
  });
}

/** Lower-cased, every whitespace and control character removed: what a URL parser would see. */
const squeezed = (value: string): string => value.replace(/[\s\p{Cc}]+/gu, "").toLowerCase();

function checkUrls(value: string, where: string): void {
  const compact = squeezed(value);
  for (let at = compact.indexOf("url("); at !== -1; at = compact.indexOf("url(", at + 4)) {
    const target = compact.slice(at + 4).replace(/^["']/, "");
    if (!target.startsWith("#")) refuse(`${where} refers to an external resource (url() may only point to #id)`);
  }
}

function checkCss(css: string, where: string): void {
  const compact = squeezed(css);
  for (const banned of ["\\", "@import", "image-set(", "expression(", "behavior:", "-moz-binding", "javascript:", "vbscript:"]) {
    if (compact.includes(banned)) refuse(`${where} contains ${banned}`);
  }
  checkUrls(css, where);
}

interface Scope {
  readonly name: string;
  readonly namespaces: ReadonlyMap<string, string>;
}

function checkAttribute(element: string, name: string, value: string, namespaces: ReadonlyMap<string, string>): void {
  const lower = name.toLowerCase();
  const [prefix, local] = name.includes(":") ? (name.split(":") as [string, string]) : [null, name];
  if (prefix === "xml") {
    if (local !== "space" && local !== "lang") refuse(`the attribute ${name} on <${element}>`);
  } else if (prefix !== null && prefix !== "xmlns") {
    const ns = namespaces.get(prefix);
    if (ns === undefined) refuse(`the attribute ${name} on <${element}> uses an undeclared prefix`);
    if (ns !== XLINK_NS && !INERT_NAMESPACES.has(ns ?? "")) refuse(`the attribute ${name} on <${element}>`);
  }
  if (local.toLowerCase().startsWith("on")) refuse(`an event handler attribute (${name}) on <${element}>`);
  const compact = squeezed(value);
  if (compact.includes("javascript:") || compact.includes("vbscript:")) refuse(`a script URL in ${name} on <${element}>`);
  if (lower === "href" || (prefix !== null && namespaces.get(prefix) === XLINK_NS && local === "href")) {
    const target = value.trim();
    if (!FRAGMENT.test(target) && !DATA_IMAGE.test(target)) refuse(`an external reference in ${name} on <${element}> (only #id or a data: PNG, JPEG, GIF or WebP image)`);
  }
  if (lower === "attributename") {
    const animated = compact.replace(/^xlink:/, "");
    if (animated === "href" || animated.startsWith("on")) refuse(`an animation of ${value} on <${element}>`);
  }
  if (lower === "style") checkCss(value, `the style attribute on <${element}>`);
  else checkUrls(value, `${name} on <${element}>`);
}

/** Reads the attributes of a start tag between `start` and its `>`; returns where the tag ends. */
function readTag(text: string, start: number): { name: string; attributes: [string, string][]; selfClosing: boolean; end: number } {
  let at = start + 1;
  const nameMatch = /^[^\s/>]+/.exec(text.slice(at, at + 256));
  const name = nameMatch?.[0] ?? "";
  if (!NAME.test(name)) refuse("a malformed element name");
  at += name.length;
  const attributes: [string, string][] = [];
  const seen = new Set<string>();
  for (;;) {
    const space = text.slice(at, at + 4096).search(/\S|$/);
    at += space;
    if (text.startsWith("/>", at)) return { name, attributes, selfClosing: true, end: at + 2 };
    if (text[at] === ">") return { name, attributes, selfClosing: false, end: at + 1 };
    if (space === 0) refuse(`a malformed tag <${name}>`);
    const attr = /^([^\s=/>]+)\s*=\s*(["'])/.exec(text.slice(at, at + 512));
    if (attr === null) return refuse(`a malformed attribute in <${name}>`);
    const [whole, attrName = "", quote = '"'] = attr;
    if (!NAME.test(attrName)) refuse(`a malformed attribute name in <${name}>`);
    if (seen.has(attrName)) refuse(`the attribute ${attrName} twice in <${name}>`);
    seen.add(attrName);
    const valueStart = at + whole.length;
    const valueEnd = text.indexOf(quote, valueStart);
    if (valueEnd === -1) refuse(`an unterminated attribute value in <${name}>`);
    const raw = text.slice(valueStart, valueEnd);
    if (raw.includes("<")) refuse(`a < inside an attribute value of <${name}>`);
    attributes.push([attrName, decode(raw)]);
    at = valueEnd + 1;
  }
}

function openElement(tag: { name: string; attributes: [string, string][] }, parent: Scope | undefined): Scope {
  const namespaces = new Map(parent?.namespaces ?? [["", SVG_NS]]);
  for (const [name, value] of tag.attributes) {
    if (name === "xmlns") {
      if (value !== SVG_NS) refuse(`the default namespace ${value} (only SVG's)`);
      namespaces.set("", value);
    } else if (name.startsWith("xmlns:")) {
      const prefix = name.slice(6);
      if (prefix === "xlink" ? value !== XLINK_NS : !INERT_NAMESPACES.has(value)) refuse(`the namespace ${value} bound to ${prefix}`);
      namespaces.set(prefix, value);
    }
  }
  const [prefix, local] = tag.name.includes(":") ? (tag.name.split(":") as [string, string]) : [null, tag.name];
  if (prefix === null) {
    if (parent === undefined && local !== "svg") refuse(`the root element <${tag.name}> (an SVG starts with <svg>)`);
    if (!SVG_ELEMENTS.has(local)) refuse(`the element <${tag.name}>`);
  } else {
    const ns = namespaces.get(prefix);
    if (ns === undefined || !INERT_NAMESPACES.has(ns)) refuse(`the element <${tag.name}>`);
    if (parent === undefined) refuse(`the root element <${tag.name}> (an SVG starts with <svg>)`);
  }
  for (const [name, value] of tag.attributes) {
    if (name !== "xmlns" && !name.startsWith("xmlns:")) checkAttribute(tag.name, name, value, namespaces);
  }
  return { name: tag.name, namespaces };
}

/** Why the SVG text is refused, or null when every construct in it is allowed. */
export function svgProblem(text: string): string | null {
  try {
    checkSvg(text);
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.message;
    throw error;
  }
}

function checkSvg(text: string): void {
  const stack: Scope[] = [];
  let rootSeen = false;
  let at = 0;
  let style: string[] | null = null;
  const textUntil = (end: number): void => {
    const chunk = text.slice(at, end);
    if (stack.length === 0) {
      if (chunk.trim() !== "") refuse("text outside the <svg> element");
      return;
    }
    const decoded = decode(chunk);
    style?.push(decoded);
  };
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt === -1) {
      textUntil(text.length);
      break;
    }
    textUntil(lt);
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt);
      if (end === -1) refuse("an unterminated processing instruction");
      if (lt !== 0 || !/^<\?xml[\s?]/.test(text.slice(lt, lt + 6))) refuse("a processing instruction (only the <?xml ...?> declaration at the start)");
      at = end + 2;
    } else if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) refuse("an unterminated comment");
      at = end + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      if (stack.length === 0) refuse("CDATA outside the <svg> element");
      const end = text.indexOf("]]>", lt);
      if (end === -1) refuse("an unterminated CDATA section");
      style?.push(text.slice(lt + 9, end));
      at = end + 3;
    } else if (/^<!doctype\s/i.test(text.slice(lt, lt + 10))) {
      if (rootSeen || stack.length > 0) refuse("a DOCTYPE after the root element");
      const end = text.indexOf(">", lt);
      if (end === -1) refuse("an unterminated DOCTYPE");
      if (text.slice(lt, end).includes("[")) refuse("a DOCTYPE with an internal subset (entity declarations); export the SVG without a DOCTYPE");
      at = end + 1;
    } else if (text.startsWith("<!", lt)) {
      refuse("a markup declaration");
    } else if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt);
      const name = end === -1 ? "" : text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) refuse(`a mismatched end tag </${name}>`);
      if (name === "style" && style !== null) {
        checkCss(style.join(""), "a <style> element");
        style = null;
      }
      at = end + 1;
    } else {
      if (rootSeen && stack.length === 0) refuse("a second root element");
      const tag = readTag(text, lt);
      const scope = openElement(tag, stack.at(-1));
      rootSeen = true;
      if (tag.name === "style") {
        if (style !== null) refuse("a <style> inside a <style>");
        if (!tag.selfClosing) style = [];
      } else if (style !== null) {
        refuse("an element inside a <style>");
      }
      if (!tag.selfClosing) stack.push(scope);
      at = tag.end;
    }
  }
  if (!rootSeen) refuse("no <svg> element");
  if (stack.length > 0) refuse(`an unclosed <${stack.at(-1)?.name ?? ""}>`);
}
