// The play pages' choice between an uploaded picture and the generic art, and the URLs of the uploaded ones.
import { describe, expect, it } from "vitest";
import { bannerArt, bannerImageUrl, prizeArt, prizeImageUrl, SET_ART, setArt, setImageUrl } from "./image-urls.ts";

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

describe("prizeArt (the picture of every prize card)", () => {
  it("shows the tier's uploaded image when it has one, whatever its rank", () => {
    const imageUrl = prizeImageUrl(TIER, UPLOAD);
    expect(prizeArt({ imageUrl })).toEqual({ kind: "upload", src: imageUrl });
  });

  it("falls back to the built-in placeholder when it has none, so every card has a picture (the medal is no stand-in)", () => {
    expect(prizeArt({ imageUrl: null })).toEqual({ kind: "generic", id: "prize-placeholder" });
  });
});
