// The public Valkey library without a server: the exact commands sent, the reply checks and the error classes. The
// library itself runs against a real Valkey with the real ACL in apps/public/test/valkey-functions.int.test.ts and
// apps/worker/test/prod-valkey-acl.int.test.ts.
import { describe, expect, it } from "vitest";
import { isFunctionMissing, loadPublicValkeyFunctions, probeRateLimitFunction, PUBLIC_VALKEY_LIBRARY, PUBLIC_VALKEY_LIBRARY_CODE, RATE_LIMIT_FUNCTION, type ValkeyCaller } from "./valkey-functions.ts";

function caller(answer: (args: readonly (string | number)[]) => unknown): ValkeyCaller & { readonly sent: (string | number)[][] } {
  const sent: (string | number)[][] = [];
  return {
    sent,
    call(command, ...args) {
      sent.push([command, ...args]);
      try {
        return Promise.resolve(answer([command, ...args]));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

describe("the public Valkey library", () => {
  it("is one named library registering the stable rate-limit function name", () => {
    expect(PUBLIC_VALKEY_LIBRARY_CODE.startsWith(`#!lua name=${PUBLIC_VALKEY_LIBRARY}\n`)).toBe(true);
    expect(RATE_LIMIT_FUNCTION).toBe("ebt_rate_limit_v1");
    expect(PUBLIC_VALKEY_LIBRARY_CODE).toContain(`redis.register_function('${RATE_LIMIT_FUNCTION}', rate_limit_v1)`);
    // Only the commands of the `public` allowlist, and nothing that reads or deletes.
    const commands = [...PUBLIC_VALKEY_LIBRARY_CODE.matchAll(/redis\.call\('([A-Z]+)'/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(["INCR", "PTTL", "PEXPIRE"]));
  });

  it("loads with FUNCTION LOAD REPLACE and checks the library name in the reply", async () => {
    const valkey = caller(() => PUBLIC_VALKEY_LIBRARY);
    expect(await loadPublicValkeyFunctions(valkey)).toBe(PUBLIC_VALKEY_LIBRARY);
    expect(valkey.sent).toEqual([["FUNCTION", "LOAD", "REPLACE", PUBLIC_VALKEY_LIBRARY_CODE]]);
    await expect(loadPublicValkeyFunctions(caller(() => "other_lib"))).rejects.toThrow(/FUNCTION LOAD answered other_lib/);
    await expect(loadPublicValkeyFunctions(caller(() => 1))).rejects.toThrow(/FUNCTION LOAD answered number/);
    await expect(
      loadPublicValkeyFunctions(
        caller(() => {
          throw new Error("NOPERM User public has no permissions to run the 'function|load' command");
        }),
      ),
    ).rejects.toThrow(/NOPERM/);
  });

  it("tells a missing function apart from every other failure", async () => {
    expect(isFunctionMissing(new Error("ERR Function not found"))).toBe(true);
    expect(isFunctionMissing(new Error("ERR function not found"))).toBe(true);
    expect(isFunctionMissing(new Error("Command timed out"))).toBe(false);
    expect(isFunctionMissing(new Error("NOPERM User public has no permissions to run the 'fcall' command"))).toBe(false);
    expect(isFunctionMissing("ERR Function not found")).toBe(false);

    const ok = caller(() => [0, 0]);
    expect(await probeRateLimitFunction(ok)).toBe("ok");
    expect(ok.sent).toEqual([["FCALL", RATE_LIMIT_FUNCTION, 0]]);
    expect(
      await probeRateLimitFunction(
        caller(() => {
          throw new Error("ERR Function not found");
        }),
      ),
    ).toBe("missing");
    expect(
      await probeRateLimitFunction(
        caller(() => {
          throw new Error("NOPERM User public has no permissions to run the 'fcall' command");
        }),
      ),
    ).toBe("refused");
    expect(
      await probeRateLimitFunction(
        caller(() => {
          throw new Error("Connection is closed.");
        }),
      ),
    ).toBe("unreachable");
    // A rejection that is not an Error (a client bug) is no NOPERM either.
    expect(await probeRateLimitFunction({ call: () => Promise.reject(new TypeError("not a Valkey reply")) })).toBe("unreachable");
  });
});
