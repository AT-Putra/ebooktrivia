// The consent links stay on the program's own play origin; a config whose play origin is anything
// else gets no links (and checkout stays shut, flow.test.ts).
import { describe, expect, it } from "vitest";
import { legalLinks, legalOrigin } from "./legal.ts";

describe("legalOrigin", () => {
  it("accepts play.<domain> next to api.<domain>", () => {
    expect(legalOrigin("https://api.example.test", "https://play.example.test")).toBe("https://play.example.test");
  });

  it("accepts the same host only when the API host is not an api.<domain> host (dev, test)", () => {
    expect(legalOrigin("http://127.0.0.1:4101", "http://127.0.0.1:4102")).toBe("http://127.0.0.1:4102");
    expect(legalOrigin("https://api.example.test", "https://api.example.test")).toBeNull();
  });

  it.each([
    ["another domain", "https://play.evil.test"],
    ["a sibling host", "https://admin.example.test"],
    ["a look-alike", "https://play.example.test.evil.test"],
    ["another scheme", "http://play.example.test"],
    ["a path", "https://play.example.test/legal"],
    ["user info", "https://user@play.example.test"],
    ["not a URL", "play.example.test"],
  ])("refuses %s", (_name, play) => {
    expect(legalOrigin("https://api.example.test", play)).toBeNull();
  });

  it("refuses a malformed API origin", () => {
    expect(legalOrigin("not a url", "https://play.example.test")).toBeNull();
  });
});

describe("legalLinks", () => {
  const legal = { play_origin: "https://play.example.test", program: "juni-2026", terms: 3, privacy: 2 };

  it("builds /legal/{program}/{kind}/{version} on the play origin from the config's slug and versions", () => {
    expect(legalLinks("https://api.example.test", legal)).toEqual({
      terms: "https://play.example.test/legal/juni-2026/terms/3",
      privacy: "https://play.example.test/legal/juni-2026/privacy/2",
    });
  });

  it("has no links without legal pages, or with a play origin that is not the API's sibling", () => {
    expect(legalLinks("https://api.example.test", null)).toBeNull();
    expect(legalLinks("https://api.example.test", { ...legal, play_origin: "https://play.evil.test" })).toBeNull();
    expect(legalLinks("https://api.example.test", { ...legal, play_origin: "https://play.example.test/x" })).toBeNull();
  });
});
