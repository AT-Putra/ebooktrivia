// The breached-password lookup (pwned-passwords.ts) against a fake range API: k-anonymity (only the 5-character
// prefix is sent), Add-Padding, count-0 padding lines, and fail open on every kind of failure. Never the real API.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPwnedPasswordsLookup, passwordSha1, PWNED_PASSWORDS_ORIGIN, type RangeFetch } from "./pwned-passwords.ts";
import { SafeFetchError } from "./safe-fetch.ts";

const PASSWORD = "correct horse battery staple";
const HASH = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase();
const PREFIX = HASH.slice(0, 5);
const SUFFIX = HASH.slice(5);
/** Another suffix of the same prefix (35 hex characters). */
const other = (n: number) => n.toString(16).toUpperCase().padStart(35, "0");

function fakeApi(answer: { status?: number; body?: string; error?: Error }): { fetch: RangeFetch; calls: { url: string; headers: Readonly<Record<string, string>> }[] } {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const fetch: RangeFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    if (answer.error !== undefined) return Promise.reject(answer.error);
    return Promise.resolve({ status: answer.status ?? 200, text: () => Promise.resolve(answer.body ?? "") });
  };
  return { fetch, calls };
}

describe("the Pwned Passwords range lookup", () => {
  it("sends only the SHA-1 prefix, with Add-Padding, and finds the suffix among the answer's lines", async () => {
    const api = fakeApi({ body: `${other(1)}:3\r\n${SUFFIX}:42\r\n${other(2)}:0\r\n` });
    expect(await createPwnedPasswordsLookup(api.fetch)(HASH)).toEqual({ status: "breached", count: 42 });
    expect(api.calls).toEqual([{ url: `${PWNED_PASSWORDS_ORIGIN}/range/${PREFIX}`, headers: { "Add-Padding": "true" } }]);
    // Neither the password nor the rest of its hash leaves the process.
    expect(JSON.stringify(api.calls)).not.toContain(SUFFIX);
    expect(JSON.stringify(api.calls)).not.toContain(PASSWORD);
  });

  it("is clean when the suffix is absent, or only present as a padding line (count 0)", async () => {
    expect(await createPwnedPasswordsLookup(fakeApi({ body: `${other(1)}:3\n${other(2)}:1\n` }).fetch)(HASH)).toEqual({ status: "clean" });
    expect(await createPwnedPasswordsLookup(fakeApi({ body: `${other(1)}:3\n${SUFFIX}:0\n` }).fetch)(HASH)).toEqual({ status: "clean" });
  });

  it("fails open: a timeout, a network error, a refusal or a body that is not a range list is unavailable, never breached", async () => {
    const lookup = (answer: Parameters<typeof fakeApi>[0]) => createPwnedPasswordsLookup(fakeApi(answer).fetch)(HASH);
    expect(await lookup({ error: new SafeFetchError("timeout", "slow") })).toEqual({ status: "unavailable", reason: "timeout" });
    expect(await lookup({ error: new SafeFetchError("blocked_address", "no") })).toEqual({ status: "unavailable", reason: "blocked_address" });
    expect(await lookup({ error: new TypeError("socket hang up") })).toEqual({ status: "unavailable", reason: "request_failed" });
    expect(await lookup({ status: 429, body: "slow down" })).toEqual({ status: "unavailable", reason: "http_429" });
    expect(await lookup({ status: 503 })).toEqual({ status: "unavailable", reason: "http_503" });
    expect(await lookup({ body: "<html>captive portal</html>" })).toEqual({ status: "unavailable", reason: "bad_body" });
    expect(await lookup({ body: "" })).toEqual({ status: "unavailable", reason: "bad_body" });
  });

  it("takes the SHA-1 in either case, refuses anything else without a request, and hashes a password the same way", async () => {
    expect(passwordSha1(PASSWORD)).toBe(HASH);
    const api = fakeApi({ body: `${SUFFIX}:5\n` });
    expect(await createPwnedPasswordsLookup(api.fetch)(HASH.toLowerCase())).toEqual({ status: "breached", count: 5 });
    for (const bad of [PASSWORD, HASH.slice(1), `${HASH}0`, "Z".repeat(40)]) {
      expect(await createPwnedPasswordsLookup(api.fetch)(bad)).toEqual({ status: "unavailable", reason: "bad_hash" });
    }
    expect(api.calls).toHaveLength(1);
  });
});
