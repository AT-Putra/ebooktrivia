// US-023: the SDK tag goes in exactly once, before the first real </head> (lp-html.ts).
import { describe, expect, it } from "vitest";
import { findHeadEnd, injectSdk } from "./lp-html.ts";

const TAG = '<script src="https://api.example.test/sdk/v1.js" data-lp="lp_abcdefgh12345678" async></script>';

describe("injectSdk", () => {
  it("inserts the tag right before the first </head>, any case", () => {
    expect(injectSdk("<html><head><title>x</title></HEAD><body></body></html>", TAG)).toEqual({
      ok: true,
      changed: true,
      html: `<html><head><title>x</title>${TAG}</HEAD><body></body></html>`,
    });
  });

  it("is idempotent: injecting into its own output changes nothing", () => {
    const once = injectSdk("<head></head>", TAG);
    if (!once.ok) throw new Error("refused");
    expect(injectSdk(once.html, TAG)).toEqual({ ok: true, changed: false, html: once.html });
  });

  it("does not count a tag inside an HTML comment as injected", () => {
    const html = `<head><!-- ${TAG} --></head>`;
    expect(injectSdk(html, TAG)).toEqual({ ok: true, changed: true, html: `<head><!-- ${TAG} -->${TAG}</head>` });
  });

  it("skips a </head> inside a comment, a script, a style, a title or a quoted attribute", () => {
    const html = `<head><!-- </head> --><script>var s = "</head>";</script><style>/* </head> */</style><title></head></title><meta content="</head>"></head>`;
    const result = injectSdk(html, TAG);
    expect(result).toEqual({ ok: true, changed: true, html: html.replace(/<\/head>$/, `${TAG}</head>`) });
  });

  it("refuses a page without </head> (no safe place for the script)", () => {
    expect(injectSdk("<!doctype html><title>x</title><p>body", TAG)).toEqual({ ok: false, problem: "no_head" });
    expect(injectSdk("<head><script>never closed </head>", TAG)).toEqual({ ok: false, problem: "no_head" });
    expect(injectSdk("<head><!-- never closed </head>", TAG)).toEqual({ ok: false, problem: "no_head" });
    expect(injectSdk('<head><meta content="never closed </head>', TAG)).toEqual({ ok: false, problem: "no_head" });
  });

  it("refuses any other SDK tag: another LP key, a pinned version, another domain, a second copy", () => {
    for (const html of [
      '<head><script src="https://api.example.test/sdk/v1.js" data-lp="lp_someoneelse0000"></script></head>',
      '<head><script src="https://api.example.test/sdk/sdk-v1.2.3.js"></script></head>',
      '<head><script src="https://api.other.test/SDK/V1.JS"></script></head>',
      '<head><div data-lp = "x"></div></head>',
      `<head>${TAG}${TAG}</head>`,
    ]) {
      expect(injectSdk(html, TAG), html).toEqual({ ok: false, problem: "sdk_tag" });
    }
  });

  it("findHeadEnd ignores a stray < and finds nothing in a document without head", () => {
    expect(findHeadEnd("a < b </head>")).toBe(6);
    expect(findHeadEnd("<p>x</p>")).toBeNull();
  });
});
