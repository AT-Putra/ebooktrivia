// Attribution capture (AC-T1): the click id (under the adnet's own parameter name), the sub
// parameters, UTM, fbclid / ttclid / gclid and the Meta cookies, kept in localStorage for 30 days.
//
// Which visit replaces the stored record (owner decision O2, security review L2):
//   - a NEW AD CLICK ID replaces it, whole: the adnet's click id, fbclid, ttclid or gclid. The URL's
//     other allowlisted parameters (sub_id, pub, UTM) travel with that click, and an old sub id never
//     rides along with a new click id;
//   - anything else leaves it untouched: a plain revisit, a UTM-only or sub-only visit (a link with
//     ?utm_source=newsletter must not erase the affiliate click an ad brought the buyer here with).
//     When nothing is stored yet, such a visit's parameters are kept (first touch), so an organic
//     visitor's UTM still reaches the order; the next visit with the same shape does not replace it;
//   - the same click opened again (a reload of the landing URL) keeps its original time and is not
//     written again, so reloading never stretches the 30 days: a click is "the same" when every key
//     the URL carries is already stored with the same value (the stored record may hold more, such as
//     the adnet's click id resolved on the first load).
//
// The per-adnet click id is only known once the page's config has arrived, but the visitor may leave
// before that. So the fixed keys are captured at boot, and the URL's candidate parameters wait in
// sessionStorage (at most 3 loads of the tab, 30 minutes) until the config arrives and the click id
// is resolved; if it never arrives, a later load in the same tab resolves them. Which parameters may
// wait there is decided below ("Pending candidates"): by the adnets' own parameter names once an
// earlier load has learned them, by a personal-data filter on a first visit.
//
// Everything read here is hostile: the URL is typed by anybody, the stores can hold whatever a
// script or an extension wrote. Only allowlisted keys are read, every value has a length cap and a
// character class, malformed values are dropped, and nothing in this file throws (a missing, full,
// blocked or corrupted store behaves like an empty one). Written to storage: the click, the adnets'
// parameter names (not personal), and the parked candidates; never a name, phone number or e-mail
// address as such.
import { normalizeIdMobile } from "@ebooktrivia/core/phone";
import { SDK_LIMITS, SDK_PATTERNS, type SdkAttribution } from "@ebooktrivia/core/sdk-contract";

export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long candidate parameters wait in sessionStorage for the config to arrive. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

/** The part of Storage this module uses (a test passes a Map-backed fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AdnetParam {
  readonly slug: string;
  readonly clickid_param: string;
}

export interface AttributionDeps {
  readonly storage: KeyValueStore | null;
  /** sessionStorage: the short-lived copy of the URL's candidate parameters. */
  readonly session: KeyValueStore | null;
  /** Milliseconds since the epoch; injectable so the 30-day expiry is testable. */
  readonly now: () => number;
  /** `document.cookie`. */
  readonly cookie: string;
}

/** A captured click and the time it was captured at. */
export interface Click {
  readonly t: number;
  readonly a: SdkAttribution;
}

type Shape = "token" | "label";
interface UrlKey {
  readonly param: string;
  readonly key: keyof SdkAttribution;
  readonly max: number;
  readonly shape: Shape;
}

const TOKEN = new RegExp(SDK_PATTERNS.token);
const LABEL_FORBIDDEN = new RegExp(SDK_PATTERNS.labelForbidden, "u");
const SLUG = new RegExp(SDK_PATTERNS.slug);
const PARAM_NAME = new RegExp(SDK_PATTERNS.clickidParam);
const FBP = new RegExp(SDK_PATTERNS.fbp);
const FBC = new RegExp(SDK_PATTERNS.fbc);

const FIXED_URL_KEYS: readonly UrlKey[] = [
  { param: "sub_id", key: "sub_id", max: SDK_LIMITS.subId, shape: "token" },
  { param: "pub", key: "pub", max: SDK_LIMITS.pub, shape: "token" },
  { param: "utm_source", key: "utm_source", max: SDK_LIMITS.utm, shape: "label" },
  { param: "utm_medium", key: "utm_medium", max: SDK_LIMITS.utm, shape: "label" },
  { param: "utm_campaign", key: "utm_campaign", max: SDK_LIMITS.utm, shape: "label" },
  { param: "utm_content", key: "utm_content", max: SDK_LIMITS.utm, shape: "label" },
  { param: "utm_term", key: "utm_term", max: SDK_LIMITS.utm, shape: "label" },
  { param: "fbclid", key: "fbclid", max: SDK_LIMITS.fbclid, shape: "token" },
  { param: "ttclid", key: "ttclid", max: SDK_LIMITS.ttclid, shape: "token" },
  { param: "gclid", key: "gclid", max: SDK_LIMITS.gclid, shape: "token" },
];

/** Every key a stored record may hold; the cookie-derived fbp / fbc are never stored. */
const STORED_KEYS: readonly UrlKey[] = [
  { param: "adnet", key: "adnet", max: SDK_LIMITS.adnetSlug, shape: "token" },
  { param: "clickid", key: "clickid", max: SDK_LIMITS.clickid, shape: "token" },
  ...FIXED_URL_KEYS,
];

/** A value kept as it is when it is in shape and length, else undefined. Labels are trimmed. */
function clean(raw: string | null | undefined, max: number, shape: Shape): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = shape === "label" ? raw.trim() : raw;
  if (value === "" || value.length > max) return undefined;
  if (shape === "token" ? !TOKEN.test(value) : LABEL_FORBIDDEN.test(value)) return undefined;
  return value;
}

/** One stored value, re-validated on the way in from storage. */
function validated(key: keyof SdkAttribution, raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const spec = STORED_KEYS.find((k) => k.key === key);
  if (spec === undefined) return undefined;
  const value = clean(raw, spec.max, spec.shape);
  if (value === undefined) return undefined;
  if (key === "adnet" && !SLUG.test(value)) return undefined;
  // A stored click id that is a contact detail (a record written by an older build, or by something else) is never sent.
  return key === "clickid" && isContact(value) ? undefined : value;
}

/**
 * An e-mail address or an Indonesian mobile number: never a click id, whatever the parameter is called.
 * An adnet's click-id parameter name is admin-configured; the console and the database refuse names
 * like "email", but the SDK does not rely on that.
 */
function isContact(value: string): boolean {
  return value.includes("@") || normalizeIdMobile(value).ok;
}

/** A well-formed attribution object out of an untrusted one: allowlisted keys, valid values. */
function sanitize(raw: unknown): SdkAttribution {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const spec of STORED_KEYS) {
    const kept = validated(spec.key, (raw as Record<string, unknown>)[spec.key]);
    if (kept !== undefined) out[spec.key] = kept;
  }
  return out;
}

const hasAny = (a: SdkAttribution): boolean => Object.keys(a).length > 0;
/** An ad click id: the adnet's, fbclid, ttclid or gclid. The only thing that replaces a stored record. */
const hasClickId = (a: SdkAttribution): boolean => a.clickid !== undefined || a.fbclid !== undefined || a.ttclid !== undefined || a.gclid !== undefined;
const same = (a: SdkAttribution, b: SdkAttribution): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => (a as Record<string, string>)[k] === (b as Record<string, string>)[k]);
};

function searchParams(search: string): URLSearchParams | null {
  try {
    return new URLSearchParams(search);
  } catch {
    return null;
  }
}

/** The allowlisted parameters that need no config: sub_id, pub, UTM, fbclid, ttclid, gclid. */
export function parseFixed(search: string): SdkAttribution {
  const params = searchParams(search);
  const out: Record<string, string> = {};
  if (params === null) return out;
  for (const spec of FIXED_URL_KEYS) {
    const value = clean(params.get(spec.param), spec.max, spec.shape);
    if (value !== undefined) out[spec.key] = value;
  }
  return out;
}

/** The adnet whose own click-id parameter is among `candidates`; `adnet=<slug>` breaks a tie between adnets that share a name. */
function pickClickid(get: (name: string) => string | null | undefined, adnets: readonly AdnetParam[], wanted: string | undefined): { clickid: string; adnet: string } | undefined {
  const ordered = [...adnets].sort((a, b) => Number(b.slug === wanted) - Number(a.slug === wanted));
  for (const adnet of ordered) {
    const clickid = clean(get(adnet.clickid_param), SDK_LIMITS.clickid, "token");
    if (clickid !== undefined && !isContact(clickid)) return { clickid, adnet: adnet.slug };
  }
  return undefined;
}

/** The click carried by a URL query string once the config is known: the fixed keys plus the adnet's click id. */
export function parseClick(search: string, adnets: readonly AdnetParam[]): SdkAttribution {
  const out: Record<string, string> = { ...parseFixed(search) };
  const params = searchParams(search);
  if (params === null) return out;
  const picked = pickClickid((name) => params.get(name), adnets, validated("adnet", params.get("adnet")));
  if (picked !== undefined) {
    out["clickid"] = picked.clickid;
    out["adnet"] = picked.adnet;
  }
  return out;
}

// --- Pending candidates (sessionStorage) ------------------------------------------------------

// What may be parked: the URL's parameters that might be an adnet's click id, bounded and kept from
// carrying personal data (security review L1, code review MED).
//   - PRIMARY: when an earlier load of this landing page already learned the adnets' click-id
//     parameter names (cached in localStorage, they are not personal), ONLY a parameter with one of
//     those names is parked.
//   - FIRST VISIT, names unknown: a parameter is parked only if its name has none of a list of
//     personal-data words as a whole word (SDK_PATTERNS.personalParamName: delimited by _ . - or the
//     ends of the name, in Indonesian and English) and its value is token-shaped,
//     has no "@", has no run of 8 to 16 digits once separators are removed, and is not a phone number
//     the Indonesian normaliser accepts. This can miss a parameter named something else; it is the
//     fallback, and the entry lives only until the config arrives (usually milliseconds), 30 minutes
//     at most, or until the tab closes.
const PERSONAL_NAME_PART = new RegExp(SDK_PATTERNS.personalParamName, "i");
const PENDING_MAX_PAIRS = 6;
const PENDING_MAX_ENTRIES = 3;
const PENDING_MAX_CHARS = 2048;
const NOT_CANDIDATE = new Set([...FIXED_URL_KEYS.map((k) => k.param), "adnet"]);

interface PendingEntry {
  readonly t: number;
  /** `adnet=<slug>`, when the URL had a valid one. */
  readonly w: string | undefined;
  /** The URL's fixed keys (already validated). */
  readonly f: SdkAttribution;
  /** Candidate click-id parameters: [name, value] pairs. */
  readonly c: readonly (readonly [string, string])[];
}

/**
 * First visit only (names unknown): a value that looks like personal data. Beyond a contact detail, a
 * run of 8 to 16 digits once separators are removed (a phone, NIK or card number). That last rule is
 * not applied anywhere else, because some adnets use numeric click ids.
 */
function looksPersonal(value: string): boolean {
  return isContact(value) || /^[0-9]{8,16}$/.test(value.replace(/[^0-9A-Za-z]/g, ""));
}

function candidatesOf(params: URLSearchParams, names: ReadonlySet<string> | null): [string, string][] {
  const out: [string, string][] = [];
  let size = 0;
  for (const [name, raw] of params) {
    if (out.length >= PENDING_MAX_PAIRS) break;
    if (!PARAM_NAME.test(name) || NOT_CANDIDATE.has(name)) continue;
    if (names === null ? PERSONAL_NAME_PART.test(name) : !names.has(name)) continue;
    const value = clean(raw, SDK_LIMITS.clickid, "token");
    // Whichever path: an e-mail address or a mobile number is never parked, even under an adnet's own name.
    if (value === undefined || (names === null ? looksPersonal(value) : isContact(value))) continue;
    size += name.length + value.length + 6;
    if (size > PENDING_MAX_CHARS) break;
    out.push([name, value]);
  }
  return out;
}

const pendingKey = (lpKey: string): string => `ebt:cand:1:${lpKey}`;

function dropPending(deps: AttributionDeps, lpKey: string): void {
  try {
    deps.session?.removeItem(pendingKey(lpKey));
  } catch {
    // Nothing to remove.
  }
}

function writePending(deps: AttributionDeps, lpKey: string, entries: readonly PendingEntry[]): void {
  try {
    deps.session?.setItem(pendingKey(lpKey), JSON.stringify({ v: 1, e: entries.map((p) => ({ t: p.t, w: p.w ?? null, f: p.f, c: p.c })) }));
  } catch {
    // sessionStorage full or blocked: the click id is still resolved on this page load.
  }
}

/**
 * The parked entries of earlier loads in this tab, oldest first. An expired entry is dropped, and a
 * record that is malformed or has nothing valid left is removed.
 */
function readPending(deps: AttributionDeps, lpKey: string): PendingEntry[] {
  try {
    const raw = deps.session?.getItem(pendingKey(lpKey));
    if (raw === null || raw === undefined) return [];
    const value: unknown = raw.length > PENDING_MAX_CHARS * PENDING_MAX_ENTRIES * 2 ? undefined : JSON.parse(raw);
    const list = typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>)["v"] === 1 ? (value as Record<string, unknown>)["e"] : undefined;
    const entries: PendingEntry[] = [];
    if (Array.isArray(list)) {
      for (const item of list.slice(0, PENDING_MAX_ENTRIES) as unknown[]) {
        const entry = parsePendingEntry(item, deps.now());
        if (entry !== undefined) entries.push(entry);
      }
    }
    if (entries.length === 0) dropPending(deps, lpKey);
    else if (!Array.isArray(list) || entries.length !== list.length) writePending(deps, lpKey, entries);
    return entries;
  } catch {
    dropPending(deps, lpKey);
    return [];
  }
}

function parsePendingEntry(item: unknown, now: number): PendingEntry | undefined {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const { t, w, f, c } = item as Record<string, unknown>;
  if (typeof t !== "number" || !Number.isFinite(t) || !Array.isArray(c)) return undefined;
  const age = now - t;
  if (!(age >= -CLOCK_SKEW_MS && age < PENDING_TTL_MS)) return undefined;
  const pairs: [string, string][] = [];
  for (const pair of c.slice(0, PENDING_MAX_PAIRS) as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [name, val] = pair as unknown[];
    if (typeof name !== "string" || typeof val !== "string" || !PARAM_NAME.test(name) || clean(val, SDK_LIMITS.clickid, "token") === undefined) continue;
    pairs.push([name, val]);
  }
  return { t, w: validated("adnet", w), f: sanitize(f), c: pairs };
}

const sameEntry = (a: PendingEntry, b: PendingEntry): boolean => a.w === b.w && same(a.f, b.f) && JSON.stringify(a.c) === JSON.stringify(b.c);

// --- The adnets' click-id parameter names (localStorage) ---------------------------------------

const namesKey = (lpKey: string): string => `ebt:names:1:${lpKey}`;

/** The click-id parameter names the last config named (not personal data), or null when this page has not learned them (yet). */
function readNames(deps: AttributionDeps, lpKey: string): ReadonlySet<string> | null {
  const { storage } = deps;
  if (storage === null) return null;
  try {
    const raw = storage.getItem(namesKey(lpKey));
    if (raw === null) return null;
    const value: unknown = raw.length > MAX_RECORD_CHARS ? undefined : JSON.parse(raw);
    const { v, t, n } = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const age = typeof t === "number" ? deps.now() - t : Number.NaN;
    if (v !== 1 || !(age >= -CLOCK_SKEW_MS && age < ATTRIBUTION_TTL_MS) || !Array.isArray(n) || n.length > SDK_LIMITS.adnetsMax) {
      storage.removeItem(namesKey(lpKey));
      return null;
    }
    return new Set((n as unknown[]).filter((name): name is string => typeof name === "string" && PARAM_NAME.test(name)));
  } catch {
    // Not JSON, or the store threw: a broken record is removed so it cannot cost a read next time.
    try {
      storage.removeItem(namesKey(lpKey));
    } catch {
      // Nothing to remove.
    }
    return null;
  }
}

function rememberNames(deps: AttributionDeps, lpKey: string, adnets: readonly AdnetParam[]): void {
  try {
    deps.storage?.setItem(namesKey(lpKey), JSON.stringify({ v: 1, t: deps.now(), n: [...new Set(adnets.map((a) => a.clickid_param))] }));
  } catch {
    // Storage blocked: the next first visit falls back to the name filter.
  }
}

// --- Stored click (localStorage) --------------------------------------------------------------

const storageKey = (lpKey: string): string => `ebt:attr:1:${lpKey}`;
const MAX_RECORD_CHARS = 16_384;
const CLOCK_SKEW_MS = 60_000;

/** The stored click if it is still inside its 30 days and well formed, else null (and removed). */
function readStored(deps: AttributionDeps, lpKey: string): Click | null {
  const { storage } = deps;
  if (storage === null) return null;
  const key = storageKey(lpKey);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const record = raw.length > MAX_RECORD_CHARS ? undefined : parseRecord(raw);
    const age = record === undefined ? Number.NaN : deps.now() - record.t;
    if (record === undefined || !(age >= -CLOCK_SKEW_MS && age < ATTRIBUTION_TTL_MS)) {
      storage.removeItem(key);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function parseRecord(raw: string): Click | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { v, t, a } = value as Record<string, unknown>;
  if (v !== 1 || typeof t !== "number" || !Number.isFinite(t)) return undefined;
  const clean_ = sanitize(a);
  return hasAny(clean_) ? { t, a: clean_ } : undefined;
}

/** Stores a click as the new record (replacing the previous one whole); best effort. */
function store(deps: AttributionDeps, lpKey: string, click: Click): void {
  try {
    deps.storage?.setItem(storageKey(lpKey), JSON.stringify({ v: 1, t: click.t, a: click.a }));
  } catch {
    // Quota exceeded or storage blocked: the click still travels with this page's own requests.
  }
}

/** The value of a cookie in a `document.cookie` string. */
export function readCookie(cookie: string, name: string): string | undefined {
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The attribution to send: `click` (the click in effect for this page load; left out, the store is
 * read again) plus the Meta browser id cookies, read fresh (the pixel may set them after the click
 * was captured). `_fbc` is built from `fbclid` when the cookie is missing, in Meta's documented
 * `fb.1.<click ms>.<fbclid>` form.
 */
export function current(deps: AttributionDeps, lpKey: string, click?: Click | null): SdkAttribution {
  const base = click === undefined ? readStored(deps, lpKey) : click;
  const out: Record<string, string> = { ...base?.a };
  const fbp = readCookie(deps.cookie, "_fbp");
  if (fbp !== undefined && FBP.test(fbp) && fbp.length <= SDK_LIMITS.fbp) out["fbp"] = fbp;
  const fbc = readCookie(deps.cookie, "_fbc");
  if (fbc !== undefined && FBC.test(fbc) && fbc.length <= SDK_LIMITS.fbc) out["fbc"] = fbc;
  else if (base !== null && out["fbclid"] !== undefined) out["fbc"] = `fb.1.${String(base.t)}.${out["fbclid"]}`;
  return out;
}

// --- The two phases ----------------------------------------------------------------------------

export interface Capture {
  /** The click in effect for this page load (stored or new), null when there is none. */
  click(): Click | null;
  /** Once the config is known: resolves the adnet's click id, from this URL or from earlier loads that never got their config. */
  resolve(adnets: readonly AdnetParam[]): void;
}

/** True when every key of `next` is already in `stored` with the same value: the same click again. */
const covers = (stored: SdkAttribution, next: SdkAttribution): boolean => Object.keys(next).every((k) => (stored as Record<string, string>)[k] === (next as Record<string, string>)[k]);

/**
 * Called at boot, before the config: captures the fixed keys, applying the rule at the top of this
 * file, and parks the URL's candidate parameters for `resolve`.
 */
export function startCapture(deps: AttributionDeps, lpKey: string, search: string): Capture {
  const t = deps.now();
  const fixed = parseFixed(search);
  let click: Click | null = readStored(deps, lpKey);

  /**
   * `next` becomes the stored click, unless it is the same click again: every key of it is already
   * stored with the same value (the stored record may hold more, such as the adnet's click id resolved
   * on the first load). The same click keeps its first time and is not written again.
   */
  const apply = (next: Click): void => {
    const stored = readStored(deps, lpKey);
    if (stored !== null && covers(stored.a, next.a)) {
      click = stored;
      return;
    }
    store(deps, lpKey, next);
    click = next;
  };

  if (hasClickId(fixed) || (hasAny(fixed) && click === null)) apply({ t, a: fixed });

  const params = searchParams(search);
  const candidates = params === null ? [] : candidatesOf(params, readNames(deps, lpKey));
  if (params !== null && candidates.length > 0) {
    // Earlier loads of this tab whose config never arrived keep their parked click ids: this load adds to them.
    const earlier = readPending(deps, lpKey);
    const mine: PendingEntry = { t, w: validated("adnet", params.get("adnet")), f: fixed, c: candidates };
    if (!earlier.some((e) => sameEntry(e, mine))) writePending(deps, lpKey, [...earlier, mine].slice(-PENDING_MAX_ENTRIES));
  }

  return {
    click: () => click,
    resolve(adnets) {
      rememberNames(deps, lpKey, adnets);
      // Earlier loads of this tab, oldest first, so the newest click wins.
      for (const entry of readPending(deps, lpKey)) {
        const picked = pickClickid((name) => entry.c.find(([n]) => n === name)?.[1], adnets, entry.w);
        if (picked === undefined) continue;
        // Only a stored click id that is newer than this one stays; a stored first-touch UTM does not outrank an ad click.
        const stored = readStored(deps, lpKey);
        if (stored !== null && hasClickId(stored.a) && stored.t > entry.t) continue;
        apply({ t: entry.t, a: { ...entry.f, clickid: picked.clickid, adnet: picked.adnet } });
      }
      const live = parseClick(search, adnets);
      if (live.clickid !== undefined) apply({ t, a: live });
      dropPending(deps, lpKey);
    },
  };
}
