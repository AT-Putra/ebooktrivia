import { describe, expect, it } from "vitest";
// The SDK's consent links (the one place that builds them), read here by relative path: the link and the
// page it names must agree, and they live in different packages.
import { legalLinks } from "../../../../packages/sdk/src/legal.ts";
import { parseLegalRequest } from "./legal.ts";
import { routeOrder } from "./order/routing.ts";

describe("the SDK consent links and the legal pages", () => {
  const links = legalLinks("https://api.example.test", { play_origin: "https://play.example.test", program: "juni-2026", terms: 3, privacy: 12 });

  it("resolve to pages parseLegalRequest accepts, with the version the buyer consented to", () => {
    expect(links).not.toBeNull();
    const parsed = [links?.terms, links?.privacy].map((href) => {
      const url = new URL(href ?? "");
      const [, root, program, kind, version] = url.pathname.split("/");
      return { origin: url.origin, root, request: parseLegalRequest(program ?? "", kind ?? "", version ?? "") };
    });
    expect(parsed).toEqual([
      { origin: "https://play.example.test", root: "legal", request: { program: "juni-2026", kind: "terms", version: 3 } },
      { origin: "https://play.example.test", root: "legal", request: { program: "juni-2026", kind: "privacy", version: 12 } },
    ]);
  });

  it("are served by the play origin's proxy rule", () => {
    for (const href of [links?.terms, links?.privacy]) {
      expect(routeOrder({ host: "play.example.test", domain: "example.test", pathname: new URL(href ?? "").pathname, orderIdParam: null })).toEqual({ kind: "legal" });
    }
  });
});

describe("parseLegalRequest", () => {
  it("reads the three segments of a legal page address", () => {
    expect(parseLegalRequest("juni-2026", "terms", "3")).toEqual({ program: "juni-2026", kind: "terms", version: 3 });
    expect(parseLegalRequest("sains", "privacy", "1000000")).toEqual({ program: "sains", kind: "privacy", version: 1_000_000 });
  });

  it("refuses anything that cannot name a legal page, all the same way", () => {
    const bad: [string, string, string][] = [
      ["Juni", "terms", "1"],
      ["juni_2026", "terms", "1"],
      ["-juni", "terms", "1"],
      ["", "terms", "1"],
      ["a".repeat(65), "terms", "1"],
      ["juni", "TERMS", "1"],
      ["juni", "cookies", "1"],
      ["juni", "terms", "0"],
      ["juni", "terms", "01"],
      ["juni", "terms", "-1"],
      ["juni", "terms", "1.5"],
      ["juni", "terms", "1e3"],
      ["juni", "terms", "10000000"],
      ["juni", "terms", "latest"],
      ["juni", "terms", "1 "],
      ["../etc", "terms", "1"],
    ];
    for (const [program, kind, version] of bad) expect(parseLegalRequest(program, kind, version), `${program}/${kind}/${version}`).toBeUndefined();
  });
});
