// The wire contract between the landing-page SDK (packages/sdk, US-019, M6a) and the public API
// (checkout US-020, visit + config US-024). TYPES and field limits only: no runtime logic, no
// imports, so the SDK bundle (no zod, no node:* modules) and the API both import this one file
// (`@ebooktrivia/core/sdk-contract`). The SDK validates responses by hand against these shapes;
// the API validates requests with its own schema built from the same limits. The prose version
// of this contract is packages/sdk/README.md.
//
// Every body is JSON, snake_case, and carries the wire version `v` (always 1 here). A breaking
// change adds /api/v2 and a new sdk/v2.js alias; `sdk/v1.js` keeps speaking v1.
//
// Attribution is best effort: the SDK already drops a malformed or over-long value, and the API
// DROPS any it still receives (wrong shape, too long, unknown key, an adnet that is not allowed
// for the page) and carries on. A bad attribution value never rejects a checkout: an order is
// worth more than its click id, and it simply counts as organic.
//
// The page's registered origin is `https://` + a host of lp_domains; the SDK itself only runs from
// an https API origin (loopback over http for tests).
//
// The SDK runs on third-party origins, so every request is sent with `credentials: "omit"`, and the
// API answers CORS only for the exact origin registered for the landing page (`Origin` header),
// without `Access-Control-Allow-Credentials`. The server stays the authority on every field.

export const SDK_WIRE_VERSION = 1 as const;

/** Path templates, relative to `https://api.<DOMAIN>`; `{lp_key}` is the `data-lp` value of the snippet. */
export const SDK_ROUTES = {
  /** GET: what the SDK needs to know about the landing page. */
  config: "/api/v1/lp/{lp_key}/config",
  /** POST: the visit beacon. */
  visit: "/api/v1/visit/{lp_key}",
  /** POST: the Cap challenge / redeem endpoints (the Cap widget appends `challenge` or `redeem`). */
  capBase: "/api/v1/cap/{lp_key}/",
  /** POST: create (or dedupe) the order and its Snap payment. */
  checkout: "/api/v1/checkout/{lp_key}",
} as const;

/**
 * Pattern SOURCES (anchored RegExp source strings, so this file stays free of runtime logic); every
 * consumer builds its own RegExp from them: the SDK, the API and the admin console's pixel check.
 */
export const SDK_PATTERNS = {
  /** The `data-lp` value (landing_pages_lp_key_check). */
  lpKey: "^lp_[0-9A-Za-z]{8,40}$",
  /** A LOWERCASE UUID, as PostgreSQL prints it: `visit_id` and `event_id`. */
  uuid: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  /** An adnet slug (adnets_slug_check) and a program slug. */
  slug: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  /** An adnet's click-id URL parameter name (adnets_clickid_param_check). */
  clickidParam: "^[A-Za-z0-9_.-]{1,64}$",
  /**
   * Words no click-id parameter name may have (flags `i`): personal data in Indonesian and English, and
   * credentials. WHOLE words only: a word is delimited by `_`, `.`, `-` or the start or end of the name,
   * so `no_hp`, `phone_number`, `kode_otp`, `e-mail` and `session_id` are refused but `swap_id`,
   * `shpclid`, `ad_wave`, `gwa` and `hpid` are not. The delimiters are spelled out (no `\b`, which means
   * something else in PostgreSQL) so that this RegExp and the Postgres `~*` of the CHECK on
   * adnets.clickid_param behave identically. An adnet's click-id parameter name is admin-configured, and
   * the SDK would otherwise capture, store and send whatever that parameter carries: a name like `email`
   * would put the buyer's address in the click id. The admin console and that CHECK refuse such names.
   */
  personalParamName:
    "(^|[_.-])(phone|hp|wa|whatsapp|nama|name|email|mail|token|otp|kode|nik|ktp|card|kartu|pass|password|pwd|secret|auth|session)($|[_.-])",
  /** Browser pixel ids, each in its vendor's format. */
  metaPixel: "^[0-9]{10,20}$",
  tiktokPixel: "^[A-Z0-9]{16,32}$",
  googleAds: "^AW-[0-9]{6,15}$",
  /** Click ids, sub_id, pub and the ad platforms' ids: printable ASCII without spaces. */
  token: "^[\\x21-\\x7e]+$",
  /** UTM values may hold any text but these (control, format incl. bidi, surrogate, private-use, unassigned); flags `u`. */
  labelForbidden: "[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}]",
  /** Meta's browser id cookies. */
  fbp: "^fb\\.[0-9]{1,2}\\.[0-9]{10,16}\\.[0-9]{1,24}$",
  fbc: "^fb\\.[0-9]{1,2}\\.[0-9]{10,16}\\.[\\x21-\\x7e]+$",
} as const;

/** Maximum lengths (UTF-16 code units, after trimming) of every client-supplied value. */
export const SDK_LIMITS = {
  /** The `data-lp` value, `lp_` + 8..40 base62 characters (landing_pages_lp_key_check). */
  lpKeyMax: 43,
  name: 120,
  email: 254,
  /** What the visitor typed; the E.164 form the SDK sends is at most 14 characters. */
  phone: 32,
  capToken: 256,
  /** An adnet slug (adnets_slug_check) and the adnet's click-id parameter name (adnets_clickid_param_check). */
  adnetSlug: 64,
  clickidParam: 64,
  clickid: 256,
  subId: 256,
  pub: 256,
  utm: 256,
  fbclid: 512,
  gclid: 512,
  ttclid: 512,
  fbp: 128,
  /** `fb.1.<13-digit ms>.<fbclid>`. */
  fbc: 544,
  /** Policy versions are small positive integers (legal_pages_version_check). */
  policyVersionMax: 1_000_000,
  /** What the SDK accepts in a response: the price in IDR, the adnets of a config, any URL. */
  valueIdrMax: 10_000_000_000,
  adnetsMax: 100,
  urlMax: 2048,
} as const;

/**
 * Attribution captured from the landing URL / cookies (orders and visits attribution columns).
 * Every value is optional and best effort: the API drops what it does not like (see the top).
 */
export interface SdkAttribution {
  /** Slug of the adnet whose click-id parameter was present; must be allowed for the landing page. */
  readonly adnet?: string;
  readonly clickid?: string;
  readonly sub_id?: string;
  readonly pub?: string;
  readonly utm_source?: string;
  readonly utm_medium?: string;
  readonly utm_campaign?: string;
  readonly utm_content?: string;
  readonly utm_term?: string;
  readonly fbclid?: string;
  /** The `_fbp` cookie of the landing page. */
  readonly fbp?: string;
  /** The `_fbc` cookie, or `fb.1.<ms>.<fbclid>` built from `fbclid` when the cookie is absent. */
  readonly fbc?: string;
  readonly ttclid?: string;
  readonly gclid?: string;
}

/** GET {config}: public, cacheable for a short time (Cache-Control: public, max-age=60). */
export interface SdkLpConfig {
  readonly v: 1;
  readonly lp_key: string;
  /** False when the landing page is inactive, sales are closed (AC-S8) or no legal page is published. */
  readonly checkout_open: boolean;
  /** The adnets allowed on this landing page, with their click-id URL parameter names. */
  readonly adnets: readonly { readonly slug: string; readonly clickid_param: string }[];
  /** Browser pixel ids registered for the page; a missing key means "not used". */
  readonly pixels: { readonly meta?: string; readonly tiktok?: string; readonly gtag?: string };
  /** Which Snap host `snap_redirect_url` must be on: app.sandbox.midtrans.com or app.midtrans.com. */
  readonly midtrans_env: "sandbox" | "production";
  /**
   * The program's newest published legal pages, linked from the consent checkbox as
   * `<play_origin>/legal/<program>/<kind>/<version>`; null when none is published.
   */
  readonly legal: {
    /** `https://play.<DOMAIN>`: the SDK refuses any other host than `play.` on the API's own domain. */
    readonly play_origin: string;
    /** The program slug. */
    readonly program: string;
    readonly terms: number;
    readonly privacy: number;
  } | null;
}

/**
 * POST {visit}: sent once per page load, after the config is known, `keepalive`, fire and forget.
 * The API answers 200 with `SdkVisitResponse` or 204 with no body. Any other status, a timeout or a
 * network failure is ignored by the SDK: it never blocks or delays the page, never retries, and the
 * checkout then goes out without `visit_id`. So the endpoint must be cheap, and a sale never depends on it.
 */
export interface SdkVisitRequest {
  readonly v: 1;
  /** The stored click if the URL carries none; the URL's own click otherwise. */
  readonly attribution: SdkAttribution;
}
export interface SdkVisitResponse {
  readonly v: 1;
  /** A lowercase UUID (`SDK_PATTERNS.uuid`); the SDK ignores anything else. */
  readonly visit_id: string;
}

/** The consent of AC-A10 (UU PDP): the exact policy versions the buyer accepted. */
export interface SdkConsent {
  readonly terms: number;
  readonly privacy: number;
}

/** POST {checkout}. The price is never sent (AC-S5): the server computes it. */
export interface SdkCheckoutRequest {
  readonly v: 1;
  readonly name: string;
  /** E.164, normalised by the SDK for feedback; the server normalises it again. */
  readonly phone: string;
  readonly email: string;
  /** A solved Cap token (single use). */
  readonly cap_token: string;
  readonly consent: SdkConsent;
  readonly attribution: SdkAttribution;
  /** The lowercase-UUID id the visit beacon returned, when it succeeded. */
  readonly visit_id?: string;
}

/** 200. `deduped` is true when an open order for the same phone and landing page was reused (AC-T8). */
export interface SdkCheckoutResponse {
  readonly v: 1;
  /** A lowercase UUID (`SDK_PATTERNS.uuid`), shared with the server-side conversions for dedupe; the only id the browser pixels may use. */
  readonly event_id: string;
  /** https URL on the Snap host of `midtrans_env`; the SDK refuses anything else. */
  readonly snap_redirect_url: string;
  /** Price in IDR, for the pixel event value. */
  readonly value_idr: number;
  readonly deduped: boolean;
}

export type SdkFieldErrors = {
  readonly name?: "required" | "too_long";
  readonly phone?: "empty" | "invalid_characters" | "not_indonesian" | "not_mobile" | "invalid_length";
  readonly email?: "required" | "invalid";
  /** `outdated`: a newer policy version was published since the SDK read the config. */
  readonly consent?: "required" | "outdated";
};
/** The form fields an error can name. */
export type SdkField = keyof SdkFieldErrors;

/**
 * Error bodies, with the HTTP status the API uses:
 *   400 validation (with `fields`), 403 captcha (missing, invalid or reused Cap token) or origin
 *   (the Origin is not registered for the page; no CORS headers are sent, so the SDK sees a
 *   network error instead), 409 sales_closed, 429 rate_limited, 502 gateway (Snap failed; the
 *   same phone may retry), 503 unavailable.
 */
export type SdkErrorCode = "validation" | "captcha" | "origin" | "sales_closed" | "rate_limited" | "gateway" | "unavailable";
export interface SdkErrorBody {
  readonly v: 1;
  readonly error: SdkErrorCode;
  readonly fields?: SdkFieldErrors;
}
