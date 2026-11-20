// A fresh migrated database with a LOGIN role in public_rw (how M4 deploys ebt_public), and the
// sealed sandbox Midtrans server key of the midtrans-stub, sealed to a payment key pair made for this
// run (the admin app would have written it, US-017). Dropped afterwards.
// DEV ONLY defaults: the local dev stack (infra/dev/compose.yaml). CI sets TEST_PG_URL and
// TEST_VALKEY_URL; the Valkey ACL is the dev stack's (user `public`).
import { createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
    publicDbUrl: string;
    valkeyUrl: string;
    valkeyUsername: string;
    valkeyPassword: string;
    /** A Valkey user that may list keys (the dev ACL's `worker`): only the tests inspect with it. */
    valkeyInspectUsername: string;
    valkeyInspectPassword: string;
    paymentPrivateKey: string;
    midtransServerKey: string;
  }
}

/** The midtrans-stub's key in these tests (DEV ONLY, test value). */
export const STUB_SERVER_KEY = "SB-Mid-server-PUBLICINT0123456789";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const db = await createTestDatabase("ebt_pub", ["public_rw"]);
  const keys = generateScopeKeyPair();
  const sealed = createSecretSealer({ payment: keys.publicKey }).sealSecret({
    scope: "payment",
    name: SECRET_NAMES.midtransServerKey("sandbox"),
    adnetId: null,
    boundHost: null,
    plaintext: STUB_SERVER_KEY,
  });
  const root = postgres(db.url, { max: 1, onnotice: () => undefined });
  try {
    await root`
      INSERT INTO public.settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
      VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext},
              ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
  } catch (error) {
    await root.end();
    await db.drop();
    throw error;
  }
  await root.end();
  project.provide("dbUrl", db.url);
  project.provide("publicDbUrl", db.logins.public_rw ?? "");
  project.provide("valkeyUrl", process.env["TEST_VALKEY_URL"] ?? "redis://127.0.0.1:56379"); // DEV ONLY
  project.provide("valkeyUsername", process.env["TEST_VALKEY_PUBLIC_USERNAME"] ?? "public");
  project.provide("valkeyPassword", process.env["TEST_VALKEY_PUBLIC_PASSWORD"] ?? "public-devonly"); // DEV ONLY
  project.provide("valkeyInspectUsername", process.env["TEST_VALKEY_USERNAME"] ?? "worker");
  project.provide("valkeyInspectPassword", process.env["TEST_VALKEY_PASSWORD"] ?? "worker-devonly"); // DEV ONLY
  project.provide("paymentPrivateKey", keys.privateKey.toString("base64url"));
  project.provide("midtransServerKey", STUB_SERVER_KEY);
  return () => db.drop();
}
