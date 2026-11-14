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

export function loadConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  const signerMode: SignerMode =
    process.env.TAB_SIGNER_MODE === "mock" ? "mock" : "browser";
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const depotOrigin = process.env.DEPOT_ORIGIN ?? "http://localhost:3001";

  // Verification is mandatory for the real browser rail. The only way to turn
  // it off is an explicit mock/test environment, and even then the receipt is
  // marked `onchainVerified: false`.
  const rawOnchain = process.env.TAB_VERIFY_ONCHAIN !== "0";
  const allowUnverifiedSettlement =
    !rawOnchain && (signerMode === "mock" || process.env.NODE_ENV === "test");

  const base: ApiConfig = {
    port: Number(process.env.PORT ?? 4000),
    databasePath: process.env.DATABASE_PATH ?? "./data/tab.db",
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
    sessionSecret:
      process.env.SESSION_SECRET ?? "tab_dev_session_secret_change_me",

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
