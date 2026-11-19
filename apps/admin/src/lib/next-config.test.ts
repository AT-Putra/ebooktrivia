// next.config.ts restates lib/config.ts's origin rules (Next.js compiles it on its own): both must
// give the same answer for every input, or the build-time allowedOrigins and the runtime Origin
// check would disagree (code review US-016 F7).
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { describe, expect, it } from "vitest";
import { allowedOriginHosts } from "../../next.config.ts";
import { parseOrigin } from "./config.ts";

const INPUTS = [
  "https://admin.example.test",
  "https://admin.example.test:8443",
  "https://admin.example.test/",
  "https://admin.example.test/login",
  "https://admin.example.test?x=1",
  "https://user:pw@admin.example.test",
  "HTTPS://admin.example.test",
  "https://ADMIN.example.test",
  "https://admin.example.test:443",
  "http://admin.example.test",
  "http://127.0.0.1:3202",
  "http://localhost:3202",
  "http://[::1]:3202",
  "http://127.0.0.2:3202",
  "http://10.0.0.5:3200",
  "ftp://admin.example.test",
  "admin.example.test",
  "null",
  "",
];

describe("next.config.ts allowedOrigins vs lib/config.ts parseOrigin", () => {
  it.each(INPUTS.flatMap((raw) => [false, true].map((loopback) => ({ raw, loopback }))))("agree on $raw (loopback flag: $loopback)", ({ raw, loopback }) => {
    const env = { ADMIN_ORIGIN: raw, ...(loopback ? { ADMIN_ALLOW_INSECURE_LOOPBACK: "1" } : {}) };
    const origin = parseOrigin(raw, loopback);
    expect(allowedOriginHosts(env, PHASE_DEVELOPMENT_SERVER)).toEqual(origin === null ? [] : [new URL(origin).host]);
    if (origin === null) expect(() => allowedOriginHosts(env, PHASE_PRODUCTION_BUILD)).toThrow(/ADMIN_ORIGIN/);
    else expect(allowedOriginHosts(env, PHASE_PRODUCTION_BUILD)).toEqual([new URL(origin).host]);
  });

  it("fails a production build without ADMIN_ORIGIN, not a dev server", () => {
    expect(() => allowedOriginHosts({}, PHASE_PRODUCTION_BUILD)).toThrow(/ADMIN_ORIGIN/);
    expect(allowedOriginHosts({}, PHASE_DEVELOPMENT_SERVER)).toEqual([]);
  });
});
