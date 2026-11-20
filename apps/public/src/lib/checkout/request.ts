// The checkout request (POST /api/v1/checkout/{lp_key}, SdkCheckoutRequest), validated against the
// shared contract (@ebooktrivia/core/sdk-contract SDK_LIMITS / SDK_PATTERNS) with zod. The server is
// the authority (AC-S4): every field is checked again here, whatever the SDK did.
//
//   - name / phone / email / consent: a bad value is a 400 `validation` with the contract's field
//     codes (`fields`), the same codes the SDK maps to Bahasa Indonesia messages;
//   - cap_token: missing or malformed is a 403 `captcha` (it is verified later, single use);
//   - attribution and visit_id are BEST EFFORT and never fail a checkout: a value of the wrong shape or
//     length, or an unknown key, is dropped (sanitizeAttribution), an invalid visit_id is ignored.
import { type IdMobileE164, normalizeIdMobile } from "@ebooktrivia/core/phone";
import { SDK_LIMITS, SDK_PATTERNS, type SdkAttribution, type SdkConsent, type SdkField, type SdkFieldErrors } from "@ebooktrivia/core/sdk-contract";
import { z } from "zod";

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const HAS_CONTROL = /[\p{Cc}\p{Cf}]/u;
const NAME_FILLER = new RegExp(SDK_PATTERNS.nameFiller, "gu");
const NOT_TEXT = new RegExp(SDK_PATTERNS.labelForbidden, "u");
/** The SDK's own e-mail shape (packages/sdk validate.ts). */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const UUID = new RegExp(SDK_PATTERNS.uuid);

/**
 * A name as it is stored (and, lowercased, compared by the buyer key): invisible fillers, control and
 * format characters become spaces, whitespace runs one space, trimmed. The same rule as the SDK's.
 */
export const normalizeName = (raw: string): string => raw.replace(NAME_FILLER, " ").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();

const policyVersion = z.number().int().min(1).max(SDK_LIMITS.policyVersionMax);

const schema = z.object({
  v: z.literal(1),
  name: z
    .string({ error: "required" })
    .transform(normalizeName)
    // A lone surrogate, a private-use or an unassigned code point is not a name (security review P2-C).
    .pipe(z.string().refine((value) => !NOT_TEXT.test(value), { error: "required" }).min(1, { error: "required" }).max(SDK_LIMITS.name, { error: "too_long" })),
  phone: z.string({ error: "empty" }).transform((raw, ctx) => {
    const result = normalizeIdMobile(raw);
    if (result.ok) return result.e164;
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  }),
  email: z
    .string({ error: "required" })
    .transform((raw) => raw.trim())
    .pipe(
      z
        .string()
        .min(1, { error: "required" })
        .refine((value) => !HAS_CONTROL.test(value), { error: "required" })
        .max(SDK_LIMITS.email, { error: "invalid" })
        .regex(EMAIL, { error: "invalid" }),
    ),
  cap_token: z.string().min(1).max(SDK_LIMITS.capToken),
  consent: z.object({ terms: policyVersion, privacy: policyVersion }, { error: "required" }),
  attribution: z.unknown().optional(),
  visit_id: z.unknown().optional(),
});

export interface CheckoutInput {
  readonly name: string;
  readonly phone: IdMobileE164;
  readonly email: string;
  readonly capToken: string;
  readonly consent: SdkConsent;
  /** Untrusted; see sanitizeAttribution. */
  readonly attribution: unknown;
  /** A lowercase UUID, or null (ignored when malformed). */
  readonly visitId: string | null;
}

export type ParsedCheckout =
  | { readonly kind: "ok"; readonly input: CheckoutInput }
  | { readonly kind: "invalid"; readonly fields?: SdkFieldErrors }
  | { readonly kind: "captcha" };

const FIELD_CODES: Readonly<Record<SdkField, readonly string[]>> = {
  name: ["required", "too_long"],
  phone: ["empty", "invalid_characters", "not_indonesian", "not_mobile", "invalid_length"],
  email: ["required", "invalid"],
  consent: ["required", "outdated"],
};
const FIELD_FALLBACK: Readonly<Record<SdkField, string>> = { name: "required", phone: "empty", email: "required", consent: "required" };
const isField = (key: unknown): key is SdkField => typeof key === "string" && key in FIELD_CODES;

export function parseCheckoutRequest(body: unknown): ParsedCheckout {
  const result = schema.safeParse(body);
  if (result.success) {
    const { data } = result;
    return {
      kind: "ok",
      input: {
        name: data.name,
        phone: data.phone,
        email: data.email,
        capToken: data.cap_token,
        consent: { terms: data.consent.terms, privacy: data.consent.privacy },
        attribution: data.attribution,
        visitId: typeof data.visit_id === "string" && UUID.test(data.visit_id) ? data.visit_id : null,
      },
    };
  }
  const fields: Record<string, string> = {};
  let captcha = false;
  let envelope = false;
  for (const issue of result.error.issues) {
    const [key] = issue.path;
    if (isField(key)) {
      // The first problem of a field names it; a nested consent problem is "required".
      if (fields[key] === undefined) fields[key] = FIELD_CODES[key].includes(issue.message) && issue.path.length === 1 ? issue.message : FIELD_FALLBACK[key];
    } else if (key === "cap_token") captcha = true;
    else envelope = true;
  }
  if (Object.keys(fields).length > 0) return { kind: "invalid", fields };
  if (envelope || !captcha) return { kind: "invalid" };
  return { kind: "captcha" };
}

// ---------------------------------------------------------------------------------------------
// Attribution: drop, never reject (contract top comment, README "Attribution").

type Shape = "token" | "label";
const TOKEN = new RegExp(SDK_PATTERNS.token);
const LABEL_FORBIDDEN = new RegExp(SDK_PATTERNS.labelForbidden, "u");
const SLUG = new RegExp(SDK_PATTERNS.slug);
const FBP = new RegExp(SDK_PATTERNS.fbp);
const FBC = new RegExp(SDK_PATTERNS.fbc);

const KEYS: readonly { readonly key: keyof SdkAttribution; readonly max: number; readonly shape: Shape; readonly pattern?: RegExp }[] = [
  { key: "adnet", max: SDK_LIMITS.adnetSlug, shape: "token", pattern: SLUG },
  { key: "clickid", max: SDK_LIMITS.clickid, shape: "token" },
  { key: "sub_id", max: SDK_LIMITS.subId, shape: "token" },
  { key: "pub", max: SDK_LIMITS.pub, shape: "token" },
  { key: "utm_source", max: SDK_LIMITS.utm, shape: "label" },
  { key: "utm_medium", max: SDK_LIMITS.utm, shape: "label" },
  { key: "utm_campaign", max: SDK_LIMITS.utm, shape: "label" },
  { key: "utm_content", max: SDK_LIMITS.utm, shape: "label" },
  { key: "utm_term", max: SDK_LIMITS.utm, shape: "label" },
  { key: "fbclid", max: SDK_LIMITS.fbclid, shape: "token" },
  { key: "fbp", max: SDK_LIMITS.fbp, shape: "token", pattern: FBP },
  { key: "fbc", max: SDK_LIMITS.fbc, shape: "token", pattern: FBC },
  { key: "ttclid", max: SDK_LIMITS.ttclid, shape: "token" },
  { key: "gclid", max: SDK_LIMITS.gclid, shape: "token" },
];

/** Values an affiliate passes through: never a contact detail (an e-mail address or an Indonesian mobile number). */
const CONTACT_CHECKED: ReadonlySet<keyof SdkAttribution> = new Set(["clickid", "sub_id", "pub"]);

function clean(raw: unknown, max: number, shape: Shape): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = shape === "label" ? raw.trim() : raw;
  if (value === "" || value.length > max) return undefined;
  if (shape === "token" ? !TOKEN.test(value) : LABEL_FORBIDDEN.test(value)) return undefined;
  return value;
}

export interface Attribution {
  /** The adnet, when its slug is allowed (active) for the landing page; null = organic. */
  readonly adnetId: string | null;
  readonly values: Readonly<Omit<Partial<Record<keyof SdkAttribution, string>>, "adnet">>;
}

/**
 * The attribution to store with the order: allowlisted keys with values in shape and length only. An
 * adnet the landing page does not allow makes the order organic: its slug and click id are dropped
 * (a click id is only meaningful with its adnet), the rest is kept.
 */
export function sanitizeAttribution(raw: unknown, allowedAdnets: ReadonlyMap<string, string>): Attribution {
  const values: Partial<Record<keyof SdkAttribution, string>> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const spec of KEYS) {
      const value = clean((raw as Record<string, unknown>)[spec.key], spec.max, spec.shape);
      if (value === undefined || (spec.pattern !== undefined && !spec.pattern.test(value))) continue;
      if (CONTACT_CHECKED.has(spec.key) && (value.includes("@") || normalizeIdMobile(value).ok)) continue;
      values[spec.key] = value;
    }
  }
  const adnetId = values.adnet === undefined ? undefined : allowedAdnets.get(values.adnet);
  delete values.adnet;
  if (adnetId === undefined) {
    delete values.clickid;
    return { adnetId: null, values };
  }
  return { adnetId, values };
}
