// Criterion 2 end to end on PostgreSQL: the admin app (admin_rw, public keys only) writes a
// sealed conversions secret bound to an adnet + host; the worker (worker_rw, private keys) loads
// it through @ebooktrivia/db conversionSecretStore and renders the postback with core.
import { randomBytes } from "node:crypto";
import { postbackSecretNames, renderPostbackUrl, TemplateError } from "@ebooktrivia/core";
import { conversionSecretStore, PG_CONNECTION_OPTIONS } from "@ebooktrivia/db";
import postgres from "postgres";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  createSecretOpener,
  createSecretSealer,
  CryptoError,
  generateScopeKeyPair,
  loadConversionSecretResolver,
  type SealedSecret,
} from "../src/index.ts";

const sql = postgres(inject("dbUrl"), { ...PG_CONNECTION_OPTIONS, max: 4, onnotice: () => undefined });
afterAll(async () => {
  await sql.end();
});

const conversions = generateScopeKeyPair();
const payment = generateScopeKeyPair();
const admin = createSecretSealer({ conversions: conversions.publicKey, payment: payment.publicKey });
const worker = createSecretOpener({ conversions: conversions.privateKey, payment: payment.privateKey });

const HOST = "track.adnet.example";
const VALUES = { clickid: "c-9", txid: "t-9", payout: "7500", status: "mt" } as const;
const template = (host: string) => `https://${host}/pb?click={clickid}&tx={txid}&p={payout}&s={status}&key={secret:api_key}`;

const suffix = (): string => randomBytes(4).toString("hex");

async function createAdnet(endpointHost: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO adnets (slug, name, clickid_param, endpoint_host)
    VALUES (${`adnet-${suffix()}`}, 'Adnet', 'clickid', ${endpointHost}) RETURNING id`;
  if (row === undefined) throw new Error("no adnet");
  return row.id;
}

/** Writes a sealed secret as admin_rw, the way the admin app will. */
async function writeSecret(secret: SealedSecret): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE admin_rw");
    await tx`
      INSERT INTO public.settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${secret.id}, ${secret.scope}, ${secret.name}, ${secret.adnetId}, ${secret.boundHost}, ${secret.ciphertext},
              ${secret.nonce}, ${secret.sealedDek}, ${secret.keyId}, ${secret.last4})`;
  });
}

/** Renders as the worker: worker_rw loads the rows, the opener decrypts, core renders. */
async function workerRender(binding: { adnetId: string; host: string }, tpl = template(binding.host)): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE worker_rw");
    const resolve = await loadConversionSecretResolver(conversionSecretStore(tx), worker, {
      ...binding,
      names: postbackSecretNames(tpl),
    });
    return renderPostbackUrl(tpl, VALUES, binding, resolve);
  });
}

async function workerRenderError(binding: { adnetId: string; host: string }, tpl?: string): Promise<unknown> {
  try {
    await workerRender(binding, tpl);
  } catch (e) {
    return e;
  }
  throw new Error("expected the render to fail");
}

const conversionSecret = (adnetId: string, boundHost: string, plaintext: string) =>
  admin.sealSecret({ scope: "conversions", name: "api_key", adnetId, boundHost, plaintext });

describe("{secret:name} on PostgreSQL (endpoint binding)", () => {
  it("resolves only for the bound adnet + host", async () => {
    const adnet = await createAdnet(HOST);
    await writeSecret(conversionSecret(adnet, HOST, "pk_live_int_0001"));
    expect(await workerRender({ adnetId: adnet, host: HOST })).toBe(
      `https://${HOST}/pb?click=c-9&tx=t-9&p=7500&s=mt&key=pk_live_int_0001`,
    );
  });

  it("gives another adnet no secret, even on the same host", async () => {
    const adnet = await createAdnet(HOST);
    const other = await createAdnet(HOST);
    await writeSecret(conversionSecret(adnet, HOST, "pk_live_int_0002"));
    const error = await workerRenderError({ adnetId: other, host: HOST });
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe("secret_unresolved");
  });

  it("gives another host or port no secret", async () => {
    const adnet = await createAdnet(HOST);
    await writeSecret(conversionSecret(adnet, HOST, "pk_live_int_0003"));
    for (const host of ["other.adnet.example", `${HOST}:8443`]) {
      expect(((await workerRenderError({ adnetId: adnet, host })) as TemplateError).code).toBe("secret_unresolved");
    }
  });

  it("has no secret after the adnet's endpoint host changed (the trigger deleted it)", async () => {
    const adnet = await createAdnet(HOST);
    const secret = conversionSecret(adnet, HOST, "pk_live_int_0004");
    await writeSecret(secret);
    expect(await workerRender({ adnetId: adnet, host: HOST })).toContain("key=pk_live_int_0004");
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE admin_rw");
      await tx`UPDATE public.adnets SET endpoint_host = 'attacker.example' WHERE id = ${adnet}`;
    });
    expect(await sql`SELECT 1 FROM settings_secrets WHERE id = ${secret.id}`).toEqual([]);
    for (const host of [HOST, "attacker.example"]) {
      expect(((await workerRenderError({ adnetId: adnet, host })) as TemplateError).code).toBe("secret_unresolved");
    }
  });

  it("fails closed on a row the superuser relabelled with a full byte copy (AAD mismatch), and the DB refuses an in-place relabel", async () => {
    const adnet = await createAdnet(HOST);
    const midtrans = admin.sealSecret({
      scope: "payment",
      name: `midtrans.server_key_${suffix()}`,
      adnetId: null,
      boundHost: "api.midtrans.com",
      plaintext: "SB-Mid-server-INT-REAL",
    });
    await writeSecret(midtrans);
    const inPlace = sql`
      UPDATE settings_secrets SET scope = 'conversions', name = 'api_key', adnet_id = ${adnet}, bound_host = ${HOST}
       WHERE id = ${midtrans.id}`;
    await expect(inPlace).rejects.toMatchObject({ code: "ET060" });
    // A new row carrying the payment row's bytes under the attacker's labels (and the conversions key id).
    const [copy] = await sql<{ id: string }[]>`
      INSERT INTO settings_secrets (scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      SELECT 'conversions', 'api_key', ${adnet}, ${HOST}, ciphertext, nonce, sealed_dek, ${admin.keyId("conversions")}, ''
        FROM settings_secrets WHERE id = ${midtrans.id}
      RETURNING id`;
    expect(copy).toBeDefined();
    const error = await workerRenderError({ adnetId: adnet, host: HOST });
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("decrypt_failed");
  });

  it("is invisible to public_rw (no SELECT on settings_secrets)", async () => {
    const adnet = await createAdnet(HOST);
    const read = sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE public_rw");
      await conversionSecretStore(tx).findConversionSecrets({ adnetId: adnet, host: HOST, names: ["api_key"] });
    });
    await expect(read).rejects.toMatchObject({ code: "42501" });
  });
});
