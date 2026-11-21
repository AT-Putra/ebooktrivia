// The browser pixels of a landing page (landing_pages.pixels, written by the admin console after it checked
// each id against the vendor's format) as the order page uses them: validated AGAIN against the same
// patterns (@ebooktrivia/core/sdk-contract SDK_PATTERNS) before an id reaches a CSP, a script URL or a
// browser, so a bad value in the database can never inject anything. A vendor with no valid id is not
// used and not allowed by the page's CSP. Google needs both the Ads id and the conversion label
// (the admin console refuses one without the other).
import { SDK_PATTERNS } from "@ebooktrivia/core/sdk-contract";

export const VENDORS = ["meta", "tiktok", "gtag"] as const;
export type Vendor = (typeof VENDORS)[number];

export interface PixelIds {
  readonly meta?: string;
  readonly tiktok?: string;
  readonly gtag?: string;
  /** The Google Ads conversion label; `gtag` and `gtag_label` go together. */
  readonly gtag_label?: string;
}

const META = new RegExp(SDK_PATTERNS.metaPixel);
const TIKTOK = new RegExp(SDK_PATTERNS.tiktokPixel);
const GOOGLE_ADS = new RegExp(SDK_PATTERNS.googleAds);
const GOOGLE_LABEL = /^[A-Za-z0-9_-]{4,64}$/;

const text = (value: unknown, pattern: RegExp): string | undefined => (typeof value === "string" && pattern.test(value) ? value : undefined);

/** The valid pixel ids of a `landing_pages.pixels` value; anything else in it is dropped. */
export function parsePixelIds(raw: unknown): PixelIds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const meta = text(Reflect.get(raw, "meta"), META);
  const tiktok = text(Reflect.get(raw, "tiktok"), TIKTOK);
  const gtag = text(Reflect.get(raw, "gtag"), GOOGLE_ADS);
  const label = text(Reflect.get(raw, "gtag_label"), GOOGLE_LABEL);
  return {
    ...(meta === undefined ? {} : { meta }),
    ...(tiktok === undefined ? {} : { tiktok }),
    ...(gtag === undefined || label === undefined ? {} : { gtag, gtag_label: label }),
  };
}

/** The vendors that have a usable id, in the fixed order of VENDORS. */
export const vendorsOf = (ids: PixelIds): Vendor[] => VENDORS.filter((vendor) => ids[vendor] !== undefined);
