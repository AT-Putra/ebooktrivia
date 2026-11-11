import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@ebooktrivia/ui", "@ebooktrivia/i18n"],
};

export default nextConfig;
