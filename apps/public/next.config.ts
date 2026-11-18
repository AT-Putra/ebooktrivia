import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Production runs the standalone build through src/server.ts (edge listener, infra/images/app).
  output: "standalone",
  // The monorepo root, so workspace packages are traced into the standalone output. Next compiles
  // this file to CommonJS (SWC), so __dirname is defined and import.meta is not.
  outputFileTracingRoot: join(__dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@ebooktrivia/ui", "@ebooktrivia/i18n"],
};

export default nextConfig;
