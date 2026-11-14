/**
 * x402 merchant rail (Stellar testnet).
 *
 * The agent asks the API to fetch a paid resource. The resource answers 402
 * with a challenge; the API turns that challenge into a normal TAB charge. The
 * browser signer still performs the on-chain payment — this module only parses
 * challenges and keeps a small demo-durable record of each request.
 */
import type { Repo } from "@tab/db";
import {
  fromUnits,
  type Charge,
  type TxReceipt,
} from "@tab/shared";
import { z } from "zod";

export const X402_MERCHANT_ID = "mch_x402";

/**
 * Stellar's all-zero account. Only a fallback: a real x402 payment uses the
 * challenge's `payTo`, not this address.
 */
const PLACEHOLDER_SETTLEMENT =
  process.env.STELLAR_MERCHANT_ADDRESS ??
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface X402Challenge {
  url: string;
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  maxTimeoutSeconds: number;
}

export class X402Error extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 500 = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "X402Error";
  }
}

const Amountish = z
  .union([z.string(), z.number()])
  .transform((value) => String(value));

const AcceptSchema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  amount: Amountish,
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive().optional(),
});

function decodeHeader(value: string): unknown {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(normalised, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Parse a 402 response into the first acceptable payment requirement. The
 * amount is converted from 7-dp base units into a decimal string.
 */
export async function parseChallenge(
  res: Response,
  url: string,
): Promise<X402Challenge> {
  if (res.status !== 402) {
    throw new X402Error(
      "X402_NO_CHALLENGE",
      `Expected a 402 payment challenge, got HTTP ${res.status}.`,
    );
  }

  const header =
    res.headers.get("payment-required") ?? res.headers.get("x-payment-required");

  let payload: unknown;
  if (header) {
    payload = decodeHeader(header);
  }
  if (payload === undefined) {
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
  }
  if (payload === undefined) {
    throw new X402Error(
      "X402_INVALID_CHALLENGE",
      "The 402 response had no readable payment challenge.",
    );
  }

  const accepts = Array.isArray(payload)
    ? payload
    : (payload as { accepts?: unknown } | null)?.accepts;

  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402Error(
      "X402_INVALID_CHALLENGE",
      "The 402 response has no `accepts` payment options.",
    );
  }

  const parsed = AcceptSchema.safeParse(accepts[0]);
  if (!parsed.success) {
    throw new X402Error(
      "X402_INVALID_CHALLENGE",
      "The 402 payment option is malformed.",
      400,
      { issues: parsed.error.issues },
    );
  }

  let units: bigint;
  try {
    units = BigInt(parsed.data.amount);
  } catch {
    throw new X402Error(
      "X402_INVALID_CHALLENGE",
      "The 402 amount is not an integer base-unit string.",
    );
  }
  if (units <= 0n) {
    throw new X402Error(
      "X402_INVALID_CHALLENGE",
      "The 402 amount must be greater than zero.",
    );
  }

  return {
    url,
    amount: fromUnits(units, 7),
    asset: parsed.data.asset,
    payTo: parsed.data.payTo,
    network: parsed.data.network,
    maxTimeoutSeconds: parsed.data.maxTimeoutSeconds ?? 60,
  };
}

/** x402 charges are distinguishable without a schema change. */
export function isX402Charge(charge: Pick<Charge, "merchantId" | "description">): boolean {
  return charge.merchantId === X402_MERCHANT_ID && charge.description.startsWith("http");
}

/** The merchant row must exist before any x402 charge can reference it. */
export function ensureX402Merchant(repo: Repo): void {
  if (repo.getMerchant(X402_MERCHANT_ID)) return;
  repo.upsertMerchant({
    id: X402_MERCHANT_ID,
    name: "x402 Resource",
    domain: "x402.local",
    emoji: "⚡",
    category: "api",
    settlementAddress: PLACEHOLDER_SETTLEMENT,
    settlementChain: "STELLAR",
    createdAt: new Date().toISOString(),
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * In-memory request record
 * ──────────────────────────────────────────────────────────────────────────── */

export interface X402Record {
  requestId: string;
  chargeId: string;
  ownerId: string;
  agentId: string;
  url: string;
  challenge: X402Challenge;
  status: string;
  body?: unknown;
  receipt?: TxReceipt | null;
  createdAt: string;
}

export interface X402Store {
  create(record: X402Record): void;
  get(requestId: string): X402Record | undefined;
  byChargeId(chargeId: string): X402Record | undefined;
  setBody(chargeId: string, body: unknown): void;
  settle(chargeId: string, receipt: TxReceipt): void;
  setStatus(chargeId: string, status: string): void;
}

/**
 * Demo-durable only: this map lives for the life of the API process. A restart
 * loses x402 response bodies, but charges themselves are persisted in SQLite
 * and still settle normally.
 */
export function createX402Store(): X402Store {
  const byId = new Map<string, X402Record>();
  const byCharge = new Map<string, string>();

  const touch = (chargeId: string, patch: Partial<X402Record>) => {
    const requestId = byCharge.get(chargeId);
    if (!requestId) return;
    const record = byId.get(requestId);
    if (!record) return;
    byId.set(requestId, { ...record, ...patch });
  };

  return {
    create(record) {
      byId.set(record.requestId, record);
      byCharge.set(record.chargeId, record.requestId);
    },
    get(requestId) {
      return byId.get(requestId);
    },
    byChargeId(chargeId) {
      const requestId = byCharge.get(chargeId);
      return requestId ? byId.get(requestId) : undefined;
    },
    setBody(chargeId, body) {
      touch(chargeId, { body });
    },
    settle(chargeId, receipt) {
      touch(chargeId, { status: "SETTLED", receipt });
    },
    setStatus(chargeId, status) {
      touch(chargeId, { status });
    },
  };
}
