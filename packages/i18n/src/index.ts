import en from "../messages/en.json" with { type: "json" };
import id from "../messages/id.json" with { type: "json" };

/** Buyer-facing surfaces default to Bahasa Indonesia; admin uses English. */
export const BUYER_LOCALE = "id" as const;
export const ADMIN_LOCALE = "en" as const;

export type Locale = typeof BUYER_LOCALE | typeof ADMIN_LOCALE;

export const messages = { id, en } as const;
