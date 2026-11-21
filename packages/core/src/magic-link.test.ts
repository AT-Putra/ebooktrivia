import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashMagicLinkToken, issueMagicLink } from "./magic-link.ts";
import { isMagicLinkChannel, MAGIC_LINK_CHANNELS, type MagicLinkChannel } from "./magic-link-url.ts";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

describe("issueMagicLink", () => {
  it("creates a 256-bit base64url token and its SHA-256 (the expiry is the database's)", () => {
    const link = issueMagicLink({ channel: "whatsapp" });
    expect(Object.keys(link).sort()).toEqual(["channel", "token", "tokenHash"]);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(link.token, "base64url")).toHaveLength(32);
    expect(link.tokenHash.equals(sha256(link.token))).toBe(true);
    expect(link.tokenHash).toHaveLength(32);
    expect(link.channel).toBe("whatsapp");
  });

  it("never repeats a token, and keeps one independent token per channel", () => {
    const tokens = new Set(Array.from({ length: 2_000 }, () => issueMagicLink({ channel: "email" }).token));
    expect(tokens.size).toBe(2_000);
    const [wa, email] = MAGIC_LINK_CHANNELS.map((channel) => issueMagicLink({ channel }));
    expect(wa?.token).not.toBe(email?.token);
  });

  it("rejects an unknown channel", () => {
    expect(() => issueMagicLink({ channel: "sms" as MagicLinkChannel })).toThrow(RangeError);
  });
});

describe("hashMagicLinkToken", () => {
  it("hashes well-formed tokens only", () => {
    const link = issueMagicLink({ channel: "email" });
    expect(hashMagicLinkToken(link.token)?.equals(link.tokenHash)).toBe(true);
    expect(hashMagicLinkToken("not-a-token")).toBeNull();
    expect(hashMagicLinkToken(`${link.token}=`)).toBeNull();
  });
});

describe("MAGIC_LINK_CHANNELS", () => {
  it("is the channel list of magic_links_channel_check", () => {
    expect(MAGIC_LINK_CHANNELS).toEqual(["whatsapp", "email"]);
    expect(MAGIC_LINK_CHANNELS.every(isMagicLinkChannel)).toBe(true);
    for (const other of ["sms", "", "WhatsApp", null, 1]) expect(isMagicLinkChannel(other)).toBe(false);
  });
});
