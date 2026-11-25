/**
 * One initialized API runtime: config, SQLite, repository, signer bus, x402
 * store, and the Hono app. `index.ts` uses it as the Vercel entrypoint and
 * `main.ts` uses it to start the long-running Node server.
 */
import { openDb, Repo } from "@tab/db";
import type { Hono } from "hono";
import { createApp } from "./create-app.js";
import { loadConfig, type ApiConfig } from "./env.js";
import { createSignerBus } from "./signer-bus.js";
import { createX402Store } from "./x402.js";

export interface ApiRuntime {
  app: Hono;
  db: ReturnType<typeof openDb>;
  repo: Repo;
  bus: ReturnType<typeof createSignerBus>;
  x402: ReturnType<typeof createX402Store>;
  config: ApiConfig;
}

export function createRuntime(overrides: Partial<ApiConfig> = {}): ApiRuntime {
  const config = loadConfig(overrides);
  const db = openDb(config.databasePath);
  const repo = new Repo(db);
  const bus = createSignerBus();
  const x402 = createX402Store();
  const app = createApp({ repo, bus, config, x402Store: x402 });

  return { app, db, repo, bus, x402, config };
}
