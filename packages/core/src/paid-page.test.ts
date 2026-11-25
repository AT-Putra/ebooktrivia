import { describe, expect, it } from "vitest";
import { isPaidPageText, PAID_PAGE_DEFAULTS, PAID_PAGE_LIMITS, paidPageWordingOf } from "./paid-page.ts";

describe("the paid page wording", () => {
  it("has defaults that pass their own rules", () => {
    for (const field of ["body", "button", "note"] as const) expect(isPaidPageText(field, PAID_PAGE_DEFAULTS[field]), field).toBe(true);
  });

  it("refuses untrimmed, too short or too long text, line breaks and invisible characters; the note may be empty", () => {
    expect(isPaidPageText("button", " Ambil ebook")).toBe(false);
    expect(isPaidPageText("button", "Ok")).toBe(false);
    expect(isPaidPageText("button", "x".repeat(PAID_PAGE_LIMITS.button.max + 1))).toBe(false);
    expect(isPaidPageText("button", "x".repeat(PAID_PAGE_LIMITS.button.max))).toBe(true);
    expect(isPaidPageText("body", "Chat kami\ndi WhatsApp sekarang")).toBe(false);
    expect(isPaidPageText("body", "Chat kami​di WhatsApp sekarang")).toBe(false);
    expect(isPaidPageText("body", "Chat kami ‮di WhatsApp")).toBe(false);
    expect(isPaidPageText("note", "")).toBe(true);
    expect(isPaidPageText("body", "")).toBe(false);
    // Counted as the buyer sees them: an emoji is one character.
    expect(isPaidPageText("button", `${"x".repeat(PAID_PAGE_LIMITS.button.max - 1)}😀`)).toBe(true);
  });

  it("reads a stored value field by field, falling back to the default for anything missing or broken", () => {
    expect(paidPageWordingOf(undefined)).toEqual(PAID_PAGE_DEFAULTS);
    expect(paidPageWordingOf(["x"])).toEqual(PAID_PAGE_DEFAULTS);
    expect(paidPageWordingOf({ body: "Chat kami di WhatsApp sekarang ya.", button: 42, note: "" })).toEqual({
      body: "Chat kami di WhatsApp sekarang ya.",
      button: PAID_PAGE_DEFAULTS.button,
      note: "",
    });
    expect(paidPageWordingOf({ button: "Ok\n" }).button).toBe(PAID_PAGE_DEFAULTS.button);
  });
});
