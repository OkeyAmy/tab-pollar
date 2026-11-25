/**
 * Vercel entrypoint. The Hono framework builder looks for a default export in
 * `app`, `index`, or `server` at the service root or under `src/`, and this is
 * the only recognized filename that imports `hono`. The long-running Node
 * server lives in `main.ts`.
 */
import type { Hono } from "hono";
import { loadEnv } from "./load-env.js";
import { createRuntime } from "./runtime.js";

loadEnv();

export const runtime = createRuntime();

const app: Hono = runtime.app;

export default app;
