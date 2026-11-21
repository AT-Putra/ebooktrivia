// The SDK tag of a hosted landing page (US-023): every HTML file of an LP ZIP gets exactly one
// `<script src="https://api.<DOMAIN>/sdk/v1.js" data-lp="lp_..." async></script>` (the snippet of
// AC-S1, apps/admin lib/settings/landing-pages.ts) right before its first </head> end tag.
//
//   - Idempotent: a file that already holds the exact tag once, outside a comment, is left as it is,
//     so injecting into an injected file changes nothing. A tag inside an HTML comment does not count
//     (the browser never runs it): the page gets the tag before its </head>.
//   - Refused (`sdk_tag`): any other reference to the SDK (another LP key, another domain, a pinned
//     sdk-vX.Y.Z.js, a second copy, a data-lp attribute): two SDKs, or one bound to another landing
//     page, would take the wrong orders. The hosting adds the tag; the page must not. This refusal
//     catches a mistake, it is NOT a security boundary: the page's own scripts may do anything
//     JavaScript can, including loading the SDK, so nothing relies on it.
//   - Refused (`no_head`): no </head> end tag. HTML allows it to be left out, but then there is no
//     safe place to put a script (above the doctype would switch the page to quirks mode), so the
//     author adds <head>...</head>.
// "First </head>" means the first end tag the browser would see: the scan skips comments, quoted
// attribute values and the contents of raw-text elements (script, style, title, textarea, ...), so
// a "</head>" inside a script string or a comment is not taken for the real one. It is a scanner,
// not an HTML parser: the HTML is the page author's, and a misplaced tag can only make the SDK
// fail to load on that page, never add anything but our own tag.

const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const SDK_REFERENCE = /\/sdk\/(?:v\d+|sdk-v\d+\.\d+\.\d+)\.js|\bdata-lp\s*=/i;

export type InjectResult = { readonly ok: true; readonly html: string; readonly changed: boolean } | { readonly ok: false; readonly problem: "no_head" | "sdk_tag" };

/** Where the first </head> end tag starts, or null. */
export function findHeadEnd(html: string): number | null {
  let at = 0;
  for (;;) {
    const lt = html.indexOf("<", at);
    if (lt === -1) return null;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) return null;
      at = end + 3;
      continue;
    }
    if (/^<\/head[\s/>]/i.test(html.slice(lt, lt + 7))) return lt;
    const start = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (start === null) {
      at = lt + 1;
      continue;
    }
    at = endOfTag(html, lt + 1 + (start[1]?.length ?? 0));
    if (at === -1) return null;
    const name = (start[1] ?? "").toLowerCase();
    if (RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}[\\s/>]`, "i");
      const match = close.exec(html.slice(at));
      if (match === null) return null;
      at += match.index + match[0].length;
    }
  }
}

/** The index after the `>` of a start tag whose name ends at `from` (quoted values skipped), or -1. */
function endOfTag(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i + 1;
    }
  }
  return -1;
}

/** Puts `tag` (the LP's SDK snippet) before the first </head> of `html`; see the file comment. */
export function injectSdk(html: string, tag: string): InjectResult {
  const parts = html.split(tag);
  if (SDK_REFERENCE.test(parts.join(""))) return { ok: false, problem: "sdk_tag" };
  const live = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(tag).length - 1;
  if (live > 1) return { ok: false, problem: "sdk_tag" };
  if (live === 1) return { ok: true, html, changed: false };
  const at = findHeadEnd(html);
  if (at === null) return { ok: false, problem: "no_head" };
  return { ok: true, html: html.slice(0, at) + tag + html.slice(at), changed: true };
}
