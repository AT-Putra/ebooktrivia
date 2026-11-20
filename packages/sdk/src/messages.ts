// Buyer-facing copy: Bahasa Indonesia from packages/i18n (BUYER_LOCALE). Only the `sdk` section is
// imported (a named import of a JSON key, which the bundler tree-shakes), so the rest of the
// catalog stays out of the bundle.
import { sdk } from "@ebooktrivia/i18n/messages/id.json";

export const text = sdk;

/** Replaces `{name}` placeholders. */
export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
