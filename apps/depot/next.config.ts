import type { NextConfig } from "next";

const api = process.env.API_BASE_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  transpilePackages: ["@tab/shared"],
  // Local dev serves the depot at /; production serves it under /depot behind
  // Caddy so everything stays same-origin.
  basePath: process.env.NEXT_BASE_PATH || undefined,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
