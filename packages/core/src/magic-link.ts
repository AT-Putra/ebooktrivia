// Player magic links (plan M8.4, §10 item 4; spec AC-D2, AC-Q1): one token per delivery channel, single
// use, valid 72 h. The token is 32 bytes (256 bits) from the CSPRNG, base64url without padding (43
// characters). Only SHA-256(token) is stored (magic_links.token_hash, 32 bytes; the plan names no pepper,
// and a 256-bit random token cannot be brute-forced from its hash).
// The DATABASE decides everything else (packages/db sql/functions.sql, US-026): issue_magic_link sets the
// expiry from its own clock (+72 h) and keeps one live link per player and channel; consume_magic_link is
// the single, channel-bound use. This module only makes tokens and hashes them; the link's URL is
// magic-link-url.ts (no node: imports, also used by the browser).
import { createHash, randomBytes } from "node:crypto";
import { MAGIC_LINK_CHANNELS, MAGIC_LINK_TOKEN_PATTERN, type MagicLinkChannel } from "./magic-link-url.ts";

const TOKEN_BYTES = 32;

export interface IssuedMagicLink {
  /** Goes into the link only; never stored or logged. */
  readonly token: string;
  /** What issue_magic_link stores. */
  readonly tokenHash: Buffer;
  readonly channel: MagicLinkChannel;
}

/** SHA-256 of a well-formed token, or null for anything that is not one. */
export function hashMagicLinkToken(token: string): Buffer | null {
  if (!MAGIC_LINK_TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest();
}

/** A new token for `channel` (its expiry is the database's: issue_magic_link). */
export function issueMagicLink(input: { readonly channel: MagicLinkChannel }): IssuedMagicLink {
  if (!MAGIC_LINK_CHANNELS.includes(input.channel)) throw new RangeError("unknown magic link channel");
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token, "utf8").digest(), channel: input.channel };
}
