// The security header set a browser must get from each host (US-031, ASVS V3.4 / V3.3): one policy, checked on real
// responses by infra/verify/local/security-headers.sh (real Caddy in front of the real production builds; CI job
// edge-smoke) and by the same script with --staging against the staging hosts. The policy (docs/asvs-l2-checklist.md
// V3.4, docs/runbooks/security-scans.md):
//   - every host: exactly one HSTS (one year; includeSubDomains on our own hosts, never on a customer's LP domain;
//     never preload: decision in the runbook), exactly one nosniff, exactly one Referrer-Policy from the strict set
//     (strict-origin on order.<DOMAIN>, AC-T5), no Server / X-Powered-By, no `Access-Control-Allow-Origin: *` except the
//     SDK files, never with credentials;
//   - HTML on admin / play / order / api (its 404 and / pages): an enforced CSP with a per-request nonce in script-src, no 'unsafe-inline' and no
//     'unsafe-eval' for scripts ('wasm-unsafe-eval' is allowed: the Cap solver), object-src 'none', base-uri 'none' or
//     'self', frame-ancestors 'none'; X-Frame-Options DENY; no-store; COOP same-origin; a Permissions-Policy that
//     turns off camera, microphone and geolocation; CORP same-origin on admin;
//   - HTML on an LP host: the documented LP default CSP (landing pages are the author's static HTML: inline scripts
//     allowed, never 'unsafe-eval'), object-src 'none', frame-ancestors 'self';
//   - JSON (the API): no-store;
//   - cookies: none at all on order, api, the SDK and LP hosts; on admin and play only `__Host-` names with Secure,
//     HttpOnly, SameSite=Strict or Lax, Path=/ and no Domain.

export type HostKind = "admin" | "play" | "order" | "api" | "sdk" | "lp";

export interface Answer {
  readonly status: number;
  /** Lowercase names, in order; a repeated header appears once per line. */
  readonly headers: readonly (readonly [string, string])[];
}

export interface Probe {
  readonly host: HostKind;
  readonly label: string;
  /** null: any status (the staging run, where answers depend on the data). */
  readonly expectedStatus: number | null;
  /** The route's own Referrer-Policy, where the app sets a stricter one than the edge's default (the play pages). */
  readonly expectedReferrer?: string;
  readonly response: Answer;
}

/** A `curl -D -` dump: the LAST status block (after any 100 Continue), names lowercased. */
export function parseHeaderDump(text: string): Answer {
  const blocks = text.replace(/\r/g, "").split(/\n(?=HTTP\/)/);
  const block = (blocks[blocks.length - 1] ?? "").trim().split("\n");
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(block[0] ?? "")?.[1] ?? "0");
  const headers = block.slice(1).flatMap((line): [string, string][] => {
    const colon = line.indexOf(":");
    return colon <= 0 ? [] : [[line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]];
  });
  return { status, headers };
}

const all = (response: Answer, name: string): string[] => response.headers.filter(([n]) => n === name).map(([, v]) => v);

/** A CSP as directive name -> source list (lowercased names; sources as sent). */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "" && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/** The sources a policy allows for <script> elements: script-src-elem, else script-src, else default-src. */
const elementSources = (csp: Map<string, string[]>): string[] | undefined => csp.get("script-src-elem") ?? csp.get("script-src") ?? csp.get("default-src");

/** Every script source list a policy enforces (elements, attributes, the rest): each must stay free of unsafe sources. */
function scriptLists(csp: Map<string, string[]>): string[][] {
  const lists = ["script-src-elem", "script-src-attr", "script-src"].map((d) => csp.get(d)).filter((l): l is string[] => l !== undefined);
  if (lists.length > 0) return lists;
  const fallback = csp.get("default-src");
  return fallback === undefined ? [] : [fallback];
}

export const NONCE = /^'nonce-[A-Za-z0-9+/_-]{16,}={0,2}'$/;
const STRICT_REFERRER = new Set(["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"]);
/** Hosts whose HTML (pages, and the 404 page of the api origin) must carry the nonce CSP and the page headers. */
const APP_HOSTS: ReadonlySet<HostKind> = new Set(["admin", "play", "order", "api"]);
const COOKIE_HOSTS: ReadonlySet<HostKind> = new Set(["admin", "play"]);

function checkCookie(header: string): string[] {
  const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
  const name = pair.slice(0, pair.indexOf("="));
  const attrs = attributes.map((a) => a.toLowerCase());
  const problems: string[] = [];
  if (!name.startsWith("__Host-")) problems.push(`cookie ${name}: not a __Host- name`);
  if (!attrs.includes("secure")) problems.push(`cookie ${name}: no Secure`);
  if (!attrs.includes("httponly")) problems.push(`cookie ${name}: no HttpOnly`);
  if (!attrs.some((a) => a === "samesite=strict" || a === "samesite=lax")) problems.push(`cookie ${name}: SameSite is not Strict or Lax`);
  if (!attrs.includes("path=/")) problems.push(`cookie ${name}: Path is not /`);
  if (attrs.some((a) => a.startsWith("domain="))) problems.push(`cookie ${name}: has a Domain`);
  return problems;
}

/** Every rule the response breaks (empty: it passes). */
export function checkProbe(probe: Probe): string[] {
  const { host, response } = probe;
  const problems: string[] = [];
  const one = (name: string): string | undefined => {
    const values = all(response, name);
    if (values.length !== 1) problems.push(`${name}: ${String(values.length)} headers, want exactly 1`);
    return values[0];
  };
  if (probe.expectedStatus !== null && response.status !== probe.expectedStatus) problems.push(`status ${String(response.status)}, want ${String(probe.expectedStatus)}`);

  const hsts = one("strict-transport-security");
  if (hsts !== undefined) {
    const want = host === "lp" ? "max-age=31536000" : "max-age=31536000; includeSubDomains";
    if (hsts !== want) problems.push(`strict-transport-security "${hsts}", want "${want}"`);
  }
  const nosniff = one("x-content-type-options");
  if (nosniff !== undefined && nosniff.toLowerCase() !== "nosniff") problems.push(`x-content-type-options "${nosniff}"`);
  const referrer = one("referrer-policy");
  if (referrer !== undefined) {
    if (host === "order" && referrer !== "strict-origin") problems.push(`referrer-policy "${referrer}", want strict-origin on the order origin`);
    else if (probe.expectedReferrer !== undefined && referrer !== probe.expectedReferrer) problems.push(`referrer-policy "${referrer}", want this route's own "${probe.expectedReferrer}"`);
    else if (!STRICT_REFERRER.has(referrer)) problems.push(`referrer-policy "${referrer}" is not one of ${[...STRICT_REFERRER].join(", ")}`);
  }
  for (const leak of ["server", "x-powered-by", "x-aspnet-version", "x-middleware-rewrite", "x-nextjs-rewritten-path", "x-nextjs-rewritten-query"]) {
    if (all(response, leak).length > 0) problems.push(`${leak} must not be sent`);
  }
  for (const acao of all(response, "access-control-allow-origin")) {
    if (acao === "*" && host !== "sdk") problems.push("access-control-allow-origin: * outside the SDK files");
  }
  if (all(response, "access-control-allow-credentials").length > 0) problems.push("access-control-allow-credentials must never be sent");

  const cookies = all(response, "set-cookie");
  if (!COOKIE_HOSTS.has(host) && cookies.length > 0) problems.push(`set-cookie on the ${host} host (${String(cookies.length)})`);
  else for (const cookie of cookies) problems.push(...checkCookie(cookie));

  // The global minimum (ASVS V3.4.3, V3.4.6) on every response of our own hosts, whatever its type: the edge adds
  // `frame-ancestors 'none'; object-src 'none'; base-uri 'none'` (infra/caddy/Caddyfile app_headers).
  if (host !== "lp") {
    const global = all(response, "content-security-policy")
      .map(parseCsp)
      .some((p) => ["frame-ancestors", "object-src", "base-uri"].every((d) => (p.get(d) ?? []).join(" ") === "'none'"));
    if (!global) problems.push("no CSP with frame-ancestors, object-src and base-uri 'none' (the edge's global policy)");
  }
  const type = (all(response, "content-type")[0] ?? "").toLowerCase();
  const cacheControl = all(response, "cache-control").join(", ").toLowerCase();
  if (type.startsWith("text/html")) {
    const policies = all(response, "content-security-policy").map(parseCsp);
    if (policies.length === 0) problems.push("HTML without an enforced Content-Security-Policy");
    const ancestors = policies.flatMap((p) => p.get("frame-ancestors") ?? []);
    const elements = policies.map(elementSources).filter((s): s is string[] => s !== undefined);
    const scripts = policies.flatMap(scriptLists);
    if (scripts.length === 0) problems.push("no CSP restricts scripts (script-src or default-src)");
    if (scripts.some((s) => s.includes("'unsafe-eval'"))) problems.push("CSP allows 'unsafe-eval' for scripts");
    if (!policies.some((p) => (p.get("object-src") ?? []).join(" ") === "'none'")) problems.push("CSP has no object-src 'none'");
    if (APP_HOSTS.has(host)) {
      if (!elements.some((s) => s.some((source) => NONCE.test(source)))) problems.push("CSP script-src has no per-request nonce");
      if (scripts.some((s) => s.includes("'unsafe-inline'"))) problems.push("CSP allows 'unsafe-inline' for scripts");
      if (!ancestors.includes("'none'")) problems.push("CSP has no frame-ancestors 'none'");
      if (!policies.some((p) => ["'none'", "'self'"].includes((p.get("base-uri") ?? []).join(" ")))) problems.push("CSP has no base-uri 'none' or 'self'");
      const xfo = one("x-frame-options");
      if (xfo !== undefined && xfo.toUpperCase() !== "DENY") problems.push(`x-frame-options "${xfo}", want DENY`);
      if (!cacheControl.includes("no-store")) problems.push(`cache-control "${cacheControl}" has no no-store`);
      if (one("cross-origin-opener-policy") !== "same-origin") problems.push("cross-origin-opener-policy is not same-origin");
      const permissions = one("permissions-policy") ?? "";
      for (const feature of ["camera=()", "microphone=()", "geolocation=()"]) if (!permissions.includes(feature)) problems.push(`permissions-policy lacks ${feature}`);
      if (host === "admin" && one("cross-origin-resource-policy") !== "same-origin") problems.push("cross-origin-resource-policy is not same-origin on admin");
    } else if (host === "lp") {
      if (!ancestors.includes("'self'") && !ancestors.includes("'none'")) problems.push("LP CSP has no frame-ancestors 'self' or 'none'");
    } else {
      problems.push(`HTML from the ${host} host`);
    }
  } else if (type.startsWith("application/json")) {
    if (!cacheControl.includes("no-store")) problems.push(`JSON with cache-control "${cacheControl}", want no-store`);
  }
  if (host === "sdk" && response.status === 200) {
    if (one("access-control-allow-origin") !== "*") problems.push("SDK file without access-control-allow-origin: *");
    if (one("cross-origin-resource-policy") !== "cross-origin") problems.push("SDK file without cross-origin-resource-policy: cross-origin");
  }
  return problems;
}

/** The nonces of a response's CSP script sources. */
export function noncesOf(response: Answer): string[] {
  return all(response, "content-security-policy")
    .map(parseCsp)
    .flatMap((p) => elementSources(p) ?? [])
    .filter((source) => NONCE.test(source));
}

/** Two loads of one page must carry different nonces (a fixed nonce is no protection). */
export function checkFreshNonce(first: Answer, second: Answer): string[] {
  const a = noncesOf(first);
  const b = noncesOf(second);
  if (a.length === 0 || b.length === 0) return ["no nonce to compare"];
  return a.some((nonce) => b.includes(nonce)) ? ["the same CSP nonce on two loads"] : [];
}
