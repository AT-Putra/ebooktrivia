import { describe, expect, it } from "vitest";
import * as sealer from "./sealer.ts";

describe("@ebooktrivia/crypto/sealer (what the admin app may import)", () => {
  it("exposes sealing only: nothing that opens a secret or an OTP", () => {
    expect(Object.keys(sealer).sort()).toEqual(["CryptoError", "SECRET_SCOPES", "createSecretSealer", "isCryptoError", "last4", "sealerFromEnv"]);
  });
});
