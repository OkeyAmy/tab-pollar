/**
 * @tab/api — long-running process entrypoint for local development, Docker,
 * and the single-container deployment. Vercel uses `index.ts` instead.
 */
import { serve } from "@hono/node-server";
import { startExpiryLoop } from "./expiry.js";
import { loadEnv } from "./load-env.js";
import { createRuntime } from "./runtime.js";

loadEnv();

const runtime = createRuntime();
const { app, db, bus, config, repo, x402 } = runtime;

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
