// Player login e2e environment (US-026): a throwaway migrated database with a public_rw LOGIN role, the
// production build of apps/public started with `next start` on its own port (the build the mockup specs'
// web server makes), the dev stack's Valkey as the ACL user `public`, and a messaging key pair of its own:
// the app seals each OTP to the public key, and the spec opens it with the private key, as the worker would
// (no worker runs here). `next start` serves plain http on 127.0.0.1, so the app gets the dev-only
// PUBLIC_DEV_PLAY_ORIGIN (refused with NODE_ENV=production; hence NODE_ENV=test).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PUBLIC_VALKEY_LIBRARY_CODE } from "@ebooktrivia/adapters/valkey-functions";
import { createSecretOpener, createSecretSealer, generateScopeKeyPair } from "@ebooktrivia/crypto";
import { SECRET_NAMES } from "@ebooktrivia/db";
import { createTestDatabase } from "@ebooktrivia/test-support/database";
import { loadValkeyFunctions } from "@ebooktrivia/test-support/valkey";
import postgres from "postgres";

export const PLAY_PORT = 3103;
export const PLAY_URL = `http://127.0.0.1:${String(PLAY_PORT)}`;

const publicDir = fileURLToPath(new URL("../../apps/public/", import.meta.url));

export interface PlayEnv {
  readonly sql: postgres.Sql;
  /** The app's origin (http://127.0.0.1:{port}). */
  readonly url: string;
  /** The published program the eligible players have paid for (US-027: the trivia page /{programSlug}). */
  readonly programId: string;
  readonly programSlug: string;
  /** An eligible player's phone (E.164) and id. */
  eligiblePlayer(): Promise<{ readonly id: string; readonly phone: string }>;
  /** The newest OTP code sent to `phone`, opened from the outbox with the messaging private key. */
  sentCode(phone: string): Promise<string | null>;
  stop(): Promise<void>;
}

/** `port`: each spec that starts its own server takes its own (the specs run in parallel workers). */
export async function startPlayEnv(port = PLAY_PORT): Promise<PlayEnv> {
  const url = `http://127.0.0.1:${String(port)}`;
  const db = await createTestDatabase("ebt_e2e_play", ["public_rw"]);
  const sql = postgres(db.url, { max: 2, onnotice: () => undefined });
  const messaging = generateScopeKeyPair();
  const payment = generateScopeKeyPair();
  const opener = createSecretOpener({ messaging: messaging.privateKey });
  // A sealed sandbox Midtrans key, so the runtime's checkout side starts as it does in production.
  const sealed = createSecretSealer({ payment: payment.publicKey }).sealSecret({
    scope: "payment",
    name: SECRET_NAMES.midtransServerKey("sandbox"),
    adnetId: null,
    boundHost: null,
    plaintext: "SB-Mid-server-E2EPLAY0123456789",
  });
  await sql`
    INSERT INTO settings_secrets (id, scope, name, adnet_id, bound_host, ciphertext, nonce, sealed_dek, key_id, last4)
    VALUES (${sealed.id}, ${sealed.scope}, ${sealed.name}, ${sealed.adnetId}, ${sealed.boundHost}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.sealedDek}, ${sealed.keyId}, ${sealed.last4})`;
  const product = (await sql<{ id: string }[]>`INSERT INTO products (title, price_idr) VALUES ('Ebook E2E', 49000) RETURNING id`)[0];
  const programSlug = `e2e-${randomBytes(4).toString("hex")}`;
  const program = (
    await sql<{ id: string }[]>`
      INSERT INTO programs (product_id, slug, name, status, sales_start_at, sales_end_at, grace_days)
      VALUES (${product?.id ?? ""}, ${programSlug}, 'Program', 'published', now() - interval '1 day', now() + interval '30 days', 30) RETURNING id`
  )[0];

  const env = {
    NODE_ENV: "test",
    DOMAIN: "ebooktrivia.example.test",
    DATABASE_URL_PUBLIC: db.logins.public_rw ?? "",
    VALKEY_URL: process.env["TEST_VALKEY_URL"] ?? "redis://127.0.0.1:56379", // DEV ONLY
    VALKEY_USERNAME: process.env["TEST_VALKEY_PUBLIC_USERNAME"] ?? "public",
    VALKEY_PASSWORD: process.env["TEST_VALKEY_PUBLIC_PASSWORD"] ?? "public-devonly", // DEV ONLY
    CAPTCHA_HMAC_KEY: randomBytes(32).toString("hex"),
    SECRETS_PAYMENT_PRIVATE_KEY: payment.privateKey.toString("base64url"),
    SECRETS_MESSAGING_PUBLIC_KEY: messaging.publicKey.toString("base64url"),
    PLAYER_AUTH_SECRETS: `1:${randomBytes(32).toString("hex")}`,
    PLAYER_OTP_PEPPER: randomBytes(32).toString("hex"),
    PUBLIC_DEV_PLAY_ORIGIN: url,
  };
  // US-031: the worker loads public's rate-limit function in production; no worker runs here.
  await loadValkeyFunctions({ url: env.VALKEY_URL, username: process.env["TEST_VALKEY_USERNAME"] ?? "worker", password: process.env["TEST_VALKEY_PASSWORD"] ?? "worker-devonly" }, PUBLIC_VALKEY_LIBRARY_CODE); // DEV ONLY
  const nextBin = createRequire(`${publicDir}package.json`).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: publicDir,
    env: { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", ...env },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${url}/login`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("public did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    sql,
    url,
    programId: program?.id ?? "",
    programSlug,
    async eligiblePlayer() {
      const phone = `+62812${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
      const row = (await sql<{ id: string }[]>`INSERT INTO players (phone, name) VALUES (${phone}, 'Budi Santoso') RETURNING id`)[0];
      await sql`INSERT INTO player_programs (player_id, program_id, first_paid_at, eligible) VALUES (${row?.id ?? ""}, ${program?.id ?? ""}, now(), true)`;
      return { id: row?.id ?? "", phone };
    },
    async sentCode(phone) {
      const [row] = await sql<{ sealed: Buffer | null; otp_id: string }[]>`
        SELECT sealed, payload->>'otp_id' AS otp_id FROM outbox WHERE topic = 'otp.send' AND payload->>'phone' = ${phone} ORDER BY created_at DESC LIMIT 1`;
      if (row === undefined || row.sealed === null) return null;
      return opener.openOtp({ otpId: row.otp_id, phone, sealed: row.sealed });
    },
    async stop() {
      child.kill();
      await sql.end({ timeout: 5 });
      await db.drop();
    },
  };
}
