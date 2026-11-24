// The public app's error checks by name (2026-11-24): the process-wide runtime and its clients are built by whichever Next.js bundle
// asks first, so an error they throw can be another bundle's copy of the class, which `instanceof` refuses (eslint.config.js forbids it).
import { describe, expect, it } from "vitest";
import { isServerKeyUnavailable, isSettingsUnavailable, ServerKeyUnavailable, SettingsUnavailable } from "./checkout/data.ts";
import { isPublicConfigError, PublicConfigError } from "./config.ts";
import { isValkeyUnavailable, ValkeyUnavailable } from "./valkey.ts";

/** An error as another bundle's copy of the class throws it: an Error with the same name, not this module's class. */
const otherCopy = (name: string, cause?: unknown) => Object.assign(new Error("x", cause === undefined ? undefined : { cause }), { name });

describe("isValkeyUnavailable", () => {
  it("is true for this copy's and another copy's ValkeyUnavailable, itself or as the cause of the error that wraps it", () => {
    expect(isValkeyUnavailable(new ValkeyUnavailable(new Error("ECONNREFUSED")))).toBe(true);
    expect(isValkeyUnavailable(otherCopy("ValkeyUnavailable"))).toBe(true);
    // The Cap builder wraps the token store's error: CaptchaStoreUnavailable { cause: ValkeyUnavailable }.
    expect(isValkeyUnavailable(otherCopy("CaptchaStoreUnavailable", otherCopy("ValkeyUnavailable")))).toBe(true);
  });

  it("is false for anything else, and looks one level deep only", () => {
    expect(isValkeyUnavailable(new Error("boom"))).toBe(false);
    expect(isValkeyUnavailable(otherCopy("CaptchaStoreUnavailable", new Error("boom")))).toBe(false);
    expect(isValkeyUnavailable(otherCopy("A", otherCopy("B", otherCopy("ValkeyUnavailable"))))).toBe(false);
    expect(isValkeyUnavailable({ name: "ValkeyUnavailable" })).toBe(false);
    expect(isValkeyUnavailable(undefined)).toBe(false);
  });
});

describe("isSettingsUnavailable, isServerKeyUnavailable, isPublicConfigError", () => {
  it("are true for this copy's and another copy's class", () => {
    expect(isSettingsUnavailable(new SettingsUnavailable("checkout.x"))).toBe(true);
    expect(isSettingsUnavailable(otherCopy("SettingsUnavailable"))).toBe(true);
    expect(isServerKeyUnavailable(new ServerKeyUnavailable("missing"))).toBe(true);
    expect(isServerKeyUnavailable(otherCopy("ServerKeyUnavailable"))).toBe(true);
    expect(isPublicConfigError(new PublicConfigError("DOMAIN is missing"))).toBe(true);
    expect(isPublicConfigError(otherCopy("PublicConfigError"))).toBe(true);
  });

  it("are false for each other's errors and for look-alike objects", () => {
    expect(isSettingsUnavailable(new ServerKeyUnavailable("missing"))).toBe(false);
    expect(isServerKeyUnavailable(new SettingsUnavailable("checkout.x"))).toBe(false);
    expect(isPublicConfigError(new Error("x"))).toBe(false);
    expect(isPublicConfigError({ name: "PublicConfigError", message: "x" })).toBe(false);
  });
});
