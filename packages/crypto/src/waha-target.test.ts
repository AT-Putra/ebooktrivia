import { describe, expect, it } from "vitest";
import { CryptoError } from "./sealed-box.ts";
import { assertWahaTarget } from "./waha-target.ts";

// Security review US-011 #1: the WAHA API key (messaging scope) is bound to waha_servers
// base_url_host, but the client sends to base_url. The client must refuse unless base_url parses
// to exactly the bound host over https.

const SERVER = { baseUrl: "https://waha.example.id:3000/api", baseUrlHost: "waha.example.id:3000" };
const SECRET = { scope: "messaging", boundHost: "waha.example.id:3000" };

function expectCode(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(CryptoError);
  expect((error as CryptoError).code).toBe(code);
}

describe("assertWahaTarget", () => {
  it("returns the parsed base URL when scheme, host label and bound host all agree", () => {
    const url = assertWahaTarget(SERVER, SECRET);
    expect(url.href).toBe("https://waha.example.id:3000/api");
    expect(assertWahaTarget({ baseUrl: "https://waha.example.id", baseUrlHost: "waha.example.id" }, { scope: "messaging", boundHost: "waha.example.id" }).host).toBe(
      "waha.example.id",
    );
  });

  it.each([
    ["base_url on another host than its label (P4)", { baseUrl: "https://evil.example/api", baseUrlHost: "waha.example.id:3000" }, SECRET],
    ["another port", { baseUrl: "https://waha.example.id:3001/api", baseUrlHost: "waha.example.id:3000" }, SECRET],
    ["label and URL agree but the secret is bound elsewhere", { baseUrl: "https://evil.example/api", baseUrlHost: "evil.example" }, SECRET],
    ["explicit default port in the label", { baseUrl: "https://waha.example.id:443/", baseUrlHost: "waha.example.id:443" }, { scope: "messaging", boundHost: "waha.example.id:443" }],
    ["numeric IPv4 shorthand normalised by the URL parser", { baseUrl: "https://2130706433/", baseUrlHost: "2130706433" }, { scope: "messaging", boundHost: "2130706433" }],
  ])("refuses %s", (_label, server, secret) => {
    expectCode(() => assertWahaTarget(server, secret), "binding_mismatch");
  });

  it.each([
    ["http (P5c)", "http://waha.example.id:3000/api"],
    ["userinfo", "https://user:pw@waha.example.id:3000/api"],
    ["unparsable", "https://"],
    ["not a URL", "waha.example.id:3000"],
  ])("refuses %s", (_label, baseUrl) => {
    expectCode(() => assertWahaTarget({ baseUrl, baseUrlHost: "waha.example.id:3000" }, SECRET), "binding_mismatch");
  });

  it("refuses a secret that is not messaging scope or has no bound host", () => {
    expectCode(() => assertWahaTarget(SERVER, { scope: "payment", boundHost: "waha.example.id:3000" }), "binding_mismatch");
    expectCode(() => assertWahaTarget(SERVER, { scope: "messaging", boundHost: null }), "binding_mismatch");
  });
});
