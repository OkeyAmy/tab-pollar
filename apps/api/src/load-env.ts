/**
 * Best-effort `.env` loading for local runs and the container image. Vercel
 * injects environment variables for real deployments, so skip it there; the
 * CLI's local `vercel dev` still reads the repo's `.env`.
 */
export function loadEnv(): void {
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview"
  ) {
    return;
  }

  const candidates = [
    // Source-file-relative: apps/api/src → repo root.
    new URL("../../../.env", import.meta.url).pathname,
    // cwd-relative when run through `pnpm --filter @tab/api`.
    "../../.env",
    // cwd-relative when run from the repo root.
    ".env",
  ];

  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Try the next location; no `.env` is a supported configuration.
    }
  }
}
