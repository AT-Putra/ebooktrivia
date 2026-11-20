// Criterion 2 (endpoint binding), unit level: `{secret:name}` resolves only for the bound adnet +
// host, end to end through core's renderPostbackUrl. The DB is a fake store here; the same flow
// runs against PostgreSQL in test/conversion-secrets.int.test.ts.
import { postbackSecretNames, renderPostbackUrl, TemplateError } from "@ebooktrivia/core";
import { describe, expect, it } from "vitest";
import { type ConversionSecretQuery, type ConversionSecretStore, loadConversionSecretResolver } from "./conversion-secrets.ts";
import { CryptoError, generateScopeKeyPair } from "./sealed-box.ts";
import { createSecretOpener } from "./opener.ts";
import { createSecretSealer, type StoredSecretRow } from "./secrets.ts";

const keys = generateScopeKeyPair();
const payment = generateScopeKeyPair();
const sealer = createSecretSealer({ conversions: keys.publicKey, payment: payment.publicKey });
const opener = createSecretOpener({ conversions: keys.privateKey, payment: payment.privateKey });

const ADNET_A = "0b9c4a61-7d2e-4f3a-9b8c-1d2e3f4a5b6c";
const ADNET_B = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const HOST = "track.adnet.example";
const TEMPLATE = `https://${HOST}/pb?click={clickid}&tx={txid}&p={payout}&s={status}&key={secret:api_key}`;
const VALUES = { clickid: "c-1", txid: "t-1", payout: "5000", status: "mt" } as const;

/** A fake settings_secrets table with the store's WHERE clause, recording every query. */
function fakeStore(rows: StoredSecretRow[]): ConversionSecretStore & { queries: ConversionSecretQuery[] } {
  const queries: ConversionSecretQuery[] = [];
  return {
    queries,
    findConversionSecrets(query) {
      queries.push(query);
      return Promise.resolve(
        rows.filter(
          (r) => r.scope === "conversions" && r.adnetId === query.adnetId && r.boundHost === query.host && query.names.includes(r.name),
        ),
      );
    },
  };
}

const secretFor = (adnetId: string, boundHost: string, plaintext = "pk_live_abc/+&=123") =>
  sealer.sealSecret({ scope: "conversions", name: "api_key", adnetId, boundHost, plaintext });

async function render(store: ConversionSecretStore, binding: { adnetId: string; host: string }, template = TEMPLATE) {
  const resolve = await loadConversionSecretResolver(store, opener, { ...binding, names: postbackSecretNames(template) });
  return renderPostbackUrl(template, VALUES, binding, resolve);
}

async function renderError(store: ConversionSecretStore, binding: { adnetId: string; host: string }, template = TEMPLATE) {
  try {
    await render(store, binding, template);
  } catch (e) {
    return e;
  }
  throw new Error("expected the render to fail");
}

describe("{secret:name} resolver (endpoint binding)", () => {
  it("resolves for the bound adnet + host, percent-encoded, loading only the template's names", async () => {
    const store = fakeStore([secretFor(ADNET_A, HOST)]);
    const url = await render(store, { adnetId: ADNET_A, host: HOST });
    expect(url).toBe(`https://${HOST}/pb?click=c-1&tx=t-1&p=5000&s=mt&key=pk_live_abc%2F%2B%26%3D123`);
    expect(store.queries).toEqual([{ adnetId: ADNET_A, host: HOST, names: ["api_key"] }]);
  });

  it("gives another adnet no secret", async () => {
    const store = fakeStore([secretFor(ADNET_A, HOST)]);
    const error = await renderError(store, { adnetId: ADNET_B, host: HOST });
    expect(error).toBeInstanceOf(TemplateError);
    expect((error as TemplateError).code).toBe("secret_unresolved");
  });

  it("gives another host or another port no secret", async () => {
    const store = fakeStore([secretFor(ADNET_A, HOST)]);
    for (const host of ["other.adnet.example", `${HOST}:8443`]) {
      const template = TEMPLATE.replace(HOST, host);
      const error = await renderError(store, { adnetId: ADNET_A, host }, template);
      expect((error as TemplateError).code).toBe("secret_unresolved");
    }
    // A secret bound to the non-default port resolves only there.
    const ported = fakeStore([secretFor(ADNET_A, `${HOST}:8443`)]);
    expect(await render(ported, { adnetId: ADNET_A, host: `${HOST}:8443` }, TEMPLATE.replace(HOST, `${HOST}:8443`))).toContain(
      `https://${HOST}:8443/pb?`,
    );
    expect(((await renderError(ported, { adnetId: ADNET_A, host: HOST })) as TemplateError).code).toBe("secret_unresolved");
  });

  it("has no secret after a host change cleared it", async () => {
    const rows = [secretFor(ADNET_A, HOST)];
    const store = fakeStore(rows);
    expect(await render(store, { adnetId: ADNET_A, host: HOST })).toContain("key=");
    rows.length = 0; // the DB trigger deletes the bound row when adnets.endpoint_host changes
    const moved = "new.adnet.example";
    for (const binding of [
      { adnetId: ADNET_A, host: HOST },
      { adnetId: ADNET_A, host: moved },
    ]) {
      const error = await renderError(store, binding, TEMPLATE.replace(HOST, binding.host));
      expect((error as TemplateError).code).toBe("secret_unresolved");
    }
  });

  it("does not trust the store: rows for another adnet, host, scope or name are ignored", async () => {
    const lying: ConversionSecretStore = {
      findConversionSecrets: () =>
        Promise.resolve([
          secretFor(ADNET_B, HOST),
          secretFor(ADNET_A, "attacker.example"),
          { ...sealer.sealSecret({ scope: "payment", name: "api_key", adnetId: ADNET_A, boundHost: HOST, plaintext: "SB-Mid-server-xyz" }) },
          sealer.sealSecret({ scope: "conversions", name: "other_key", adnetId: ADNET_A, boundHost: HOST, plaintext: "x".repeat(12) }),
        ]),
    };
    const error = await renderError(lying, { adnetId: ADNET_A, host: HOST });
    expect((error as TemplateError).code).toBe("secret_unresolved");
  });

  it("fails closed on a relabelled row: the payment secret relabelled as this adnet's conversions secret", async () => {
    const midtrans = sealer.sealSecret({ scope: "payment", name: "midtrans.server_key", adnetId: null, boundHost: "api.midtrans.com", plaintext: "SB-Mid-server-REAL" });
    const relabelled = { ...midtrans, scope: "conversions", name: "api_key", adnetId: ADNET_A, boundHost: HOST, keyId: sealer.keyId("conversions") };
    const store = fakeStore([relabelled]);
    const error = await renderError(store, { adnetId: ADNET_A, host: HOST });
    expect(error).toBeInstanceOf(CryptoError);
    expect((error as CryptoError).code).toBe("decrypt_failed");
  });

  it("does not query the store for a template without secrets, and answers only its own binding", async () => {
    const store = fakeStore([secretFor(ADNET_A, HOST)]);
    const template = `https://${HOST}/pb?click={clickid}&tx={txid}&p={payout}&s={status}`;
    expect(await render(store, { adnetId: ADNET_A, host: HOST }, template)).toContain("click=c-1");
    expect(store.queries).toEqual([]);
    const resolve = await loadConversionSecretResolver(store, opener, { adnetId: ADNET_A, host: HOST, names: ["api_key", "api_key"] });
    expect(store.queries).toEqual([{ adnetId: ADNET_A, host: HOST, names: ["api_key"] }]);
    expect(resolve({ name: "api_key", adnetId: ADNET_A, host: HOST })).toMatchObject({
      scope: "conversions",
      adnetId: ADNET_A,
      boundHost: HOST,
    });
    expect(resolve({ name: "api_key", adnetId: ADNET_B, host: HOST })).toBeUndefined();
    expect(resolve({ name: "api_key", adnetId: ADNET_A, host: `${HOST}:443` })).toBeUndefined();
    expect(resolve({ name: "missing", adnetId: ADNET_A, host: HOST })).toBeUndefined();
  });
});
