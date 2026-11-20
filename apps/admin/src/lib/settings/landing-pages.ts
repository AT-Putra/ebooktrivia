// Landing pages (AC-S1, AC-T5; US-017): the page, its program, allowed adnets, browser pixel ids,
// registered domains and the copy-paste snippet.
//   - create / program / active / allowed adnets: Owner (landing_page.settings.edit);
//   - name: Staff too (landing_page.content.edit);
//   - pixel ids: Owner (pixel.edit). They end up inside the order page's pixel scripts (M6), so they
//     are checked against each vendor's id format here and must be re-checked where they are used;
//   - domains: Owner (lp_domain.register, §10 item 18), checked by lp-domains.ts.
import { randomBytes } from "node:crypto";
import { type FieldKind, type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "./audited.ts";
import { InvalidInput, singleLine } from "./fields.ts";
import { checkLpDomain, LP_DOMAIN_MESSAGES } from "./lp-domains.ts";

const LP_FIELDS: Readonly<Record<string, FieldKind>> = { name: "value", program_id: "value", active: "value", adnet_ids: "value", lp_key: "value" };
const PIXEL_FIELDS: Readonly<Record<string, FieldKind>> = { meta: "value", tiktok: "value", gtag: "value", gtag_label: "value" };

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `lp_` + 24 random base62 characters (~142 bits); matches landing_pages_lp_key_check. */
export function newLpKey(): string {
  let key = "lp_";
  // Rejection sampling: bytes >= 248 would bias the first 62 * 4 = 248 values.
  while (key.length < 27) {
    for (const byte of randomBytes(32)) {
      if (byte < 248 && key.length < 27) key += BASE62.charAt(byte % 62);
    }
  }
  return key;
}

/** The snippet of AC-S1: the versioned SDK alias on the api origin (plan M6.1). */
export function snippet(domain: string, lpKey: string): string {
  return `<script src="https://api.${domain}/sdk/v1.js" data-lp="${lpKey}" async></script>`;
}

export const parseLpName = (raw: string): string => singleLine(raw, "Enter a name (up to 120 characters).", { max: 120 });

export interface Pixels {
  readonly meta: string | null;
  readonly tiktok: string | null;
  readonly gtag: string | null;
  readonly gtag_label: string | null;
}

const PIXEL_RULES: readonly { readonly key: keyof Pixels; readonly pattern: RegExp; readonly message: string }[] = [
  { key: "meta", pattern: /^[0-9]{10,20}$/, message: "The Meta pixel id is 10 to 20 digits." },
  { key: "tiktok", pattern: /^[A-Z0-9]{16,32}$/, message: "The TikTok pixel code is 16 to 32 capital letters and digits." },
  { key: "gtag", pattern: /^AW-[0-9]{6,15}$/, message: "The Google Ads id looks like AW-123456789." },
  { key: "gtag_label", pattern: /^[A-Za-z0-9_-]{4,64}$/, message: "The Google Ads conversion label is 4 to 64 letters, digits, - or _." },
];

/** Pixel ids from the form: empty is "not used"; anything else must match the vendor's format. */
export function parsePixels(values: Readonly<Record<keyof Pixels, string>>): Pixels {
  const out: Record<string, string | null> = {};
  for (const rule of PIXEL_RULES) {
    const value = values[rule.key].trim();
    if (value !== "" && !rule.pattern.test(value)) throw new InvalidInput(rule.message);
    out[rule.key] = value === "" ? null : value;
  }
  if ((out["gtag"] === null) !== (out["gtag_label"] === null)) throw new InvalidInput("Enter both the Google Ads id and its conversion label, or neither.");
  return out as unknown as Pixels;
}

const pixelsJson = (p: Pixels): Record<string, string> => Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => e[1] !== null));

export async function createLandingPage(sql: Sql, input: { readonly name: string; readonly programId: string }): Promise<string> {
  return auditedChange(
    sql,
    async (tx, audit) => {
      const values = { lp_key: newLpKey(), name: input.name, program_id: input.programId, active: true };
      const [row] = await tx<{ id: string }[]>`INSERT INTO public.landing_pages ${tx(values)} RETURNING id`;
      const id = row?.id ?? "";
      audit({ action: "landing_page.create", entityType: "landing_page", entityId: id, fields: LP_FIELDS, after: values });
      return id;
    },
    { "23503": "The chosen program does not exist." },
  );
}

async function lockLp(tx: Tx, id: string) {
  const [row] = await tx<{ name: string; program_id: string; active: boolean; pixels: Record<string, unknown> }[]>`
    SELECT name, program_id, active, pixels FROM public.landing_pages WHERE id = ${id} FOR UPDATE`;
  if (row === undefined) throw new InvalidInput("This landing page no longer exists.");
  return row;
}

export async function renameLandingPage(sql: Sql, id: string, name: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await lockLp(tx, id);
    await tx`UPDATE public.landing_pages SET name = ${name}, updated_at = clock_timestamp() WHERE id = ${id}`;
    audit({ action: "landing_page.rename", entityType: "landing_page", entityId: id, fields: LP_FIELDS, before: { name: before.name }, after: { name } });
  });
}

/** Owner: program, active, allowed adnets. The program cannot change once the page has orders. */
export async function updateLandingPageSettings(
  sql: Sql,
  id: string,
  input: { readonly programId: string; readonly active: boolean; readonly adnetIds: readonly string[] },
): Promise<void> {
  await auditedChange(
    sql,
    async (tx, audit) => {
      const before = await lockLp(tx, id);
      if (input.programId !== before.program_id) {
        const [orders] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.orders WHERE landing_page_id = ${id}`;
        if ((orders?.n ?? 0) > 0) throw new InvalidInput("This landing page has orders, so its program cannot change. Create a new landing page instead.");
      }
      const adnetsBefore = (await tx<{ adnet_id: string }[]>`SELECT adnet_id FROM public.landing_page_adnets WHERE landing_page_id = ${id} ORDER BY adnet_id`).map((r) => r.adnet_id);
      const adnetIds = [...new Set(input.adnetIds)].sort();
      await tx`UPDATE public.landing_pages SET program_id = ${input.programId}, active = ${input.active}, updated_at = clock_timestamp() WHERE id = ${id}`;
      await tx`DELETE FROM public.landing_page_adnets WHERE landing_page_id = ${id}`;
      if (adnetIds.length > 0) {
        await tx`INSERT INTO public.landing_page_adnets ${tx(adnetIds.map((adnet_id) => ({ landing_page_id: id, adnet_id })))}`;
      }
      audit({
        action: "landing_page.update",
        entityType: "landing_page",
        entityId: id,
        fields: LP_FIELDS,
        before: { program_id: before.program_id, active: before.active, adnet_ids: adnetsBefore },
        after: { program_id: input.programId, active: input.active, adnet_ids: adnetIds },
      });
    },
    { "23503": "The chosen program or adnet does not exist." },
  );
}

export async function updatePixels(sql: Sql, id: string, pixels: Pixels): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const before = await lockLp(tx, id);
    await tx`UPDATE public.landing_pages SET pixels = ${tx.json(pixelsJson(pixels))}, updated_at = clock_timestamp() WHERE id = ${id}`;
    const old = before.pixels;
    const pick = (key: string): string | null => (typeof old[key] === "string" ? old[key] : null);
    audit({
      action: "landing_page.pixels_update",
      entityType: "landing_page",
      entityId: id,
      fields: PIXEL_FIELDS,
      before: { meta: pick("meta"), tiktok: pick("tiktok"), gtag: pick("gtag"), gtag_label: pick("gtag_label") },
      after: { ...pixels },
    });
  });
}

/** Owner: registers a domain after the registrable-domain check. Caddy picks it up via NOTIFY. */
export async function registerDomain(sql: Sql, landingPageId: string, input: string, appDomain: string | null): Promise<string> {
  const checked = checkLpDomain(input, appDomain);
  if (!checked.ok) throw new InvalidInput(LP_DOMAIN_MESSAGES[checked.reason]);
  return auditedChange(
    sql,
    async (tx, audit) => {
      await lockLp(tx, landingPageId);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO public.lp_domains (landing_page_id, host) VALUES (${landingPageId}, ${checked.host}) RETURNING id`;
      audit({ action: "lp_domain.register", entityType: "lp_domain", entityId: row?.id ?? null, fields: { host: "value", landing_page_id: "value" }, after: { host: checked.host, landing_page_id: landingPageId } });
      return checked.host;
    },
    { "23505": "This domain is already registered.", "23514": LP_DOMAIN_MESSAGES.invalid },
  );
}

export async function removeDomain(sql: Sql, landingPageId: string, domainId: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const [row] = await tx<{ host: string }[]>`
      DELETE FROM public.lp_domains WHERE id = ${domainId} AND landing_page_id = ${landingPageId} RETURNING host`;
    if (row === undefined) throw new InvalidInput("This domain is no longer registered.");
    audit({ action: "lp_domain.remove", entityType: "lp_domain", entityId: domainId, fields: { host: "value", landing_page_id: "value" }, before: { host: row.host, landing_page_id: landingPageId }, after: null });
  });
}

export interface LandingPageRow {
  readonly id: string;
  readonly lpKey: string;
  readonly name: string;
  readonly programId: string;
  readonly programName: string;
  readonly active: boolean;
  readonly pixels: Pixels;
  readonly adnetIds: readonly string[];
  readonly domains: readonly { readonly id: string; readonly host: string }[];
}

export async function listLandingPages(sql: Sql): Promise<LandingPageRow[]> {
  const rows = await sql<{ id: string; lp_key: string; name: string; program_id: string; program_name: string; active: boolean; pixels: Record<string, unknown>; adnet_ids: string[]; domains: { id: string; host: string }[] }[]>`
    SELECT lp.id, lp.lp_key, lp.name, lp.program_id, p.name AS program_name, lp.active, lp.pixels,
           coalesce((SELECT array_agg(a.adnet_id ORDER BY a.adnet_id) FROM public.landing_page_adnets a WHERE a.landing_page_id = lp.id), '{}') AS adnet_ids,
           coalesce((SELECT json_agg(json_build_object('id', d.id, 'host', d.host) ORDER BY d.host) FROM public.lp_domains d WHERE d.landing_page_id = lp.id), '[]') AS domains
      FROM public.landing_pages lp JOIN public.programs p ON p.id = lp.program_id
     ORDER BY lp.created_at DESC`;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return rows.map((r) => ({
    id: r.id,
    lpKey: r.lp_key,
    name: r.name,
    programId: r.program_id,
    programName: r.program_name,
    active: r.active,
    pixels: { meta: str(r.pixels["meta"]), tiktok: str(r.pixels["tiktok"]), gtag: str(r.pixels["gtag"]), gtag_label: str(r.pixels["gtag_label"]) },
    adnetIds: r.adnet_ids,
    domains: r.domains,
  }));
}
