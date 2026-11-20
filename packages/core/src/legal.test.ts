import { describe, expect, it } from "vitest";
import { legalBlocks } from "./legal.ts";

describe("legalBlocks", () => {
  it("splits on blank lines, keeps lines inside a paragraph, and reads '# ' as a heading", () => {
    expect(legalBlocks("# Syarat dan Ketentuan\r\nBerlaku untuk musim 1.\r\n\r\n\r\n1. Peserta membeli ebook.\n2. Peserta bermain.  \n \n# Hadiah")).toEqual([
      { kind: "heading", text: "Syarat dan Ketentuan" },
      { kind: "paragraph", lines: ["Berlaku untuk musim 1."] },
      { kind: "paragraph", lines: ["1. Peserta membeli ebook.", "2. Peserta bermain."] },
      { kind: "heading", text: "Hadiah" },
    ]);
  });

  it("returns markup as plain text, untouched (renderers insert text nodes)", () => {
    const body = `<script>alert(1)</script>\n<img src=x onerror=alert(2)>`;
    expect(legalBlocks(body)).toEqual([{ kind: "paragraph", lines: ["<script>alert(1)</script>", "<img src=x onerror=alert(2)>"] }]);
  });

  it("has no blocks for an empty or blank body; '#' without a space is text", () => {
    expect(legalBlocks("")).toEqual([]);
    expect(legalBlocks(" \n\t\n")).toEqual([]);
    expect(legalBlocks("#tagar")).toEqual([{ kind: "paragraph", lines: ["#tagar"] }]);
  });
});
