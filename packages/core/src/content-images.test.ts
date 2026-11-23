import { describe, expect, it } from "vitest";
import { contentImagePath, DISPLAY_BOXES, displayImagePath, isPublicImagePath } from "./content-images.ts";

const ID = "11111111-1111-4111-8111-111111111111";

describe("content image paths", () => {
  it("keeps set thumbnails, prize images and program banners in images/ and question images in question-images/, named by the upload id", () => {
    expect(contentImagePath("thumbnail", ID)).toBe(`images/${ID}.webp`);
    expect(contentImagePath("prize", ID)).toBe(`images/${ID}.webp`);
    expect(contentImagePath("banner", ID)).toBe(`images/${ID}.webp`);
    expect(contentImagePath("question", ID)).toBe(`question-images/${ID}.webp`);
  });

  it("derives the display copy as a sibling of the shown file", () => {
    expect(displayImagePath(ID)).toBe(`images/${ID}.display.webp`);
  });

  it("serves exactly the shown path of an upload: not a question image's, not another id's, not the display copy, not a traversal", () => {
    expect(isPublicImagePath(ID, `images/${ID}.webp`)).toBe(true);
    for (const path of [
      `question-images/${ID}.webp`,
      `images/${ID}.display.webp`,
      "images/22222222-2222-4222-8222-222222222222.webp",
      `images/../question-images/${ID}.webp`,
      `/images/${ID}.webp`,
      `images/${ID}.webp/`,
      `deliverables/${ID}.pdf`,
      "",
    ]) {
      expect(isPublicImagePath(ID, path), path).toBe(false);
    }
  });

  it("boxes a thumbnail at 480 x 600, a prize image at 256 x 256 and a program banner at 1344 x 448 (3:1)", () => {
    expect(DISPLAY_BOXES).toEqual({ thumbnail: { width: 480, height: 600 }, prize: { width: 256, height: 256 }, banner: { width: 1344, height: 448 } });
  });
});
