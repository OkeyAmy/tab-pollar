/**
 * @tab/api — process entrypoint. Loads `.env` best-effort, opens SQLite,
 * mounts the Hono app and starts the reservation-expiry loop.
 */
import { serve } from "@hono/node-server";
import { openDb, Repo } from "@tab/db";
import { createApp } from "./app.js";
import { loadConfig } from "./env.js";
import { startExpiryLoop } from "./expiry.js";
import { createSignerBus } from "./signer-bus.js";
import { createX402Store } from "./x402.js";

function loadEnv(): void {
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

loadEnv();

const config = loadConfig();
const db = openDb(config.databasePath);
const repo = new Repo(db);
const bus = createSignerBus();
const x402 = createX402Store();
const app = createApp({ repo, bus, config, x402Store: x402 });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  TAB api  →  http://localhost:${info.port}\n`);
});

const stopExpiry = startExpiryLoop({ repo, bus, x402, config });

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopExpiry();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
