// Midtrans (AC-S10; US-017). Owner only (midtrans.edit: gateway secrets and fees).
//   - environment: sandbox or production (app_settings midtrans.environment). Switching to
//     production needs the production server key; every switch is audited (plan M11 go-live);
//   - enabled methods: the Snap `enabled_payments` codes offered to buyers (midtrans.enabled_methods);
//   - per-method gateway fee: flat whole rupiah + a percentage in basis points
//     (midtrans.fees = { method: { flat_idr, percent_bps } }, @ebooktrivia/core gatewayFeeIdr), for
//     the ROI report; the buyer always pays the product price;
//   - server keys: one per environment, sealed payment-scope secrets (midtrans.<env>.server_key).
//     A sandbox key must look like a sandbox key and a production key like a production key, so the
//     two cannot be swapped by mistake.
// None of these values is secret except the keys (public_rw reads app_settings).
import { BPS_PER_UNIT, MIDTRANS_METHODS, type MidtransMethod } from "@ebooktrivia/core";
import { SECRET_NAMES } from "@ebooktrivia/db";
import type postgres from "postgres";
import { type AuditRecorder, type FieldKind, type Tx, withAudit } from "../audit.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import type { Sql } from "../db.ts";
import type { SettingsConfig } from "./env.ts";
import { formValue, InvalidInput, wholeNumber } from "./fields.ts";
import { clearSecret, parseSecret, requireSealer, secretStatus, type SecretStatus, writeSecret } from "./secrets.ts";

export const MIDTRANS_ENVIRONMENTS = ["sandbox", "production"] as const;
export type MidtransEnvironment = (typeof MIDTRANS_ENVIRONMENTS)[number];

/** Snap enabled_payments codes offered in the console: one list in @ebooktrivia/core (unverified until US-005). */
export { MIDTRANS_METHODS, type MidtransMethod };
const METHOD_CODES: readonly string[] = MIDTRANS_METHODS.map((m) => m.code);

export const MAX_FLAT_FEE_IDR = 10_000_000;

export interface MethodFee {
  readonly flat_idr: number;
  readonly percent_bps: number;
}

export interface MidtransSettings {
  readonly environment: MidtransEnvironment;
  readonly enabledMethods: readonly MidtransMethod[];
  readonly fees: Readonly<Partial<Record<MidtransMethod, MethodFee>>>;
}

const SETTING_FIELDS: Readonly<Record<string, FieldKind>> = { value: "value" };
const KEY_PREFIX: Readonly<Record<MidtransEnvironment, RegExp>> = {
  sandbox: /^SB-Mid-server-[A-Za-z0-9_-]{8,120}$/,
  production: /^Mid-server-[A-Za-z0-9_-]{8,120}$/,
};

/** "0.7" -> 70 bp. Up to two decimals, 0 % .. 100 %; integer arithmetic only. */
export function percentToBps(raw: string): number {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(raw.trim() === "" ? "0" : raw.trim());
  if (match === null) throw new InvalidInput("A percentage fee is 0 to 100 with up to two decimals, e.g. 0.7.");
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > BPS_PER_UNIT) throw new InvalidInput("A percentage fee is 0 to 100 with up to two decimals, e.g. 0.7.");
  return bps;
}

export const bpsToPercent = (bps: number): string => `${String(Math.trunc(bps / 100))}${bps % 100 === 0 ? "" : `.${String(bps % 100).padStart(2, "0").replace(/0$/, "")}`}`;

/** Enabled methods and their fees from the form ("method:<code>", "flat:<code>", "percent:<code>"). */
export function parseMethodsAndFees(form: FormData): Pick<MidtransSettings, "enabledMethods" | "fees"> {
  const enabledMethods = MIDTRANS_METHODS.map((m) => m.code).filter((code) => form.get(`method:${code}`) === "on");
  if (enabledMethods.length === 0) throw new InvalidInput("Enable at least one payment method.");
  const fees: Partial<Record<MidtransMethod, MethodFee>> = {};
  for (const code of enabledMethods) {
    const flatRaw = formValue(form, `flat:${code}`).replace(/[.\s]/g, "");
    fees[code] = {
      flat_idr: wholeNumber(flatRaw === "" ? "0" : flatRaw, `The flat fee is 0 to ${MAX_FLAT_FEE_IDR.toLocaleString("en-US")} rupiah.`, { min: 0, max: MAX_FLAT_FEE_IDR }),
      percent_bps: percentToBps(formValue(form, `percent:${code}`)),
    };
  }
  return { enabledMethods, fees };
}

function parseStored(rows: readonly { key: string; value: unknown }[]): MidtransSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const env = byKey.get("midtrans.environment");
  const methods = byKey.get("midtrans.enabled_methods");
  const fees = byKey.get("midtrans.fees");
  const enabledMethods = Array.isArray(methods) ? methods.filter((m): m is MidtransMethod => typeof m === "string" && METHOD_CODES.includes(m)) : [];
  const parsedFees: Partial<Record<MidtransMethod, MethodFee>> = {};
  if (typeof fees === "object" && fees !== null) {
    for (const [code, fee] of Object.entries(fees as Record<string, unknown>)) {
      const f = fee as Partial<MethodFee> | null;
      if (METHOD_CODES.includes(code) && Number.isSafeInteger(f?.flat_idr) && Number.isSafeInteger(f?.percent_bps)) {
        parsedFees[code as MidtransMethod] = { flat_idr: f?.flat_idr ?? 0, percent_bps: f?.percent_bps ?? 0 };
      }
    }
  }
  return { environment: env === "production" ? "production" : "sandbox", enabledMethods, fees: parsedFees };
}

async function readSettings(sql: Sql | Tx, lock: boolean): Promise<MidtransSettings> {
  const rows = lock
    ? await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings WHERE key LIKE 'midtrans.%' FOR UPDATE`
    : await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM public.app_settings WHERE key LIKE 'midtrans.%'`;
  return parseStored(rows);
}

export const getMidtransSettings = (sql: Sql): Promise<MidtransSettings> => readSettings(sql, false);

async function putSetting(tx: Tx, audit: AuditRecorder, adminUserId: string, key: string, before: unknown, after: postgres.JSONValue): Promise<void> {
  await tx`
    INSERT INTO public.app_settings (key, value, updated_by_admin_user_id, updated_at)
    VALUES (${key}, ${tx.json(after)}, ${adminUserId}, clock_timestamp())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by_admin_user_id = EXCLUDED.updated_by_admin_user_id, updated_at = EXCLUDED.updated_at`;
  audit({ action: "app_setting.update", entityType: "app_setting", entityId: key, fields: SETTING_FIELDS, before: { value: before }, after: { value: after } });
}

export async function updateMethodsAndFees(sql: Sql, adminUserId: string, input: Pick<MidtransSettings, "enabledMethods" | "fees">): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await readSettings(tx, true);
    await putSetting(tx, audit, adminUserId, "midtrans.enabled_methods", before.enabledMethods, [...input.enabledMethods]);
    await putSetting(tx, audit, adminUserId, "midtrans.fees", before.fees, { ...input.fees });
  });
}

export async function setEnvironment(sql: Sql, adminUserId: string, environment: MidtransEnvironment): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await readSettings(tx, true);
    if (before.environment === environment) throw new InvalidInput(`Midtrans already runs in ${environment}.`);
    if (environment === "production") {
      const key = await secretStatus(tx, { scope: "payment", name: SECRET_NAMES.midtransServerKey("production"), adnetId: null });
      if (!key.set) throw new InvalidInput("Save the production server key before switching to production.");
    }
    await putSetting(tx, audit, adminUserId, "midtrans.environment", before.environment, environment);
  });
}

export function parseServerKey(environment: MidtransEnvironment, raw: string): string {
  const key = parseSecret(raw);
  if (!KEY_PREFIX[environment].test(key)) {
    throw new InvalidInput(environment === "sandbox" ? "A sandbox server key starts with SB-Mid-server-." : "A production server key starts with Mid-server- (not SB-Mid-server-).");
  }
  return key;
}

export async function setServerKey(sql: Sql, settings: SettingsConfig, environment: MidtransEnvironment, raw: string): Promise<void> {
  const sealer = requireSealer(settings, "payment");
  const key = parseServerKey(environment, raw);
  await auditedChange(
    sql,
    async (tx, audit) => {
      await writeSecret(tx, audit, sealer, { scope: "payment", name: SECRET_NAMES.midtransServerKey(environment), adnetId: null, boundHost: null }, key);
    },
    { "23505": CONCURRENT_SAVE },
  );
}

export async function clearServerKey(sql: Sql, environment: MidtransEnvironment): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const current = await readSettings(tx, true);
    if (current.environment === environment) throw new InvalidInput(`The ${environment} key is in use: switch environments before removing it.`);
    await clearSecret(tx, audit, { scope: "payment", name: SECRET_NAMES.midtransServerKey(environment), adnetId: null });
  });
}

export async function serverKeyStatuses(sql: Sql): Promise<Readonly<Record<MidtransEnvironment, SecretStatus>>> {
  return {
    sandbox: await secretStatus(sql, { scope: "payment", name: SECRET_NAMES.midtransServerKey("sandbox"), adnetId: null }),
    production: await secretStatus(sql, { scope: "payment", name: SECRET_NAMES.midtransServerKey("production"), adnetId: null }),
  };
}
