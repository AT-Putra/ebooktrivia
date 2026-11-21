import { describe, expect, it } from "vitest";
import { issueMagicLink } from "./magic-link.ts";
import { MAGIC_LINK_PATH, MAGIC_LINK_TOKEN_PATTERN, type MagicLinkChannel, magicLinkUrl, parseMagicLinkFragment } from "./magic-link-url.ts";

const ORIGIN = "https://play.example.id";
const TOKEN = "A".repeat(21) + "-_" + "z9".repeat(10);

describe("magicLinkUrl", () => {
  it("puts the channel and the token in the fragment of the confirm page", () => {
    expect(TOKEN).toMatch(MAGIC_LINK_TOKEN_PATTERN);
    const url = new URL(magicLinkUrl(ORIGIN, "whatsapp", TOKEN));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe(MAGIC_LINK_PATH);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#c=whatsapp&t=${TOKEN}`);
  });

  it("round-trips with parseMagicLinkFragment for issued tokens on both channels", () => {
    for (const channel of ["whatsapp", "email"] as const) {
      const { token } = issueMagicLink({ channel });
      expect(parseMagicLinkFragment(new URL(magicLinkUrl(ORIGIN, channel, token)).hash)).toEqual({ channel, token });
    }
  });

  it("refuses an origin with a path, an unknown channel and a malformed token", () => {
    expect(() => magicLinkUrl(`${ORIGIN}/x`, "email", TOKEN)).toThrow(RangeError);
    expect(() => magicLinkUrl(`${ORIGIN}/`, "email", TOKEN)).toThrow(RangeError);
    expect(() => magicLinkUrl(ORIGIN, "sms" as MagicLinkChannel, TOKEN)).toThrow(RangeError);
    expect(() => magicLinkUrl(ORIGIN, "email", `${TOKEN}A`)).toThrow(RangeError);
    expect(() => magicLinkUrl(ORIGIN, "email", "short")).toThrow(RangeError);
  });
});

describe("parseMagicLinkFragment", () => {
  it("accepts the fragment with or without the leading #", () => {
    expect(parseMagicLinkFragment(`#c=email&t=${TOKEN}`)).toEqual({ channel: "email", token: TOKEN });
    expect(parseMagicLinkFragment(`c=whatsapp&t=${TOKEN}`)).toEqual({ channel: "whatsapp", token: TOKEN });
  });

  it.each([
    ["empty", ""],
    ["only #", "#"],
    ["no channel", `#t=${TOKEN}`],
    ["no token", "#c=email"],
    ["unknown channel", `#c=sms&t=${TOKEN}`],
    ["short token", "#c=email&t=abc"],
    ["token with padding", `#c=email&t=${TOKEN.slice(1)}=`],
    ["extra parameter", `#c=email&t=${TOKEN}&x=1`],
    ["repeated token", `#c=email&t=${TOKEN}&t=${TOKEN}`],
  ])("returns null for %s", (_name, hash) => {
    expect(parseMagicLinkFragment(hash)).toBeNull();
  });
});
