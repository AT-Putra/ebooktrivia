// The public API runtime (lib/runtime.ts): least privilege at start (a public_rw login only, the payment
// private key only), and the dev-only midtrans-stub rewrite.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { describe, expect, inject, it, vi } from "vitest";
import { LoginRoleError } from "../src/lib/db.ts";
import { createRuntime } from "../src/lib/runtime.ts";
import { DOMAIN } from "./support.ts";

const env = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: "test",
  DOMAIN,
  DATABASE_URL_PUBLIC: inject("publicDbUrl"),
  VALKEY_URL: inject("valkeyUrl"),
  VALKEY_USERNAME: inject("valkeyUsername"),
  VALKEY_PASSWORD: inject("valkeyPassword"),
  SECRETS_PAYMENT_PRIVATE_KEY: inject("paymentPrivateKey"),
  CAPTCHA_HMAC_KEY: randomBytes(32).toString("hex"),
  PLAYER_AUTH_SECRETS: `1:${randomBytes(32).toString("hex")}`,
  PLAYER_OTP_PEPPER: randomBytes(32).toString("hex"),
  SECRETS_MESSAGING_PUBLIC_KEY: generateScopeKeyPair().publicKey.toString("base64url"),
  ...overrides,
});

describe("public runtime", () => {
  it("starts as a public_rw login with the payment key only", async () => {
    const rt = await createRuntime(env());
    try {
      expect(rt.checkout.domain).toBe(DOMAIN);
      expect(rt.checkout.opener.scopes).toEqual(["payment"]);
      // The notification inbox (US-021) shares the pool, Valkey and the payment key.
      expect(rt.webhooks.opener.scopes).toEqual(["payment"]);
      expect(rt.webhooks.sql).toBe(rt.checkout.sql);
      expect(await rt.checkout.valkey.ping()).toBe("PONG");
    } finally {
      await rt.close();
    }
  });

  it("refuses a login outside public_rw (the superuser here)", async () => {
    await expect(createRuntime(env({ DATABASE_URL_PUBLIC: inject("dbUrl") }))).rejects.toBeInstanceOf(LoginRoleError);
  });

  it("refuses to start without its Cap signing key", async () => {
    await expect(createRuntime(env({ CAPTCHA_HMAC_KEY: undefined }))).rejects.toThrow(/CAPTCHA_HMAC_KEY/);
  });

  it("starts the player login with the messaging PUBLIC key only (US-026)", async () => {
    const rt = await createRuntime(env());
    try {
      expect(rt.play?.playOrigin).toBe(`https://play.${DOMAIN}`);
      expect(rt.play?.sql).toBe(rt.checkout.sql);
      expect(rt.play?.sealer.sealOtp({ otpId: "00000000-0000-4000-8000-000000000001", phone: "+6281234567890", code: "123456" })).toHaveLength(54);
    } finally {
      await rt.close();
    }
  });

  it.each([
    ["SECRETS_MESSAGING_PUBLIC_KEY missing", { SECRETS_MESSAGING_PUBLIC_KEY: undefined }],
    ["SECRETS_MESSAGING_PUBLIC_KEY malformed", { SECRETS_MESSAGING_PUBLIC_KEY: "not-a-key" }],
    ["PLAYER_OTP_PEPPER missing", { PLAYER_OTP_PEPPER: undefined }],
    ["PLAYER_AUTH_SECRETS missing", { PLAYER_AUTH_SECRETS: undefined }],
  ])("without the player login (%s) checkout and the webhook still start; only play is off, with a warning", async (_name, overrides) => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    let rt: Awaited<ReturnType<typeof createRuntime>>;
    try {
      rt = await createRuntime(env(overrides));
    } finally {
      spy.mockRestore();
    }
    try {
      expect(rt.play).toBeNull();
      expect(rt.checkout.opener.scopes).toEqual(["payment"]);
      expect(await rt.checkout.valkey.ping()).toBe("PONG");
      expect(lines.join("")).toContain('"event":"play.disabled"');
    } finally {
      await rt.close();
    }
  });

  it("refuses another scope's private key", async () => {
    const other = generateScopeKeyPair().privateKey.toString("base64url");
    await expect(createRuntime(env({ SECRETS_MESSAGING_PRIVATE_KEY: other }))).rejects.toThrow(/payment private key only/);
    await expect(createRuntime(env({ SECRETS_PAYMENT_PRIVATE_KEY: undefined }))).rejects.toThrow();
  });

  it("sends the sandbox hosts to the local midtrans-stub with PUBLIC_DEV_MIDTRANS_STUB_URL (dev only)", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers.host ?? ""}`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "t", redirect_url: "https://app.sandbox.midtrans.com/snap/v4/redirection/t" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const stub = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const rt = await createRuntime(env({ PUBLIC_DEV_MIDTRANS_STUB_URL: stub }));
    try {
      const response = await rt.checkout.midtransFetch("https://app.sandbox.midtrans.com/snap/v1/transactions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(201);
      expect(seen).toEqual([`POST /snap/v1/transactions ${new URL(stub).host}`]);
    } finally {
      await rt.close();
      server.close();
    }
    await expect(createRuntime(env({ NODE_ENV: "production", PUBLIC_DEV_MIDTRANS_STUB_URL: stub }))).rejects.toThrow(/dev-only/);
  });
});
