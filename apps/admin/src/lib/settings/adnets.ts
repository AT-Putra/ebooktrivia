// Adnets (AC-T2, plan M2.3 endpoint binding / M7.1; US-017). Owner only (adnet.edit: postback
// templates and their secrets are "postback secrets" of AC-A1).
//
// The endpoint host is taken from the templates: every MO / MT / reversal template must start
// with the same static https://host[:port] (http only without secrets), and adnets.endpoint_host
// is set to it. `{secret:name}` in a template resolves only conversions-scope secrets bound to this
// adnet AND that host; changing the host deletes the adnet's secrets bound to the old one
// (sql/triggers.sql adnets_clear_bound_secrets), so a compromised console cannot send an existing
// secret to a new host. Each template is checked with the real renderer
// (@ebooktrivia/core renderPostbackUrlRedacted) against sample values, so a template the worker
// would refuse is refused here.
import { randomUUID } from "node:crypto";
import { postbackSecretNames, renderPostbackUrlRedacted, TemplateError, type TemplateErrorCode } from "@ebooktrivia/core";
import { type FieldKind, withAudit } from "../audit.ts";
import type { Sql } from "../db.ts";
import { checkHostname, ENDPOINT_MESSAGES } from "./endpoints.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import { InvalidInput, optionalLine, singleLine, slug, wholeNumber } from "./fields.ts";
import { clearSecret, parseSecret, requireSealer, secretStatuses, type SecretStatus, writeSecret } from "./secrets.ts";
import type { SettingsConfig } from "./env.ts";

const ADNET_FIELDS: Readonly<Record<string, FieldKind>> = {
  slug: "value",
  name: "value",
  clickid_param: "value",
  mo_url_template: "value",
  mt_url_template: "value",
  reversal_url_template: "value",
  payout_idr: "value",
  endpoint_host: "value",
  active: "value",
};

const TEMPLATE_MESSAGES: Readonly<Partial<Record<TemplateErrorCode, string>>> = {
  unknown_variable: "uses an unknown macro (allowed: {clickid} {txid} {payout} {status} {sub_id} {pub} {secret:name})",
  malformed_token: "has a { or } that is not part of a macro",
  invalid_url: "is not a valid URL starting with a fixed https://host",
  host_mismatch: "does not use the same host and port as the other templates",
  insecure_scheme: "must use https to carry a {secret:...}",
  secret_not_allowed: "uses a secret where none is allowed",
  invalid_value: "would produce an invalid URL",
};

const SAMPLE = { clickid: "click123", txid: "TX0001", payout: "10000", status: "approved", sub_id: "sub", pub: "pub" } as const;
const STATIC_ORIGIN = /^(https?:\/\/[^/?#{}\s]+)(?:[/?#]|$)/i;
const SECRET_NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

export interface AdnetInput {
  readonly slug: string;
  readonly name: string;
  readonly clickidParam: string;
  readonly moUrlTemplate: string | null;
  readonly mtUrlTemplate: string | null;
  readonly reversalUrlTemplate: string | null;
  readonly payoutIdr: number;
  readonly active: boolean;
}

export function parseAdnet(values: Readonly<Record<"slug" | "name" | "clickidParam" | "mo" | "mt" | "reversal" | "payout", string>>, active: boolean): AdnetInput {
  const clickidParam = values.clickidParam.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(clickidParam)) throw new InvalidInput("The click id parameter is 1 to 64 letters, digits, _ . or -.");
  const template = (raw: string, label: string) => optionalLine(raw, `The ${label} template is one line of up to 2048 characters.`, 2048);
  return {
    slug: slug(values.slug, "The slug is lowercase letters, digits and single hyphens (up to 64)."),
    name: singleLine(values.name, "Enter a name (up to 100 characters).", { max: 100 }),
    clickidParam,
    moUrlTemplate: template(values.mo, "MO"),
    mtUrlTemplate: template(values.mt, "MT"),
    reversalUrlTemplate: template(values.reversal, "reversal"),
    payoutIdr: wholeNumber(values.payout.replace(/[.\s]/g, ""), "The payout is 0 to 100,000,000 rupiah.", { min: 0, max: 100_000_000 }),
    active,
  };
}

/** The endpoint host of the templates (URL.host form), checked like every outbound host; null without templates. */
export function endpointHostOf(input: AdnetInput, adnetId: string): string | null {
  const templates = [
    ["MO", input.moUrlTemplate],
    ["MT", input.mtUrlTemplate],
    ["reversal", input.reversalUrlTemplate],
  ] as const;
  let host: string | null = null;
  for (const [label, template] of templates) {
    if (template === null) continue;
    if (host === null) {
      const origin = STATIC_ORIGIN.exec(template)?.[1];
      let url: URL;
      try {
        url = new URL(origin ?? "");
      } catch {
        throw new InvalidInput(`The ${label} template ${TEMPLATE_MESSAGES.invalid_url ?? ""}.`);
      }
      const checked = checkHostname(url.hostname, false);
      if (!checked.ok) throw new InvalidInput(`The ${label} template host: ${ENDPOINT_MESSAGES[checked.reason]}`);
      host = url.host;
    }
    try {
      renderPostbackUrlRedacted(template, SAMPLE, { adnetId, host });
    } catch (error) {
      if (error instanceof TemplateError) throw new InvalidInput(`The ${label} template ${TEMPLATE_MESSAGES[error.code] ?? "is not valid"}.`);
      throw error;
    }
  }
  return host;
}

const MESSAGES: Readonly<Record<string, string>> = { "23505": "Another adnet already uses this slug.", "23514": "The adnet settings are not valid." };

const rowValues = (input: AdnetInput, endpointHost: string | null) => ({
  slug: input.slug,
  name: input.name,
  clickid_param: input.clickidParam,
  mo_url_template: input.moUrlTemplate,
  mt_url_template: input.mtUrlTemplate,
  reversal_url_template: input.reversalUrlTemplate,
  payout_idr: input.payoutIdr,
  endpoint_host: endpointHost,
  active: input.active,
});

export async function createAdnet(sql: Sql, input: AdnetInput): Promise<string> {
  const id = randomUUID();
  const after = rowValues(input, endpointHostOf(input, id));
  await auditedChange(
    sql,
    async (tx, audit) => {
      await tx`INSERT INTO public.adnets ${tx({ id, ...after })}`;
      audit({ action: "adnet.create", entityType: "adnet", entityId: id, fields: ADNET_FIELDS, after });
    },
    MESSAGES,
  );
  return id;
}

/** Returns how many of the adnet's secrets the database deleted because the endpoint host changed. */
export async function updateAdnet(sql: Sql, id: string, input: AdnetInput): Promise<{ readonly secretsCleared: number }> {
  const values = rowValues(input, endpointHostOf(input, id));
  return auditedChange(
    sql,
    async (tx, audit) => {
      const [before] = await tx<Record<keyof typeof values, unknown>[]>`
        SELECT slug, name, clickid_param, mo_url_template, mt_url_template, reversal_url_template, payout_idr::float8 AS payout_idr, endpoint_host, active
          FROM public.adnets WHERE id = ${id} FOR UPDATE`;
      if (before === undefined) throw new InvalidInput("This adnet no longer exists.");
      const [secrets] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.settings_secrets WHERE adnet_id = ${id}`;
      await tx`UPDATE public.adnets SET ${tx(values)}, updated_at = clock_timestamp() WHERE id = ${id}`;
      const [left] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.settings_secrets WHERE adnet_id = ${id}`;
      const secretsCleared = (secrets?.n ?? 0) - (left?.n ?? 0);
      audit({ action: "adnet.update", entityType: "adnet", entityId: id, fields: ADNET_FIELDS, before, after: values, facts: { secrets_cleared: secretsCleared } });
      return { secretsCleared };
    },
    MESSAGES,
  );
}

export const parseSecretName = (raw: string): string => {
  const name = raw.trim();
  if (name.length > 64 || !SECRET_NAME.test(name)) throw new InvalidInput("The secret name is lowercase letters, digits and _ (dots between parts), e.g. api_key.");
  return name;
};

/** Sets `{secret:name}` of an adnet: conversions scope, bound to this adnet and its endpoint host. */
export async function setAdnetSecret(sql: Sql, settings: SettingsConfig, adnetId: string, name: string, plaintext: string): Promise<void> {
  const sealer = requireSealer(settings, "conversions");
  const value = parseSecret(plaintext);
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [adnet] = await tx<{ endpoint_host: string | null }[]>`SELECT endpoint_host FROM public.adnets WHERE id = ${adnetId} FOR UPDATE`;
      if (adnet === undefined) throw new InvalidInput("This adnet no longer exists.");
      if (adnet.endpoint_host === null) throw new InvalidInput("Add a postback template first: a secret is bound to the template's host.");
      await writeSecret(tx, audit, sealer, { scope: "conversions", name, adnetId, boundHost: adnet.endpoint_host }, value);
    },
    { "23505": CONCURRENT_SAVE },
  );
}

export async function clearAdnetSecret(sql: Sql, adnetId: string, name: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    await clearSecret(tx, audit, { scope: "conversions", name, adnetId });
  });
}

export interface AdnetRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly clickidParam: string;
  readonly moUrlTemplate: string | null;
  readonly mtUrlTemplate: string | null;
  readonly reversalUrlTemplate: string | null;
  readonly payoutIdr: number;
  readonly endpointHost: string | null;
  readonly active: boolean;
  /** Names referenced by the templates plus names stored for this adnet, with their status. */
  readonly secrets: readonly (SecretStatus & { readonly name: string; readonly referenced: boolean })[];
}

export async function listAdnets(sql: Sql): Promise<AdnetRow[]> {
  const rows = await sql<Omit<AdnetRow, "secrets">[]>`
    SELECT id, slug, name, clickid_param AS "clickidParam", mo_url_template AS "moUrlTemplate", mt_url_template AS "mtUrlTemplate",
           reversal_url_template AS "reversalUrlTemplate", payout_idr::float8 AS "payoutIdr", endpoint_host AS "endpointHost", active
      FROM public.adnets ORDER BY name`;
  const stored = await sql<{ adnet_id: string; name: string }[]>`
    SELECT adnet_id, name FROM public.settings_secrets WHERE scope = 'conversions' AND adnet_id IS NOT NULL`;
  const out: AdnetRow[] = [];
  for (const row of rows) {
    const referenced = new Set<string>();
    for (const template of [row.moUrlTemplate, row.mtUrlTemplate, row.reversalUrlTemplate]) {
      if (template === null) continue;
      try {
        for (const name of postbackSecretNames(template)) referenced.add(name);
      } catch {
        // A stored template that no longer parses references nothing; editing it re-validates.
      }
    }
    const names = [...new Set([...referenced, ...stored.filter((s) => s.adnet_id === row.id).map((s) => s.name)])].sort();
    const statuses = await secretStatuses(sql, names.map((name) => ({ scope: "conversions", name, adnetId: row.id })));
    out.push({ ...row, secrets: names.map((name, i) => ({ ...(statuses[i] ?? { set: false, last4: "", updatedAt: null }), name, referenced: referenced.has(name) })) });
  }
  return out;
}
