import type { NextConfig } from "next";

// In production, Vercel's top-level rewrite sends /api/* to the api service.
// This rewrite only exists for local runs, where the apps use separate ports.
const api = process.env.VERCEL
  ? null
  : process.env.API_BASE_URL ??
    (process.env.NODE_ENV === "development" ? "http://localhost:4000" : null);

// Vercel serves the depot under /depot; the Docker image sets NEXT_BASE_PATH.
// `basePath` is inlined at build time, so this must be decided here.
const basePath =
  process.env.NEXT_BASE_PATH || (process.env.VERCEL ? "/depot" : undefined);

// The console is the same origin as the depot on Vercel and in the container.
// Only local dev runs it on a separate port.
const consoleUrl =
  process.env.NEXT_PUBLIC_TAB_CONSOLE_URL ??
  (process.env.VERCEL || basePath ? "/" : "http://localhost:3000");

const nextConfig: NextConfig = {
  transpilePackages: ["@tab/shared"],
  basePath,
  env: {
    NEXT_PUBLIC_TAB_CONSOLE_URL: consoleUrl,
  },
  async rewrites() {
    return api
      ? [
          {
            source: "/api/:path*",
            destination: `${api}/api/:path*`,
            // Client URLs are origin-relative, even when the depot has a basePath.
            basePath: false,
          },
        ]
      : [];
  },
};

export default nextConfig;
