// The magic link's channels and URL (US-026 defines it, US-025 sends it; plan M8.4, §10 item 4). No node:
// imports, so the play login page's client code can use it too (subpath @ebooktrivia/core/magic-link-url).
//
//   https://play.<DOMAIN>/masuk#c=<channel>&t=<token>
//
// The token rides in the URL FRAGMENT: a browser never sends a fragment to a server, so it is in no access
// log (Caddy, the app), in no Referer, and a link scanner that GETs the URL only gets the confirm page. That
// page (GET, no state change) reads the fragment, removes it from the address bar, and only a click on its
// button POSTs the token (the single-use consume). The channel is part of the link: a token issued for one
// channel is refused on the other ("one per channel").

/** The delivery channels, one token each (magic_links_channel_check; the one list every caller uses). */
export const MAGIC_LINK_CHANNELS = ["whatsapp", "email"] as const;
export type MagicLinkChannel = (typeof MAGIC_LINK_CHANNELS)[number];

export const isMagicLinkChannel = (value: unknown): value is MagicLinkChannel => MAGIC_LINK_CHANNELS.some((c) => c === value);

/** The confirm page's path on the play origin. */
export const MAGIC_LINK_PATH = "/masuk";
/** 32 random bytes, base64url without padding. */
export const MAGIC_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MagicLinkTarget {
  readonly channel: MagicLinkChannel;
  readonly token: string;
}

/** The link for `token` on `playOrigin` (an origin such as https://play.example.id, no path). */
export function magicLinkUrl(playOrigin: string, channel: MagicLinkChannel, token: string): string {
  const origin = new URL(playOrigin);
  if (origin.origin !== playOrigin) throw new RangeError("playOrigin must be an origin (scheme, host, port) without a path");
  if (!isMagicLinkChannel(channel)) throw new RangeError("unknown magic link channel");
  if (!MAGIC_LINK_TOKEN_PATTERN.test(token)) throw new RangeError("not a magic link token");
  return `${playOrigin}${MAGIC_LINK_PATH}#c=${channel}&t=${token}`;
}

/** The channel and token of a link's fragment (`location.hash`, with or without "#"), or null. */
export function parseMagicLinkFragment(hash: string): MagicLinkTarget | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const channel = params.get("c");
  const token = params.get("t");
  if (channel === null || token === null || [...params.keys()].length !== 2) return null;
  if (!isMagicLinkChannel(channel) || !MAGIC_LINK_TOKEN_PATTERN.test(token)) return null;
  return { channel, token };
}
