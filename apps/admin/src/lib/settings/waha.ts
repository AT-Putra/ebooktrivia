// WAHA servers and sessions (AC-A3 "WAHA servers and sessions (weights, caps)", AC-D3, plan M3.1
// private-IP allowlist; US-017). Owner only (waha.edit).
//   - a server's base URL is https with a canonical host (endpoints.ts); a private-network IPv4
//     literal needs the server's explicit "allow private IP" flag, which is audited, and the worker
//     passes base_url_host to safe-fetch's allowPrivateHosts only for servers with that flag
//     (loopback, link-local and cloud metadata stay refused even then);
//   - the API key is a sealed messaging-scope secret named waha.<server id>.api_key, bound to
//     base_url_host (ET062 otherwise); changing the base URL's host deletes it
//     (waha_servers_clear_bound_secrets), so the key is never sent to a new host unasked;
//   - sessions: name (the WAHA session), pool number (E.164, Indonesian mobile), weight (round robin)
//     and daily cap. The pool number is shown to buyers (wa.me) but audited as a reference only.
import { normalizeIdMobile } from "@ebooktrivia/core";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { type FieldKind, withAudit } from "../audit.ts";
import { auditedChange, CONCURRENT_SAVE } from "./audited.ts";
import type { Sql } from "../db.ts";
import { checkWahaBaseUrl, ENDPOINT_MESSAGES } from "./endpoints.ts";
import type { SettingsConfig } from "./env.ts";
import { InvalidInput, singleLine, wholeNumber } from "./fields.ts";
import { clearSecret, parseSecret, requireSealer, secretStatuses, type SecretStatus, writeSecret } from "./secrets.ts";

const SERVER_FIELDS: Readonly<Record<string, FieldKind>> = { name: "value", base_url: "value", base_url_host: "value", allow_private_ip: "value", active: "value" };
const SESSION_FIELDS: Readonly<Record<string, FieldKind>> = { server_id: "value", session_name: "value", phone: "pii", weight: "value", daily_cap: "value", active: "value" };

export interface WahaServerInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly baseUrlHost: string;
  readonly allowPrivateIp: boolean;
  readonly active: boolean;
}

export function parseWahaServer(values: { readonly name: string; readonly baseUrl: string }, flags: { readonly allowPrivateIp: boolean; readonly active: boolean }): WahaServerInput {
  const checked = checkWahaBaseUrl(values.baseUrl, flags.allowPrivateIp);
  if (!checked.ok) throw new InvalidInput(ENDPOINT_MESSAGES[checked.reason]);
  return {
    name: singleLine(values.name, "Enter a name (up to 100 characters).", { max: 100 }),
    baseUrl: checked.baseUrl,
    baseUrlHost: checked.host,
    allowPrivateIp: flags.allowPrivateIp,
    active: flags.active,
  };
}

export interface WahaSessionInput {
  readonly serverId: string;
  readonly sessionName: string;
  readonly phone: string | null;
  readonly weight: number;
  readonly dailyCap: number;
  readonly active: boolean;
}

export function parseWahaSession(values: { readonly serverId: string; readonly sessionName: string; readonly phone: string; readonly weight: string; readonly dailyCap: string }, active: boolean): WahaSessionInput {
  const sessionName = values.sessionName.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionName)) throw new InvalidInput("The session name is 1 to 64 letters, digits, _ or - (as in WAHA).");
  let phone: string | null = null;
  if (values.phone.trim() !== "") {
    const parsed = normalizeIdMobile(values.phone);
    if (!parsed.ok) throw new InvalidInput("Enter the session's WhatsApp number as an Indonesian mobile number, e.g. 0812 3456 7890.");
    phone = parsed.e164;
  }
  return {
    serverId: values.serverId,
    sessionName,
    phone,
    weight: wholeNumber(values.weight, "The weight is 1 to 100.", { min: 1, max: 100 }),
    dailyCap: wholeNumber(values.dailyCap, "The daily cap is 0 to 10,000 messages.", { min: 0, max: 10_000 }),
    active,
  };
}

const serverRow = (s: WahaServerInput) => ({ name: s.name, base_url: s.baseUrl, base_url_host: s.baseUrlHost, allow_private_ip: s.allowPrivateIp, active: s.active });
const sessionRow = (s: WahaSessionInput) => ({ server_id: s.serverId, session_name: s.sessionName, phone: s.phone, weight: s.weight, daily_cap: s.dailyCap, active: s.active });

const MESSAGES: Readonly<Record<string, string>> = {
  "23505": "This server already has a session with that name.",
  "23514": "The address or values are not valid for a WAHA server.",
  "23503": "The chosen server does not exist.",
};

export function createWahaServer(sql: Sql, input: WahaServerInput): Promise<string> {
  return auditedChange(sql, async (tx, audit) => {
      const values = serverRow(input);
      const [row] = await tx<{ id: string }[]>`INSERT INTO public.waha_servers ${tx(values)} RETURNING id`;
      const id = row?.id ?? "";
      audit({ action: "waha_server.create", entityType: "waha_server", entityId: id, fields: SERVER_FIELDS, after: values });
      return id;
  }, MESSAGES);
}

/** Returns whether the API key was deleted (the base URL moved to another host). */
export function updateWahaServer(sql: Sql, id: string, input: WahaServerInput): Promise<{ readonly keyCleared: boolean }> {
  return auditedChange(sql, async (tx, audit) => {
      const [before] = await tx<Record<keyof ReturnType<typeof serverRow>, unknown>[]>`
        SELECT name, base_url, base_url_host, allow_private_ip, active FROM public.waha_servers WHERE id = ${id} FOR UPDATE`;
      if (before === undefined) throw new InvalidInput("This server no longer exists.");
      const name = SECRET_NAMES.wahaApiKey(id);
      const had = (await tx`SELECT 1 FROM public.settings_secrets WHERE scope = 'messaging' AND name = ${name}`).length > 0;
      const values = serverRow(input);
      await tx`UPDATE public.waha_servers SET ${tx(values)}, updated_at = clock_timestamp() WHERE id = ${id}`;
      const has = (await tx`SELECT 1 FROM public.settings_secrets WHERE scope = 'messaging' AND name = ${name}`).length > 0;
      audit({ action: "waha_server.update", entityType: "waha_server", entityId: id, fields: SERVER_FIELDS, before, after: values, facts: { api_key_cleared: had && !has } });
      return { keyCleared: had && !has };
  }, MESSAGES);
}

export async function setWahaApiKey(sql: Sql, settings: SettingsConfig, serverId: string, raw: string): Promise<void> {
  const sealer = requireSealer(settings, "messaging");
  const key = parseSecret(raw);
  await auditedChange(
    sql,
    async (tx, audit) => {
      const [server] = await tx<{ base_url_host: string }[]>`SELECT base_url_host FROM public.waha_servers WHERE id = ${serverId} FOR UPDATE`;
      if (server === undefined) throw new InvalidInput("This server no longer exists.");
      await writeSecret(tx, audit, sealer, { scope: "messaging", name: SECRET_NAMES.wahaApiKey(serverId), adnetId: null, boundHost: server.base_url_host }, key);
    },
    { "23505": CONCURRENT_SAVE },
  );
}

export async function clearWahaApiKey(sql: Sql, serverId: string): Promise<void> {
  await withAudit(sql, async (tx, audit) => {
    await clearSecret(tx, audit, { scope: "messaging", name: SECRET_NAMES.wahaApiKey(serverId), adnetId: null });
  });
}

export function createWahaSession(sql: Sql, input: WahaSessionInput): Promise<string> {
  return auditedChange(sql, async (tx, audit) => {
      const values = sessionRow(input);
      const [row] = await tx<{ id: string }[]>`INSERT INTO public.waha_sessions ${tx(values)} RETURNING id`;
      const id = row?.id ?? "";
      audit({ action: "waha_session.create", entityType: "waha_session", entityId: id, fields: SESSION_FIELDS, after: values });
      return id;
  }, MESSAGES);
}

export function updateWahaSession(sql: Sql, id: string, input: Omit<WahaSessionInput, "serverId">): Promise<void> {
  return auditedChange(sql, async (tx, audit) => {
      const [before] = await tx<Record<string, unknown>[]>`
        SELECT session_name, phone, weight, daily_cap, active FROM public.waha_sessions WHERE id = ${id} FOR UPDATE`;
      if (before === undefined) throw new InvalidInput("This session no longer exists.");
      const values = { session_name: input.sessionName, phone: input.phone, weight: input.weight, daily_cap: input.dailyCap, active: input.active };
      await tx`UPDATE public.waha_sessions SET ${tx(values)}, updated_at = clock_timestamp() WHERE id = ${id}`;
      audit({ action: "waha_session.update", entityType: "waha_session", entityId: id, fields: SESSION_FIELDS, before, after: values });
  }, MESSAGES);
}

export interface WahaServerRow {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly allowPrivateIp: boolean;
  readonly active: boolean;
  readonly apiKey: SecretStatus;
  readonly sessions: readonly {
    readonly id: string;
    readonly sessionName: string;
    readonly phone: string | null;
    readonly weight: number;
    readonly dailyCap: number;
    readonly active: boolean;
    readonly status: string | null;
  }[];
}

export async function listWahaServers(sql: Sql): Promise<WahaServerRow[]> {
  const servers = await sql<{ id: string; name: string; base_url: string; allow_private_ip: boolean; active: boolean }[]>`
    SELECT id, name, base_url, allow_private_ip, active FROM public.waha_servers ORDER BY name`;
  const sessions = await sql<{ id: string; server_id: string; session_name: string; phone: string | null; weight: number; daily_cap: number; active: boolean; status: string | null }[]>`
    SELECT id, server_id, session_name, phone, weight, daily_cap, active, status FROM public.waha_sessions ORDER BY session_name`;
  const keys = await secretStatuses(sql, servers.map((s) => ({ scope: "messaging", name: SECRET_NAMES.wahaApiKey(s.id), adnetId: null })));
  return servers.map((s, i) => ({
    id: s.id,
    name: s.name,
    baseUrl: s.base_url,
    allowPrivateIp: s.allow_private_ip,
    active: s.active,
    apiKey: keys[i] ?? { set: false, last4: "", updatedAt: null },
    sessions: sessions
      .filter((x) => x.server_id === s.id)
      .map((x) => ({ id: x.id, sessionName: x.session_name, phone: x.phone, weight: x.weight, dailyCap: x.daily_cap, active: x.active, status: x.status })),
  }));
}

/** Active sessions on active servers (the test-send sender choice). */
export async function activeSessions(sql: Sql): Promise<{ readonly id: string; readonly label: string }[]> {
  return sql<{ id: string; label: string }[]>`
    SELECT s.id, w.name || ' / ' || s.session_name AS label
      FROM public.waha_sessions s JOIN public.waha_servers w ON w.id = s.server_id
     WHERE s.active AND w.active ORDER BY label`;
}
