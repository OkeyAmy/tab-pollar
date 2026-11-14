#!/usr/bin/env node
/**
 * Pollar admin via the MCP Gateway. Run with:
 *   pnpm --filter @tab/mcp exec tsx scripts/admin.ts whoami
 *   pnpm --filter @tab/mcp exec tsx scripts/admin.ts configure
 *
 * Reads POLLAR_PAT from .env. Never prints the token.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function loadEnv() {
  const p = resolve(process.cwd(), "../../.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const token = process.env.POLLAR_PAT;
if (!token) {
  console.error("POLLAR_PAT missing from .env");
  process.exit(1);
}

const client = new Client({ name: "tab-ops", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL("https://mcp.api.pollar.xyz/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }> | undefined)
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return text;
  }
}

async function main() {
  await client.connect(transport);
  const cmd = process.argv[2] ?? "whoami";

  if (cmd === "whoami") {
    console.log(JSON.stringify(await call("whoami"), null, 2));
    return;
  }

  const appsRes = await call("list_applications");
  const apps = Array.isArray(appsRes) ? appsRes : (appsRes?.applications ?? []);
  console.log("apps:", apps.map((a: any) => `${a.id} ${a.name} (${a.network ?? "?"})`).join("\n       "));

  const appId = process.env.POLLAR_APP_ID ?? apps[0]?.id;
  if (!appId) throw new Error("No application found for this token");
  console.log("using app:", appId);

  if (cmd === "readiness") {
    console.log(JSON.stringify(await call("check_application_readiness", { id: appId }), null, 2));
    return;
  }

  if (cmd === "balance") {
    console.log(JSON.stringify(await call("get_application_wallets", { id: appId }), null, 2));
    return;
  }

  if (cmd === "transactions") {
    console.log(JSON.stringify(await call("get_application_transactions", { id: appId, limit: 10 }), null, 2));
    return;
  }

  if (cmd === "configure") {
    const origins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
    ];
    const redirects = [
      "http://localhost:3000",
      "http://localhost:3000/",
      "http://localhost:3001",
      "http://localhost:3001/",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
    ];

    console.log("\n▸ domains");
    console.log(JSON.stringify(await call("update_application_domains", { id: appId, allowed_origins: origins }), null, 2));

    console.log("\n▸ redirect uris");
    console.log(JSON.stringify(await call("update_application_redirect_uris", { id: appId, allowed_redirect_uris: redirects }), null, 2));

    console.log("\n▸ enable test USDC");
    console.log(
      JSON.stringify(
        await call("enable_asset", {
          id: appId,
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          name: "USD Coin (testnet)",
        }),
        null,
        2,
      ),
    );

    console.log("\n▸ fund global wallet");
    console.log(JSON.stringify(await call("ensure_wallet_funded", { id: appId, role: "GLOBAL" }), null, 2));

    console.log("\n▸ gas wallet");
    console.log(JSON.stringify(await call("ensure_wallet_funded", { id: appId, role: "GAS" }), null, 2));

    console.log("\n▸ readiness");
    console.log(JSON.stringify(await call("check_application_readiness", { id: appId }), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await client.close().catch(() => {});
  });
