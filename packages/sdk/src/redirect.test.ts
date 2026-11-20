// The open-redirect guard: only https Snap payment pages on the configured environment's host are followed.
import { describe, expect, it } from "vitest";
import { snapRedirectTarget } from "./redirect.ts";

const UUID = "66e4fa55-fdac-4ef9-91b5-733b97d1b862";
const SANDBOX = `https://app.sandbox.midtrans.com/snap/v4/redirection/${UUID}`;
const PRODUCTION = `https://app.midtrans.com/snap/v4/redirection/${UUID}`;

describe("snapRedirectTarget", () => {
  it("accepts the Snap URL of the configured environment", () => {
    expect(snapRedirectTarget(SANDBOX, "sandbox")).toBe(SANDBOX);
    expect(snapRedirectTarget(PRODUCTION, "production")).toBe(PRODUCTION);
  });

  it.each(["/snap/v2/vtweb/", "/snap/v3/redirection/", "/snap/v4/redirection/", "/snap/v10/redirection/"])("accepts the documented shape %s<token> (any Snap version)", (prefix) => {
    const url = `https://app.sandbox.midtrans.com${prefix}${UUID}`;
    expect(snapRedirectTarget(url, "sandbox")).toBe(url);
  });

  it("refuses the other environment's host", () => {
    expect(snapRedirectTarget(SANDBOX, "production")).toBeNull();
    expect(snapRedirectTarget(PRODUCTION, "sandbox")).toBeNull();
  });

  it.each([
    ["http scheme", `http://app.sandbox.midtrans.com/snap/v4/redirection/${UUID}`],
    ["another host", `https://evil.example.test/snap/v4/redirection/${UUID}`],
    ["a look-alike suffix", "https://app.sandbox.midtrans.com.evil.example.test/snap/v4/redirection/x"],
    ["a look-alike prefix", "https://evilapp.sandbox.midtrans.com/snap/v4/redirection/x"],
    ["a sub-domain", "https://x.app.sandbox.midtrans.com/snap/v4/redirection/x"],
    ["user info before the host", `https://app.sandbox.midtrans.com@evil.example.test/snap/v4/redirection/${UUID}`],
    ["user info naming the right host", `https://user:pw@app.sandbox.midtrans.com/snap/v4/redirection/${UUID}`],
    ["a port", `https://app.sandbox.midtrans.com:8443/snap/v4/redirection/${UUID}`],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["a protocol-relative URL", `//app.sandbox.midtrans.com/snap/v4/redirection/${UUID}`],
    ["a relative path", `/snap/v4/redirection/${UUID}`],
    ["a bare host", "app.sandbox.midtrans.com/snap"],
    ["an empty string", ""],
    ["a lone space", " "],
  ])("refuses %s", (_name, url) => {
    expect(snapRedirectTarget(url, "sandbox")).toBeNull();
  });

  describe("the path must be a Snap payment page and nothing else (security review L1)", () => {
    it.each([
      ["a query", `${SANDBOX}?next=https://evil.example.test`],
      ["an empty query", `${SANDBOX}?`],
      ["a fragment", `${SANDBOX}#x`],
      ["an empty fragment", `${SANDBOX}#`],
      ["the site root", "https://app.sandbox.midtrans.com/"],
      ["another path", "https://app.sandbox.midtrans.com/login"],
      ["a path that only starts like a Snap page", `https://app.sandbox.midtrans.com/snap/v4/redirection/${UUID}/extra`],
      ["a trailing slash", `${SANDBOX}/`],
      ["an unknown Snap page kind", `https://app.sandbox.midtrans.com/snap/v4/other/${UUID}`],
      ["no Snap version", `https://app.sandbox.midtrans.com/snap/redirection/${UUID}`],
      ["no token", "https://app.sandbox.midtrans.com/snap/v4/redirection/"],
      ["a token with a dot-dot", "https://app.sandbox.midtrans.com/snap/v4/redirection/.."],
      ["an encoded slash in the token", "https://app.sandbox.midtrans.com/snap/v4/redirection/a%2Fb"],
      ["an underscore in the token", "https://app.sandbox.midtrans.com/snap/v4/redirection/a_b"],
      ["a token over 200 characters", `https://app.sandbox.midtrans.com/snap/v4/redirection/${"a".repeat(201)}`],
      ["an upper-case path", `https://app.sandbox.midtrans.com/SNAP/V4/REDIRECTION/${UUID}`],
    ])("refuses %s", (_name, url) => {
      expect(snapRedirectTarget(url, "sandbox")).toBeNull();
    });

    it("accepts a token of exactly 200 characters", () => {
      const url = `https://app.sandbox.midtrans.com/snap/v4/redirection/${"a".repeat(200)}`;
      expect(snapRedirectTarget(url, "sandbox")).toBe(url);
    });
  });

  it("refuses values that are not strings", () => {
    for (const value of [undefined, null, 42, {}, [SANDBOX], { toString: () => SANDBOX }]) expect(snapRedirectTarget(value, "sandbox")).toBeNull();
  });

  it("refuses an over-long URL", () => {
    expect(snapRedirectTarget(`${SANDBOX}/${"a".repeat(2100)}`, "sandbox")).toBeNull();
  });

  it("navigates to the parsed form, never the raw string (case and tabs are normalised, a backslash never leaves the host)", () => {
    expect(snapRedirectTarget(`HTTPS://APP.SANDBOX.MIDTRANS.COM/snap/v4/redirection/${UUID}`, "sandbox")).toBe(SANDBOX);
    expect(snapRedirectTarget(`https://app.sandbox.midtrans.com/snap/v4/redi\trection/${UUID}`, "sandbox")).toBe(SANDBOX);
    expect(snapRedirectTarget("https://app.sandbox.midtrans.com\\@evil.example.test/x", "sandbox")).toBeNull();
  });
});
