// OTP and rate-limit parameters (AC-A3; US-018): the otp.* and orders.* keys of app_settings
// (seeded by packages/db sql/seed.sql). Owner only (app_settings.edit, owner decision 2026-11-18),
// each change audited with before / after values.
//
// Every value is a whole number inside the bounds of @ebooktrivia/db APP_SETTING_BOUNDS, the one
// table the database's app_settings_bounds_check is built from too (security review US-018 L4), so
// no writer, admin_rw included, stores a value outside them, and it always passes
// app_settings_positive_int_check. What reads them in SQL keeps working: enqueue_otp
// (otp.phone_cap, otp.phone_window_seconds), the player_otps trigger, which clamps a new code's
// expires_at to otp.code_ttl_seconds (codes already issued keep their expiry), and the orders
// checkout guard (orders.expiry_seconds). The rest is read by the public app (M6 / M9).
// Bounds (chosen for a WhatsApp OTP and a Midtrans Snap checkout):
//   otp.code_ttl_seconds      60..900      code validity (default 300 = 5 min)
//   otp.max_attempts          1..5         wrong codes before a code is void (5, the spec's)
//   otp.phone_cap             1..10        codes sent per phone per window (3)
//   otp.phone_window_seconds  3600..86400  that window (3600: never shorter than the spec's hour)
//   otp.ip_cap                1..100       code requests per IP per window (10)
//   otp.ip_window_seconds     600..86400   that window (3600)
//   otp.cooldown_seconds      15..600      wait before asking for another code (60); must be
//                                          shorter than the code validity (checked here only:
//                                          it spans two rows)
//   orders.expiry_seconds     900..86400   unpaid order / Snap page expiry (86400 = 24 h, AC-S8)
import { APP_SETTING_BOUNDS } from "@ebooktrivia/db";
import type { AuditRecorder, FieldKind, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { formValue, InvalidInput, wholeNumber } from "./fields.ts";

type LimitKey = keyof typeof APP_SETTING_BOUNDS;

export interface LimitSpec {
  readonly key: LimitKey;
  /** The form field name. */
  readonly field: string;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

const limit = (key: LimitKey, field: string, label: string, unit: string, fallback: number): LimitSpec => ({
  key,
  field,
  label,
  unit,
  min: APP_SETTING_BOUNDS[key][0],
  max: APP_SETTING_BOUNDS[key][1],
  fallback,
});

export const LIMITS: readonly LimitSpec[] = [
  limit("otp.code_ttl_seconds", "codeTtlSeconds", "OTP code validity", "seconds", 300),
  limit("otp.max_attempts", "maxAttempts", "Wrong codes before a code is void", "attempts", 5),
  limit("otp.phone_cap", "phoneCap", "Codes per phone number per window", "codes", 3),
  limit("otp.phone_window_seconds", "phoneWindowSeconds", "Phone window", "seconds", 3600),
  limit("otp.ip_cap", "ipCap", "Code requests per IP address per window", "requests", 10),
  limit("otp.ip_window_seconds", "ipWindowSeconds", "IP window", "seconds", 3600),
  limit("otp.cooldown_seconds", "cooldownSeconds", "Wait before another code", "seconds", 60),
  limit("orders.expiry_seconds", "orderExpirySeconds", "Unpaid order and payment page expiry", "seconds", 86_400),
];

export const LIMIT_FIELDS: readonly string[] = LIMITS.map((l) => l.field);
const SETTING_FIELDS: Readonly<Record<string, FieldKind>> = { value: "value" };

export type Limits = Readonly<Record<string, number>>;

/** Every limit from the form (all required, each within its bounds). */
export function parseLimits(form: FormData): Limits {
  const values: Record<string, number> = {};
  for (const l of LIMITS) {
    values[l.key] = wholeNumber(formValue(form, l.field), `${l.label}: a whole number from ${l.min.toLocaleString("en-US")} to ${l.max.toLocaleString("en-US")} ${l.unit}.`, l);
  }
  if ((values["otp.cooldown_seconds"] ?? 0) >= (values["otp.code_ttl_seconds"] ?? 0)) {
    throw new InvalidInput("The wait before another code must be shorter than the code validity.");
  }
  return values;
}

/** The stored values (a missing or malformed one shows its seeded default). */
export async function getLimits(sql: Sql | Tx, lock = false): Promise<Limits> {
  const keys = LIMITS.map((l) => l.key);
  const rows = lock
    ? await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings WHERE key = ANY (${keys}) FOR UPDATE`
    : await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings WHERE key = ANY (${keys})`;
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(LIMITS.map((l) => [l.key, Number.isSafeInteger(byKey.get(l.key)) ? (byKey.get(l.key) as number) : l.fallback]));
}

async function put(tx: Tx, audit: AuditRecorder, adminUserId: string, key: string, before: number, after: number): Promise<void> {
  await tx`
    INSERT INTO public.app_settings (key, value, updated_by_admin_user_id, updated_at)
    VALUES (${key}, ${tx.json(after)}, ${adminUserId}, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
  audit({ action: "app_setting.update", entityType: "app_setting", entityId: key, fields: SETTING_FIELDS, before: { value: before }, after: { value: after } });
}

/** Saves the changed limits; returns how many changed. */
export async function saveLimits(sql: Sql, adminUserId: string, next: Limits): Promise<number> {
  return auditedChange(sql, async (tx, audit) => {
    const current = await getLimits(tx, true);
    let changed = 0;
    for (const l of LIMITS) {
      const before = current[l.key] ?? l.fallback;
      const after = next[l.key] ?? before;
      if (after === before) continue;
      await put(tx, audit, adminUserId, l.key, before, after);
      changed++;
    }
    if (changed === 0) throw new InvalidInput("Nothing changed.");
    return changed;
  });
}
