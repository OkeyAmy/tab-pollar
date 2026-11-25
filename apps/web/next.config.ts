import type { NextConfig } from "next";

// In production, Vercel's top-level rewrite sends /api/* to the api service.
// This rewrite only exists for local runs, where the apps use separate ports.
const api = process.env.VERCEL
  ? null
  : process.env.API_BASE_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:4000" : null);

const nextConfig: NextConfig = {
  transpilePackages: ["@tab/shared", "@tab/pollar"],
  async rewrites() {
    return api
      ? [{ source: "/api/:path*", destination: `${api}/api/:path*` }]
      : [];
  },
};

export default nextConfig;
