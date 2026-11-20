// The links of the consent checkbox (AC-A10): the program's legal pages on the play origin, built
// from the config's program slug and policy versions, never taken from the network as URLs.
import type { SdkLpConfig } from "@ebooktrivia/core/sdk-contract";

/** `<play origin>` if it is the API's own sibling (`api.<d>` -> `play.<d>`, or the same host outside production). */
export function legalOrigin(apiOrigin: string, playOrigin: string): string | null {
  try {
    const api = new URL(apiOrigin);
    const play = new URL(playOrigin);
    if (play.origin !== playOrigin || play.protocol !== api.protocol) return null;
    const expected = api.hostname.startsWith("api.") ? `play.${api.hostname.slice(4)}` : api.hostname;
    return play.hostname === expected ? playOrigin : null;
  } catch {
    return null;
  }
}

export interface LegalLinks {
  readonly terms: string;
  readonly privacy: string;
}

/** The two legal page URLs, or null when the config has none or its play origin is not the API's sibling. */
export function legalLinks(apiOrigin: string, legal: SdkLpConfig["legal"]): LegalLinks | null {
  if (legal === null) return null;
  const origin = legalOrigin(apiOrigin, legal.play_origin);
  if (origin === null) return null;
  return {
    terms: `${origin}/legal/${legal.program}/terms/${String(legal.terms)}`,
    privacy: `${origin}/legal/${legal.program}/privacy/${String(legal.privacy)}`,
  };
}
