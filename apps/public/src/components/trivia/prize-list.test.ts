// The prize section of the banner card, rendered to static markup: one card per tier, the columns, the pills, the picture.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatRupiah } from "../../lib/format.ts";
import { PrizeList, type PrizeTierView } from "./prize-list.tsx";

const UPLOAD = "/api/v1/play/img/prize/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.webp";
const tier = (rankFrom: number, rankTo: number, over: Partial<PrizeTierView> = {}): PrizeTierView => ({ rankFrom, rankTo, name: `Hadiah ${String(rankFrom)}`, valueIdr: 500_000, imageUrl: null, ...over });
const FIVE = [tier(1, 1), tier(2, 2), tier(3, 3), tier(4, 4), tier(5, 9)];

const render = (tiers: readonly PrizeTierView[], headingId = "prizes-h"): string => renderToStaticMarkup(createElement(PrizeList, { tiers, headingId }));
const cards = (html: string): string[] => html.match(/<li[\s>][\s\S]*?<\/li>/g) ?? [];
const pills = (card: string): string[] => [...card.matchAll(/data-slot="badge"[^>]*>([^<]*)</g)].map((m) => m[1] ?? "");
const listClass = (html: string): string => /<ul[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";

describe("the prize grid's columns: one below xl, then by the number of tiers", () => {
  it.each([
    [1, "xl:grid-cols-1"],
    [2, "xl:grid-cols-2"],
    [3, "xl:grid-cols-3"],
    [4, "xl:grid-cols-2"],
    [5, "xl:grid-cols-3"],
  ])("%i tier(s): %s", (count, expected) => {
    const classes = listClass(render(FIVE.slice(0, count))).split(" ");
    expect(classes).toContain(expected);
    expect(classes.filter((c) => c.includes("grid-cols"))).toEqual(["grid-cols-1", expected]);
  });

  it("has more than five tiers on 3 columns too, and is a list named by its heading", () => {
    const html = render([...FIVE, tier(10, 12), tier(13, 20)]);
    expect(listClass(html)).toContain("xl:grid-cols-3");
    const id = /<h2 id="([^"]*)"/.exec(html)?.[1];
    expect(id).toBe("prizes-h");
    expect(html).toMatch(/<ul role="list" aria-labelledby="prizes-h"/);
  });
});

describe("one card per tier", () => {
  it("renders exactly one prize card per tier, each with its name", () => {
    const html = render(FIVE);
    expect(cards(html)).toHaveLength(5);
    expect(html.match(/data-testid="prize-card"/g)).toHaveLength(5);
    cards(html).forEach((card, i) => {
      expect(card).toContain(`Hadiah ${String((FIVE[i] as PrizeTierView).rankFrom)}`);
    });
  });

  it("names the list by the heading it is given, so two lists never share an id", () => {
    expect(render(FIVE, "a-prizes")).toContain('<h2 id="a-prizes"');
    expect(render(FIVE, "a-prizes")).toContain('aria-labelledby="a-prizes"');
  });

  it("has the heading and the no-prizes note, and no list, with no tiers", () => {
    const html = render([]);
    expect(html).toContain('<h2 id="prizes-h"');
    expect(html).toContain("Hadiah diumumkan oleh penyelenggara.");
    expect(html).not.toContain("<ul");
  });

  it("writes the rank and the winners: 'Juara 2–6' and '· 5 pemenang'; a one-place tier is only 'Juara 1' (the count would repeat the rank)", () => {
    const [one, five, two] = cards(render([tier(1, 1), tier(2, 6), tier(7, 8)]));
    expect(one).toContain("Juara 1");
    expect(one).not.toContain("pemenang");
    expect(five).toContain("Juara 2–6");
    expect(five).toContain("· 5 pemenang");
    expect(two).toContain("· 2 pemenang");
  });

  it("keeps the rank line's medal and label together, and the winners count apart, so it breaks only between the two", () => {
    const [, five] = cards(render([tier(1, 1), tier(2, 6)]));
    expect(five).toMatch(/<span class="inline-flex items-center gap-1\.5 whitespace-nowrap"><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Juara 2–6<\/span> <span class="whitespace-nowrap">· 5 pemenang<\/span>/);
  });

  it("sizes the picture frame 76 px, the gap 12 px and the padding 10 px below md, 112, 16 and 12 px from md (so the rank line fits one line on a phone)", () => {
    const [card] = cards(render([tier(1, 1), tier(2, 6)]));
    expect(card).toMatch(/<li class="[^"]*\bgap-3\b[^"]*\bp-2\.5\b[^"]*\bmd:gap-4\b[^"]*\bmd:p-3\b/);
    expect(card).toMatch(/data-testid="prize-picture"/);
    expect(card).toMatch(/class="size-19 [^"]*\bmd:size-28\b[^"]*" data-testid="prize-picture"/);
  });
});

describe("the pills", () => {
  it("shows 'Hadiah utama' only on the rankFrom=1 card, whatever the order of the tiers", () => {
    const html = render([tier(2, 6), tier(1, 1), tier(7, 9)]);
    expect(cards(html).map((card) => card.includes("Hadiah utama"))).toEqual([false, true, false]);
  });

  it("gives the rank-1 card 'Hadiah utama' and, when its value is above 0, its value next to it", () => {
    expect(pills(cards(render([tier(1, 1, { valueIdr: 25_000_000 })]))[0] ?? "")).toEqual(["Hadiah utama", formatRupiah(25_000_000)]);
    expect(pills(cards(render([tier(1, 1, { valueIdr: 0 })]))[0] ?? "")).toEqual(["Hadiah utama"]);
  });

  it("gives every other tier only its value, and no pill at all when the value is 0", () => {
    const [, valued, free] = cards(render([tier(1, 1), tier(2, 6, { valueIdr: 500_000 }), tier(7, 9, { valueIdr: 0 })]));
    expect(pills(valued ?? "")).toEqual([formatRupiah(500_000)]);
    expect(pills(free ?? "")).toEqual([]);
    expect(free).not.toContain("data-slot=");
  });

  it("never wraps a pill", () => {
    for (const card of cards(render([tier(1, 1), tier(2, 6)]))) expect(card.match(/data-slot="badge"[^>]*class="([^"]*)"/g)?.every((p) => p.includes("whitespace-nowrap"))).toBe(true);
  });
});

describe("the picture", () => {
  it("shows the built-in placeholder in the frame when the tier has no image, and the upload when it has one", () => {
    const [placeholder, uploaded] = cards(render([tier(1, 1), tier(2, 6, { imageUrl: UPLOAD })]));
    expect(placeholder).toContain("/assets/prize-placeholder/");
    expect(placeholder).toContain('alt=""');
    expect(uploaded).toContain(`src="${UPLOAD}"`);
    expect(uploaded).not.toContain("prize-placeholder");
    expect(uploaded).toContain('alt=""');
  });

  it("keeps an upload whole (object-contain) and lets the placeholder art fill the frame (object-cover)", () => {
    const [placeholder, uploaded] = cards(render([tier(1, 1), tier(2, 6, { imageUrl: UPLOAD })]));
    expect(placeholder).toContain("object-cover");
    expect(uploaded).toContain("object-contain");
    expect(uploaded).not.toContain("object-cover");
  });

  it("loads the rank-1 picture at once and every other lazily", () => {
    const [top, other] = cards(render([tier(1, 1, { imageUrl: UPLOAD }), tier(2, 6, { imageUrl: UPLOAD })]));
    expect(top).toContain('loading="eager"');
    expect(other).toContain('loading="lazy"');
  });
});

describe("a lone card", () => {
  it("centres its content from md; a card among others does not", () => {
    expect(cards(render([tier(1, 1)]))[0]).toContain("md:justify-center");
    for (const card of cards(render([tier(1, 1), tier(2, 6)]))) expect(card).not.toContain("justify-center");
  });
});
