import type { NextConfig } from "next";

const api = process.env.API_BASE_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  transpilePackages: ["@tab/shared", "@tab/pollar"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
