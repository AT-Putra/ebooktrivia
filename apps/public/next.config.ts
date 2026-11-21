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
  // The proxy (src/proxy.ts) rewrites /{publicId} and / on the order origin to internal routes with an
  // absolute URL built from its request's URL. Without this the proxy's URL host is "localhost" while Next
  // resolves the rewrite against the address it listens on (EDGE_HOST in production), so every rewrite
  // looked like an EXTERNAL one and answered an empty 404. With it the proxy sees Next's own initial URL, so
  // the two agree. (We use no basePath, i18n or data routes, which is what the normalisation is for.)
  skipProxyUrlNormalize: true,
  transpilePackages: ["@ebooktrivia/ui", "@ebooktrivia/i18n", "@ebooktrivia/db", "@ebooktrivia/edge", "@ebooktrivia/core", "@ebooktrivia/crypto", "@ebooktrivia/adapters", "@ebooktrivia/sdk"],
};

export default nextConfig;
