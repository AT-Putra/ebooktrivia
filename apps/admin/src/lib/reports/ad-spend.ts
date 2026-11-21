// Ad spend (AC-A8): what the Owner spent on Meta / TikTok / Google / elsewhere, entered by hand and subtracted in the ROI
// report. Owner only (ad_spend.edit, plan M5a: "ad spend" is beyond Staff's content, trivia, resends and reports).
// One row per day, platform and (optionally) landing page, adnet and campaign; whole rupiah. Every create, change and
// delete is audited (non-PII fields only). A row names at most what it knows: spend with no landing page or no adnet
// still counts in the ROI total and has a row of its own in the groupings (lib/reports/roi.ts).
import type { FieldKind, Tx } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange } from "../settings/audited.ts";
import { calendarDate, formValue, InvalidInput, optionalLine, uuid, wholeNumber } from "../settings/fields.ts";
import { idrOf, PAGE_SIZE } from "./common.ts";

export const AD_PLATFORMS = ["meta", "tiktok", "google", "other"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];
export const AD_PLATFORM_LABELS: Readonly<Record<AdPlatform, string>> = { meta: "Meta", tiktok: "TikTok", google: "Google", other: "Other" };

export const AD_SPEND_FORM_FIELDS = ["id", "spend_date", "platform", "landing_page_id", "adnet_id", "utm_campaign", "amount_idr", "note"] as const;

/** The most one row may hold (Rp 10 billion): a typo is caught here, not in the ROI. */
export const MAX_AD_SPEND_IDR = 10_000_000_000;

const FIELDS: Readonly<Record<string, FieldKind>> = {
  spend_date: "value",
  platform: "value",
  landing_page_id: "value",
  adnet_id: "value",
  utm_campaign: "value",
  amount_idr: "value",
  note: "value",
};

export interface AdSpendInput {
  readonly spendDate: string;
  readonly platform: AdPlatform;
  readonly landingPageId: string | null;
  readonly adnetId: string | null;
  readonly utmCampaign: string | null;
  readonly amountIdr: number;
  readonly note: string | null;
}

/** An ad-spend form, validated: the date a real day not after today (WIB), the amount whole rupiah, every id a UUID. */
export function parseAdSpend(form: FormData, today: string): AdSpendInput {
  const date = calendarDate(formValue(form, "spend_date"), "Enter the date the money was spent.");
  const spendDate = `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
  if (spendDate > today) throw new InvalidInput("The date cannot be in the future.");
  const platform = AD_PLATFORMS.find((p) => p === formValue(form, "platform"));
  if (platform === undefined) throw new InvalidInput("Choose the platform.");
  const optionalId = (name: string, message: string): string | null => {
    const raw = formValue(form, name).trim();
    return raw === "" ? null : uuid(raw, message);
  };
  const amountRaw = formValue(form, "amount_idr").replace(/[.\s]/g, "");
  return {
    spendDate,
    platform,
    landingPageId: optionalId("landing_page_id", "Choose a landing page from the list."),
    adnetId: optionalId("adnet_id", "Choose an adnet from the list."),
    utmCampaign: optionalLine(formValue(form, "utm_campaign"), "A campaign name is up to 256 characters, on one line.", 256),
    amountIdr: wholeNumber(amountRaw, `The amount is 0 to ${MAX_AD_SPEND_IDR.toLocaleString("en-US")} rupiah, whole.`, { min: 0, max: MAX_AD_SPEND_IDR }),
    note: optionalLine(formValue(form, "note"), "A note is up to 200 characters, on one line.", 200),
  };
}

const MESSAGES: Readonly<Record<string, string>> = {
  "23503": "That landing page or adnet no longer exists. Reload the page.",
  "23514": "The amount or the platform is not valid.",
};

const row = (input: AdSpendInput) => ({
  spend_date: input.spendDate,
  platform: input.platform,
  landing_page_id: input.landingPageId,
  adnet_id: input.adnetId,
  utm_campaign: input.utmCampaign,
  amount_idr: input.amountIdr,
  note: input.note,
});

export async function createAdSpend(sql: Sql, input: AdSpendInput): Promise<string> {
  return auditedChange(
    sql,
    async (tx, audit) => {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO public.ad_spend (spend_date, platform, landing_page_id, adnet_id, utm_campaign, amount_idr, note)
        VALUES (${input.spendDate}, ${input.platform}, ${input.landingPageId}, ${input.adnetId}, ${input.utmCampaign}, ${input.amountIdr}, ${input.note})
        RETURNING id`;
      if (created === undefined) throw new Error("the ad spend row was not created");
      audit({ action: "ad_spend.create", entityType: "ad_spend", entityId: created.id, fields: FIELDS, before: null, after: row(input) });
      return created.id;
    },
    MESSAGES,
  );
}

async function currentRow(tx: Tx, id: string): Promise<ReturnType<typeof row> | undefined> {
  const [r] = await tx<{ spend_date: string; platform: string; landing_page_id: string | null; adnet_id: string | null; utm_campaign: string | null; amount_idr: string; note: string | null }[]>`
    SELECT spend_date::text, platform, landing_page_id, adnet_id, utm_campaign, amount_idr::text, note FROM public.ad_spend WHERE id = ${id} FOR UPDATE`;
  return r === undefined ? undefined : ({ ...r, amount_idr: idrOf(r.amount_idr), platform: r.platform as AdPlatform });
}

export async function updateAdSpend(sql: Sql, id: string, input: AdSpendInput): Promise<void> {
  await auditedChange(
    sql,
    async (tx, audit) => {
      const before = await currentRow(tx, id);
      if (before === undefined) throw new InvalidInput("This ad spend row no longer exists.");
      await tx`
        UPDATE public.ad_spend
           SET spend_date = ${input.spendDate}, platform = ${input.platform}, landing_page_id = ${input.landingPageId}, adnet_id = ${input.adnetId},
               utm_campaign = ${input.utmCampaign}, amount_idr = ${input.amountIdr}, note = ${input.note}, updated_at = now()
         WHERE id = ${id}`;
      audit({ action: "ad_spend.update", entityType: "ad_spend", entityId: id, fields: FIELDS, before, after: row(input) });
    },
    MESSAGES,
  );
}

export async function deleteAdSpend(sql: Sql, id: string): Promise<void> {
  await auditedChange(sql, async (tx, audit) => {
    const before = await currentRow(tx, id);
    if (before === undefined) throw new InvalidInput("This ad spend row no longer exists.");
    await tx`DELETE FROM public.ad_spend WHERE id = ${id}`;
    audit({ action: "ad_spend.delete", entityType: "ad_spend", entityId: id, fields: FIELDS, before, after: null });
  });
}

export interface AdSpendRow {
  readonly id: string;
  readonly spendDate: string;
  readonly platform: AdPlatform;
  readonly landingPageId: string | null;
  readonly landingPage: string | null;
  readonly adnetId: string | null;
  readonly adnet: string | null;
  readonly utmCampaign: string | null;
  readonly amountIdr: number;
  readonly note: string | null;
}

/** The ad-spend rows of a date range, newest first, one page; with the total of the whole range. */
export async function listAdSpend(sql: Sql, input: { readonly from: string; readonly to: string; readonly page: number }): Promise<{ readonly rows: AdSpendRow[]; readonly total: number; readonly count: number }> {
  const rows = await sql<
    { id: string; spend_date: string; platform: string; landing_page_id: string | null; landing_page: string | null; adnet_id: string | null; adnet: string | null; utm_campaign: string | null; amount_idr: string; note: string | null }[]
  >`
    SELECT s.id, s.spend_date::text, s.platform, s.landing_page_id, lp.name AS landing_page, s.adnet_id, a.name AS adnet, s.utm_campaign, s.amount_idr::text, s.note
      FROM public.ad_spend s LEFT JOIN public.landing_pages lp ON lp.id = s.landing_page_id LEFT JOIN public.adnets a ON a.id = s.adnet_id
     WHERE s.spend_date BETWEEN ${input.from}::date AND ${input.to}::date
     ORDER BY s.spend_date DESC, s.created_at DESC, s.id
     LIMIT ${PAGE_SIZE} OFFSET ${(input.page - 1) * PAGE_SIZE}`;
  const [sum] = await sql<{ total: string; n: number }[]>`SELECT coalesce(sum(amount_idr), 0)::text AS total, count(*)::int AS n FROM public.ad_spend WHERE spend_date BETWEEN ${input.from}::date AND ${input.to}::date`;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      spendDate: r.spend_date,
      platform: (AD_PLATFORMS.find((p) => p === r.platform) ?? "other"),
      landingPageId: r.landing_page_id,
      landingPage: r.landing_page,
      adnetId: r.adnet_id,
      adnet: r.adnet,
      utmCampaign: r.utm_campaign,
      amountIdr: idrOf(r.amount_idr),
      note: r.note,
    })),
    total: idrOf(sum?.total),
    count: sum?.n ?? 0,
  };
}
