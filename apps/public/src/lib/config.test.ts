import { describe, expect, it } from "vitest";
import { loadPublicConfig, parseValkey, PublicConfigError } from "./config.ts";

const base = {
  NODE_ENV: "production",
  DOMAIN: "ebooktrivia.example.id",
  DATABASE_URL_PUBLIC: "postgres://ebt_public:pw@127.0.0.1:5432/ebt",
  VALKEY_URL: "redis://10.89.1.5:6379",
  VALKEY_USERNAME: "public",
  VALKEY_PASSWORD: "pw",
  CAPTCHA_HMAC_KEY: "a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2",
  PLAYER_AUTH_SECRETS: `2:${"c3d4".repeat(16)}, 1:${"E5F6".repeat(16)}`,
  PLAYER_OTP_PEPPER: "0f1e".repeat(16),
};

describe("public config", () => {
  it("loads a production public.env", () => {
    expect(loadPublicConfig(base)).toEqual({
      production: true,
      domain: "ebooktrivia.example.id",
      databaseUrl: base.DATABASE_URL_PUBLIC,
      valkey: { host: "10.89.1.5", port: 6379, db: 0, username: "public", password: "pw", tls: false },
      captchaKey: Buffer.from(base.CAPTCHA_HMAC_KEY, "hex"),
      midtransStubUrl: null,
      play: {
        playOrigin: "https://play.ebooktrivia.example.id",
        playerAuthSecrets: [
          { version: 2, value: "c3d4".repeat(16) },
          { version: 1, value: "e5f6".repeat(16) },
        ],
        otpPepper: Buffer.from(base.PLAYER_OTP_PEPPER, "hex"),
      },
      playUnavailable: null,
      wahaWebhookSecret: undefined,
      dataDir: "/srv/data",
    });
  });

  it("parses the player login secrets (US-026); a missing or malformed one disables the login only, naming the variable", () => {
    for (const secrets of [undefined, "", "1:abc", `1:${"ab".repeat(32)},1:${"cd".repeat(32)}`, `1:${"ab".repeat(32)},2:${"AB".repeat(32)}`, `1:${"0".repeat(64)}`, `1:${"ab".repeat(32)}`, `x:${"ab".repeat(32)}`]) {
      const config = loadPublicConfig({ ...base, PLAYER_AUTH_SECRETS: secrets });
      expect(config.play, String(secrets)).toBeNull();
      expect(config.playUnavailable, String(secrets)).toMatch(/PLAYER_AUTH_SECRETS/);
      expect(config.captchaKey).toHaveLength(32);
    }
    for (const pepper of [undefined, "ab".repeat(31), "zz".repeat(32)]) {
      expect(loadPublicConfig({ ...base, PLAYER_OTP_PEPPER: pepper }).playUnavailable, String(pepper)).toMatch(/PLAYER_OTP_PEPPER/);
    }
    expect(loadPublicConfig({ ...base, PLAYER_OTP_PEPPER: "77".repeat(32) }).playUnavailable).toMatch(/one byte repeated/);
  });

  it("allows a loopback play origin outside production only (the e2e server)", () => {
    expect(loadPublicConfig({ ...base, NODE_ENV: "test", PUBLIC_DEV_PLAY_ORIGIN: "http://127.0.0.1:3103" }).play?.playOrigin).toBe("http://127.0.0.1:3103");
    expect(() => loadPublicConfig({ ...base, PUBLIC_DEV_PLAY_ORIGIN: "http://127.0.0.1:3103" })).toThrow(/dev-only/);
    for (const url of ["http://10.0.0.1:3103", "http://127.0.0.1:3103/", "ftp://127.0.0.1", "nope"]) {
      expect(() => loadPublicConfig({ ...base, NODE_ENV: "development", PUBLIC_DEV_PLAY_ORIGIN: url }), url).toThrow(/loopback/);
    }
  });

  it("takes the WAHA webhook secret (16 to 256 printable characters) and the data directory", () => {
    expect(loadPublicConfig({ ...base, WAHA_WEBHOOK_HMAC_SECRET: "x".repeat(32), PUBLIC_DATA_DIR: "/data" })).toMatchObject({ wahaWebhookSecret: "x".repeat(32), dataDir: "/data" });
    for (const bad of ["short", "x".repeat(257), `${"x".repeat(20)} spaced`, `${"x".repeat(20)}\n`]) {
      expect(() => loadPublicConfig({ ...base, WAHA_WEBHOOK_HMAC_SECRET: bad }), bad).toThrow(/WAHA_WEBHOOK_HMAC_SECRET/);
    }
  });

  it("requires NODE_ENV, a lowercase DOMAIN and a postgres URL", () => {
    expect(() => loadPublicConfig({ ...base, NODE_ENV: undefined })).toThrow(PublicConfigError);
    for (const domain of [undefined, "Example.id", "localhost", "example.id.", "exa mple.id"]) expect(() => loadPublicConfig({ ...base, DOMAIN: domain }), String(domain)).toThrow(/DOMAIN/);
    expect(() => loadPublicConfig({ ...base, DATABASE_URL_PUBLIC: "mysql://x" })).toThrow(/DATABASE_URL_PUBLIC/);
  });

  it("requires CAPTCHA_HMAC_KEY: at least 32 bytes of canonical hex, as provisioning generates it", () => {
    expect(loadPublicConfig({ ...base, CAPTCHA_HMAC_KEY: "AB12".repeat(20) }).captchaKey).toHaveLength(40);
    for (const key of [undefined, "", "ab".repeat(31), "zz".repeat(32), Buffer.alloc(32).toString("base64"), "a".repeat(65)]) {
      expect(() => loadPublicConfig({ ...base, CAPTCHA_HMAC_KEY: key }), String(key)).toThrow(/CAPTCHA_HMAC_KEY/);
    }
    // One byte repeated is a placeholder, not a key.
    for (const key of ["0".repeat(64), "ff".repeat(32), "a1".repeat(48).replace(/1/g, "a")]) {
      expect(() => loadPublicConfig({ ...base, CAPTCHA_HMAC_KEY: key }), key).toThrow(/one byte repeated/);
    }
  });

  it("refuses a messaging or conversions private key (public.env holds the payment key only)", () => {
    expect(() => loadPublicConfig({ ...base, SECRETS_MESSAGING_PRIVATE_KEY: "" })).toThrow(/SECRETS_MESSAGING_PRIVATE_KEY/);
    expect(() => loadPublicConfig({ ...base, SECRETS_CONVERSIONS_PRIVATE_KEY: "x" })).toThrow(/SECRETS_CONVERSIONS_PRIVATE_KEY/);
  });

  it("allows the midtrans-stub rewrite on loopback outside production only", () => {
    expect(loadPublicConfig({ ...base, NODE_ENV: "test", PUBLIC_DEV_MIDTRANS_STUB_URL: "http://127.0.0.1:53001" }).midtransStubUrl).toBe("http://127.0.0.1:53001");
    expect(() => loadPublicConfig({ ...base, PUBLIC_DEV_MIDTRANS_STUB_URL: "http://127.0.0.1:53001" })).toThrow(/dev-only/);
    for (const url of ["http://10.0.0.1:53001", "http://127.0.0.1:53001/x", "ftp://127.0.0.1", "nope"]) {
      expect(() => loadPublicConfig({ ...base, NODE_ENV: "development", PUBLIC_DEV_MIDTRANS_STUB_URL: url }), url).toThrow(/loopback/);
    }
  });

  it("parses Valkey like the worker: no credentials in the URL, both or neither of user and password, required in production", () => {
    expect(parseValkey({ VALKEY_URL: "rediss://[::1]:6380/0" }, false)).toEqual({ host: "::1", port: 6380, db: 0, username: undefined, password: undefined, tls: true });
    expect(parseValkey({ VALKEY_URL: "redis://h:1" }, false).db).toBe(0);
    for (const db of ["1", "2", "15", "00"]) expect(() => parseValkey({ VALKEY_URL: `redis://h:1/${db}` }, false), db).toThrow(/database 0/);
    expect(() => parseValkey({ VALKEY_URL: "redis://u:p@h:1" }, false)).toThrow(/credentials/);
    expect(() => parseValkey({ VALKEY_URL: "redis://h:1", VALKEY_USERNAME: "u" }, false)).toThrow(/go together/);
    expect(() => parseValkey({ VALKEY_URL: "redis://h:1" }, true)).toThrow(/required in production/);
    expect(() => parseValkey({ VALKEY_URL: "http://h:1" }, false)).toThrow(/VALKEY_URL/);
    expect(() => parseValkey({ VALKEY_URL: "redis://h:1/x" }, false)).toThrow(/database 0/);
    expect(() => parseValkey({ VALKEY_URL: "redis://h:1?a=1" }, false)).toThrow(/query/);
    expect(() => parseValkey({}, false)).toThrow(/VALKEY_URL/);
  });
});
