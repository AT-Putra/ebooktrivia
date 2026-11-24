// The public Valkey library without a server: the exact commands sent, the reply checks and the error classes. The
// library itself runs against a real Valkey with the real ACL in apps/public/test/valkey-functions.int.test.ts and
// apps/worker/test/prod-valkey-acl.int.test.ts.
import { describe, expect, it } from "vitest";
import {
  isFunctionMissing,
  loadPublicValkeyFunctions,
  parseWaReadItem,
  probeRateLimitFunction,
  PUBLIC_VALKEY_LIBRARY,
  PUBLIC_VALKEY_LIBRARY_CODE,
  RATE_LIMIT_FUNCTION,
  type ValkeyCaller,
  WA_READ_FUNCTION,
  WA_READ_ITEM_TTL_S,
  WA_READ_NAMESPACE,
  WA_READ_PENDING_TTL_S,
  WA_READ_RING_SIZE,
  waReadCall,
  waReadKeys,
} from "./valkey-functions.ts";

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
  it("is one named library registering the stable function names", () => {
    expect(PUBLIC_VALKEY_LIBRARY_CODE.startsWith(`#!lua name=${PUBLIC_VALKEY_LIBRARY}\n`)).toBe(true);
    expect(RATE_LIMIT_FUNCTION).toBe("ebt_rate_limit_v1");
    expect(WA_READ_FUNCTION).toBe("ebt_wa_read_v1");
    expect(PUBLIC_VALKEY_LIBRARY_CODE).toContain(`redis.register_function('${RATE_LIMIT_FUNCTION}', rate_limit_v1)`);
    expect(PUBLIC_VALKEY_LIBRARY_CODE).toContain(`redis.register_function('${WA_READ_FUNCTION}', wa_read_v1)`);
    // Only the commands of the `public` allowlist (+incr +pttl +pexpire +set), and nothing that reads or deletes.
    const commands = [...PUBLIC_VALKEY_LIBRARY_CODE.matchAll(/redis\.call\('([A-Z]+)'/g)].map((m) => m[1]);
    expect(new Set(commands)).toEqual(new Set(["INCR", "PTTL", "PEXPIRE", "SET"]));
  });

  describe("the read hand-off (ebt_wa_read_v1): the keys, the item and the call", () => {
    const item = { session: "default", messageId: "false_628123456789@c.us_3EB0AAAA0001", digest: "0123456789abcdef0123456789abcdef" };

    it("keeps everything under one namespace of public's own prefix, and the ring's slots by the counter", () => {
      const keys = waReadKeys();
      expect(WA_READ_NAMESPACE).toBe("cache:public:wa-read");
      expect(keys.pending(item.digest)).toBe(`cache:public:wa-read:c:${item.digest}`);
      expect(keys.seq).toBe("cache:public:wa-read:seq");
      expect(keys.item(1)).toBe("cache:public:wa-read:i:1");
      expect(keys.item(WA_READ_RING_SIZE)).toBe("cache:public:wa-read:i:0");
      expect(keys.item(WA_READ_RING_SIZE + 7)).toBe("cache:public:wa-read:i:7");
      expect(waReadKeys("cache:public:other").item(3)).toBe("cache:public:other:i:3");
    });

    it("builds the call for a well formed item only: odd sessions, ids of groups and channels and digests that are not hex are refused", () => {
      const call = waReadCall(WA_READ_NAMESPACE, item);
      expect(call).toEqual({
        keys: [`cache:public:wa-read:c:${item.digest}`, "cache:public:wa-read:seq"],
        args: [String(WA_READ_PENDING_TTL_S), String(WA_READ_RING_SIZE), String(WA_READ_ITEM_TTL_S), String(7 * 86_400_000), "cache:public:wa-read:i:", `default|${item.messageId}|${item.digest}`],
      });
      expect(waReadCall(WA_READ_NAMESPACE, { ...item, session: "bad session" })).toBeNull();
      expect(waReadCall(WA_READ_NAMESPACE, { ...item, session: "x".repeat(65) })).toBeNull();
      expect(waReadCall(WA_READ_NAMESPACE, { ...item, session: "a|b" })).toBeNull();
      for (const messageId of ["false_120363025246125486@g.us_AAAA1111", "false_status@broadcast_AAAA1111", "false_628123456789@c.us_A|B", "true_628123@c.us_", "x"]) expect(waReadCall(WA_READ_NAMESPACE, { ...item, messageId }), messageId).toBeNull();
      for (const digest of ["", "0123", "0123456789ABCDEF0123456789ABCDEF", "g123456789abcdef0123456789abcdef"]) expect(waReadCall(WA_READ_NAMESPACE, { ...item, digest }), digest).toBeNull();
    });

    it("reads an item back only when it is exactly what the function wrote", () => {
      expect(parseWaReadItem(`12|default|${item.messageId}|${item.digest}`)).toEqual({ n: 12, ...item });
      for (const value of [null, "", "junk", `0|default|${item.messageId}|${item.digest}`, `x|default|${item.messageId}|${item.digest}`, `1|default|${item.messageId}`, `1|default|${item.messageId}|${item.digest}|more`, `1|bad session|${item.messageId}|${item.digest}`, `1|default|false_120363025246125486@g.us_AAAA1111|${item.digest}`]) {
        expect(parseWaReadItem(value), String(value)).toBeUndefined();
      }
    });
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
