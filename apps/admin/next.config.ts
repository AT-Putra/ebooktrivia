import { join } from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Server action CSRF (plan M5a.2). Next.js compares the Origin host with the Host / X-Forwarded-Host
// the app sees (Caddy forwards admin.<DOMAIN> unchanged); allowedOrigins lists the admin host only.
// It is read from ADMIN_ORIGIN at BUILD time (the standalone server never reads this file): a
// production build without a valid ADMIN_ORIGIN fails (code review US-016 CM1). The image build
// gets it from infra/provision/build-images.sh (https://admin.<DOMAIN>); the e2e and CI builds use
// a loopback origin with ADMIN_ALLOW_INSECURE_LOOPBACK=1. The exact Origin check at runtime
// (proxy.ts, lib/next/actions.ts) is the primary control: it also refuses a missing Origin, which
// Next.js lets through. Same rules as lib/config.ts parseOrigin, restated here because Next.js
// compiles this file on its own; src/lib/next-config.test.ts checks both give the same answers.
export function allowedOriginHosts(env: Readonly<Record<string, string | undefined>>, phase: string): string[] {
  const raw = env["ADMIN_ORIGIN"];
  const loopback = env["ADMIN_ALLOW_INSECURE_LOOPBACK"] === "1";
  const url = ((): URL | null => {
    try {
      return raw === undefined ? null : new URL(raw);
    } catch {
      return null;
    }
  })();
  const valid =
    url !== null &&
    url.origin === raw &&
    (url.protocol === "https:" || (loopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  if (valid) return [url.host];
  if (phase === PHASE_PRODUCTION_BUILD) {
    throw new Error("ADMIN_ORIGIN must be set to the console's origin (https://admin.<DOMAIN>) for a production build");
  }
  return [];
}

export default function config(phase: string): NextConfig {
  return {
    // Production runs the standalone build through src/server.ts (edge listener, infra/images/app).
    output: "standalone",
    // The monorepo root, so workspace packages are traced into the standalone output. Next compiles
    // this file to CommonJS (SWC), so __dirname is defined and import.meta is not.
    outputFileTracingRoot: join(__dirname, "../.."),
    poweredByHeader: false,
    reactStrictMode: true,
    transpilePackages: ["@ebooktrivia/ui", "@ebooktrivia/db", "@ebooktrivia/edge", "@ebooktrivia/core", "@ebooktrivia/crypto", "@ebooktrivia/adapters", "@ebooktrivia/uploads"],
    // Native binding: loaded by Node at runtime, never bundled.
    serverExternalPackages: ["@node-rs/argon2"],
    experimental: {
      // forbidden() -> the 403 page (lib/next/require-admin.ts).
      authInterrupts: true,
      serverActions: { allowedOrigins: allowedOriginHosts(process.env, phase), bodySizeLimit: "1mb" },
    },
  };
}
