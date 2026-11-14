/**
 * @tab/shared — the single source of truth for TAB's domain model, wire
 * contracts and money math. Every workspace imports from here.
 *
 * Rule: this package has no runtime dependencies except zod, and no I/O.
 */
import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────────
 * Primitives
 * ──────────────────────────────────────────────────────────────────────────── */

/** Decimal string, never a float. Up to 7 fractional digits (Stellar precision). */
export const MoneySchema = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "must be a positive decimal string");
export type Money = z.infer<typeof MoneySchema>;

export const ChainSchema = z.enum(["STELLAR", "SOLANA"]);
export type Chain = z.infer<typeof ChainSchema>;

export const AssetSchema = z.enum(["USDC", "XLM"]);
export type Asset = z.infer<typeof AssetSchema>;

export const IsoDateSchema = z.string().datetime({ offset: true });
export type IsoDate = z.infer<typeof IsoDateSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Identifiers
 * ──────────────────────────────────────────────────────────────────────────── */

export const ID_PREFIX = {
  user: "usr",
  agent: "agt",
  card: "crd",
  charge: "chg",
  token: "tkn",
  merchant: "mch",
  event: "evt",
  signerJob: "sgn",
  purchase: "pur",
  session: "ses",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${ID_PREFIX[kind]}_${hex}`;
}

/** Agent keys are shown once; only the hash is stored. */
export const KEY_PREFIX = {
  agent: "tab_agent_",
  merchant: "tab_merchant_",
  owner: "tab_owner_",
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Money math (integer base units — never floating point)
 * ──────────────────────────────────────────────────────────────────────────── */

export function toUnits(amount: Money | string, decimals = 7): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function fromUnits(units: bigint, decimals = 7): Money {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}` as Money;
}

export function addMoney(a: Money, b: Money, decimals = 7): Money {
  return fromUnits(toUnits(a, decimals) + toUnits(b, decimals), decimals);
}

export function subMoney(a: Money, b: Money, decimals = 7): Money {
  return fromUnits(toUnits(a, decimals) - toUnits(b, decimals), decimals);
}

export function cmpMoney(a: Money, b: Money, decimals = 7): -1 | 0 | 1 {
  const ua = toUnits(a, decimals);
  const ub = toUnits(b, decimals);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

export function isPositive(a: Money): boolean {
  return toUnits(a) > 0n;
}

/**
 * Human display: $25.00. Amounts are USD-denominated in the product UI.
 *
 * Display formatting is still money math, so it stays in bigint/string land:
 * no `Number()` on an amount, and cent rounding is explicit (half-up) rather
 * than delegated to a float formatter.
 */
export function formatUsd(amount: Money | string): string {
  const raw = String(amount).trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [wholeRaw = "0", fracRaw = ""] = unsigned.split(".");
  const centsRaw = (fracRaw + "00").slice(0, 2);
  let whole = BigInt(wholeRaw || "0");
  let cents = BigInt(centsRaw || "0");
  // blindfold: math — third fractional digit at 5 or above rounds the cent up.
  if (fracRaw.length > 2 && fracRaw[2] >= "5") {
    cents += 1n;
    if (cents >= 100n) {
      cents -= 100n;
      whole += 1n;
    }
  }
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${cents.toString().padStart(2, "0")}`;
}

/** Short human age, e.g. "just now", "4m ago", "in 23h". */
export function formatRelativeTime(
  date: string | Date,
  now: Date | number = Date.now(),
): string {
  const then = typeof date === "string" ? new Date(date) : date;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const deltaMs = then.getTime() - nowMs;
  const future = deltaMs > 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);
  const phrase = (() => {
    if (seconds < 45) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${Math.max(1, minutes)}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  })();
  if (phrase === "just now") return phrase;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

/** `abc123…f9e0` for explorer hashes / ids. Never truncates shorter input. */
export function truncateHash(hash: string, head = 6, tail = 4): string {
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** Card-face expiry label. "Expired" once the instant has passed. */
export function cardExpiryLabel(
  expiresAt: string | Date,
  now: Date | number = Date.now(),
): string {
  const then = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const ms = then.getTime() - nowMs;
  if (ms <= 0) return "Expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `Expires in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Enums
 * ──────────────────────────────────────────────────────────────────────────── */

export const AgentStatusSchema = z.enum(["ACTIVE", "PAUSED", "REVOKED"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const CardStatusSchema = z.enum([
  "ACTIVE",
  "PAUSED",
  "REVOKED",
  "EXHAUSTED",
  "EXPIRED",
]);
export type CardStatus = z.infer<typeof CardStatusSchema>;

export const ChargeStatusSchema = z.enum([
  "AWAITING_APPROVAL",
  "QUEUED",
  "SIGNING",
  "SETTLED",
  "DECLINED",
  "FAILED",
  "EXPIRED",
]);
export type ChargeStatus = z.infer<typeof ChargeStatusSchema>;

export const SignerJobStatusSchema = z.enum([
  "QUEUED",
  "CLAIMED",
  "SIGNED",
  "FAILED",
]);
export type SignerJobStatus = z.infer<typeof SignerJobStatusSchema>;

export const TokenStatusSchema = z.enum(["ACTIVE", "USED", "EXPIRED", "REVOKED"]);
export type TokenStatus = z.infer<typeof TokenStatusSchema>;

/**
 * Stable policy reason codes. The UI, the agent SDK and the tests all switch on
 * these. Adding a code is a contract change (see .agents/DECISIONS.md).
 */
export const PolicyCodeSchema = z.enum([
  "OK",
  "OK_APPROVAL_REQUIRED",
  "CARD_NOT_FOUND",
  "CARD_REVOKED",
  "CARD_PAUSED",
  "CARD_EXPIRED",
  "CARD_EXHAUSTED",
  "AGENT_REVOKED",
  "AGENT_PAUSED",
  "AMOUNT_INVALID",
  "AMOUNT_ABOVE_PER_CHARGE",
  "AMOUNT_ABOVE_DAILY_LIMIT",
  "AMOUNT_ABOVE_BUDGET",
  "MERCHANT_NOT_ALLOWED",
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "TOKEN_ALREADY_USED",
  "TOKEN_MERCHANT_MISMATCH",
  "TOKEN_AMOUNT_EXCEEDED",
  "ASSET_MISMATCH",
  "SIGNER_OFFLINE",
  "INSUFFICIENT_BALANCE",
  "SETTLEMENT_ERROR",
]);
export type PolicyCode = z.infer<typeof PolicyCodeSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Core entities
 * ──────────────────────────────────────────────────────────────────────────── */

export const UserSchema = z.object({
  id: z.string(),
  pollarUserId: z.string(),
  email: z.string().email().nullable(),
  name: z.string().nullable(),
  stellarAddress: z.string().nullable(),
  solanaAddress: z.string().nullable(),
  createdAt: IsoDateSchema,
});
export type User = z.infer<typeof UserSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  emoji: z.string().default("🤖"),
  status: AgentStatusSchema,
  keyPrefix: z.string(),
  lastSeenAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type Agent = z.infer<typeof AgentSchema>;

export const SpendingLimitsSchema = z.object({
  /** Max a single charge may be. */
  perCharge: MoneySchema,
  /** Max settled + reserved in a rolling 24h window. */
  daily: MoneySchema,
  /** At or below this, no human approval is needed. */
  autoApproveUnder: MoneySchema,
});
export type SpendingLimits = z.infer<typeof SpendingLimitsSchema>;

export const BudgetSchema = z.object({
  total: MoneySchema,
  spent: MoneySchema,
  reserved: MoneySchema,
});
export type Budget = z.infer<typeof BudgetSchema>;

export const CardSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  agentId: z.string(),
  label: z.string(),
  /** Display-only, derived from the id. Never used for authorization. */
  maskedNumber: z.string(),
  status: CardStatusSchema,
  chain: ChainSchema,
  asset: AssetSchema,
  budget: BudgetSchema,
  limits: SpendingLimitsSchema,
  /** Merchant ids this card may pay. Empty = all merchants (discouraged). */
  merchants: z.array(z.string()),
  expiresAt: IsoDateSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Card = z.infer<typeof CardSchema>;

export const MerchantSchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  emoji: z.string(),
  category: z.string(),
  settlementAddress: z.string(),
  settlementChain: ChainSchema,
  createdAt: IsoDateSchema,
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const TxReceiptSchema = z.object({
  chain: ChainSchema,
  hash: z.string(),
  explorerUrl: z.string(),
  asset: AssetSchema,
  amount: MoneySchema,
  memo: z.string().nullable(),
  confirmedAt: IsoDateSchema.nullable(),
  /** Optional: true once the chain was independently checked (not just the signer). */
  onchainVerified: z.boolean().optional(),
  /** Optional: how the payment was fulfilled. */
  settlement: z.enum(["direct", "facilitator", "mock"]).optional(),
});
export type TxReceipt = z.infer<typeof TxReceiptSchema>;

export const PolicyCheckSchema = z.object({
  code: PolicyCodeSchema,
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  code: PolicyCodeSchema,
  message: z.string(),
  checks: z.array(PolicyCheckSchema),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const ChargeSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  agentId: z.string(),
  ownerId: z.string(),
  merchantId: z.string(),
  merchantName: z.string(),
  amount: MoneySchema,
  asset: AssetSchema,
  description: z.string(),
  status: ChargeStatusSchema,
  decision: PolicyDecisionSchema,
  approvalRequired: z.boolean(),
  approvedAt: IsoDateSchema.nullable(),
  declinedAt: IsoDateSchema.nullable(),
  declineReason: z.string().nullable(),
  receipt: TxReceiptSchema.nullable(),
  error: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Charge = z.infer<typeof ChargeSchema>;

export const CardTokenSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  agentId: z.string(),
  merchantId: z.string().nullable(),
  maxAmount: MoneySchema,
  status: TokenStatusSchema,
  expiresAt: IsoDateSchema,
  usedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type CardToken = z.infer<typeof CardTokenSchema>;

export const SignerJobSchema = z.object({
  id: z.string(),
  chargeId: z.string(),
  status: SignerJobStatusSchema,
  claimedAt: IsoDateSchema.nullable(),
  completedAt: IsoDateSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
});
export type SignerJob = z.infer<typeof SignerJobSchema>;

export const LedgerEventTypeSchema = z.enum([
  "USER_CREATED",
  "AGENT_CREATED",
  "AGENT_KEY_ROTATED",
  "CARD_CREATED",
  "CARD_PAUSED",
  "CARD_RESUMED",
  "CARD_REVOKED",
  "TOKEN_ISSUED",
  "CHARGE_REQUESTED",
  "CHARGE_AUTO_APPROVED",
  "CHARGE_APPROVAL_REQUIRED",
  "CHARGE_APPROVED",
  "CHARGE_DECLINED",
  "CHARGE_SIGNING",
  "CHARGE_SETTLED",
  "CHARGE_FAILED",
  "PURCHASE_COMPLETED",
]);
export type LedgerEventType = z.infer<typeof LedgerEventTypeSchema>;

export const LedgerEventSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  cardId: z.string().nullable(),
  chargeId: z.string().nullable(),
  type: LedgerEventTypeSchema,
  actor: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateSchema,
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * API inputs
 * ──────────────────────────────────────────────────────────────────────────── */

export const CreateAgentSchema = z.object({
  name: z.string().min(2).max(40),
  description: z.string().max(200).optional(),
  emoji: z.string().max(8).optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

export const CreateCardSchema = z.object({
  agentId: z.string(),
  label: z.string().min(2).max(40),
  budget: MoneySchema,
  perCharge: MoneySchema,
  daily: MoneySchema,
  autoApproveUnder: MoneySchema,
  merchants: z.array(z.string()).min(1),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(24),
  chain: ChainSchema.default("STELLAR"),
});
export type CreateCardInput = z.infer<typeof CreateCardSchema>;

export const UpdateCardSchema = z.object({
  label: z.string().min(2).max(40).optional(),
  budget: MoneySchema.optional(),
  perCharge: MoneySchema.optional(),
  daily: MoneySchema.optional(),
  autoApproveUnder: MoneySchema.optional(),
  merchants: z.array(z.string()).optional(),
  expiresAt: IsoDateSchema.optional(),
});
export type UpdateCardInput = z.infer<typeof UpdateCardSchema>;

/** Agent asks for a single-use card token before a purchase. */
export const TokenRequestSchema = z.object({
  cardId: z.string(),
  merchantId: z.string(),
  amount: MoneySchema,
  description: z.string().max(120).optional(),
});
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

/** Merchant redeems a token. */
export const ChargeRequestSchema = z.object({
  token: z.string(),
  merchantId: z.string(),
  amount: MoneySchema,
  description: z.string().max(120),
  idempotencyKey: z.string().max(120).optional(),
});
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>;

/** Agent one-shot purchase against a known merchant SKU. */
export const PurchaseRequestSchema = z.object({
  cardId: z.string(),
  merchantId: z.string(),
  sku: z.string(),
  amount: MoneySchema,
  description: z.string().max(120).optional(),
});
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;

export const SkuSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  name: z.string(),
  description: z.string(),
  price: MoneySchema,
  unit: z.string(),
  licensePrefix: z.string(),
});
export type Sku = z.infer<typeof SkuSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * API outputs
 * ──────────────────────────────────────────────────────────────────────────── */

export const SessionResponseSchema = z.object({
  user: UserSchema,
  agents: z.array(AgentSchema),
  cards: z.array(CardSchema),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const TokenResponseSchema = z.object({
  token: z.string(),
  tokenId: z.string(),
  expiresAt: IsoDateSchema,
  card: z.object({
    id: z.string(),
    maskedNumber: z.string(),
    label: z.string(),
  }),
  merchantId: z.string(),
  maxAmount: MoneySchema,
  decision: PolicyDecisionSchema,
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const PurchaseResponseSchema = z.object({
  purchaseId: z.string(),
  charge: ChargeSchema,
  sku: SkuSchema,
  licenseKey: z.string(),
  receipt: TxReceiptSchema.nullable(),
});
export type PurchaseResponse = z.infer<typeof PurchaseResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(["testnet", "mainnet"]),
  demoMode: z.boolean(),
  signerOnline: z.boolean(),
  merchants: z.number(),
  now: IsoDateSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Signer bus (browser ⇄ API)
 * ──────────────────────────────────────────────────────────────────────────── */

export const SignerPaymentSchema = z.object({
  chargeId: z.string(),
  chain: ChainSchema,
  destination: z.string(),
  amount: MoneySchema,
  asset: AssetSchema,
  assetIssuer: z.string().nullable(),
  memo: z.string().max(28).nullable(),
  merchantName: z.string(),
  description: z.string(),
});
export type SignerPayment = z.infer<typeof SignerPaymentSchema>;

export const SignerResultSchema = z.object({
  chargeId: z.string(),
  status: z.enum(["success", "pending", "error"]),
  hash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  error: z.string().nullable(),
  signedAt: IsoDateSchema,
});
export type SignerResult = z.infer<typeof SignerResultSchema>;

export const SignerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), signerId: z.string() }),
  z.object({ type: z.literal("payment.queued"), payment: SignerPaymentSchema }),
  z.object({ type: z.literal("payment.cancelled"), chargeId: z.string() }),
  z.object({ type: z.literal("charge.settled"), charge: ChargeSchema }),
  z.object({ type: z.literal("charge.failed"), charge: ChargeSchema }),
]);
export type SignerEvent = z.infer<typeof SignerEventSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Presentation helpers (safe for client bundles)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Deterministic, non-sensitive display number. Looks like a card, authorizes nothing. */
export function maskCardNumber(cardId: string): string {
  let h = 2166136261;
  for (let i = 0; i < cardId.length; i++) {
    h ^= cardId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
    const n = Math.abs(h).toString().padStart(10, "0");
  return `4021 •••• •••• ${n.slice(-4)}`;
}

export function explorerUrl(chain: Chain, hash: string): string {
  return chain === "SOLANA"
    ? `https://explorer.solana.com/tx/${hash}?cluster=devnet`
    : `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function isCardUsable(card: Card, now = Date.now()): boolean {
  return (
    card.status === "ACTIVE" &&
    new Date(card.expiresAt).getTime() > now &&
    toUnits(card.budget.spent) + toUnits(card.budget.reserved) < toUnits(card.budget.total)
  );
}

export function remainingBudget(card: Card): Money {
  const left = toUnits(card.budget.total) - toUnits(card.budget.spent) - toUnits(card.budget.reserved);
  return fromUnits(left > 0n ? left : 0n);
}

/** Receipt memo: 28-byte Stellar text memo limit. */
export function receiptMemo(chargeId: string): string {
  return `TAB:${chargeId.replace(/^chg_/, "").slice(0, 24)}`;
}
