// US-021: how the worker reaches Midtrans (src/midtrans-access.ts). It opens the deployment's sealed
// server key with the payment private key it holds by design (plan §3), as worker_rw, on every use.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { afterAll, describe, expect, it } from "vitest";
import { MidtransKeyUnavailable, midtransSource, paymentsFromEnv } from "../src/midtrans-access.ts";
import { loadWorkerConfig } from "../src/worker-config.ts";
import { sql } from "./support/db.ts";
import { workerPool } from "./support/midtrans.ts";
import { workerEnv } from "./support/processes.ts";
import { uniquePrefix } from "./support/valkey.ts";

const workerSql = workerPool(2);
const keys = generateScopeKeyPair();
const SERVER_KEY = "SB-Mid-server-ACCESS0123456789";
const sealed = createSecretSealer({ payment: keys.publicKey }).sealSecret({
  scope: "payment",
  name: SECRET_NAMES.midtransServerKey("sandbox"),
  adnetId: null,
  boundHost: null,
  plaintext: SERVER_KEY,
});
await sql`
  INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
  VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
afterAll(async () => {
  await sql`DELETE FROM settings_secrets WHERE id = ${sealed.id}`;
});

const noFetch = () => Promise.reject(new Error("no request expected"));

async function unavailable(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(MidtransKeyUnavailable);
    return (error as Error).message;
  }
  throw new Error("expected MidtransKeyUnavailable");
}

async function withEnvironment<T>(value: string, fn: () => Promise<T>): Promise<T> {
  await sql`UPDATE app_settings SET value = ${JSON.stringify(value)}::text::jsonb WHERE key = 'midtrans.environment'`;
  try {
    return await fn();
  } finally {
    await sql`UPDATE app_settings SET value = '"sandbox"' WHERE key = 'midtrans.environment'`;
  }
}

describe("midtransSource", () => {
  it("opens the sandbox server key as worker_rw and pins the environment's hosts", async () => {
    const config = await midtransSource(createSecretOpener({ payment: keys.privateKey }), noFetch)(workerSql);
    expect(config).toMatchObject({ serverKey: SERVER_KEY, snapBaseUrl: "https://app.sandbox.midtrans.com", apiBaseUrl: "https://api.sandbox.midtrans.com" });
  });

  it("fails closed: another environment's key missing, a key it cannot open, an unknown environment", async () => {
    const source = midtransSource(createSecretOpener({ payment: keys.privateKey }), noFetch);
    expect(await withEnvironment("production", () => unavailable(source(workerSql)))).toMatch(/missing/);
    expect(await withEnvironment("staging", () => unavailable(source(workerSql)))).toMatch(/environment/);
    const stranger = midtransSource(createSecretOpener({ payment: generateScopeKeyPair().privateKey }), noFetch);
    expect(await unavailable(stranger(workerSql))).toMatch(/unreadable/);
  });
});

describe("paymentsFromEnv", () => {
  const env = (extra: Record<string, string> = {}) => workerEnv(uniquePrefix(), extra);

  it("is off without the payment private key", () => {
    expect(paymentsFromEnv(env(), loadWorkerConfig(env()))).toBeUndefined();
  });

  it("with the key: the WhatsApp delay of the config, and the sandbox hosts sent to the dev stub", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers.authorization ?? ""}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status_code: "404", status_message: "Transaction does not exist." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const stub = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const e = env({ SECRETS_PAYMENT_PRIVATE_KEY: keys.privateKey.toString("base64url"), WORKER_DEV_MIDTRANS_STUB_URL: stub, WORKER_WA_DELAY_MS: "0" });
    const port = paymentsFromEnv(e, loadWorkerConfig(e));
    try {
      expect(port?.waDelayMs).toBe(0);
      const config = await port?.midtrans(workerSql);
      const response = await config?.fetch("https://api.sandbox.midtrans.com/v2/abc-1/status", { method: "GET", headers: { authorization: "Basic x" } });
      expect(response?.status).toBe(404);
      expect(seen).toEqual(["GET /v2/abc-1/status Basic x"]);
      // Without the stub URL and the dev flags the safe-fetch is strict: the same loopback address is refused.
      const strict = env({ SECRETS_PAYMENT_PRIVATE_KEY: keys.privateKey.toString("base64url"), WORKER_DEV_ALLOW_HTTP: "false", WORKER_DEV_ALLOW_LOOPBACK: "false" });
      const strictPort = paymentsFromEnv(strict, loadWorkerConfig(strict));
      await expect((await strictPort?.midtrans(workerSql))?.fetch(`${stub}/v2/abc-1/status`, { method: "GET", headers: {} })).rejects.toThrow();
      await strictPort?.close?.();
      expect(seen).toHaveLength(1);
    } finally {
      await port?.close?.();
      server.close();
    }
  });
});
