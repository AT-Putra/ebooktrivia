// US-024 in the console, as the admin_rw login the app uses: the write-only CAPI access tokens of a landing
// page's pixels (sealed with the PUBLIC conversions key, bound to the platform's host, never readable back, audited as
// {set} only), "Staff cannot see secrets", and the audited manual re-fire of a conversion.
import { CAPI_HOSTS } from "@ebooktrivia/core";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { findCapiSecret } from "@ebooktrivia/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Permission } from "../src/lib/policy.ts";
import { capiTokenStatuses, clearCapiToken, refireConversion, setCapiToken } from "../src/lib/settings/conversions.ts";
import type { SettingsConfig } from "../src/lib/settings/env.ts";
import { InvalidInput } from "../src/lib/settings/fields.ts";
import { listAdnets } from "../src/lib/settings/adnets.ts";
import { asAdmin, createTestAdmin, newRuntime, root, suffix } from "./support.ts";

const pair = generateScopeKeyPair();
const sealer = createSecretSealer({ conversions: pair.publicKey });
/** The worker side (the private key): only here to prove what the admin wrote opens correctly. */
const workerOpener = createSecretOpener({ conversions: pair.privateKey });
const META_PIXEL = "1234567890123";
const TIKTOK_PIXEL = "C3ABCDEFGH0123456";

let settings: SettingsConfig;
let rt: ReturnType<typeof newRuntime>;
let ownerId = "";

beforeAll(async () => {
  settings = { domain: "example.test", dataDir: "", pdfMaxBytes: 1024, uploadMaxOpenSessions: 1, uploadMaxStagedBytes: 1024, sealer };
  rt = newRuntime(undefined, settings);
  ownerId = (await createTestAdmin(rt, "owner")).userId;
});
afterAll(async () => {
  await root`DELETE FROM settings_secrets WHERE name LIKE 'capi.%'`;
});

const as = <T>(fn: () => Promise<T>): Promise<T> => asAdmin(ownerId, fn);

async function shop(pixels: Record<string, string>) {
  const [product] = await root<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES (${`Ebook ${suffix()}`}, 49000) RETURNING id`;
  const [program] = await root<{ id: string }[]>`
    INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
    VALUES (${product?.id ?? ""}, ${`p-${suffix()}`}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`;
  const [lp] = await root<{ id: string }[]>`
    INSERT INTO landing_pages (lp_key, name, program_id, pixels) VALUES (${`lp_${suffix()}${suffix()}`}, 'LP', ${program?.id ?? ""}, ${JSON.stringify(pixels)}::text::jsonb) RETURNING id`;
  return { productId: product?.id ?? "", programId: program?.id ?? "", landingPageId: lp?.id ?? "" };
}

describe("CAPI access tokens (write-only, sealed with the public conversions key)", () => {
  it("seals a Meta token as capi.meta.<pixel>, bound to graph.facebook.com with no adnet; the admin login cannot read it back, the private key opens it", async () => {
    const { landingPageId } = await shop({ meta: META_PIXEL });
    const token = `EAAmeta-${suffix()}${suffix()}${suffix()}`;
    await as(() => setCapiToken(rt.sql, settings, landingPageId, "meta", token));
    const row = await findCapiSecret(root, { name: `capi.meta.${META_PIXEL}`, host: CAPI_HOSTS.meta });
    expect(row).toMatchObject({ scope: "conversions", adnetId: null, boundHost: "graph.facebook.com" });
    expect(Buffer.from(row?.ciphertext ?? []).toString("utf8")).not.toContain(token);
    expect(row === undefined ? "" : workerOpener.openSecret(row)).toBe(token);
    for (const column of ["ciphertext", "nonce", "sealed_dek"]) {
      await expect(rt.sql.unsafe(`SELECT ${column} FROM public.settings_secrets WHERE name = $1`, [`capi.meta.${META_PIXEL}`])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(rt.sql.unsafe("SELECT * FROM public.settings_secrets")).rejects.toMatchObject({ code: "42501" });
    // The console shows set + last 4 only; the audit log {set}, never the value or its last 4.
    const statuses = await capiTokenStatuses(rt.sql, [{ id: landingPageId, pixels: { meta: META_PIXEL, tiktok: null } }]);
    expect(statuses.get(landingPageId)?.meta).toMatchObject({ set: true, last4: token.slice(-4) });
    expect(statuses.get(landingPageId)?.tiktok).toBeUndefined();
    const [audit] = await root<{ text: string; changes: Record<string, unknown> }[]>`
      SELECT row_to_json(a)::text AS text, changes FROM audit_log a WHERE action = 'settings_secret.set' AND changes ->> 'name' = ${`capi.meta.${META_PIXEL}`} ORDER BY id DESC LIMIT 1`;
    expect(audit?.changes["value"]).toEqual({ set: true });
    expect(audit?.text).not.toContain(token);
    expect(audit?.text).not.toContain(`"${token.slice(-4)}"`);
  });

  it("names a TikTok token by the lowercase pixel code, replaces it under the same row id, and removes it", async () => {
    const { landingPageId } = await shop({ tiktok: TIKTOK_PIXEL });
    await as(() => setCapiToken(rt.sql, settings, landingPageId, "tiktok", `tt-first-${suffix()}${suffix()}`));
    const name = `capi.tiktok.${TIKTOK_PIXEL.toLowerCase()}`;
    const first = await findCapiSecret(root, { name, host: CAPI_HOSTS.tiktok });
    const second = `tt-second-${suffix()}${suffix()}`;
    await as(() => setCapiToken(rt.sql, settings, landingPageId, "tiktok", second));
    const after = await findCapiSecret(root, { name, host: CAPI_HOSTS.tiktok });
    expect(after?.id).toBe(first?.id);
    expect(after === undefined ? "" : workerOpener.openSecret(after)).toBe(second);
    await as(() => clearCapiToken(rt.sql, landingPageId, "tiktok"));
    expect(await findCapiSecret(root, { name, host: CAPI_HOSTS.tiktok })).toBeUndefined();
    const [audit] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'settings_secret.clear' ORDER BY id DESC LIMIT 1`;
    expect(audit?.changes).toMatchObject({ value: { set: false }, name });
  });

  it("refuses a token for a pixel the page does not have, for a pixel id that is not in its vendor's format, and without the sealing key", async () => {
    const none = await shop({});
    await expect(as(() => setCapiToken(rt.sql, settings, none.landingPageId, "meta", "token-token-token-token"))).rejects.toThrow(/Set the Meta pixel id/);
    await expect(as(() => setCapiToken(rt.sql, settings, none.landingPageId, "tiktok", "token-token-token-token"))).rejects.toThrow(/TikTok pixel code/);
    const odd = await shop({ meta: "not-a-pixel" });
    await expect(as(() => setCapiToken(rt.sql, settings, odd.landingPageId, "meta", "token-token-token-token"))).rejects.toThrow(/not in the platform's format/);
    const ok = await shop({ meta: "5555555555555" });
    await expect(as(() => setCapiToken(rt.sql, { ...settings, sealer: null }, ok.landingPageId, "meta", "token-token-token-token"))).rejects.toThrow(InvalidInput);
    await expect(as(() => setCapiToken(rt.sql, settings, ok.landingPageId, "meta", "line\nbreak"))).rejects.toThrow(/control characters/);
    await expect(as(() => setCapiToken(rt.sql, settings, "00000000-0000-4000-8000-000000000000", "meta", "token-token-token-token"))).rejects.toThrow(/no longer exists/);
  });

  it("an adnet's secret listing never offers a CAPI token (it has no adnet), and the console never lists a sealed column", async () => {
    const { landingPageId } = await shop({ meta: "7777777777777" });
    await as(() => setCapiToken(rt.sql, settings, landingPageId, "meta", `EAAother-${suffix()}${suffix()}`));
    expect((await listAdnets(rt.sql)).flatMap((a) => a.secrets.map((s) => s.name)).filter((n) => n.startsWith("capi."))).toEqual([]);
  });
});

describe("Staff cannot see or set secrets (AC-A1, criterion 4)", () => {
  it("the policy denies Staff every secret and re-fire permission, and the Owner has them", () => {
    const secretPermissions = ["pixel.edit", "adnet.edit", "midtrans.edit", "smtp.edit", "waha.edit", "conversion.refire"] as const satisfies readonly Permission[];
    for (const permission of secretPermissions) {
      expect(can("staff", permission), permission).toBe(false);
      expect(can("owner", permission), permission).toBe(true);
    }
  });

  it("no database login of the app (and so no role of the console) can read a sealed column of any secret", async () => {
    for (const column of ["ciphertext", "nonce", "sealed_dek"]) {
      await expect(rt.sql.unsafe(`SELECT ${column} FROM public.settings_secrets`)).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("manual re-fire of a conversion (AC-T3, audited)", () => {
  async function conversion(opts: { orderStatus?: string; status: string; lastError?: string | null; sink?: string; kind?: string }) {
    const base = await shop({});
    const [order] = await root<{ id: string }[]>`
      INSERT INTO orders (public_id, order_code, landing_page_id, program_id, product_id, buyer_name, buyer_phone, buyer_email, buyer_key, amount_idr, expires_at)
      VALUES (${`${suffix()}${suffix()}${suffix()}`}, ${`${suffix()}${suffix()}`.toUpperCase()}, ${base.landingPageId}, ${base.programId}, ${base.productId}, 'Pembeli', '+6281234567890', 'buyer@example.invalid',
              sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 49000, now() + interval '1 day') RETURNING id`;
    await root`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = ${order?.id ?? ""}`;
    const [event] = await root<{ id: string }[]>`
      INSERT INTO conversion_events (order_id, sink, kind, status, txid, event_id, attempts, last_error, failed_at, sent_at)
      VALUES (${order?.id ?? ""}, ${opts.sink ?? "meta"}, ${opts.kind ?? "mt"}, ${opts.status}, ${order?.id ?? ""}, gen_random_uuid(), 6, ${opts.lastError ?? null},
              ${opts.status === "failed" ? new Date() : null}, ${opts.status === "sent" ? new Date() : null}) RETURNING id`;
    if (opts.orderStatus !== undefined && opts.orderStatus !== "paid") await root`UPDATE orders SET status = ${opts.orderStatus} WHERE id = ${order?.id ?? ""}`;
    return { orderId: order?.id ?? "", id: event?.id ?? "" };
  }
  const state = async (id: string) => (await root<{ status: string; last_error: string | null; attempts: number }[]>`SELECT status::text AS status, last_error, attempts FROM conversion_events WHERE id = ${id}`)[0];

  it("puts a failed conversion back into the send path, due now, and writes the audit entry in the same transaction", async () => {
    const { id, orderId } = await conversion({ status: "failed", lastError: "HTTP 500" });
    await as(() => refireConversion(rt.sql, id));
    expect(await state(id)).toEqual({ status: "pending", last_error: null, attempts: 6 });
    const [audit] = await root<{ actor_kind: string; actor_admin_user_id: string; changes: Record<string, unknown> }[]>`
      SELECT actor_kind, actor_admin_user_id, changes FROM audit_log WHERE action = 'conversion.refire' AND entity_id = ${id}`;
    expect(audit).toMatchObject({ actor_kind: "admin", actor_admin_user_id: ownerId });
    expect(audit?.changes).toMatchObject({ status: { before: "failed", after: "pending" }, sink: "meta", kind: "mt", order_id: orderId, attempts: 6, resend_sent: false });
  });

  it("resends a sent conversion only when explicitly told to, and records that", async () => {
    const { id } = await conversion({ status: "sent" });
    await expect(as(() => refireConversion(rt.sql, id))).rejects.toThrow(/Only a failed conversion/);
    expect((await state(id))?.status).toBe("sent");
    await as(() => refireConversion(rt.sql, id, { resendSent: true }));
    expect((await state(id))?.status).toBe("pending");
    const [audit] = await root<{ changes: Record<string, unknown> }[]>`SELECT changes FROM audit_log WHERE action = 'conversion.refire' AND entity_id = ${id}`;
    expect(audit?.changes).toMatchObject({ status: { before: "sent", after: "pending" }, resend_sent: true });
  });

  it("refuses what is in flight, the MT of an order that is not paid (cancelled or not), and an unknown id; nothing is audited", async () => {
    const pending = await conversion({ status: "pending" });
    const unpaid = await conversion({ status: "failed", lastError: "HTTP 500", orderStatus: "refunded" });
    const cancelledUnpaid = await conversion({ status: "failed", lastError: "order_not_paid", orderStatus: "review" });
    await expect(as(() => refireConversion(rt.sql, pending.id, { resendSent: true }))).rejects.toThrow(/Only a failed conversion/);
    for (const { id } of [unpaid, cancelledUnpaid]) await expect(as(() => refireConversion(rt.sql, id))).rejects.toThrow(/not paid/);
    await expect(as(() => refireConversion(rt.sql, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow(/no longer exists/);
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'conversion.refire' AND entity_id = ANY (${[pending.id, unpaid.id, cancelledUnpaid.id]})`).toEqual([]);
    expect([(await state(pending.id))?.status, (await state(unpaid.id))?.status, (await state(cancelledUnpaid.id))?.status]).toEqual(["pending", "failed", "failed"]);
  });

  it("re-fires a row payments took out of the send path (order_not_paid) once its order is paid NOW, audited as normal", async () => {
    const { id } = await conversion({ status: "failed", lastError: "order_not_paid" });
    await as(() => refireConversion(rt.sql, id));
    expect(await state(id)).toEqual({ status: "pending", last_error: null, attempts: 6 });
    expect(await root`SELECT 1 FROM audit_log WHERE action = 'conversion.refire' AND entity_id = ${id}`).toHaveLength(1);
  });

  it("the console's login cannot write the conversion log any other way (42501): it reads it and re-fires, nothing more", async () => {
    const { id } = await conversion({ status: "failed" });
    for (const statement of [
      "UPDATE public.conversion_events SET status = 'pending' WHERE id = $1",
      "DELETE FROM public.conversion_events WHERE id = $1",
      "INSERT INTO public.conversion_attempts (conversion_event_id, attempt) VALUES ($1, 99)",
      "DELETE FROM public.conversion_attempts WHERE conversion_event_id = $1",
    ]) await expect(rt.sql.unsafe(statement, [id]), statement).rejects.toMatchObject({ code: "42501" });
    expect(await rt.sql`SELECT id FROM public.conversion_events WHERE id = ${id}`).toHaveLength(1);
  });
});
