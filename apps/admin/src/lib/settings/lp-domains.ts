// Landing-page domain registration (AC-S1/S2, risk R4; US-017). Owner only (policy
// lp_domain.register, plan §10 item 18). A registered host gets a TLS certificate from Caddy's
// on-demand TLS and serves untrusted LP HTML, so it must never share a site with the app:
//
//   - the input must already be the stored form apps/worker's Caddy `ask` accepts
//     (@ebooktrivia/core normalizeHost): ASCII letters, digits, "-" and "." only, at least two
//     labels, no trailing dot, no IP literal, no port. ASCII case is folded ("Shop.Example" is
//     shop.example), so a mixed-case spelling of the app's own domain is caught below. Unicode is
//     refused (no UTS46 mapping: enter an IDN as its xn-- A-labels), so full-width letters, the
//     Kelvin sign, U+3002 and similar aliases never reach the database;
//   - an A-label must decode to a single script among Latin / Cyrillic / Greek / Armenian
//     (no mixed-script lookalike such as Latin "paypal" with a Cyrillic "a");
//   - its registrable domain (eTLD+1 by the Public Suffix List incl. private suffixes, tldts) must
//     exist (a public suffix itself, e.g. co.id or github.io, is refused) and differ from the
//     registrable domain of DOMAIN (so admin./play./api.<DOMAIN> and any sibling are refused).
import { domainToUnicode } from "node:url";
import { normalizeHost } from "@ebooktrivia/core";
import { getDomain } from "tldts";

export type LpDomainRefusal = "invalid" | "unicode" | "mixed_script" | "public_suffix" | "own_domain" | "no_app_domain";

export const LP_DOMAIN_MESSAGES: Readonly<Record<LpDomainRefusal, string>> = {
  invalid: "Enter a host name such as shop.example.id: letters, digits, hyphens and dots only, no IP address, port, path or trailing dot.",
  unicode: "Enter an internationalised domain in its xn-- (punycode) form.",
  mixed_script: "This domain mixes alphabets (for example Latin and Cyrillic letters) and could imitate another domain.",
  public_suffix: "This is a public suffix (like co.id), not a domain someone can own.",
  own_domain: "Landing pages cannot use the app's own domain or any of its subdomains.",
  no_app_domain: "Landing-page domains cannot be registered: DOMAIN is not configured on the server.",
};

const OPTIONS = { allowPrivateDomains: true } as const;
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u];

/** True when the label (Unicode form) uses letters of more than one of the confusable scripts. */
function mixesScripts(label: string): boolean {
  return CONFUSABLE_SCRIPTS.filter((script) => script.test(label)).length > 1;
}

/** The stored form of `input`, or why it is refused. `appDomain` is DOMAIN (null: not configured). */
export function checkLpDomain(input: string, appDomain: string | null): { readonly ok: true; readonly host: string } | { readonly ok: false; readonly reason: LpDomainRefusal } {
  if (appDomain === null) return { ok: false, reason: "no_app_domain" };
  const raw = input.trim();
  if (/[^\x20-\x7e]/.test(raw)) return { ok: false, reason: "unicode" };
  const host = normalizeHost(raw);
  if (host === null) return { ok: false, reason: "invalid" };
  for (const label of host.split(".")) {
    if (label.startsWith("xn--") && mixesScripts(domainToUnicode(label))) return { ok: false, reason: "mixed_script" };
  }
  const registrable = getDomain(host, OPTIONS);
  if (registrable === null) return { ok: false, reason: "public_suffix" };
  if (registrable === getDomain(appDomain, OPTIONS)) return { ok: false, reason: "own_domain" };
  return { ok: true, host };
}
