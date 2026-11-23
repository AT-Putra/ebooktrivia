// The play pages' choice between an uploaded picture and the generic art, and the URLs of the uploaded ones.
import { describe, expect, it } from "vitest";
import { bannerArt, bannerImageUrl, prizeImageUrl, prizeLayout, SET_ART, setArt, setImageUrl } from "./image-urls.ts";

const SET = "11111111-1111-4111-8111-111111111111";
const TIER = "22222222-2222-4222-8222-222222222222";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
const PROGRAM = "44444444-4444-4444-8444-444444444444";

describe("the image URLs", () => {
  it("name the owning row and the upload (so a replaced image is a new URL), under the play API", () => {
    expect(setImageUrl(SET, UPLOAD)).toBe(`/api/v1/play/img/set/${SET}/${UPLOAD}.webp`);
    expect(prizeImageUrl(TIER, UPLOAD)).toBe(`/api/v1/play/img/prize/${TIER}/${UPLOAD}.webp`);
    expect(bannerImageUrl(PROGRAM, UPLOAD)).toBe(`/api/v1/play/img/banner/${PROGRAM}/${UPLOAD}.webp`);
  });
});

describe("setArt", () => {
  it("shows the set's uploaded thumbnail when it has one, whatever its place in the grid", () => {
    const thumbnailUrl = setImageUrl(SET, UPLOAD);
    for (const n of [1, 2, 7, 90]) expect(setArt({ thumbnailUrl }, n)).toEqual({ kind: "upload", src: thumbnailUrl });
  });

  it("falls back to the generic art in rotation when it has none (tile 1 the first, tile 7 the first again)", () => {
    expect(setArt({ thumbnailUrl: null }, 1)).toEqual({ kind: "generic", id: SET_ART[0] });
    expect(setArt({ thumbnailUrl: null }, 6)).toEqual({ kind: "generic", id: SET_ART[5] });
    expect(setArt({ thumbnailUrl: null }, 7)).toEqual({ kind: "generic", id: SET_ART[0] });
    expect(setArt({ thumbnailUrl: null }, 90)).toEqual({ kind: "generic", id: SET_ART[(90 - 1) % SET_ART.length] });
  });

  it("mixes the two in one grid: only the sets without a thumbnail rotate the generic art", () => {
    const sets = [{ thumbnailUrl: setImageUrl(SET, UPLOAD) }, { thumbnailUrl: null }, { thumbnailUrl: null }];
    expect(sets.map((set, i) => setArt(set, i + 1).kind)).toEqual(["upload", "generic", "generic"]);
  });
});

describe("bannerArt (the banner card's big picture)", () => {
  it("shows the program's uploaded banner when it has one", () => {
    const bannerUrl = bannerImageUrl(PROGRAM, UPLOAD);
    expect(bannerArt({ bannerUrl })).toEqual({ kind: "upload", src: bannerUrl });
  });

  it("falls back to the built-in art every program shared before when it has none", () => {
    expect(bannerArt({ bannerUrl: null })).toEqual({ kind: "generic", id: "banner-program" });
  });
});

describe("the prize list: the featured grand prize and the compact rows", () => {
  const first = prizeImageUrl(TIER, UPLOAD);
  const second = prizeImageUrl(SET, TIER);
  const tier = (rankFrom: number, imageUrl: string | null) => ({ rankFrom, imageUrl });

  it("features the tier that starts at rank 1, with its uploaded image", () => {
    const layout = prizeLayout([tier(1, first), tier(2, second)]);
    expect(layout.featured).toEqual({ tier: tier(1, first), position: 0, art: { kind: "upload", src: first } });
    // Whatever the order of the list, the rank-1 tier is the featured one (and keeps its place for the medal's tone).
    const reversed = prizeLayout([tier(2, second), tier(1, first)]);
    expect(reversed.featured).toEqual({ tier: tier(1, first), position: 1, art: { kind: "upload", src: first } });
  });

  it("shows the placeholder in the featured tile when the rank-1 tier has no image, even if another tier has one", () => {
    expect(prizeLayout([tier(1, null), tier(2, second)]).featured?.art).toEqual({ kind: "generic", id: "prize-placeholder" });
  });

  it("has no featured tile when no tier starts at rank 1 (and none at all with no tiers)", () => {
    expect(prizeLayout([tier(2, second)]).featured).toBeNull();
    expect(prizeLayout([tier(2, second)]).rows).toEqual([{ tier: tier(2, second), position: 0, image: second }]);
    expect(prizeLayout([])).toEqual({ featured: null, rows: [] });
  });

  it("gives every other tier ONE leading visual: its own image, or null (the medal icon stands in the box)", () => {
    const { rows } = prizeLayout([tier(1, first), tier(2, second), tier(4, null)]);
    expect(rows.map((row) => row.image)).toEqual([second, null]);
    expect(rows.map((row) => row.position)).toEqual([1, 2]);
  });

  it("shows each tier's picture exactly once: the rank-1 tier's is in the featured tile and not in a row", () => {
    const layout = prizeLayout([tier(1, first), tier(2, second)]);
    expect(layout.featured?.art).toEqual({ kind: "upload", src: first });
    expect(layout.rows.map((row) => row.tier.rankFrom)).toEqual([2]);
    expect(layout.rows.map((row) => row.image)).toEqual([second]);
  });
});
