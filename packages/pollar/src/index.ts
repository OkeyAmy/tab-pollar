/**
 * @tab/pollar — the only place in the codebase that knows how to move money.
 *
 * OWNER: Pollar research agent.
 *
 * The API never signs. Payments are executed in the browser by the human's
 * Pollar session (DPoP-bound, non-extractable key) inside the Signer Console.
 * That is what makes the card revocable: close the console, the agent stops.
 *
 * Two rails live here:
 * - `createBrowserPayer` — classic Stellar payment / Solana SPL transfer.
 * - `createX402Payer`    — HTTP 402 settlement for machine-to-machine checkout
 *   (Soroban auth-entry signing; the facilitator pays the network fee).
 *
 * Everything in this file is pure or takes its I/O as an argument, so it can be
 * unit-tested without a wallet, a network, or a login.
 */
import { explorerUrl, type Asset, type Chain, type Money, type SignerPayment } from "@tab/shared";
import { decodePaymentResponseHeader } from "@x402/fetch";

/* ────────────────────────────────────────────────────────────────────────────
 * Constants (all public chain data — no secrets)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Stellar assets always carry 7 decimals. */
export const STELLAR_DECIMALS = 7;
/** Circle's test USDC on Stellar testnet (enabled on the TAB app). */
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** The Stellar Asset Contract for the USDC above — what x402 charges in. */
export const TESTNET_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
/** USDC SPL mint (Solana). 6 decimals. */
export const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Stellar text memos are capped at 28 bytes, not 28 characters. */
export const STELLAR_MEMO_MAX_BYTES = 28;
/** Public SDF Soroban RPC for testnet. There is no public one for pubnet. */
export const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

/** Stable code the SDK returns while a wallet is still provisioning. */
export const WALLET_NOT_READY_CODE = "SDK_WALLET_NOT_READY";
/** Stable code when a headless request cannot render the confirmation modal. */
export const CONFIRMATION_UNAVAILABLE_CODE = "SDK_CONFIRMATION_UNAVAILABLE";

const STELLAR_ACCOUNT_RE = /^[GCM][A-Z2-7]{55}$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;
/** Stellar `int64` amount ceiling, in stroops. */
const STELLAR_MAX_UNITS = 9_223_372_036_854_775_807n;

/* ────────────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PaymentIntent extends SignerPayment {
  assetIssuer: string | null;
}

export interface PaymentOutcome {
  status: "success" | "pending" | "error";
  hash: string | null;
  explorerUrl: string | null;
  error: string | null;
  /** Machine-readable reason (`SDK_WALLET_NOT_READY`, `COSIGN_PENDING`, …). */
  code?: string | null;
  raw?: unknown;
}

export interface PollarPayer {
  readonly kind: "browser" | "mock";
  pay(intent: PaymentIntent): Promise<PaymentOutcome>;
}

/**
 * The subset of a Pollar transaction outcome this package reads. It mirrors
 * `SubmitOutcome` from `@pollar/core` without taking a dependency on it, so the
 * package stays installable in a headless script.
 */
export interface PollarSubmitOutcome {
  status: string;
  hash?: string;
  details?: string;
  resultCode?: string;
  code?: string;
  message?: string;
}

/** The subset of @pollar/core's client this package depends on. */
export interface PollarClientLike {
  runTx(
    operation: "payment",
    params: Record<string, unknown>,
    options?: { memo?: { type: "text"; value: string } },
  ): Promise<PollarSubmitOutcome>;
  sendPayment?(args: {
    chain: "SOLANA";
    destination: string;
    amount: string;
    mint?: string;
  }): Promise<PollarSubmitOutcome>;
}

/** The exact second argument `runTx('payment', ...)` expects on Stellar. */
export type StellarPaymentAsset =
  | { type: "native" }
  | { type: "credit_alphanum4"; code: "USDC"; issuer: string };

export interface StellarPaymentParams {
  destination: string;
  amount: string;
  asset: StellarPaymentAsset;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Amount conversion (bigint only — never floating point)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Converts a decimal string to integer base units without going through a JS
 * number. Throws on anything the target chain cannot represent, rather than
 * silently truncating (a truncated amount is a wrong payment).
 */
function toBaseUnits(amount: string, decimals: number, label: string): bigint {
  const value = String(amount).trim();
  if (!DECIMAL_RE.test(value)) {
    throw new Error(`${label} amount "${amount}" is not a non-negative decimal string.`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `${label} amount "${amount}" has more than ${decimals} decimal places.`,
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Validates a Stellar decimal amount (7dp, positive) and returns it unchanged. */
function toStellarAmount(amount: Money | string): string {
  const units = toBaseUnits(String(amount), STELLAR_DECIMALS, "Stellar");
  if (units <= 0n) {
    throw new Error(`Stellar amount "${amount}" must be greater than zero.`);
  }
  if (units > STELLAR_MAX_UNITS) {
    throw new Error(`Stellar amount "${amount}" exceeds the int64 ledger limit.`);
  }
  return String(amount);
}

function assertStellarAddress(address: string, label: string): string {
  if (!STELLAR_ACCOUNT_RE.test(address)) {
    throw new Error(`${label} "${address}" is not a valid Stellar account address.`);
  }
  return address;
}

/** UTF-8 byte length, so a multi-byte emoji cannot smuggle past the 28-byte cap. */
function memoBytes(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

function assertMemo(memo: string | null): string | null {
  if (!memo) return null;
  const bytes = memoBytes(memo);
  if (bytes > STELLAR_MEMO_MAX_BYTES) {
    throw new Error(
      `Stellar memo is ${bytes} bytes; the maximum is ${STELLAR_MEMO_MAX_BYTES}.`,
    );
  }
  return memo;
}

/** Solana takes integer base units. USDC has 6 decimals, native SOL has 9. */
export function toSolanaAmount(amount: Money, asset: Asset): string {
  const decimals = asset === "USDC" ? 6 : 9;
  return toBaseUnits(String(amount), decimals, `Solana ${asset}`).toString();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Stellar params
 * ──────────────────────────────────────────────────────────────────────────── */

function envUsdcIssuer(): string | undefined {
  // `process` is absent in some browser bundles; Next still inlines
  // NEXT_PUBLIC_* at build time, so this stays a real value in the web app.
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env.NEXT_PUBLIC_USDC_ISSUER || undefined;
}

/**
 * Builds the exact arguments for `runTx('payment', ...)`.
 * Stellar amounts are decimal strings (7dp) and the memo is passed separately
 * in the third argument, never inside `params`.
 */
export function toStellarPaymentParams(
  intent: PaymentIntent,
  fallbackIssuer?: string | null,
): StellarPaymentParams {
  const destination = assertStellarAddress(intent.destination, "Destination");
  const amount = toStellarAmount(intent.amount);

  if (intent.asset === "XLM") {
    return { destination, amount, asset: { type: "native" } };
  }

  const issuer = intent.assetIssuer ?? fallbackIssuer ?? envUsdcIssuer();
  if (!issuer) {
    throw new Error(
      "A USDC payment needs an issuer: set assetIssuer on the intent or " +
        "NEXT_PUBLIC_USDC_ISSUER in the environment.",
    );
  }
  assertStellarAddress(issuer, "USDC issuer");
  return {
    destination,
    amount,
    asset: { type: "credit_alphanum4", code: "USDC", issuer },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Browser payer
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BrowserPayerOptions {
  /** USDC issuer on Stellar. Required when the settlement asset is USDC. */
  usdcIssuer?: string;
  /** SPL mint used on Solana. Defaults to mainnet USDC. */
  solanaMint?: string;
}

function errorCodeOf(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Maps a Pollar transaction outcome to TAB's receipt shape. */
export function mapPollarOutcome(
  result: PollarSubmitOutcome,
  chain: Chain,
): PaymentOutcome {
  const hash = typeof result.hash === "string" && result.hash.length > 0 ? result.hash : null;
  const url = hash ? explorerUrl(chain, hash) : null;

  if (result.status === "success") {
    return { status: "success", hash, explorerUrl: url, error: null, code: null, raw: result };
  }
  if (result.status === "pending") {
    return { status: "pending", hash, explorerUrl: url, error: null, code: null, raw: result };
  }
  if (result.status === "cosign_pending") {
    return {
      status: "pending",
      hash: null,
      explorerUrl: null,
      error: "Waiting for a co-signer to approve this payment.",
      code: "COSIGN_PENDING",
      raw: result,
    };
  }

  const code = result.code ?? result.resultCode ?? null;
  return {
    status: "error",
    hash,
    explorerUrl: url,
    error: result.message ?? result.details ?? code ?? "Payment failed",
    code,
    raw: result,
  };
}

export function createBrowserPayer(
  client: PollarClientLike,
  opts: BrowserPayerOptions = {},
): PollarPayer {
  return {
    kind: "browser",
    async pay(intent) {
      try {
        if (intent.chain === "SOLANA") {
          if (!client.sendPayment) throw new Error("This Pollar client has no sendPayment().");
          const result = await client.sendPayment({
            chain: "SOLANA",
            destination: intent.destination,
            amount: toSolanaAmount(intent.amount, intent.asset),
            ...(intent.asset === "USDC" ? { mint: opts.solanaMint ?? USDC_SOLANA_MINT } : {}),
          });
          return mapPollarOutcome(result, "SOLANA");
        }

        const params = toStellarPaymentParams(intent, opts.usdcIssuer ?? null);
        const memo = assertMemo(intent.memo);
        const result = await client.runTx(
          "payment",
          params as unknown as Record<string, unknown>,
          memo ? { memo: { type: "text", value: memo } } : undefined,
        );
        return mapPollarOutcome(result, "STELLAR");
      } catch (err) {
        return {
          status: "error",
          hash: null,
          explorerUrl: null,
          error: errorMessageOf(err),
          code: errorCodeOf(err),
        };
      }
    },
  };
}

/** True when the payment may succeed later without changing anything. */
export function isRetryableSettlement(outcome: PaymentOutcome): boolean {
  return (
    outcome.code === WALLET_NOT_READY_CODE ||
    outcome.code === CONFIRMATION_UNAVAILABLE_CODE ||
    outcome.code === "COSIGN_PENDING"
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Mock payer
 * ──────────────────────────────────────────────────────────────────────────── */

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic 64-hex pseudo-hash: stable across runs, never used on-chain. */
function mockTxHash(intent: PaymentIntent): string {
  const seed = [
    intent.chain,
    intent.chargeId,
    intent.amount,
    intent.asset,
    intent.destination,
    intent.memo ?? "",
  ].join("|");
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) {
    parts.push(fnv1a(`${i}:${seed}`, 0x811c9dc5 + i * 0x9e3779b9).toString(16).padStart(8, "0"));
  }
  return parts.join("");
}

/**
 * Deterministic fake payer for tests and for DEMO_MODE=1 when no key is set.
 * The hash is derived from the intent, so a test can assert on it and a demo
 * can replay the same receipt.
 */
export function createMockPayer(
  opts: { delayMs?: number; hash?: string } = {},
): PollarPayer {
  return {
    kind: "mock",
    async pay(intent) {
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      const hash = opts.hash ?? mockTxHash(intent);
      return {
        status: "success",
        hash,
        explorerUrl: explorerUrl(intent.chain, hash),
        error: null,
        code: null,
        raw: { mock: true, intent },
      };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * x402 (HTTP 402) payer
 * ──────────────────────────────────────────────────────────────────────────── */

export type X402Network = "stellar:testnet" | "stellar:pubnet";

/**
 * The slice of `@pollar/core`'s client that `nirium-pollar-adapter` drives.
 * `signAuthEntry` is the only required method: x402 signs a Soroban
 * authorization entry and the facilitator submits the transaction.
 */
export interface X402PollarClient {
  address?: string;
  walletAddress?: string;
  getAuthState?: () => unknown;
  signAuthEntry?: (
    entryXdr: string,
    options: { validUntilLedger: number },
  ) => Promise<
    | { status: "signed"; signedAuthEntry: string }
    | { status: "error"; details?: string; code?: string }
    | { status: "cosign_pending"; request?: unknown }
    | { signedAuthEntry: string; signerAddress?: string }
  >;
}

export interface X402PayerOptions {
  /** Soroban RPC used to simulate the transfer. Defaults to SDF testnet. */
  sorobanRpcUrl?: string;
  /** CAIP-2 network. Defaults to `stellar:testnet`. */
  network?: X402Network;
  /** Payer address, for a client that has not exposed it yet. */
  address?: string;
  /** Nirium agent base URL, if the caller already knows it. */
  agentBaseUrl?: string;
  /** Base fetch, injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export interface X402Settlement {
  success: boolean | null;
  txHash: string | null;
  network: string | null;
  payer: string | null;
  /** Settled amount in atomic units, when the facilitator reports it. */
  amount: string | null;
}

export interface X402PaymentResult extends X402Settlement {
  ok: boolean;
  status: number;
  body: unknown;
  /**
   * The underlying response. Its body has already been consumed to populate
   * `body`; read headers from here, not the stream.
   */
  raw: Response;
}

export interface X402Payer {
  readonly kind: "x402";
  /** GET/POST a paid resource, signing the 402 challenge and retrying once. */
  fetchPaid(url: string, init?: RequestInit): Promise<X402PaymentResult>;
}

const EMPTY_SETTLEMENT: X402Settlement = {
  success: null,
  txHash: null,
  network: null,
  payer: null,
  amount: null,
};

/**
 * Reads the facilitator's settlement receipt from `PAYMENT-RESPONSE`
 * (or the legacy `X-PAYMENT-RESPONSE`). Never throws: a malformed or absent
 * header is reported as nulls so the paid body can still be returned.
 */
export function readX402Settlement(headers: Headers): X402Settlement {
  const raw =
    headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return { ...EMPTY_SETTLEMENT };

  try {
    const parsed = decodePaymentResponseHeader(raw) as unknown as Record<string, unknown>;
    return {
      success: typeof parsed.success === "boolean" ? parsed.success : null,
      txHash:
        typeof parsed.transaction === "string" && parsed.transaction.length > 0
          ? parsed.transaction
          : null,
      network: typeof parsed.network === "string" ? parsed.network : null,
      payer: typeof parsed.payer === "string" ? parsed.payer : null,
      amount: typeof parsed.amount === "string" ? parsed.amount : null,
    };
  } catch {
    return { ...EMPTY_SETTLEMENT };
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Wraps the logged-in Pollar client as an x402 payer.
 *
 * The heavy modules (`@x402/stellar`, `@stellar/stellar-sdk`,
 * `nirium-pollar-adapter`) are imported lazily on the first paid request, so
 * importing `@tab/pollar` from the API or an SSR page stays cheap.
 *
 * Requirements on the Pollar side (dashboard, not code):
 * - Wallets → Signing rules: allow contract `CBIELTK…DAMA`, function `transfer`.
 * - Signature validity window ≥ the server's `maxTimeoutSeconds` (300 s).
 * - USDC enabled so the wallet holds the trustline, and a USDC balance.
 */
export function createX402Payer(
  pollar: X402PollarClient,
  opts: X402PayerOptions = {},
): X402Payer {
  const network = opts.network ?? "stellar:testnet";
  const sorobanRpcUrl =
    opts.sorobanRpcUrl ?? (network === "stellar:testnet" ? DEFAULT_SOROBAN_RPC_URL : undefined);

  if (!sorobanRpcUrl) {
    throw new Error(
      "createX402Payer: set { sorobanRpcUrl } for stellar:pubnet — there is no public SDF Soroban RPC on mainnet.",
    );
  }

  type PaidFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;

  let paidFetch: PaidFetch | null = null;
  let loading: Promise<PaidFetch | null> | null = null;

  async function build(): Promise<PaidFetch> {
    const { createPollarSigner, createNiriumAdapter } = await import("nirium-pollar-adapter");

    const signer = createPollarSigner(
      pollar as unknown as Parameters<typeof createPollarSigner>[0],
      {
        network,
        rpcUrl: sorobanRpcUrl,
        ...(opts.address ? { address: opts.address } : {}),
      },
    );

    // The adapter is Nirium's supported x402 path: it negotiates the 402,
    // signs the SEP-43 auth entry through Pollar, and retries. Hand-building
    // an x402Client produced an invalid payment payload against this merchant.
    const adapter = createNiriumAdapter({
      signer,
      network,
      rpcUrl: sorobanRpcUrl,
      ...(opts.agentBaseUrl ? { agentBaseUrl: opts.agentBaseUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    return (input, init) => adapter.x402Fetch(String(input), init);
  }

  return {
    kind: "x402",
    async fetchPaid(url, init) {
      if (!paidFetch) {
        if (!loading) {
          loading = build()
            .then((fn) => (paidFetch = fn))
            .catch((err: unknown) => {
              loading = null;
              throw err;
            });
        }
        await loading;
      }

      const response = await paidFetch!(url, init);
      const settlement = readX402Settlement(response.headers);
      const body = await readResponseBody(response);
      return {
        ok: response.ok,
        status: response.status,
        body,
        ...settlement,
        raw: response,
      };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Environment helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Chain ⇄ asset helpers used by the API and the UI. */
export function settlementAsset(): Asset {
  if (typeof process === "undefined" || !process.env) return "USDC";
  return process.env.NEXT_PUBLIC_SETTLEMENT_ASSET === "XLM" ? "XLM" : "USDC";
}

/** The configured USDC issuer, or null when the app settles in XLM. */
export function settlementAssetIssuer(): string | null {
  if (settlementAsset() === "XLM") return null;
  return envUsdcIssuer() ?? null;
}

export function chainLabel(chain: Chain): string {
  return chain === "STELLAR" ? "Stellar" : "Solana";
}
