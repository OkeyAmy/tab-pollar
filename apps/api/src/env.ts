/**
 * Runtime configuration. Everything is read from `process.env` with safe
 * defaults so the API boots with no `.env` at all.
 */
import type { Asset } from "@tab/shared";

export type SignerMode = "browser" | "mock";
export type Network = "testnet" | "mainnet";

export interface RateLimitConfig {
  sessionPerMin: number;
  tokensPerMin: number;
  chargesPerMin: number;
  x402PerMin: number;
}

export interface ApiConfig {
  port: number;
  databasePath: string;
  signerMode: SignerMode;
  demoMode: boolean;
  network: Network;

  /** Pollar Server API token verification. */
  pollarSecretKey: string;
  pollarVerifyUrl: string;
  pollarApplicationId: string | null;

  /** TAB's own opaque session. The brief caps this at 12h. */
  sessionTtlMs: number;
  sessionSecret: string;

  /** Charge tokens live for 5 minutes. */
  tokenTtlMs: number;
  /** How long `POST /purchases` waits for settlement. */
  purchaseWaitMs: number;
  /** AWAITING_APPROVAL older than this is expired. */
  approvalTtlMs: number;
  /** QUEUED/SIGNING older than this is expired. */
  signerExpiryMs: number;

  webOrigin: string;
  depotOrigin: string;
  allowedOrigins: string[];

  settlementAsset: Asset;
  usdcIssuer: string | null;

  /** On-chain verification (Horizon / Solana RPC). */
  horizonUrl: string;
  solanaRpcUrl: string | null;
  onchainVerify: boolean;
  /** Only ever true for tests or `TAB_SIGNER_MODE=mock`. */
  allowUnverifiedSettlement: boolean;

  /** x402 fetches are allowlisted. */
  x402AllowedHosts: string[];

  rateLimits: RateLimitConfig;
  enableLogger: boolean;
}

function detectNetwork(): Network {
  const key = `${process.env.POLLAR_SECRET_KEY ?? ""} ${process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? ""}`;
  return key.includes("mainnet") ? "mainnet" : "testnet";
}

/** Origins are compared byte-for-byte with the browser's Origin header. */
function normaliseOrigin(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  // Vercel deployment URLs are bare hosts. Local `vercel dev` URLs are HTTP.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(trimmed);
  return `${local ? "http" : "https"}://${trimmed.replace(/\/+$/, "")}`;
}

/**
 * The web app is the origin users see. On Vercel we can derive it from the
 * platform's deployment variables so approval links and CSRF origin checks
 * work on preview and production without a hardcoded hostname.
 */
function vercelOrigin(): string | null {
  const host =
    process.env.VERCEL_ENV === "production"
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
      : process.env.VERCEL_URL ?? process.env.VERCEL_BRANCH_URL;
  return host ? normaliseOrigin(host) : null;
}

function vercelOrigins(): string[] {
  return [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normaliseOrigin);
}

let warnedAboutSessionSecret = false;

export function loadConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  const signerMode: SignerMode =
    process.env.TAB_SIGNER_MODE === "mock" ? "mock" : "browser";
  const configuredWebOrigin = process.env.WEB_ORIGIN?.trim();
  const webOrigin = configuredWebOrigin
    ? normaliseOrigin(configuredWebOrigin)
    : vercelOrigin() ?? "http://localhost:3000";
  // Web and depot share one origin on Vercel; locally the depot is :3001.
  const depotOrigin = process.env.DEPOT_ORIGIN?.trim()
    ? normaliseOrigin(process.env.DEPOT_ORIGIN)
    : process.env.VERCEL
      ? webOrigin
      : "http://localhost:3001";

  // Verification is mandatory for the real browser rail. The only way to turn
  // it off is an explicit mock/test environment, and even then the receipt is
  // marked `onchainVerified: false`.
  const rawOnchain = process.env.TAB_VERIFY_ONCHAIN !== "0";
  const allowUnverifiedSettlement =
    !rawOnchain && (signerMode === "mock" || process.env.NODE_ENV === "test");

  const sessionSecret =
    process.env.SESSION_SECRET ?? "tab_dev_session_secret_change_me";
  if (
    !process.env.SESSION_SECRET &&
    process.env.VERCEL_ENV === "production" &&
    !warnedAboutSessionSecret
  ) {
    warnedAboutSessionSecret = true;
    console.warn(
      "[tab/api] SESSION_SECRET is not set; using the insecure development default.",
    );
  }

  const base: ApiConfig = {
    port: Number(process.env.PORT ?? 4000),
    // Vercel's filesystem is read-only except `/tmp`. This keeps the demo
    // writable, but the file (and its data) is per-instance and ephemeral.
    databasePath:
      process.env.DATABASE_PATH ??
      (process.env.VERCEL_ENV === "production" ||
      process.env.VERCEL_ENV === "preview"
        ? "/tmp/tab.db"
        : "./data/tab.db"),
    signerMode,
    demoMode: process.env.TAB_DEMO_MODE !== "0",
    network: detectNetwork(),

    pollarSecretKey: process.env.POLLAR_SECRET_KEY ?? "",
    pollarVerifyUrl:
      process.env.POLLAR_VERIFY_URL ??
      "https://server.api.pollar.xyz/v3/tokens/verify",
    pollarApplicationId:
      process.env.POLLAR_APPLICATION_ID ??
      process.env.NEXT_PUBLIC_POLLAR_APP_ID ??
      null,

    sessionTtlMs: 12 * 60 * 60 * 1000,
    sessionSecret,

    tokenTtlMs: 5 * 60_000,
    purchaseWaitMs: 20_000,
    approvalTtlMs: 10 * 60_000,
    // A human may need to read the Pollar confirmation and approve it; 2 min
    // was shorter than the signature window and expired charges mid-signing.
    signerExpiryMs: 10 * 60_000,

    webOrigin,
    depotOrigin,
    allowedOrigins: Array.from(
      new Set([
        webOrigin,
        depotOrigin,
        ...vercelOrigins(),
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
      ]),
    ),

    settlementAsset:
      process.env.NEXT_PUBLIC_SETTLEMENT_ASSET === "XLM" ? "XLM" : "USDC",
    usdcIssuer: process.env.NEXT_PUBLIC_USDC_ISSUER || null,

    horizonUrl:
      process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    solanaRpcUrl: process.env.SOLANA_RPC_URL || null,
    onchainVerify: rawOnchain || !allowUnverifiedSettlement,
    allowUnverifiedSettlement,

    x402AllowedHosts: (process.env.X402_ALLOWED_HOSTS ?? "nirium-agent.fly.dev")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),

    rateLimits: {
      sessionPerMin: 10,
      tokensPerMin: 60,
      chargesPerMin: 60,
      x402PerMin: 20,
    },
    enableLogger: process.env.NODE_ENV !== "test",
  };

  return { ...base, ...overrides };
}
