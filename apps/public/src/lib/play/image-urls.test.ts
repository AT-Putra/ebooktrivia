// The play pages' choice between an uploaded picture and the generic art, and the URLs of the uploaded ones.
import { describe, expect, it } from "vitest";
import { prizeArt, prizeImageUrl, SET_ART, setArt, setImageUrl, tierRowImage } from "./image-urls.ts";

const SET = "11111111-1111-4111-8111-111111111111";
const TIER = "22222222-2222-4222-8222-222222222222";
const UPLOAD = "33333333-3333-4333-8333-333333333333";

describe("the image URLs", () => {
  it("name the owning row and the upload (so a replaced image is a new URL), under the play API", () => {
    expect(setImageUrl(SET, UPLOAD)).toBe(`/api/v1/play/img/set/${SET}/${UPLOAD}.webp`);
    expect(prizeImageUrl(TIER, UPLOAD)).toBe(`/api/v1/play/img/prize/${TIER}/${UPLOAD}.webp`);
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

describe("the prize slot and the tier rows", () => {
  const first = prizeImageUrl(TIER, UPLOAD);
  const second = prizeImageUrl(SET, TIER);

  it("shows the RANK-1 tier's uploaded image in the prize slot", () => {
    expect(prizeArt([{ rankFrom: 1, imageUrl: first }, { rankFrom: 2, imageUrl: second }])).toEqual({ kind: "upload", src: first });
    expect(prizeArt([{ rankFrom: 2, imageUrl: second }, { rankFrom: 1, imageUrl: first }])).toEqual({ kind: "upload", src: first });
  });

  it("falls back to the placeholder when the rank-1 tier has no image, even if another tier has one, and with no tiers", () => {
    expect(prizeArt([{ rankFrom: 1, imageUrl: null }, { rankFrom: 2, imageUrl: second }])).toEqual({ kind: "generic", id: "prize-placeholder" });
    expect(prizeArt([{ rankFrom: 2, imageUrl: second }])).toEqual({ kind: "generic", id: "prize-placeholder" });
    expect(prizeArt([])).toEqual({ kind: "generic", id: "prize-placeholder" });
  });

  it("gives a tier row its own image, except the one the slot already shows (not repeated)", () => {
    const tiers = [
      { rankFrom: 1, imageUrl: first },
      { rankFrom: 2, imageUrl: second },
      { rankFrom: 4, imageUrl: null },
    ];
    const slot = prizeArt(tiers);
    expect(tiers.map((tier) => tierRowImage(tier, slot))).toEqual([null, second, null]);
    // With the placeholder in the slot every tier that has an image shows it in its row.
    const withoutRankOne = [
      { rankFrom: 1, imageUrl: null },
      { rankFrom: 2, imageUrl: second },
    ];
    expect(withoutRankOne.map((tier) => tierRowImage(tier, prizeArt(withoutRankOne)))).toEqual([null, second]);
  });
});
