// Server-side conversions in the console (US-024; plan M7; AC-T2, AC-T6, AC-T3).
//
// CAPI access tokens. The Meta Conversions API and the TikTok Events API are called with an access token per pixel.
// The Owner sets it write-only next to the pixel ids of a landing page (pixel.edit, which is Owner-only: "every
// integration secret", AC-A1). It is sealed with the conversions PUBLIC key (the admin process holds no private key
// and cannot read a sealed column back) as the conversions-scope secret `capi.meta.<pixel id>` or
// `capi.tiktok.<pixel code, lowercase>`, with no adnet and bound to the platform's fixed API host (core CAPI_HOSTS;
// settings_secrets_binding_check): the worker sends it nowhere else, and no adnet's `{secret:name}` can name it. The
// token belongs to the PIXEL, so two landing pages with one pixel share it. The console shows only whether it is
// set and, for a token of 16 characters or more, its last 4 characters; the audit log records {set} only.
//
// Manual re-fire of a conversion (AC-T3: "failed, with manual re-fire"). Owner only (conversion.refire). The
// database function public.refire_conversion decides what may be re-fired (a failed row; a sent one only when
// explicitly resent; the MT of an unpaid order never, whoever asks: ET080) and the worker then sends it like any
// other. It is the console's ONLY write to the conversion log: admin_rw holds no INSERT, UPDATE or DELETE on
// conversion_events or conversion_attempts. The audit entry is written in the same transaction. The reports
// (US-029) put the button on the page; this is the action behind it.
import { CAPI_HOSTS, type CapiPlatform, capiSecretName } from "@ebooktrivia/core";
import { type FieldKind, type Tx, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput } from "./fields.ts";
import { clearSecret, parseSecret, requireSealer, secretStatuses, type SecretStatus, writeSecret } from "./secrets.ts";

export const CAPI_PLATFORMS: readonly CapiPlatform[] = ["meta", "tiktok"];
export const CAPI_LABELS: Readonly<Record<CapiPlatform, string>> = { meta: "Meta Conversions API", tiktok: "TikTok Events API" };

export const parseCapiPlatform = (raw: string): CapiPlatform => {
  const platform = CAPI_PLATFORMS.find((p) => p === raw);
  if (platform === undefined) throw new InvalidInput("Choose Meta or TikTok.");
  return platform;
};

/** The pixel id the landing page stores for `platform` (the page is locked while the token is written). */
async function pixelOf(sql: Tx, landingPageId: string, platform: CapiPlatform): Promise<string> {
  const [page] = await sql<{ pixels: Record<string, unknown> }[]>`SELECT pixels FROM public.landing_pages WHERE id = ${landingPageId} FOR UPDATE`;
  if (page === undefined) throw new InvalidInput("This landing page no longer exists.");
  const id = page.pixels[platform];
  if (typeof id !== "string" || id === "") throw new InvalidInput(`Set the ${platform === "meta" ? "Meta pixel id" : "TikTok pixel code"} of this landing page first: the access token belongs to the pixel.`);
  return id;
}

function secretNameOf(platform: CapiPlatform, pixelId: string): string {
  try {
    return capiSecretName(platform, pixelId);
  } catch {
    throw new InvalidInput("The pixel id of this landing page is not in the platform's format: correct it first.");
  }
}

/** Sets (or replaces) the CAPI access token of the landing page's pixel. */
export async function setCapiToken(sql: Sql, settings: SettingsConfig, landingPageId: string, platform: CapiPlatform, plaintext: string): Promise<void> {
  const sealer = requireSealer(settings, "conversions");
  const value = parseSecret(plaintext);
  await auditedChange(
    sql,
    async (tx, audit) => {
      const name = secretNameOf(platform, await pixelOf(tx, landingPageId, platform));
      await writeSecret(tx, audit, sealer, { scope: "conversions", name, adnetId: null, boundHost: CAPI_HOSTS[platform] }, value);
    },
    { "23505": CONCURRENT_SAVE },
  );
}

export async function clearCapiToken(sql: Sql, landingPageId: string, platform: CapiPlatform): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    const name = secretNameOf(platform, await pixelOf(tx, landingPageId, platform));
    await clearSecret(tx, audit, { scope: "conversions", name, adnetId: null });
  });
}

/** Whether each landing page's Meta / TikTok pixel has an access token (set / last4 only; a sealed column is never read). */
export async function capiTokenStatuses(
  sql: Sql,
  pages: readonly { readonly id: string; readonly pixels: { readonly meta: string | null; readonly tiktok: string | null } }[],
): Promise<ReadonlyMap<string, Partial<Record<CapiPlatform, SecretStatus>>>> {
  const targets: { readonly landingPageId: string; readonly platform: CapiPlatform; readonly name: string }[] = [];
  for (const page of pages) {
    for (const platform of CAPI_PLATFORMS) {
      const pixel = page.pixels[platform];
      if (pixel === null) continue;
      try {
        targets.push({ landingPageId: page.id, platform, name: capiSecretName(platform, pixel) });
      } catch {
        // A pixel id that is not in the platform's format has no token to show; editing it re-validates.
      }
    }
  }
  const statuses = await secretStatuses(sql, targets.map((t) => ({ scope: "conversions" as const, name: t.name, adnetId: null })));
  const out = new Map<string, Partial<Record<CapiPlatform, SecretStatus>>>();
  for (const [i, target] of targets.entries()) {
    const status = statuses[i];
    if (status === undefined) continue;
    out.set(target.landingPageId, { ...out.get(target.landingPageId), [target.platform]: status });
  }
  return out;
}

const REFIRE_FIELDS: Readonly<Record<string, FieldKind>> = { status: "value" };

const REFIRE_MESSAGES: Readonly<Record<string, string>> = {
  ET010: "This conversion no longer exists.",
  ET084: "Only a failed conversion can be re-fired (a sent one only when you confirm that it is sent again).",
  ET080: "The order of this conversion is not paid, so its MT cannot be sent.",
};

/** Puts a failed conversion (or, when `resendSent`, a sent one) back into the send path; audited. */
export async function refireConversion(sql: Sql, id: string, options: { readonly resendSent?: boolean } = {}): Promise<void> {
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [before] = await tx<{ status: string; sink: string; kind: string; order_id: string; attempts: number }[]>`
        SELECT status::text AS status, sink, kind, order_id, attempts FROM public.conversion_events WHERE id = ${id}`;
      if (before === undefined) throw new InvalidInput(REFIRE_MESSAGES["ET010"] ?? "");
      await tx`SELECT public.refire_conversion(${id}::uuid, ${options.resendSent === true}::boolean)`;
      audit({
        action: "conversion.refire",
        entityType: "conversion_event",
        entityId: id,
        fields: REFIRE_FIELDS,
        before: { status: before.status },
        after: { status: "pending" },
        facts: { sink: before.sink, kind: before.kind, order_id: before.order_id, attempts: before.attempts, resend_sent: options.resendSent === true },
      });
    },
    REFIRE_MESSAGES,
  );
}
