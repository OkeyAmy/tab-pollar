#!/usr/bin/env node
/**
 * Smoke check for the TAB MCP server: start it over stdio with a dummy agent
 * key and list the tools it exposes. No API call is made, so the key never
 * needs to be real.
 *
 *   pnpm --filter @tab/mcp exec tsx scripts/list-tools.ts
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const REPO = resolve(PKG, "../..");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
// Dummy value: tools/list does not touch the API.
env.TAB_API_KEY = "tab_agent_verify_only";
env.TAB_API_URL = process.env.TAB_API_URL ?? "http://localhost:4000";

const transport = new StdioClientTransport({
  command: resolve(REPO, "node_modules/.bin/tsx"),
  args: [resolve(PKG, "src/index.ts")],
  env,
  stderr: "pipe",
});

const client = new Client({ name: "tab-verify", version: "0.1.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`TAB MCP server exposes ${tools.length} tool(s):`);
  for (const tool of tools) {
    console.log(`  ${tool.name.padEnd(14)} ${tool.description ?? ""}`);
  }
} finally {
  await client.close().catch(() => {});
}
