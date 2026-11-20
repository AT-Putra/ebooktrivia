import { generateScopeKeyPair } from "@ebooktrivia/crypto";
import { describe, expect, it } from "vitest";
import { AdminConfigError } from "../config.ts";
import { DEFAULT_PDF_MAX_BYTES, loadSettingsConfig, NO_SETTINGS, parseDomain, privateKeyVariables } from "./env.ts";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

describe("admin settings config (plan M2.3: the admin process holds public keys only)", () => {
  const pair = generateScopeKeyPair();

  it.each(["SECRETS_PAYMENT_PRIVATE_KEY", "SECRETS_MESSAGING_PRIVATE_KEY", "SECRETS_CONVERSIONS_PRIVATE_KEY", "secrets_payment_private_key", "SECRETS_ANY_PRIVATE_KEY_V2"])(
    "refuses to start with %s in the environment, even empty",
    (name) => {
      for (const value of [b64(pair.privateKey), ""]) {
        expect(() => loadSettingsConfig({ [name]: value })).toThrow(AdminConfigError);
      }
      expect(privateKeyVariables({ [name]: "" })).toEqual([name]);
    },
  );

  it("names the variable in the error, never its value", () => {
    const value = b64(pair.privateKey);
    let message = "";
    try {
      loadSettingsConfig({ SECRETS_PAYMENT_PRIVATE_KEY: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SECRETS_PAYMENT_PRIVATE_KEY");
    expect(message).not.toContain(value);
  });

  it("builds a sealer from public keys, which has no way to decrypt", () => {
    const settings = loadSettingsConfig({ SECRETS_PAYMENT_PUBLIC_KEY: b64(pair.publicKey) });
    expect(settings.sealer?.scopes).toEqual(["payment"]);
    expect(Object.keys(settings.sealer ?? {}).sort()).toEqual(["keyId", "scopes", "sealOtp", "sealSecret"]);
  });

  it("refuses a malformed public key and has no sealer without keys", () => {
    expect(() => loadSettingsConfig({ SECRETS_PAYMENT_PUBLIC_KEY: "not-a-key" })).toThrow(AdminConfigError);
    expect(loadSettingsConfig({})).toEqual(NO_SETTINGS);
  });

  it("parses the data directory and the PDF cap (default and maximum 100 MiB)", () => {
    expect(loadSettingsConfig({}).pdfMaxBytes).toBe(DEFAULT_PDF_MAX_BYTES);
    expect(loadSettingsConfig({ ADMIN_PDF_MAX_BYTES: String(50 * 1024 * 1024) }).pdfMaxBytes).toBe(50 * 1024 * 1024);
    for (const bad of ["0", "1024", String(100 * 1024 * 1024 + 1), "1e8", "-5", "abc"]) {
      expect(() => loadSettingsConfig({ ADMIN_PDF_MAX_BYTES: bad }), bad).toThrow(AdminConfigError);
    }
    expect(() => loadSettingsConfig({ ADMIN_DATA_DIR: "relative/dir" })).toThrow(AdminConfigError);
  });

  it("accepts DOMAIN only in stored form with a registrable domain", () => {
    expect(parseDomain("example.test")).toBe("example.test");
    expect(parseDomain(undefined)).toBeNull();
    for (const bad of ["Example.test", "example.test.", "co.id", "localhost", "203.0.113.1", "bücher.example"]) {
      expect(() => parseDomain(bad), bad).toThrow(AdminConfigError);
    }
  });
});
