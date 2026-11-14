#!/usr/bin/env tsx
/**
 * TAB · Pollar smoke test — `pnpm smoke`
 *
 * Answers, in order:
 *   1. Are the keys present, and are they TESTNET keys?
 *   2. Does the SDK config endpoint accept us from the web app's origin?
 *   3. Is CORS wired for the browser (preflight + origin allowlist)?
 *   4. Is the settlement asset real on Stellar testnet?
 *   5. Does the x402 merchant answer `402` with the shape we expect?
 *
 * It never prints a secret: keys are shown as prefix + length only.
 * Exit code 1 when a check fails, 0 when everything that can be checked
 * headlessly passes.
 *
 * Node's fetch times out on some hosts on this network (Horizon, Fly). That is
 * a transport quirk, not a product failure, so every probe falls back to curl
 * before it is reported as unreachable.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_SOROBAN_RPC_URL,
  TESTNET_USDC_ISSUER,
  TESTNET_USDC_SAC,
} from "../packages/pollar/src/index.ts";

setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_URL = "https://sdk.api.pollar.xyz/v3/applications/config";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const X402_URL = "https://nirium-agent.fly.dev/api/v1/premium/market";
const WEB_ORIGIN = "http://localhost:3000";
const TIMEOUT_MS = 15_000;

type Status = "pass" | "fail" | "warn" | "info";

const results: Array<{ status: Status; label: string; detail?: string }> = [];

function record(status: Status, label: string, detail?: string): void {
  results.push({ status, label, detail });
}

const ICON: Record<Status, string> = { pass: "✓", fail: "✗", warn: "!", info: "·" };

/** Prefix + length only. Never the whole key. */
function fingerprint(value: string | undefined): string {
  if (!value) return "missing";
  return `${value.slice(0, 12)}… (${value.length} chars)`;
}

function loadEnv(): void {
  const file = resolve(ROOT, ".env");
  if (!existsSync(file)) {
    record("warn", ".env", "not found — falling back to the process environment");
    return;
  }
  try {
    process.loadEnvFile(file);
    record("pass", ".env", "loaded");
  } catch (error) {
    record("fail", ".env", error instanceof Error ? error.message : String(error));
  }
}

/* ── transport: fetch first, curl fallback ─────────────────────────────────── */

interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  ms: number;
  via: "fetch" | "curl";
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method,
      headers: opts.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
      ms: Date.now() - started,
      via: "fetch",
    };
  } catch {
    return curlRequest(url, method, opts.headers ?? {}, timeoutMs, started);
  }
}

async function curlRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  timeoutMs: number,
  started: number,
): Promise<HttpResponse> {
  const args = ["-sS", "-i", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-X", method];
  for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`);
  args.push(url);

  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 8 * 1024 * 1024 });
  const split = stdout.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("curl returned no HTTP response");

  const head = stdout.slice(0, split).split("\r\n");
  const statusLine = head.shift() ?? "";
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(statusLine);
  if (!match) throw new Error(`curl returned an unexpected status line: ${statusLine}`);

  const parsedHeaders = new Headers();
  for (const line of head) {
    const colon = line.indexOf(":");
    if (colon > 0) parsedHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  return {
    status: Number(match[1]),
    headers: parsedHeaders,
    text: stdout.slice(split + 4),
    ms: Date.now() - started,
    via: "curl",
  };
}

function jsonBody<T>(response: HttpResponse): T | undefined {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    return undefined;
  }
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/* ── checks ───────────────────────────────────────────────────────────────── */

async function checkKeys(): Promise<{ publishable?: string; secret?: string }> {
  const publishable = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY;
  const secret = process.env.POLLAR_SECRET_KEY;
  const pat = process.env.POLLAR_PAT;

  if (!publishable) {
    record("fail", "NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY", "missing");
  } else if (!publishable.startsWith("pub_testnet_")) {
    record(
      "fail",
      "NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY",
      `not a testnet key → ${fingerprint(publishable)}`,
    );
  } else {
    record("pass", "publishable key", fingerprint(publishable));
  }

  if (!secret) {
    record("fail", "POLLAR_SECRET_KEY", "missing");
  } else if (!secret.startsWith("sec_testnet_")) {
    record("fail", "POLLAR_SECRET_KEY", `not a testnet key → ${fingerprint(secret)}`);
  } else {
    record("pass", "secret key", `${fingerprint(secret)} — server-only, never ships to the browser`);
  }

  record("info", "POLLAR_PAT", pat ? "present (admin/MCP tooling only)" : "absent (optional)");

  if (publishable && secret && publishable === secret) {
    record("fail", "key separation", "publishable and secret key are the same value");
  }

  return { publishable, secret };
}

interface ConfigBody {
  success?: boolean;
  code?: string;
  content?: {
    application?: {
      name?: string;
      network?: string;
      chains?: string[];
      walletProvisioning?: string;
      walletCustodyMode?: string;
      signConfirmation?: { mode?: string; windowSeconds?: number; maxUsd?: string };
    };
  };
}

async function checkConfig(publishable: string | undefined): Promise<void> {
  if (!publishable) {
    record("fail", "config endpoint", "skipped — no publishable key");
    return;
  }

  try {
    const response = await request(CONFIG_URL, {
      headers: { "x-pollar-api-key": publishable, Origin: WEB_ORIGIN },
    });
    const body = jsonBody<ConfigBody>(response);

    if (response.status !== 200) {
      record(
        "fail",
        "config endpoint",
        `HTTP ${response.status} ${errorCode(body) ?? ""} — add ${WEB_ORIGIN} under Developers → Websites`,
      );
      return;
    }

    record("pass", "config endpoint", `200 in ${response.ms}ms (${response.via})`);

    const app = body?.content?.application;
    if (app?.network !== "testnet") {
      record("fail", "network", `expected testnet, got ${String(app?.network)}`);
    } else {
      record("pass", "network", "testnet");
    }

    const chains = app?.chains ?? [];
    if (!chains.includes("STELLAR")) {
      record("fail", "chains", `Stellar is not enabled (${chains.join(", ") || "none"})`);
    } else {
      record("pass", "chains", chains.join(", "));
    }

    record("info", "wallet", `${app?.walletProvisioning ?? "?"} · ${app?.walletCustodyMode ?? "?"}`);

    const confirm = app?.signConfirmation;
    const mode = confirm?.mode ?? "?";
    const detail = `${mode} · ${confirm?.windowSeconds ?? "?"}s · $${confirm?.maxUsd ?? "?"}`;
    if (mode === "PROMPT") {
      record(
        "warn",
        "signature confirmation",
        `${detail} — change to WINDOW or AUTO for a smooth demo and for x402`,
      );
    } else {
      record("pass", "signature confirmation", detail);
    }

    if (app?.name) record("info", "application", app.name);
  } catch (error) {
    record(
      "fail",
      "config endpoint",
      `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function checkCors(publishable: string | undefined): Promise<void> {
  if (!publishable) return;

  try {
    const preflight = await request(CONFIG_URL, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-pollar-api-key",
      },
    });
    const allowOrigin = preflight.headers.get("access-control-allow-origin");
    if (preflight.status === 204 && allowOrigin === WEB_ORIGIN) {
      record("pass", "CORS preflight", `204 · allow-origin ${allowOrigin}`);
    } else {
      record(
        "fail",
        "CORS preflight",
        `HTTP ${preflight.status} · allow-origin ${allowOrigin ?? "absent"}`,
      );
    }

    const evil = await request(CONFIG_URL, {
      headers: { "x-pollar-api-key": publishable, Origin: "https://tab-smoke.invalid" },
    });
    const code = errorCode(jsonBody(evil));
    if (evil.status === 403 && code === "ORIGIN_NOT_ALLOWED") {
      record("pass", "origin allowlist", "unknown origin rejected (403 ORIGIN_NOT_ALLOWED)");
    } else {
      record(
        "fail",
        "origin allowlist",
        `unknown origin returned ${evil.status} ${code ?? ""} — expected 403`,
      );
    }
  } catch (error) {
    record(
      "fail",
      "CORS",
      `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function checkSettlementAsset(): Promise<void> {
  const asset = process.env.NEXT_PUBLIC_SETTLEMENT_ASSET === "XLM" ? "XLM" : "USDC";
  const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER || TESTNET_USDC_ISSUER;

  record("info", "settlement asset", asset);

  if (asset === "XLM") {
    record(
      "warn",
      "asset decision",
      "XLM fallback selected — USDC is verified on this app; prefer USDC for the demo",
    );
    return;
  }

  if (issuer !== TESTNET_USDC_ISSUER) {
    record(
      "warn",
      "USDC issuer",
      `${issuer.slice(0, 8)}… is not Circle's testnet issuer; the demo expects ${TESTNET_USDC_ISSUER.slice(0, 8)}…`,
    );
  } else {
    record("pass", "USDC issuer", `${issuer.slice(0, 8)}…${issuer.slice(-6)} (Circle testnet)`);
  }

  try {
    const response = await request(
      `${HORIZON_URL}/assets?asset_code=USDC&asset_issuer=${encodeURIComponent(issuer)}`,
      { headers: { Accept: "application/json" } },
    );
    const body = jsonBody<{ _embedded?: { records?: unknown[] } }>(response);
    const records = body?._embedded?.records ?? [];
    if (response.status === 200 && records.length > 0) {
      record("pass", "Horizon", "USDC asset exists on Stellar testnet (7 decimals)");
    } else {
      record("fail", "Horizon", `USDC asset not found (HTTP ${response.status})`);
    }
  } catch (error) {
    record(
      "warn",
      "Horizon",
      `could not verify the asset: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  record("info", "x402 asset contract", TESTNET_USDC_SAC);
  record("info", "Soroban RPC", DEFAULT_SOROBAN_RPC_URL);
}

interface PaymentRequired {
  accepts?: Array<{
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    extra?: { areFeesSponsored?: boolean };
  }>;
}

async function checkX402(): Promise<void> {
  try {
    const response = await request(X402_URL, { headers: { Accept: "application/json" } });
    if (response.status !== 402) {
      record("warn", "x402 merchant", `HTTP ${response.status} — expected 402 Payment Required`);
      return;
    }

    const header = response.headers.get("payment-required");
    if (!header) {
      record("warn", "x402 merchant", "402 without a payment-required header");
      return;
    }

    const parsed = JSON.parse(
      Buffer.from(header, "base64").toString("utf8"),
    ) as PaymentRequired;
    const accept = parsed.accepts?.[0];
    if (!accept) {
      record("warn", "x402 merchant", "402 with an empty accepts[]");
      return;
    }

    const amount = accept.amount ? Number(accept.amount) / 1e7 : null;
    const assetOk = accept.asset === TESTNET_USDC_SAC;
    const networkOk = accept.network === "stellar:testnet";

    record(
      networkOk && assetOk ? "pass" : "warn",
      "x402 merchant",
      `402 · ${accept.scheme} · ${accept.network} · ${amount ?? "?"} USDC · fees ${
        accept.extra?.areFeesSponsored ? "sponsored" : "not sponsored"
      } (${response.via})`,
    );
    if (!assetOk) {
      record("warn", "x402 asset", `${String(accept.asset).slice(0, 8)}… is not the USDC contract`);
    }
    if (!networkOk) {
      record("warn", "x402 network", `expected stellar:testnet, got ${String(accept.network)}`);
    }
  } catch (error) {
    record(
      "warn",
      "x402 merchant",
      `unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */

function guidance(): void {
  const lines = [
    "",
    "Before a real testnet payment works:",
    "",
    "  1. Signature confirmation (Wallets → Settings): PROMPT blocks agent-only runs.",
    '     Use "Ask once per window" (300 s / $50) or "Never ask". Mount the Pollar',
    "     confirmation modal in the Signer Console or payments fail with",
    "     SDK_CONFIRMATION_UNAVAILABLE.",
    "  2. Fund the human wallet with test USDC: https://faucet.circle.com",
    "     (Stellar testnet) or https://faucet.sozu.capital. 0.05 USDC covers one",
    "     x402 call; a $25 TAB demo needs ~25 USDC.",
    "  3. x402 only (Wallets → Signing rules): allow contract",
    `     ${TESTNET_USDC_SAC}`,
    '     function "transfer" (lowercase), validity window ≥ 300 s (60 ledgers).',
    "  4. Sign in once with Google so the wallet exists and holds its USDC trustline.",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

function printReport(): void {
  const width = Math.max(...results.map((r) => r.label.length), 10);
  process.stdout.write("\nTAB · Pollar smoke\n");
  process.stdout.write(`${"─".repeat(width + 24)}\n`);
  for (const result of results) {
    const detail = result.detail ? `  ${result.detail}` : "";
    process.stdout.write(`  ${ICON[result.status]} ${result.label.padEnd(width)}${detail}\n`);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const passed = results.filter((r) => r.status === "pass").length;
  process.stdout.write(
    `\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed, ${warned} warnings\n`,
  );
  if (failed > 0) {
    process.stdout.write("Fix the ✗ lines above. No secret was printed by this script.\n");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { publishable } = await checkKeys();
  await checkConfig(publishable);
  await checkCors(publishable);
  await checkSettlementAsset();
  await checkX402();
  guidance();
  printReport();

  if (results.some((r) => r.status === "fail")) process.exitCode = 1;
}

await main();
