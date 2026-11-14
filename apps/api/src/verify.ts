/**
 * On-chain settlement verification. The browser's hash is a claim; this module
 * checks Horizon (Stellar) or the Solana RPC before the API marks a charge
 * SETTLED.
 *
 * Honesty note: for classic Stellar payments we verify success, destination,
 * amount, asset and memo. For x402 we verify the settlement tx exists and
 * succeeded and record `settlement: "facilitator"`; we do not pretend to decode
 * arbitrary Soroban events.
 */
import { cmpMoney, type Asset, type Chain } from "@tab/shared";
import type { ApiConfig } from "./env.js";

export type SettlementKind =
  | "stellar-horizon"
  | "solana-rpc"
  | "facilitator"
  | "unverified";

export interface SettlementExpectation {
  chain: Chain;
  destination: string;
  amount: string;
  asset: Asset;
  assetIssuer: string | null;
  memo: string | null;
  /** ISO timestamp of the charge; the tx must not predate it. */
  notBefore: string;
  x402: boolean;
}

export interface VerificationResult {
  verified: boolean;
  settlement: SettlementKind;
  reason: string | null;
  confirmedAt: string | null;
  detail?: unknown;
}

const CLOCK_SKEW_MS = 5 * 60_000;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function horizonBase(config: ApiConfig): string {
  return config.horizonUrl.replace(/\/+$/, "");
}

async function readJson(
  res: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await res.json();
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function operationsFrom(payload: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!payload) return [];
  const embedded = payload._embedded;
  if (embedded && typeof embedded === "object") {
    const records = (embedded as { records?: unknown }).records;
    if (Array.isArray(records)) {
      return records.filter(
        (record): record is Record<string, unknown> =>
          !!record && typeof record === "object",
      );
    }
  }
  const records = payload.records;
  return Array.isArray(records)
    ? records.filter(
        (record): record is Record<string, unknown> =>
          !!record && typeof record === "object",
      )
    : [];
}

function isPrivateMemo(tx: Record<string, unknown>): string | null {
  const memoType = asString(tx.memo_type);
  if (!memoType || memoType === "none") return null;
  return asString(tx.memo);
}

function assetMatches(
  op: Record<string, unknown>,
  expectation: SettlementExpectation,
): boolean {
  const assetType = asString(op.asset_type);
  if (assetType === "native") return expectation.asset === "XLM";
  if (expectation.asset !== "USDC") return false;
  if (asString(op.asset_code) !== "USDC") return false;
  if (expectation.assetIssuer && asString(op.asset_issuer) !== expectation.assetIssuer) {
    return false;
  }
  return true;
}

function paymentMatches(
  op: Record<string, unknown>,
  expectation: SettlementExpectation,
): boolean {
  if (asString(op.type) !== "payment") return false;
  if (asString(op.to) !== expectation.destination) return false;
  const amount = asString(op.amount);
  if (!amount || cmpMoney(amount, expectation.amount) !== 0) return false;
  return assetMatches(op, expectation);
}

async function verifyStellar(input: {
  hash: string;
  expectation: SettlementExpectation;
  config: ApiConfig;
  fetchImpl: typeof fetch;
}): Promise<VerificationResult> {
  const base = horizonBase(input.config);

  let txRes: Response;
  try {
    txRes = await input.fetchImpl(
      `${base}/transactions/${encodeURIComponent(input.hash)}`,
    );
  } catch (err) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "HORIZON_UNAVAILABLE",
      confirmedAt: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!txRes.ok) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "TX_NOT_FOUND",
      confirmedAt: null,
      detail: `Horizon returned HTTP ${txRes.status}.`,
    };
  }

  const tx = await readJson(txRes);
  if (!tx) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "TX_INVALID",
      confirmedAt: null,
    };
  }

  if (tx.successful !== true) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "TX_FAILED",
      confirmedAt: null,
    };
  }

  const createdAt = asString(tx.created_at);
  if (createdAt) {
    const txTime = Date.parse(createdAt);
    const notBefore = Date.parse(input.expectation.notBefore);
    if (
      Number.isFinite(txTime) &&
      Number.isFinite(notBefore) &&
      txTime < notBefore - CLOCK_SKEW_MS
    ) {
      return {
        verified: false,
        settlement: "unverified",
        reason: "TX_TOO_OLD",
        confirmedAt: null,
        detail: { createdAt, notBefore: input.expectation.notBefore },
      };
    }
  }

  if (input.expectation.memo !== null) {
    const memo = isPrivateMemo(tx);
    if (memo !== input.expectation.memo) {
      return {
        verified: false,
        settlement: "unverified",
        reason: "MEMO_MISMATCH",
        confirmedAt: null,
        detail: { expected: input.expectation.memo, actual: memo },
      };
    }
  }

  let opsRes: Response;
  try {
    opsRes = await input.fetchImpl(
      `${base}/transactions/${encodeURIComponent(input.hash)}/operations`,
    );
  } catch (err) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "HORIZON_UNAVAILABLE",
      confirmedAt: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const operations = opsRes.ok ? operationsFrom(await readJson(opsRes)) : [];
  const match = operations.some((op) => paymentMatches(op, input.expectation));

  if (match) {
    return {
      verified: true,
      settlement: input.expectation.x402 ? "facilitator" : "stellar-horizon",
      reason: null,
      confirmedAt: createdAt ?? null,
      ...(input.expectation.x402
        ? { detail: { classicPayment: true } }
        : {}),
    };
  }

  if (input.expectation.x402) {
    // The facilitator may settle via Soroban. We can honestly verify that the
    // tx exists and succeeded; we do not claim to decode its contract events.
    return {
      verified: true,
      settlement: "facilitator",
      reason: null,
      confirmedAt: createdAt ?? null,
      detail: {
        classicPayment: false,
        note: "Settlement tx succeeded; no classic payment operation found (Soroban or contract-mediated transfer).",
      },
    };
  }

  return {
    verified: false,
    settlement: "unverified",
    reason: "PAYMENT_MISMATCH",
    confirmedAt: null,
    detail: { operations: operations.length },
  };
}

async function verifySolana(input: {
  hash: string;
  config: ApiConfig;
  fetchImpl: typeof fetch;
}): Promise<VerificationResult> {
  if (!input.config.solanaRpcUrl) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "SOLANA_RPC_NOT_CONFIGURED",
      confirmedAt: null,
    };
  }

  let res: Response;
  try {
    res = await input.fetchImpl(input.config.solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [input.hash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      }),
    });
  } catch (err) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "SOLANA_RPC_UNAVAILABLE",
      confirmedAt: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const payload = res.ok ? await readJson(res) : null;
  const result = payload?.result as
    | { meta?: { err?: unknown }; blockTime?: number }
    | null
    | undefined;

  if (!result) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "TX_NOT_FOUND",
      confirmedAt: null,
    };
  }
  if (result.meta?.err) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "TX_FAILED",
      confirmedAt: null,
      detail: result.meta.err,
    };
  }

  return {
    verified: true,
    settlement: "solana-rpc",
    reason: null,
    confirmedAt:
      typeof result.blockTime === "number"
        ? new Date(result.blockTime * 1000).toISOString()
        : null,
  };
}

export async function verifySettlement(input: {
  hash: string;
  expectation: SettlementExpectation;
  config: ApiConfig;
  fetchImpl: typeof fetch;
}): Promise<VerificationResult> {
  if (!input.config.onchainVerify) {
    return {
      verified: false,
      settlement: "unverified",
      reason: "VERIFICATION_DISABLED",
      confirmedAt: null,
    };
  }

  if (input.expectation.chain === "SOLANA") {
    return verifySolana({
      hash: input.hash,
      config: input.config,
      fetchImpl: input.fetchImpl,
    });
  }

  return verifyStellar({
    hash: input.hash,
    expectation: input.expectation,
    config: input.config,
    fetchImpl: input.fetchImpl,
  });
}
