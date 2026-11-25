/**
 * @tab/api — the control plane. It never signs payments and never sees a
 * private key. See `.agents/CONTRACTS.md` for the frozen wire contract and
 * `.agents/SECURITY.md` for the non-negotiables enforced here.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Repo } from "@tab/db";
import { evaluateCharge, validateLimits } from "@tab/policy";
import {
  ChargeRequestSchema,
  CreateAgentSchema,
  CreateCardSchema,
  KEY_PREFIX,
  PurchaseRequestSchema,
  SignerResultSchema,
  TokenRequestSchema,
  UpdateCardSchema,
  cmpMoney,
  explorerUrl,
  fromUnits,
  maskCardNumber,
  newId,
  receiptMemo,
  toUnits,
  type Agent,
  type Asset,
  type Card,
  type CardToken,
  type Charge,
  type ChargeStatus,
  type Chain,
  type LedgerEventType,
  type Merchant,
  type PolicyDecision,
  type SignerPayment,
  type Sku,
  type TxReceipt,
} from "@tab/shared";
import { type ApiConfig, loadConfig } from "./env.js";
import { fail, parseWith, readJson, type ErrorStatus } from "./http.js";
import {
  SESSION_COOKIE,
  checkOrigin,
  clearSessionMeta,
  csrfTokenFor,
  deleteSessionMeta,
  hashToken,
  randomHex,
  requireAgent,
  requireFreshSession,
  requireMutation,
  requireSession,
  resolveActor,
  writeSessionMeta,
} from "./auth.js";
import { PollarVerifyError, verifyPollarToken } from "./pollar.js";
import {
  getPurchaseByChargeId,
  setChargePartialReceipt,
  updateAgentProfile,
} from "./repo-ext.js";
import { type SignerBus, sseConnection } from "./signer-bus.js";
import { clientIp, perMinute, RateLimiter, type RateLimitPolicy } from "./ratelimit.js";
import { type DnsLookup, defaultDnsLookup, validateX402Url } from "./ssrf.js";
import { verifySettlement, type SettlementExpectation } from "./verify.js";
import {
  X402_MERCHANT_ID,
  type X402Challenge,
  type X402Store,
  X402Error,
  createX402Store,
  ensureX402Merchant,
  isX402Charge,
  parseChallenge,
} from "./x402.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateAppOptions {
  repo: Repo;
  bus: SignerBus;
  config?: Partial<ApiConfig>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to DNS resolution. */
  dnsLookup?: DnsLookup;
  /** Injectable for tests; defaults to a private in-process map. */
  x402Store?: X402Store;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Local request schemas (no frozen counterpart exists)
 * ──────────────────────────────────────────────────────────────────────────── */

const SessionInputSchema = z.object({
  accessToken: z.string().min(1).optional(),
  /** Display hints only. userId/wallet are never read from the client. */
  email: z.string().email().nullable().optional(),
  name: z.string().max(120).nullable().optional(),
});

const UpdateAgentSchema = z
  .object({
    name: z.string().min(2).max(40).optional(),
    description: z.string().max(200).nullable().optional(),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update.",
  });

const X402RequestSchema = z.object({
  cardId: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "must be an http(s) URL"),
  idempotencyKey: z.string().max(120).optional(),
});

/**
 * `PurchaseRequestSchema` is frozen in @tab/shared; the idempotency field is
 * additive here and accepted from the body or the `Idempotency-Key` header.
 */
const PurchaseInputSchema = PurchaseRequestSchema.extend({
  idempotencyKey: z.string().max(120).optional(),
});

const SignerResultInputSchema = SignerResultSchema.extend({
  body: z.unknown().optional(),
  // The browser signer has no id for the merchant request and sends null.
  x402RequestId: z.string().nullable().optional(),
});

/** The one-click judge demo never accepts a client amount. */
const DemoPurchaseSchema = z.object({
  cardId: z.string().min(1),
  scenario: z.enum(["auto", "approval", "overcharge", "merchant", "x402"]),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

class RedeemError extends Error {
  constructor(
    public status: ErrorStatus,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "RedeemError";
  }
}

type VerifiedReceipt = TxReceipt & {
  verificationReason?: string;
};

const nowIso = () => new Date().toISOString();
const since24h = () => new Date(Date.now() - DAY_MS).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 500);
}

const LICENSE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function licenseBlock(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += LICENSE_ALPHABET[byte % LICENSE_ALPHABET.length];
  return out;
}

function makeLicenseKey(prefix: string): string {
  const clean =
    prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "TAB";
  return `${clean}-${licenseBlock()}-${licenseBlock()}-${licenseBlock()}`;
}

function findHeaderValue(body: unknown, name: string): string | null {
  if (!body) return null;
  if (typeof body === "string") return body;
  if (typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === "string") {
      return value;
    }
  }
  if (record.headers && typeof record.headers === "object") {
    return findHeaderValue(record.headers, name);
  }
  return null;
}

function decodePaymentResponse(body: unknown): unknown | null {
  const raw =
    findHeaderValue(body, "payment-response") ??
    findHeaderValue(body, "paymentResponse");
  if (!raw) return null;
  const normalised = raw.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(normalised, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractTxHash(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["hash", "txHash", "transaction", "transactionHash", "tx_hash"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * App factory
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The demo catalogue is seed data, but the deployed app must never be left
 * unable to sell because a reset or a partial seed removed it. Ensure the
 * merchants + SKUs exist; this is demo-only and idempotent.
 */
const DEMO_SKUS: Sku[] = [
  { id: "exa-starter", merchantId: "mch_exa", name: "Exa Starter", description: "1,000 searches", price: "2.50", unit: "1,000 searches", licensePrefix: "EXA" },
  { id: "exa-pro", merchantId: "mch_exa", name: "Exa Pro", description: "10,000 searches", price: "9.00", unit: "10,000 searches", licensePrefix: "EXA" },
  { id: "firecrawl-1k", merchantId: "mch_firecrawl", name: "Firecrawl 1K", description: "1,000 pages crawled", price: "4.00", unit: "1,000 pages", licensePrefix: "FIRE" },
  { id: "firecrawl-10k", merchantId: "mch_firecrawl", name: "Firecrawl 10K", description: "10,000 pages crawled", price: "19.00", unit: "10,000 pages", licensePrefix: "FIRE" },
  { id: "openai-5", merchantId: "mch_openai", name: "OpenAI $5", description: "API credit", price: "5.00", unit: "$5 credit", licensePrefix: "OAI" },
  { id: "openai-20", merchantId: "mch_openai", name: "OpenAI $20", description: "API credit", price: "20.00", unit: "$20 credit", licensePrefix: "OAI" },
];

function ensureDemoCatalogue(repo: Repo): void {
  const now = new Date().toISOString();
  const settlement =
    process.env.STELLAR_MERCHANT_ADDRESS?.trim() ||
    repo.listMerchants().find((m) => m.id !== X402_MERCHANT_ID)?.settlementAddress ||
    "";
  if (!settlement) return;

  const merchants: Merchant[] = [
    { id: "mch_exa", name: "Exa", domain: "exa.ai", emoji: "🔎", category: "search", settlementAddress: settlement, settlementChain: "STELLAR", createdAt: now },
    { id: "mch_firecrawl", name: "Firecrawl", domain: "firecrawl.dev", emoji: "🔥", category: "scraping", settlementAddress: settlement, settlementChain: "STELLAR", createdAt: now },
    { id: "mch_openai", name: "OpenAI", domain: "openai.com", emoji: "🤖", category: "ai", settlementAddress: settlement, settlementChain: "STELLAR", createdAt: now },
    { id: X402_MERCHANT_ID, name: "Nirium", domain: "nirium-agent.fly.dev", emoji: "📈", category: "market data", settlementAddress: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC", settlementChain: "STELLAR", createdAt: now },
  ];
  for (const merchant of merchants) {
    if (!repo.getMerchant(merchant.id)) repo.upsertMerchant(merchant);
  }
  // ensureX402Merchant may have created a placeholder row first; upgrade its label.
  const x402 = repo.getMerchant(X402_MERCHANT_ID);
  if (x402 && x402.name === "x402 Resource") {
    repo.upsertMerchant({ ...x402, name: "Nirium", domain: "nirium-agent.fly.dev", emoji: "📈", category: "market data", settlementAddress: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC" });
  }
  for (const sku of DEMO_SKUS) {
    if (!repo.getSku(sku.id)) repo.upsertSku(sku);
  }
}

export function createApp(options: CreateAppOptions): Hono {
  const { repo, bus } = options;
  const config = loadConfig(options.config);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dnsLookupImpl = options.dnsLookup ?? defaultDnsLookup;
  const x402 = options.x402Store ?? createX402Store();
  const limiter = new RateLimiter();

  ensureX402Merchant(repo);
  // Production boot repairs a partial/reset catalogue; tests keep their fixtures.
  if (process.env.NODE_ENV === "production") ensureDemoCatalogue(repo);

  const app = new Hono();
  const api = new Hono();

  if (config.enableLogger) {
    // Path-only logging. Hono's default logger includes the query string, which
    // would leak merchant `?token=` credentials into logs.
    app.use("*", async (c, next) => {
      const started = Date.now();
      await next();
      const path = new URL(c.req.url).pathname;
      console.log(
        `${c.req.method} ${path} ${c.res.status} ${Date.now() - started}ms`,
      );
    });
  }

  app.use(
    "*",
    cors({
      origin: config.allowedOrigins,
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "Idempotency-Key",
        "x-tab-csrf",
        "x-tab-token",
      ],
      maxAge: 600,
    }),
  );

  const notFound = (c: Context, message = "Not found.") =>
    fail(c, 404, "NOT_FOUND", message);

  const enforceLimit = (
    c: Context,
    key: string,
    policy: RateLimitPolicy,
  ): Response | null => {
    const result = limiter.check(key, policy);
    if (result.allowed) return null;
    c.header("Retry-After", String(result.retryAfter));
    return fail(c, 429, "RATE_LIMITED", "Too many requests; slow down.", {
      retryAfter: result.retryAfter,
    });
  };

  const ledger = (input: {
    ownerId: string;
    cardId?: string | null;
    chargeId?: string | null;
    type: LedgerEventType;
    actor: string;
    summary: string;
    data?: Record<string, unknown>;
  }): void => {
    repo.appendEvent({
      id: newId("event"),
      ownerId: input.ownerId,
      cardId: input.cardId ?? null,
      chargeId: input.chargeId ?? null,
      type: input.type,
      actor: input.actor,
      summary: input.summary,
      data: input.data ?? {},
      createdAt: nowIso(),
    });
  };

  function x402Asset(raw: string): { asset: Asset; issuer: string | null } {
    const value = raw.trim();
    const upper = value.toUpperCase();
    if (upper === "XLM" || value.toLowerCase() === "native") {
      return { asset: "XLM", issuer: null };
    }
    if (upper === "USDC") return { asset: "USDC", issuer: config.usdcIssuer };
    if (/^G[A-Z0-9]{55}$/.test(value)) return { asset: "USDC", issuer: value };
    return { asset: "USDC", issuer: config.usdcIssuer };
  }

  function buildSignerPayment(
    charge: Charge,
    card: Card,
    merchant: Merchant,
  ): SignerPayment {
    const record = isX402Charge(charge) ? x402.byChargeId(charge.id) : undefined;
    const challengeAsset = record ? x402Asset(record.challenge.asset) : null;
    return {
      chargeId: charge.id,
      chain: card.chain,
      destination: record?.challenge.payTo ?? merchant.settlementAddress,
      amount: charge.amount,
      asset: challengeAsset?.asset ?? charge.asset,
      assetIssuer: challengeAsset
        ? challengeAsset.issuer
        : charge.asset === "USDC" && card.chain === "STELLAR"
          ? config.usdcIssuer
          : null,
      memo: receiptMemo(charge.id),
      merchantName: merchant.name,
      description: charge.description,
    };
  }

  function x402Extras(
    charge: Charge,
  ): { x402Url: string; x402Challenge: X402Challenge } | Record<string, never> {
    if (!isX402Charge(charge)) return {};
    const record = x402.byChargeId(charge.id);
    if (!record) return {};
    return { x402Url: record.url, x402Challenge: record.challenge };
  }

  function queueCharge(charge: Charge): void {
    const card = repo.getCard(charge.cardId);
    const merchant = repo.getMerchant(charge.merchantId);
    if (!card || !merchant) return;
    bus.broadcast(charge.ownerId, "payment.queued", {
      type: "payment.queued",
      payment: buildSignerPayment(charge, card, merchant),
      ...x402Extras(charge),
    });
  }

  const approvalUrl = (chargeId: string): string =>
    `${config.webOrigin.replace(/\/+$/, "")}/app?charge=${encodeURIComponent(chargeId)}`;

  const isUniqueConstraint = (err: unknown): boolean => {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: unknown }).code;
    return (
      code === "SQLITE_CONSTRAINT_UNIQUE" ||
      (err instanceof Error && /UNIQUE constraint failed/i.test(err.message))
    );
  };

  /** x402 replay: never fetch or create a second charge. */
  function replayX402(c: Context, existing: Charge): Response {
    c.header("Idempotent-Replayed", "true");
    const record = x402.byChargeId(existing.id);
    return c.json(
      {
        requestId: record?.requestId ?? existing.id,
        chargeId: existing.id,
        ...(record ? { challenge: record.challenge } : {}),
        ...(existing.status === "AWAITING_APPROVAL"
          ? { approvalUrl: approvalUrl(existing.id) }
          : {}),
      },
      200,
    );
  }

  /** Purchase replay: return the original purchase/charge, never a new one. */
  function replayPurchase(
    c: Context,
    existing: Charge,
    requestedSkuId: string,
  ): Response {
    c.header("Idempotent-Replayed", "true");
    const purchase = getPurchaseByChargeId(repo, existing.id);
    const skuRow =
      (purchase ? repo.getSku(purchase.skuId) : repo.getSku(requestedSkuId)) ??
      null;

    if (existing.status === "SETTLED") {
      if (purchase && skuRow) {
        return c.json(
          {
            purchaseId: purchase.id,
            charge: existing,
            sku: skuRow,
            licenseKey: purchase.licenseKey,
            receipt: existing.receipt,
          },
          200,
        );
      }
      return c.json({ charge: existing }, 200);
    }

    if (existing.status === "FAILED") {
      return fail(
        c,
        402,
        "SETTLEMENT_ERROR",
        existing.error ?? "The payment failed.",
        { charge: existing },
      );
    }
    if (existing.status === "DECLINED" || existing.status === "EXPIRED") {
      return fail(
        c,
        403,
        existing.status === "DECLINED" ? "CHARGE_DECLINED" : "CHARGE_EXPIRED",
        `Charge is ${existing.status}.`,
        { charge: existing },
      );
    }

    return c.json(
      {
        charge: existing,
        status: "PENDING",
        ...(purchase ? { purchaseId: purchase.id } : {}),
        ...(existing.status === "AWAITING_APPROVAL"
          ? { approvalUrl: approvalUrl(existing.id) }
          : {}),
      },
      202,
    );
  }

  function makeReceipt(args: {
    chain: Chain;
    hash: string;
    asset: Asset;
    amount: string;
    memo: string | null;
    confirmedAt: string | null;
    verified: boolean;
    settlement?: TxReceipt["settlement"];
    reason?: string | null;
  }): VerifiedReceipt {
    return {
      chain: args.chain,
      hash: args.hash,
      explorerUrl: explorerUrl(args.chain, args.hash),
      asset: args.asset,
      amount: args.amount,
      memo: args.memo,
      confirmedAt: args.confirmedAt,
      onchainVerified: args.verified,
      ...(args.settlement ? { settlement: args.settlement } : {}),
      ...(args.reason ? { verificationReason: args.reason } : {}),
    };
  }

  function receiptSettlement(
    result: Awaited<ReturnType<typeof verifySettlement>>,
  ): NonNullable<TxReceipt["settlement"]> {
    if (result.settlement === "facilitator") return "facilitator";
    if (result.reason === "VERIFICATION_DISABLED") return "mock";
    return "direct";
  }

  function expectationFor(
    charge: Charge,
    card: Card,
    merchant: Merchant,
    record: ReturnType<X402Store["byChargeId"]>,
  ): SettlementExpectation {
    if (record) {
      const asset = x402Asset(record.challenge.asset);
      return {
        chain: card.chain,
        destination: record.challenge.payTo,
        amount: record.challenge.amount,
        asset: asset.asset,
        assetIssuer: asset.issuer,
        memo: null,
        notBefore: charge.createdAt,
        x402: true,
      };
    }
    return {
      chain: card.chain,
      destination: merchant.settlementAddress,
      amount: charge.amount,
      asset: charge.asset,
      assetIssuer:
        charge.asset === "USDC" && card.chain === "STELLAR"
          ? config.usdcIssuer
          : null,
      memo: receiptMemo(charge.id),
      notBefore: charge.createdAt,
      x402: false,
    };
  }

  /* ── token issue + charge create ────────────────────────────────────────── */

  type IssueResult =
    | { ok: true; rawToken: string; token: CardToken; decision: PolicyDecision }
    | { ok: false; decision: PolicyDecision };

  function issueTokenFor(args: {
    card: Card;
    agent: Agent;
    merchant: Merchant;
    amount: string;
    description: string;
  }): IssueResult {
    const decision = evaluateCharge({
      card: args.card,
      agent: args.agent,
      merchantId: args.merchant.id,
      amount: args.amount,
      dailyCommitted: repo.committedSince(args.card.id, since24h()),
    });
    if (!decision.allowed) return { ok: false, decision };

    const rawToken = `tab_ch_${randomHex(16)}`;
    const token = repo.createToken({
      id: newId("token"),
      cardId: args.card.id,
      agentId: args.agent.id,
      merchantId: args.merchant.id,
      maxAmount: args.amount,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + config.tokenTtlMs).toISOString(),
      createdAt: nowIso(),
    });

    ledger({
      ownerId: args.card.ownerId,
      cardId: args.card.id,
      type: "TOKEN_ISSUED",
      actor: `agent:${args.agent.id}`,
      summary: `Token issued to ${args.agent.name} for ${args.amount}`,
      data: {
        tokenId: token.id,
        merchantId: args.merchant.id,
        amount: args.amount,
        code: decision.code,
      },
    });

    return { ok: true, rawToken, token, decision };
  }

  function createChargeRow(args: {
    card: Card;
    agent: Agent;
    merchant: Merchant;
    amount: string;
    description: string;
    decision: PolicyDecision;
    idempotencyKey: string | null;
    purchase?: { id: string; skuId: string; licenseKey: string };
  }): Charge {
    const status: ChargeStatus = args.decision.requiresApproval
      ? "AWAITING_APPROVAL"
      : "QUEUED";

    const charge = repo.createCharge({
      id: newId("charge"),
      cardId: args.card.id,
      agentId: args.agent.id,
      ownerId: args.card.ownerId,
      merchantId: args.merchant.id,
      amount: args.amount,
      asset: args.card.asset,
      description: args.description,
      status,
      decision: args.decision,
      approvalRequired: args.decision.requiresApproval,
      idempotencyKey: args.idempotencyKey,
      createdAt: nowIso(),
    });

    if (args.purchase) {
      // The key is generated with the charge but only exposed after settlement.
      repo.createPurchase({
        id: args.purchase.id,
        chargeId: charge.id,
        skuId: args.purchase.skuId,
        agentId: args.agent.id,
        licenseKey: args.purchase.licenseKey,
        createdAt: nowIso(),
      });
    }

    if (!args.decision.requiresApproval) {
      repo.createSignerJob({
        id: newId("signerJob"),
        chargeId: charge.id,
        createdAt: nowIso(),
      });
    }

    ledger({
      ownerId: args.card.ownerId,
      cardId: args.card.id,
      chargeId: charge.id,
      type: "CHARGE_REQUESTED",
      actor: `merchant:${args.merchant.id}`,
      summary: `${args.merchant.name} requested ${args.amount}`,
      data: {
        amount: args.amount,
        merchantId: args.merchant.id,
        status,
      },
    });
    ledger({
      ownerId: args.card.ownerId,
      cardId: args.card.id,
      chargeId: charge.id,
      type: args.decision.requiresApproval
        ? "CHARGE_APPROVAL_REQUIRED"
        : "CHARGE_AUTO_APPROVED",
      actor: "policy",
      summary: args.decision.message,
      data: { code: args.decision.code },
    });

    return charge;
  }

  function createChargeFromToken(args: {
    token: CardToken;
    card: Card;
    agent: Agent;
    merchant: Merchant;
    amount: string;
    description: string;
    decision: PolicyDecision;
    idempotencyKey: string | null;
    purchase?: { id: string; skuId: string; licenseKey: string };
  }): Charge {
    return repo.db.transaction(() => {
      if (!repo.markTokenUsed(args.token.id)) {
        throw new RedeemError(
          403,
          "TOKEN_ALREADY_USED",
          "This token was already redeemed.",
        );
      }
      if (!repo.reserveBudget(args.card.id, args.amount)) {
        throw new RedeemError(
          403,
          "AMOUNT_ABOVE_BUDGET",
          "This would exceed the card's remaining budget.",
        );
      }
      const charge = createChargeRow(args);
      // The frozen charges table has no token_id column. Bind the redeemed
      // token to this exact charge in the meta table so a merchant can poll
      // with the (now USED) token without being able to read other charges.
      repo.setMeta(`charge_token:${charge.id}`, args.token.id);
      return charge;
    })();
  }

  function createChargeDirect(args: {
    card: Card;
    agent: Agent;
    merchant: Merchant;
    amount: string;
    description: string;
    decision: PolicyDecision;
    idempotencyKey: string | null;
  }): Charge {
    return repo.db.transaction(() => {
      if (!repo.reserveBudget(args.card.id, args.amount)) {
        throw new RedeemError(
          403,
          "AMOUNT_ABOVE_BUDGET",
          "This would exceed the card's remaining budget.",
        );
      }
      return createChargeRow(args);
    })();
  }

  /**
   * The single purchase path. `POST /purchases` (agent key) and
   * `POST /demo/purchase` (owner cookie + CSRF) both land here, so the demo
   * cannot skip the token, policy, reservation, signer job or ledger events.
   */
  async function executePurchase(
    c: Context,
    args: {
      card: Card;
      agent: Agent;
      merchantId: string;
      skuId: string;
      amount: string;
      description?: string;
      idempotencyKey: string | null;
      /** Demo-only wording; never changes the code or the policy decision. */
      explainDenial?: (decision: PolicyDecision) => string;
    },
  ): Promise<Response> {
    const { card, agent } = args;

    // Replay before issuing a token or touching budget.
    if (args.idempotencyKey) {
      const existing = repo.getChargeByIdempotency(card.id, args.idempotencyKey);
      if (existing) return replayPurchase(c, existing, args.skuId);
    }

    const sku = repo.getSku(args.skuId);
    if (!sku) return notFound(c, "Unknown SKU.");
    if (sku.merchantId !== args.merchantId) {
      return fail(
        c,
        400,
        "VALIDATION_ERROR",
        "This SKU belongs to a different merchant.",
        { skuMerchantId: sku.merchantId },
      );
    }
    if (cmpMoney(args.amount, sku.price) !== 0) {
      return fail(c, 400, "AMOUNT_MISMATCH", `This SKU costs ${sku.price}.`, {
        expected: sku.price,
        received: args.amount,
      });
    }

    const merchant = repo.getMerchant(args.merchantId);
    if (!merchant) return notFound(c, "Unknown merchant.");
    if (merchant.settlementChain !== card.chain) {
      return fail(
        c,
        403,
        "ASSET_MISMATCH",
        "This merchant settles on a different chain.",
        { cardChain: card.chain, merchantChain: merchant.settlementChain },
      );
    }

    const description = args.description ?? sku.name;
    const issued = issueTokenFor({
      card,
      agent,
      merchant,
      amount: sku.price,
      description,
    });
    if (!issued.ok) {
      return fail(
        c,
        403,
        issued.decision.code,
        args.explainDenial?.(issued.decision) ?? issued.decision.message,
        { decision: issued.decision },
      );
    }

    const purchaseId = newId("purchase");
    const licenseKey = makeLicenseKey(sku.licensePrefix);

    let charge: Charge;
    try {
      charge = createChargeFromToken({
        token: issued.token,
        card,
        agent,
        merchant,
        amount: sku.price,
        description,
        decision: issued.decision,
        idempotencyKey: args.idempotencyKey,
        purchase: { id: purchaseId, skuId: sku.id, licenseKey },
      });
    } catch (err) {
      if (err instanceof RedeemError) {
        return fail(c, err.status, err.code, err.message, err.details);
      }
      if (isUniqueConstraint(err) && args.idempotencyKey) {
        const existing = repo.getChargeByIdempotency(card.id, args.idempotencyKey);
        if (existing) return replayPurchase(c, existing, args.skuId);
      }
      throw err;
    }

    if (charge.status === "AWAITING_APPROVAL") {
      return c.json(
        {
          charge,
          status: "PENDING",
          approvalUrl: approvalUrl(charge.id),
        },
        202,
      );
    }

    queueCharge(charge);
    const settled = await waitForCharge(charge.id, config.purchaseWaitMs);

    if (settled.status === "SETTLED") {
      return c.json(
        {
          purchaseId,
          charge: settled,
          sku,
          licenseKey,
          receipt: settled.receipt,
        },
        200,
      );
    }

    if (settled.status === "FAILED") {
      return fail(
        c,
        402,
        "SETTLEMENT_ERROR",
        settled.error ?? "The payment failed.",
        { charge: settled },
      );
    }

    if (settled.status === "DECLINED" || settled.status === "EXPIRED") {
      return fail(
        c,
        403,
        settled.status === "DECLINED" ? "CHARGE_DECLINED" : "CHARGE_EXPIRED",
        settled.status === "DECLINED"
          ? "The card owner declined this purchase."
          : "The signer did not settle this purchase in time.",
        { charge: settled },
      );
    }

    return c.json({ charge: settled, status: "PENDING" }, 202);
  }

  /**
   * The single x402 request path. The agent route and the judge demo both use
   * it, so HTTPS/allowlist/DNS checks, policy, reservation and the signer job
   * are identical.
   */
  async function executeX402Request(
    c: Context,
    args: {
      card: Card;
      agent: Agent;
      url: string;
      idempotencyKey: string | null;
    },
  ): Promise<Response> {
    const { card, agent } = args;

    // Replay before the network fetch, so a retry never pays twice.
    if (args.idempotencyKey) {
      const existing = repo.getChargeByIdempotency(card.id, args.idempotencyKey);
      if (existing) return replayX402(c, existing);
    }

    const safe = await validateX402Url({
      raw: args.url,
      allowedHosts: config.x402AllowedHosts,
      lookup: dnsLookupImpl,
    });
    if (!safe.ok) {
      return fail(c, 400, safe.code, safe.message);
    }
    const safeUrl = safe.url.toString();

    ensureX402Merchant(repo);
    const merchant = repo.getMerchant(X402_MERCHANT_ID);
    if (!merchant) {
      return fail(c, 500, "INTERNAL", "The x402 merchant is not configured.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetchImpl(safeUrl, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      return fail(
        c,
        500,
        "X402_FETCH_FAILED",
        err instanceof Error ? err.message : "Could not reach the x402 resource.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      return fail(
        c,
        400,
        "X402_REDIRECT_BLOCKED",
        "The x402 resource tried to redirect; redirects are not followed.",
      );
    }

    let challenge: X402Challenge;
    try {
      challenge = await parseChallenge(res, safeUrl);
    } catch (err) {
      if (err instanceof X402Error) {
        return fail(c, err.status, err.code, err.message, err.details);
      }
      throw err;
    }

    const decision = evaluateCharge({
      card,
      agent,
      merchantId: X402_MERCHANT_ID,
      amount: challenge.amount,
      dailyCommitted: repo.committedSince(card.id, since24h()),
    });
    if (!decision.allowed) {
      return fail(c, 403, decision.code, decision.message, {
        decision,
        challenge,
      });
    }

    const requestId = newId("purchase");
    let charge: Charge;
    try {
      charge = createChargeDirect({
        card,
        agent,
        merchant,
        amount: challenge.amount,
        description: safeUrl,
        decision,
        idempotencyKey: args.idempotencyKey,
      });
    } catch (err) {
      if (err instanceof RedeemError) {
        return fail(c, err.status, err.code, err.message, err.details);
      }
      if (isUniqueConstraint(err) && args.idempotencyKey) {
        const existing = repo.getChargeByIdempotency(card.id, args.idempotencyKey);
        if (existing) return replayX402(c, existing);
      }
      throw err;
    }

    x402.create({
      requestId,
      chargeId: charge.id,
      ownerId: card.ownerId,
      agentId: agent.id,
      url: safeUrl,
      challenge,
      status: charge.status,
      createdAt: nowIso(),
    });

    if (charge.status === "QUEUED") queueCharge(charge);

    return c.json(
      {
        requestId,
        chargeId: charge.id,
        challenge,
        ...(charge.status === "AWAITING_APPROVAL"
          ? { approvalUrl: approvalUrl(charge.id) }
          : {}),
      },
      201,
    );
  }

  function expireApproval(charge: Charge, reason: string, summary: string): Charge {
    return repo.db.transaction(() => {
      repo.releaseBudget(charge.cardId, charge.amount);
      repo.cancelSignerJob(charge.id);
      x402.setStatus(charge.id, "EXPIRED");
      const next = repo.setChargeStatus(charge.id, "EXPIRED", { error: reason });
      ledger({
        ownerId: charge.ownerId,
        cardId: charge.cardId,
        chargeId: charge.id,
        type: "CHARGE_FAILED",
        actor: "system:expiry",
        summary,
        data: { reason, amount: charge.amount },
      });
      return next;
    })();
  }

  async function waitForCharge(chargeId: string, timeoutMs: number): Promise<Charge> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const charge = repo.getCharge(chargeId);
      if (!charge) throw new Error("Charge disappeared while waiting.");
      if (
        charge.status === "SETTLED" ||
        charge.status === "FAILED" ||
        charge.status === "DECLINED" ||
        charge.status === "EXPIRED"
      ) {
        return charge;
      }
      if (Date.now() >= deadline) return charge;
      await sleep(100);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Health (public)
   * ────────────────────────────────────────────────────────────────────────── */

  const healthPayload = () => ({
    ok: true,
    mode: config.network,
    demoMode: config.demoMode,
    signerOnline: bus.size > 0,
    merchants: repo.listMerchants().length,
    now: nowIso(),
  });

  api.get("/health", (c) => c.json(healthPayload()));

  /* ──────────────────────────────────────────────────────────────────────────
   * Session (verified through Pollar; CSRF issued here)
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/session", async (c) => {
    const origin = checkOrigin(c, config.allowedOrigins);
    if (!origin.ok) return origin.response;

    const limited = enforceLimit(
      c,
      `session:${clientIp(c.req.raw.headers)}`,
      perMinute(config.rateLimits.sessionPerMin),
    );
    if (limited) return limited;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, SessionInputSchema, body.value);
    if (!parsed.ok) return parsed.response;

    const header = c.req.header("authorization");
    const headerToken = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : null;
    const token =
      headerToken && !headerToken.startsWith(KEY_PREFIX.agent)
        ? headerToken
        : parsed.data.accessToken;

    if (!token) {
      return fail(c, 401, "UNAUTHORIZED", "Send your Pollar access token.");
    }

    let verified: Awaited<ReturnType<typeof verifyPollarToken>>;
    try {
      verified = await verifyPollarToken({ token, config, fetchImpl });
    } catch (err) {
      if (err instanceof PollarVerifyError) {
        return fail(c, err.status, err.code, err.message);
      }
      throw err;
    }

    const existing = repo.getUserByPollarId(verified.userId);
    const user = repo.upsertUser({
      id: existing?.id ?? newId("user"),
      pollarUserId: verified.userId,
      email: parsed.data.email ?? verified.email ?? null,
      name: parsed.data.name ?? verified.name ?? null,
      stellarAddress: verified.walletAddress,
      solanaAddress: verified.solanaAddress,
      createdAt: existing?.createdAt ?? nowIso(),
    });

    if (!existing) {
      ledger({
        ownerId: user.id,
        type: "USER_CREATED",
        actor: `user:${user.id}`,
        summary: `${user.name ?? user.email ?? "A human"} opened a TAB account`,
        data: { pollarUserId: user.pollarUserId },
      });
    }

    const now = Date.now();
    const pollarExpires = Date.parse(verified.expiresAt);
    const expiresMs = Math.min(now + config.sessionTtlMs, pollarExpires);
    if (expiresMs <= now) {
      return fail(c, 401, "POLLAR_TOKEN_EXPIRED", "This Pollar token has expired.");
    }

    const rawSession = randomHex(32);
    const tokenHash = hashToken(rawSession);
    repo.createSession({
      id: newId("session"),
      userId: user.id,
      tokenHash,
      createdAt: nowIso(),
      expiresAt: new Date(expiresMs).toISOString(),
    });
    writeSessionMeta(repo, tokenHash, {
      pollarExpiresAt: verified.expiresAt,
      verifiedAt: nowIso(),
      applicationId: verified.applicationId,
      network: verified.network,
      walletAddress: verified.walletAddress,
    });

    const csrfToken = csrfTokenFor(rawSession, config.sessionSecret);
    setCookie(c, SESSION_COOKIE, rawSession, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.max(1, Math.floor((expiresMs - now) / 1000)),
      secure: process.env.NODE_ENV === "production",
    });

    return c.json({
      user,
      agents: repo.listAgents(user.id),
      cards: repo.listCards(user.id),
      csrfToken,
      sessionExpiresAt: new Date(expiresMs).toISOString(),
    });
  });

  api.get("/session/csrf", (c) => {
    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;
    return c.json({ csrfToken: auth.csrfToken });
  });

  api.post("/session/logout", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;
    repo.deleteSession(auth.tokenHash);
    deleteSessionMeta(repo, auth.tokenHash);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  api.get("/me", (c) => {
    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;
    const user = auth.user;
    return c.json({
      user,
      agents: repo.listAgents(user.id),
      cards: repo.listCards(user.id),
      charges: repo.listCharges(user.id),
      ledger: repo.listLedger(user.id),
      csrfToken: auth.csrfToken,
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Agents
   * ────────────────────────────────────────────────────────────────────────── */

  api.get("/agents", (c) => {
    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;
    return c.json({ agents: repo.listAgents(auth.user.id) });
  });

  api.post("/agents", async (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, CreateAgentSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const rawKey = `${KEY_PREFIX.agent}${randomHex(20)}`;
    const agent = repo.createAgent({
      id: newId("agent"),
      ownerId: auth.user.id,
      name: input.name,
      description: input.description ?? null,
      emoji: input.emoji ?? "🤖",
      keyHash: hashToken(rawKey),
      keyPrefix: rawKey.slice(0, KEY_PREFIX.agent.length + 4),
      createdAt: nowIso(),
    });

    ledger({
      ownerId: auth.user.id,
      type: "AGENT_CREATED",
      actor: `user:${auth.user.id}`,
      summary: `Created agent ${agent.name}`,
      data: { agentId: agent.id },
    });

    return c.json({ agent, apiKey: rawKey }, 201);
  });

  api.patch("/agents/:id", async (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const agent = repo.getAgent(c.req.param("id"));
    if (!agent || agent.ownerId !== auth.user.id) return notFound(c);

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, UpdateAgentSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    updateAgentProfile(repo, agent.id, {
      name: input.name,
      description: input.description,
    });
    if (input.status) repo.setAgentStatus(agent.id, input.status);

    return c.json({ agent: repo.getAgent(agent.id)! });
  });

  api.post("/agents/:id/rotate-key", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const agent = repo.getAgent(c.req.param("id"));
    if (!agent || agent.ownerId !== auth.user.id) return notFound(c);

    const rawKey = `${KEY_PREFIX.agent}${randomHex(20)}`;
    repo.rotateAgentKey(
      agent.id,
      hashToken(rawKey),
      rawKey.slice(0, KEY_PREFIX.agent.length + 4),
    );

    ledger({
      ownerId: auth.user.id,
      type: "AGENT_KEY_ROTATED",
      actor: `user:${auth.user.id}`,
      summary: `Rotated ${agent.name}'s key`,
      data: { agentId: agent.id },
    });

    return c.json({ agent: repo.getAgent(agent.id)!, apiKey: rawKey });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Cards
   * ────────────────────────────────────────────────────────────────────────── */

  api.get("/cards", (c) => {
    const auth = resolveActor(c, repo, config);
    if (!auth.ok) return auth.response;
    return c.json({
      cards:
        auth.actor.kind === "user"
          ? repo.listCards(auth.actor.user.id)
          : repo.listCardsForAgent(auth.actor.agent.id),
    });
  });

  api.post("/cards", async (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, CreateCardSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const limits = validateLimits({
      perCharge: input.perCharge,
      daily: input.daily,
      total: input.budget,
      autoApproveUnder: input.autoApproveUnder,
    });
    if (!limits.ok) {
      return fail(
        c,
        400,
        "INVALID_LIMITS",
        limits.reason ?? "Card limits are inconsistent.",
        { reason: limits.reason },
      );
    }

    const agent = repo.getAgent(input.agentId);
    if (!agent || agent.ownerId !== auth.user.id) return notFound(c);

    const missing = input.merchants.filter((id) => !repo.getMerchant(id));
    if (missing.length > 0) {
      return fail(c, 400, "VALIDATION_ERROR", "Unknown merchant(s).", {
        merchants: missing,
      });
    }

    const id = newId("card");
    const card = repo.createCard({
      id,
      ownerId: auth.user.id,
      agentId: agent.id,
      label: input.label,
      maskedNumber: maskCardNumber(id),
      chain: input.chain,
      asset: config.settlementAsset,
      budgetTotal: input.budget,
      perCharge: input.perCharge,
      daily: input.daily,
      autoApproveUnder: input.autoApproveUnder,
      merchants: input.merchants,
      expiresAt: new Date(
        Date.now() + input.expiresInHours * 60 * 60 * 1000,
      ).toISOString(),
      createdAt: nowIso(),
    });

    ledger({
      ownerId: auth.user.id,
      cardId: card.id,
      type: "CARD_CREATED",
      actor: `user:${auth.user.id}`,
      summary: `Opened a ${input.budget} tab for ${agent.name}`,
      data: {
        agentId: agent.id,
        budget: input.budget,
        perCharge: input.perCharge,
        daily: input.daily,
        autoApproveUnder: input.autoApproveUnder,
        merchants: input.merchants,
      },
    });

    return c.json({ card }, 201);
  });

  api.get("/cards/:id", (c) => {
    const auth = resolveActor(c, repo, config);
    if (!auth.ok) return auth.response;
    const card = repo.getCard(c.req.param("id"));
    if (!card) return notFound(c);
    if (auth.actor.kind === "user" && card.ownerId !== auth.actor.user.id) {
      return notFound(c);
    }
    if (auth.actor.kind === "agent" && card.agentId !== auth.actor.agent.id) {
      return notFound(c);
    }
    return c.json({ card });
  });

  api.patch("/cards/:id", async (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const card = repo.getCard(c.req.param("id"));
    if (!card || card.ownerId !== auth.user.id) return notFound(c);
    if (card.status === "REVOKED") {
      return fail(c, 409, "CARD_REVOKED", "This card was revoked.");
    }

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, UpdateCardSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const limits = validateLimits({
      perCharge: input.perCharge ?? card.limits.perCharge,
      daily: input.daily ?? card.limits.daily,
      total: input.budget ?? card.budget.total,
      autoApproveUnder:
        input.autoApproveUnder ?? card.limits.autoApproveUnder,
    });
    if (!limits.ok) {
      return fail(
        c,
        400,
        "INVALID_LIMITS",
        limits.reason ?? "Card limits are inconsistent.",
        { reason: limits.reason },
      );
    }

    if (input.budget !== undefined) {
      const committed =
        toUnits(card.budget.spent) + toUnits(card.budget.reserved);
      if (toUnits(input.budget) < committed) {
        return fail(
          c,
          400,
          "AMOUNT_ABOVE_BUDGET",
          "The new budget is below funds already spent or reserved.",
          {
            committed: fromUnits(committed),
            requested: input.budget,
          },
        );
      }
    }

    if (input.merchants !== undefined) {
      const missing = input.merchants.filter((id) => !repo.getMerchant(id));
      if (missing.length > 0) {
        return fail(c, 400, "VALIDATION_ERROR", "Unknown merchant(s).", {
          merchants: missing,
        });
      }
    }

    const updated = repo.updateCard(card.id, {
      label: input.label,
      budgetTotal: input.budget,
      perCharge: input.perCharge,
      daily: input.daily,
      autoApproveUnder: input.autoApproveUnder,
      merchants: input.merchants,
      expiresAt: input.expiresAt,
    });

    return c.json({ card: updated });
  });

  api.post("/cards/:id/pause", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;
    const card = repo.getCard(c.req.param("id"));
    if (!card || card.ownerId !== auth.user.id) return notFound(c);
    if (card.status === "REVOKED") {
      return fail(c, 409, "CARD_REVOKED", "This card was revoked.");
    }
    if (card.status === "PAUSED") return c.json({ card });

    const updated = repo.updateCard(card.id, { status: "PAUSED" });
    ledger({
      ownerId: auth.user.id,
      cardId: card.id,
      type: "CARD_PAUSED",
      actor: `user:${auth.user.id}`,
      summary: `Paused ${card.label}`,
    });
    return c.json({ card: updated });
  });

  api.post("/cards/:id/resume", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;
    const card = repo.getCard(c.req.param("id"));
    if (!card || card.ownerId !== auth.user.id) return notFound(c);
    if (card.status === "REVOKED") {
      return fail(c, 409, "CARD_REVOKED", "This card was revoked.");
    }
    if (new Date(card.expiresAt).getTime() <= Date.now()) {
      return fail(c, 409, "CARD_EXPIRED", "This card has expired.");
    }
    if (card.status === "ACTIVE") return c.json({ card });

    const updated = repo.updateCard(card.id, { status: "ACTIVE" });
    ledger({
      ownerId: auth.user.id,
      cardId: card.id,
      type: "CARD_RESUMED",
      actor: `user:${auth.user.id}`,
      summary: `Resumed ${card.label}`,
    });
    return c.json({ card: updated });
  });

  api.post("/cards/:id/revoke", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const card = repo.getCard(c.req.param("id"));
    if (!card || card.ownerId !== auth.user.id) return notFound(c);
    if (card.status === "REVOKED") return c.json({ card });

    const cancelled: Charge[] = [];
    repo.db.transaction(() => {
      repo.updateCard(card.id, { status: "REVOKED" });
      repo.revokeTokensForCard(card.id);

      const open = repo
        .listChargesForCard(card.id, 500)
        .filter(
          (charge) =>
            charge.status === "AWAITING_APPROVAL" || charge.status === "QUEUED",
        );

      for (const charge of open) {
        repo.releaseBudget(card.id, charge.amount);
        repo.setChargeStatus(charge.id, "EXPIRED", {
          error: "card revoked",
        });
        repo.cancelSignerJob(charge.id);
        x402.setStatus(charge.id, "EXPIRED");
        ledger({
          ownerId: auth.user.id,
          cardId: card.id,
          chargeId: charge.id,
          type: "CHARGE_FAILED",
          actor: `user:${auth.user.id}`,
          summary: "Card revoked before settlement",
          data: { reason: "CARD_REVOKED", amount: charge.amount },
        });
        cancelled.push(charge);
      }

      ledger({
        ownerId: auth.user.id,
        cardId: card.id,
        type: "CARD_REVOKED",
        actor: `user:${auth.user.id}`,
        summary: `Revoked ${card.label}`,
        data: { cancelledCharges: cancelled.length },
      });
    })();

    for (const charge of cancelled) {
      bus.broadcast(auth.user.id, "payment.cancelled", {
        type: "payment.cancelled",
        chargeId: charge.id,
      });
    }

    return c.json({ card: repo.getCard(card.id)! });
  });

  api.get("/cards/:id/charges", (c) => {
    const auth = resolveActor(c, repo, config);
    if (!auth.ok) return auth.response;
    const card = repo.getCard(c.req.param("id"));
    if (!card) return notFound(c);
    if (auth.actor.kind === "user" && card.ownerId !== auth.actor.user.id) {
      return notFound(c);
    }
    if (auth.actor.kind === "agent" && card.agentId !== auth.actor.agent.id) {
      return notFound(c);
    }
    const limit = clampLimit(c.req.query("limit"), 50);
    return c.json({ charges: repo.listChargesForCard(card.id, limit) });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Tokens (agent)
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/tokens", async (c) => {
    const auth = requireAgent(c, repo);
    if (!auth.ok) return auth.response;

    const limited = enforceLimit(
      c,
      `tokens:${auth.agent.id}`,
      perMinute(config.rateLimits.tokensPerMin),
    );
    if (limited) return limited;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, TokenRequestSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const card = repo.getCard(input.cardId);
    if (
      !card ||
      card.agentId !== auth.agent.id ||
      card.ownerId !== auth.agent.ownerId
    ) {
      return notFound(c);
    }

    const merchant = repo.getMerchant(input.merchantId);
    if (!merchant) return notFound(c, "Unknown merchant.");

    const issued = issueTokenFor({
      card,
      agent: auth.agent,
      merchant,
      amount: input.amount,
      description: input.description ?? `Token for ${merchant.name}`,
    });

    if (!issued.ok) {
      return fail(c, 403, issued.decision.code, issued.decision.message, {
        decision: issued.decision,
      });
    }

    return c.json(
      {
        token: issued.rawToken,
        tokenId: issued.token.id,
        expiresAt: issued.token.expiresAt,
        card: {
          id: card.id,
          maskedNumber: card.maskedNumber,
          label: card.label,
        },
        merchantId: merchant.id,
        maxAmount: input.amount,
        decision: issued.decision,
      },
      201,
    );
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Charges
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/charges", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, ChargeRequestSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const limited = enforceLimit(
      c,
      `charges:${clientIp(c.req.raw.headers)}:${hashToken(input.token).slice(0, 16)}`,
      perMinute(config.rateLimits.chargesPerMin),
    );
    if (limited) return limited;

    const idempotencyKey =
      (c.req.header("idempotency-key") ?? input.idempotencyKey ?? "").trim() ||
      null;

    const token = repo.getTokenByHash(hashToken(input.token));
    if (!token) {
      return fail(c, 403, "TOKEN_INVALID", "This charge token is not valid.");
    }

    if (idempotencyKey) {
      const existing = repo.getChargeByIdempotency(token.cardId, idempotencyKey);
      if (existing) {
        // Audit contract: conflict, with the original charge in the body.
        c.header("Idempotent-Replayed", "true");
        return c.json({ charge: existing }, 409);
      }
    }

    if (token.status === "USED") {
      return fail(
        c,
        403,
        "TOKEN_ALREADY_USED",
        "This token was already redeemed.",
      );
    }
    if (token.status !== "ACTIVE") {
      return fail(c, 403, "TOKEN_INVALID", "This token is no longer active.");
    }
    if (new Date(token.expiresAt).getTime() <= Date.now()) {
      return fail(c, 403, "TOKEN_EXPIRED", "This token has expired.");
    }
    if (token.merchantId && token.merchantId !== input.merchantId) {
      return fail(
        c,
        403,
        "TOKEN_MERCHANT_MISMATCH",
        "This token is bound to another merchant.",
      );
    }
    if (cmpMoney(input.amount, token.maxAmount) > 0) {
      return fail(
        c,
        403,
        "TOKEN_AMOUNT_EXCEEDED",
        `This token is capped at ${token.maxAmount}.`,
      );
    }

    const card = repo.getCard(token.cardId);
    const agent = repo.getAgent(token.agentId);
    const merchant = repo.getMerchant(input.merchantId);
    if (!card || !agent || !merchant) {
      return fail(c, 403, "TOKEN_INVALID", "This token can no longer be redeemed.");
    }
    if (merchant.settlementChain !== card.chain) {
      return fail(
        c,
        403,
        "ASSET_MISMATCH",
        "This merchant settles on a different chain.",
        { cardChain: card.chain, merchantChain: merchant.settlementChain },
      );
    }

    const decision = evaluateCharge({
      card,
      agent,
      merchantId: merchant.id,
      amount: input.amount,
      dailyCommitted: repo.committedSince(card.id, since24h()),
    });
    if (!decision.allowed) {
      return fail(c, 403, decision.code, decision.message, { decision });
    }

    let charge: Charge;
    try {
      charge = createChargeFromToken({
        token,
        card,
        agent,
        merchant,
        amount: input.amount,
        description: input.description,
        decision,
        idempotencyKey,
      });
    } catch (err) {
      if (err instanceof RedeemError) {
        return fail(c, err.status, err.code, err.message, err.details);
      }
      throw err;
    }

    if (charge.status === "QUEUED") queueCharge(charge);
    return c.json(
      {
        charge,
        ...(charge.status === "AWAITING_APPROVAL"
          ? { approvalUrl: approvalUrl(charge.id) }
          : {}),
      },
      201,
    );
  });

  api.get("/charges", (c) => {
    const auth = resolveActor(c, repo, config);
    if (!auth.ok) return auth.response;

    const limit = clampLimit(c.req.query("limit"), 50);
    const cardId = c.req.query("cardId");

    if (cardId) {
      const card = repo.getCard(cardId);
      if (!card) return notFound(c);
      if (auth.actor.kind === "user" && card.ownerId !== auth.actor.user.id) {
        return notFound(c);
      }
      if (auth.actor.kind === "agent" && card.agentId !== auth.actor.agent.id) {
        return notFound(c);
      }
      return c.json({ charges: repo.listChargesForCard(cardId, limit) });
    }

    return c.json({
      charges:
        auth.actor.kind === "user"
          ? repo.listCharges(auth.actor.user.id, limit)
          : repo.listChargesForAgent(auth.actor.agent.id, limit),
    });
  });

  api.get("/charges/:id", (c) => {
    const charge = repo.getCharge(c.req.param("id"));
    if (!charge) return notFound(c);

    // Merchant polling: `x-tab-token` is preferred, `?token=` is the fallback.
    // A USED/EXPIRED token may read only the one charge it created.
    const tokenRaw =
      c.req.header("x-tab-token") ?? c.req.query("token");
    if (tokenRaw) {
      const token = repo.getTokenByHash(hashToken(tokenRaw));
      if (!token) return notFound(c);
      if (repo.getMeta(`charge_token:${charge.id}`) !== token.id) {
        return notFound(c);
      }
      return c.json({ charge });
    }

    const auth = resolveActor(c, repo, config);
    if (!auth.ok) return auth.response;
    if (auth.actor.kind === "user" && charge.ownerId !== auth.actor.user.id) {
      return notFound(c);
    }
    if (auth.actor.kind === "agent" && charge.agentId !== auth.actor.agent.id) {
      return notFound(c);
    }

    const purchase =
      charge.status === "SETTLED" ? getPurchaseByChargeId(repo, charge.id) : null;

    return c.json({
      charge,
      ...(charge.status === "AWAITING_APPROVAL"
        ? { approvalUrl: approvalUrl(charge.id) }
        : {}),
      ...(purchase
        ? {
            purchase: {
              purchaseId: purchase.id,
              skuId: purchase.skuId,
              licenseKey: purchase.licenseKey,
            },
          }
        : {}),
    });
  });

  api.post("/charges/:id/approve", async (c) => {
    const auth = await requireFreshSession(c, repo, config, fetchImpl, {
      always: true,
    });
    if (!auth.ok) return auth.response;

    const charge = repo.getCharge(c.req.param("id"));
    if (!charge || charge.ownerId !== auth.user.id) return notFound(c);
    if (charge.status !== "AWAITING_APPROVAL") {
      return fail(
        c,
        409,
        "CHARGE_NOT_AWAITING_APPROVAL",
        `Charge is ${charge.status}.`,
      );
    }

    if (Date.now() - Date.parse(charge.createdAt) > config.approvalTtlMs) {
      const expired = expireApproval(
        charge,
        "APPROVAL_EXPIRED",
        "Approval expired; reservation released",
      );
      return fail(
        c,
        409,
        "CHARGE_EXPIRED",
        "This approval expired; the reservation was released.",
        { charge: expired },
      );
    }

    const card = repo.getCard(charge.cardId);
    const agent = repo.getAgent(charge.agentId);
    const merchant = repo.getMerchant(charge.merchantId);
    if (!card || !agent || !merchant) {
      return fail(c, 500, "INTERNAL", "Charge references missing data.");
    }

    // Remove this charge's own reservation from both the card view and the
    // daily committed figure; otherwise approval double-counts it.
    const reservedAfterRelease = toUnits(card.budget.reserved) - toUnits(charge.amount);
    const policyCard: Card = {
      ...card,
      budget: {
        ...card.budget,
        reserved: fromUnits(reservedAfterRelease > 0n ? reservedAfterRelease : 0n),
      },
    };
    const committedAfterRelease =
      toUnits(repo.committedSince(card.id, since24h())) - toUnits(charge.amount);
    const decision = evaluateCharge({
      card: policyCard,
      agent,
      merchantId: charge.merchantId,
      amount: charge.amount,
      dailyCommitted: fromUnits(
        committedAfterRelease > 0n ? committedAfterRelease : 0n,
      ),
    });

    if (!decision.allowed) {
      const failed = repo.db.transaction(() => {
        repo.releaseBudget(card.id, charge.amount);
        repo.cancelSignerJob(charge.id);
        x402.setStatus(charge.id, "FAILED");
        const next = repo.setChargeStatus(charge.id, "FAILED", {
          error: decision.code,
        });
        ledger({
          ownerId: auth.user.id,
          cardId: card.id,
          chargeId: charge.id,
          type: "CHARGE_FAILED",
          actor: "policy",
          summary: decision.message,
          data: { code: decision.code },
        });
        return next;
      })();
      return fail(c, 403, decision.code, decision.message, {
        decision,
        charge: failed,
      });
    }

    const updated = repo.db.transaction(() => {
      const next = repo.setChargeStatus(charge.id, "QUEUED", {
        approvedAt: nowIso(),
      });
      repo.createSignerJob({
        id: newId("signerJob"),
        chargeId: charge.id,
        createdAt: nowIso(),
      });
      ledger({
        ownerId: auth.user.id,
        cardId: card.id,
        chargeId: charge.id,
        type: "CHARGE_APPROVED",
        actor: `user:${auth.user.id}`,
        summary: `Approved ${charge.amount} at ${merchant.name}`,
        data: { amount: charge.amount, merchantId: merchant.id },
      });
      return next;
    })();

    queueCharge(updated);
    return c.json({ charge: updated });
  });

  api.post("/charges/:id/decline", async (c) => {
    const auth = await requireFreshSession(c, repo, config, fetchImpl, {
      always: true,
    });
    if (!auth.ok) return auth.response;

    const charge = repo.getCharge(c.req.param("id"));
    if (!charge || charge.ownerId !== auth.user.id) return notFound(c);

    if (
      charge.status !== "AWAITING_APPROVAL" &&
      charge.status !== "QUEUED"
    ) {
      return fail(c, 409, "CHARGE_NOT_DECLINABLE", `Charge is ${charge.status}.`);
    }

    if (
      charge.status === "AWAITING_APPROVAL" &&
      Date.now() - Date.parse(charge.createdAt) > config.approvalTtlMs
    ) {
      const expired = expireApproval(
        charge,
        "APPROVAL_EXPIRED",
        "Approval expired; reservation released",
      );
      return fail(
        c,
        409,
        "CHARGE_EXPIRED",
        "This approval expired; the reservation was released.",
        { charge: expired },
      );
    }

    let reason = "Declined by the card owner.";
    if (c.req.header("content-type")?.includes("application/json")) {
      const body = await readJson(c);
      if (body.ok && body.value && typeof body.value === "object") {
        const raw = (body.value as { reason?: unknown }).reason;
        if (typeof raw === "string" && raw.trim()) reason = raw.trim();
      }
    }

    const updated = repo.db.transaction(() => {
      repo.releaseBudget(charge.cardId, charge.amount);
      repo.cancelSignerJob(charge.id);
      x402.setStatus(charge.id, "DECLINED");
      const next = repo.setChargeStatus(charge.id, "DECLINED", {
        declinedAt: nowIso(),
        declineReason: reason,
      });
      ledger({
        ownerId: auth.user.id,
        cardId: charge.cardId,
        chargeId: charge.id,
        type: "CHARGE_DECLINED",
        actor: `user:${auth.user.id}`,
        summary: `Declined ${charge.amount}`,
        data: { reason, amount: charge.amount },
      });
      return next;
    })();

    if (charge.status === "QUEUED") {
      bus.broadcast(auth.user.id, "payment.cancelled", {
        type: "payment.cancelled",
        chargeId: charge.id,
      });
    }

    return c.json({ charge: updated });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Purchases (one-shot SKU buy)
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/purchases", async (c) => {
    const auth = requireAgent(c, repo);
    if (!auth.ok) return auth.response;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, PurchaseInputSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const card = repo.getCard(input.cardId);
    if (
      !card ||
      card.agentId !== auth.agent.id ||
      card.ownerId !== auth.agent.ownerId
    ) {
      return notFound(c);
    }

    const idempotencyKey =
      (c.req.header("idempotency-key") ?? input.idempotencyKey ?? "").trim() ||
      null;

    return executePurchase(c, {
      card,
      agent: auth.agent,
      merchantId: input.merchantId,
      skuId: input.sku,
      amount: input.amount,
      description: input.description,
      idempotencyKey,
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * One-click judge demo (owner cookie + CSRF only; same service path)
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/demo/purchase", async (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;

    const limited = enforceLimit(
      c,
      `demo:${auth.user.id}`,
      perMinute(config.rateLimits.chargesPerMin),
    );
    if (limited) return limited;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, DemoPurchaseSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const { cardId, scenario } = parsed.data;

    const card = repo.getCard(cardId);
    if (!card || card.ownerId !== auth.user.id) return notFound(c);

    const agent = repo.getAgent(card.agentId);
    if (!agent || agent.ownerId !== auth.user.id) {
      return fail(c, 404, "AGENT_NOT_FOUND", "This card's agent no longer exists.");
    }

    // Resolve merchant, SKU and price on the server. The body never carries an
    // amount, so a judge cannot make the demo spend more than the scenario.
    const scenarios: Record<
      "auto" | "approval" | "overcharge" | "merchant",
      { merchantId: string; skuId: string }
    > = {
      auto: { merchantId: "mch_exa", skuId: "exa-starter" },
      approval: { merchantId: "mch_firecrawl", skuId: "firecrawl-1k" },
      overcharge: { merchantId: "mch_exa", skuId: "exa-pro" },
      merchant: { merchantId: "mch_openai", skuId: "openai-5" },
    };

    if (scenario === "x402") {
      return executeX402Request(c, {
        card,
        agent,
        url: "https://nirium-agent.fly.dev/api/v1/premium/market",
        idempotencyKey: null,
      });
    }

    const target = scenarios[scenario];
    let sku = repo.getSku(target.skuId);
    if (!sku) {
      ensureDemoCatalogue(repo);
      sku = repo.getSku(target.skuId);
    }
    if (!sku) {
      return fail(
        c,
        404,
        "SKU_NOT_FOUND",
        "The demo catalogue is not seeded. Run the seed script, then retry.",
      );
    }

    const storeName = repo.getMerchant(target.merchantId)?.name ?? "This store";
    const explainDenial = (decision: PolicyDecision): string => {
      switch (decision.code) {
        case "MERCHANT_NOT_ALLOWED":
          return `${storeName} is not on this card's approved store list. Nothing moved.`;
        case "AMOUNT_ABOVE_PER_CHARGE":
          return `This purchase is over the card's per-purchase cap. Nothing moved.`;
        case "AMOUNT_ABOVE_DAILY_LIMIT":
          return `This purchase would go over the card's daily cap. Nothing moved.`;
        case "AMOUNT_ABOVE_BUDGET":
          return `This tab does not have enough left. Nothing moved.`;
        case "CARD_REVOKED":
          return "This card was revoked. Nothing moved.";
        case "CARD_PAUSED":
          return "This card is paused. Nothing moved.";
        case "CARD_EXPIRED":
          return "This card has expired. Nothing moved.";
        default:
          return `${decision.message} Nothing moved.`;
      }
    };

    return executePurchase(c, {
      card,
      agent,
      merchantId: target.merchantId,
      skuId: target.skuId,
      amount: sku.price,
      idempotencyKey: null,
      explainDenial,
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * x402 paid-resource rail (HTTPS + allowlist + DNS + no redirects)
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/x402/requests", async (c) => {
    const auth = requireAgent(c, repo);
    if (!auth.ok) return auth.response;

    const limited = enforceLimit(
      c,
      `x402:${auth.agent.id}`,
      perMinute(config.rateLimits.x402PerMin),
    );
    if (limited) return limited;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, X402RequestSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const card = repo.getCard(input.cardId);
    if (
      !card ||
      card.agentId !== auth.agent.id ||
      card.ownerId !== auth.agent.ownerId
    ) {
      return notFound(c);
    }

    const idempotencyKey =
      (c.req.header("idempotency-key") ?? input.idempotencyKey ?? "").trim() ||
      null;

    return executeX402Request(c, {
      card,
      agent: auth.agent,
      url: input.url,
      idempotencyKey,
    });
  });

  api.get("/x402/requests/:id", (c) => {
    const auth = requireAgent(c, repo);
    if (!auth.ok) return auth.response;

    const record = x402.get(c.req.param("id"));
    if (
      !record ||
      record.agentId !== auth.agent.id ||
      record.ownerId !== auth.agent.ownerId
    ) {
      return notFound(c);
    }

    const charge = repo.getCharge(record.chargeId);
    const receipt = charge?.receipt ?? record.receipt ?? null;

    return c.json({
      requestId: record.requestId,
      chargeId: record.chargeId,
      status: charge?.status ?? record.status,
      ...(record.body === undefined ? {} : { body: record.body }),
      ...(receipt ? { receipt } : {}),
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Merchants (public) + ledger (cookie)
   * ────────────────────────────────────────────────────────────────────────── */

  api.get("/merchants", (c) =>
    c.json({ merchants: repo.listMerchants(), skus: repo.listSkus() }),
  );

  api.get("/ledger", (c) => {
    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;
    const limit = clampLimit(c.req.query("limit"), 100);
    return c.json({ events: repo.listLedger(auth.user.id, limit) });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Signer bus
   * ────────────────────────────────────────────────────────────────────────── */

  api.get("/signer/stream", (c) => {
    const origin = checkOrigin(c, config.allowedOrigins);
    if (!origin.ok) return origin.response;

    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;

    const { stream, close } = sseConnection(bus, auth.user.id);
    c.req.raw.signal.addEventListener("abort", () => close(), { once: true });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  api.get("/signer/pending", (c) => {
    const auth = requireSession(c, repo, config);
    if (!auth.ok) return auth.response;

    const pending = repo.getChargesAwaitingSigner(auth.user.id).flatMap((charge) => {
      const card = repo.getCard(charge.cardId);
      const merchant = repo.getMerchant(charge.merchantId);
      if (!card || !merchant) return [];
      return [
        {
          charge,
          payment: buildSignerPayment(charge, card, merchant),
          ...x402Extras(charge),
        },
      ];
    });

    return c.json({
      pending,
      payments: pending.map((entry) => entry.payment),
    });
  });

  api.post("/signer/claim/:chargeId", async (c) => {
    const auth = await requireFreshSession(c, repo, config, fetchImpl, {
      always: false,
    });
    if (!auth.ok) return auth.response;

    const charge = repo.getCharge(c.req.param("chargeId"));
    if (!charge || charge.ownerId !== auth.user.id) return notFound(c);

    if (charge.status === "SIGNING") {
      return fail(
        c,
        409,
        "ALREADY_CLAIMED",
        "This settlement is already being signed.",
      );
    }
    if (charge.status !== "QUEUED") {
      return fail(c, 409, "NOT_CLAIMABLE", `Charge is ${charge.status}.`);
    }
    if (!repo.claimSignerJob(charge.id)) {
      return fail(
        c,
        409,
        "ALREADY_CLAIMED",
        "Another signer claimed this settlement first.",
      );
    }

    const updated = repo.db.transaction(() => {
      const next = repo.setChargeStatus(charge.id, "SIGNING");
      ledger({
        ownerId: auth.user.id,
        cardId: charge.cardId,
        chargeId: charge.id,
        type: "CHARGE_SIGNING",
        actor: `signer:${auth.user.id}`,
        summary: "Signer claimed the payment",
        data: { amount: charge.amount },
      });
      return next;
    })();

    x402.setStatus(charge.id, "SIGNING");
    return c.json({ charge: updated });
  });

  api.post("/signer/result", async (c) => {
    const auth = await requireFreshSession(c, repo, config, fetchImpl, {
      always: false,
    });
    if (!auth.ok) return auth.response;

    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseWith(c, SignerResultInputSchema, body.value);
    if (!parsed.ok) return parsed.response;
    const input = parsed.data;

    const charge = repo.getCharge(input.chargeId);
    if (!charge || charge.ownerId !== auth.user.id) return notFound(c);

    if (charge.status === "SETTLED") return c.json({ charge });

    if (
      charge.status === "DECLINED" ||
      charge.status === "FAILED" ||
      charge.status === "EXPIRED"
    ) {
      return fail(c, 409, "CHARGE_NOT_PENDING", `Charge is ${charge.status}.`);
    }
    if (charge.status === "AWAITING_APPROVAL") {
      return fail(
        c,
        409,
        "CHARGE_NOT_SIGNING",
        "This charge is still waiting for approval.",
      );
    }

    const card = repo.getCard(charge.cardId);
    const merchant = repo.getMerchant(charge.merchantId);
    if (!card || !merchant) {
      return fail(c, 500, "INTERNAL", "Charge references missing data.");
    }

    const record = isX402Charge(charge) ? x402.byChargeId(charge.id) : undefined;

    if (input.status === "success") {
      if (!input.hash) {
        return fail(
          c,
          400,
          "VALIDATION_ERROR",
          "A successful settlement needs a transaction hash.",
        );
      }

      // x402: decode PAYMENT-RESPONSE when present and make sure it describes
      // the same transaction the signer reported.
      const paymentResponse = decodePaymentResponse(input.body);
      const responseHash = extractTxHash(paymentResponse);
      if (responseHash && responseHash !== input.hash) {
        const failed = repo.db.transaction(() => {
          repo.releaseBudget(charge.cardId, charge.amount);
          repo.completeSignerJob(charge.id, "FAILED", "PAYMENT_RESPONSE_MISMATCH");
          x402.setStatus(charge.id, "FAILED");
          const next = repo.setChargeStatus(charge.id, "FAILED", {
            error: "PAYMENT_RESPONSE_MISMATCH",
          });
          ledger({
            ownerId: charge.ownerId,
            cardId: charge.cardId,
            chargeId: charge.id,
            type: "CHARGE_FAILED",
            actor: `signer:${auth.user.id}`,
            summary: "PAYMENT-RESPONSE did not match the reported hash",
            data: {
              reason: "PAYMENT_RESPONSE_MISMATCH",
              reported: input.hash,
              paymentResponseHash: responseHash,
            },
          });
          return next;
        })();
        return fail(c, 402, "SETTLEMENT_ERROR", "The payment response did not match the transaction hash.", {
          charge: failed,
        });
      }

      const verification = await verifySettlement({
        hash: input.hash,
        expectation: expectationFor(charge, card, merchant, record),
        config,
        fetchImpl,
      });

      const canSettleUnverified =
        verification.reason === "VERIFICATION_DISABLED" &&
        config.allowUnverifiedSettlement;

      const canSettleSolanaUnverified =
        card.chain === "SOLANA" &&
        verification.reason === "SOLANA_RPC_NOT_CONFIGURED";

      if (verification.verified || canSettleUnverified || canSettleSolanaUnverified) {
        const receipt = makeReceipt({
          chain: card.chain,
          hash: input.hash,
          asset: charge.asset,
          amount: charge.amount,
          memo: record ? null : receiptMemo(charge.id),
          confirmedAt: verification.confirmedAt ?? input.signedAt,
          verified: verification.verified,
          settlement: receiptSettlement(verification),
          reason: verification.verified ? null : verification.reason,
        });

        const settled = repo.db.transaction(() => {
          repo.settleBudget(charge.cardId, charge.amount);
          const next = repo.setChargeReceipt(charge.id, receipt);
          repo.completeSignerJob(charge.id, "SIGNED");
          ledger({
            ownerId: charge.ownerId,
            cardId: charge.cardId,
            chargeId: charge.id,
            type: "CHARGE_SETTLED",
            actor: `signer:${auth.user.id}`,
            summary: `Settled ${charge.amount}`,
            data: {
              hash: receipt.hash,
              explorerUrl: receipt.explorerUrl,
              onchainVerified: receipt.onchainVerified,
              settlement: receipt.settlement,
            },
          });
          return next;
        })();

        if (input.body !== undefined) x402.setBody(charge.id, input.body);
        if (record) x402.settle(charge.id, receipt);

        bus.broadcast(charge.ownerId, "charge.settled", {
          type: "charge.settled",
          charge: settled,
        });

        return c.json({ charge: settled });
      }

      // Verification failed: fail closed, release the reservation, and record
      // exactly what did not match.
      const failed = repo.db.transaction(() => {
        repo.releaseBudget(charge.cardId, charge.amount);
        repo.completeSignerJob(charge.id, "FAILED", verification.reason);
        x402.setStatus(charge.id, "FAILED");
        const next = repo.setChargeStatus(charge.id, "FAILED", {
          error: `ONCHAIN_${verification.reason ?? "MISMATCH"}`,
        });
        ledger({
          ownerId: charge.ownerId,
          cardId: charge.cardId,
          chargeId: charge.id,
          type: "CHARGE_FAILED",
          actor: `signer:${auth.user.id}`,
          summary: `On-chain verification failed: ${verification.reason ?? "unknown"}`,
          data: {
            reason: verification.reason,
            detail: verification.detail,
            claimedHash: input.hash,
          },
        });
        return next;
      })();

      bus.broadcast(charge.ownerId, "charge.failed", {
        type: "charge.failed",
        charge: failed,
      });

      return fail(
        c,
        402,
        "SETTLEMENT_ERROR",
        "The transaction could not be verified on-chain.",
        { charge: failed, verification },
      );
    }

    if (input.status === "pending") {
      const partial = makeReceipt({
        chain: card.chain,
        hash: input.hash ?? "",
        asset: charge.asset,
        amount: charge.amount,
        memo: record ? null : receiptMemo(charge.id),
        confirmedAt: null,
        verified: false,
        reason: "AWAITING_CONFIRMATION",
      });

      const updated = repo.db.transaction(() => {
        repo.setChargeStatus(charge.id, "SIGNING");
        repo.claimSignerJob(charge.id);
        if (input.hash) setChargePartialReceipt(repo, charge.id, partial);
        ledger({
          ownerId: charge.ownerId,
          cardId: charge.cardId,
          chargeId: charge.id,
          type: "CHARGE_SIGNING",
          actor: `signer:${auth.user.id}`,
          summary: "Payment submitted; awaiting confirmation",
          data: input.hash ? { hash: input.hash } : {},
        });
        return repo.getCharge(charge.id)!;
      })();

      if (input.body !== undefined) x402.setBody(charge.id, input.body);
      x402.setStatus(charge.id, "SIGNING");

      return c.json({ charge: updated });
    }

    const failed = repo.db.transaction(() => {
      repo.releaseBudget(charge.cardId, charge.amount);
      const next = repo.setChargeStatus(charge.id, "FAILED", {
        error: input.error ?? "Settlement failed",
      });
      repo.completeSignerJob(charge.id, "FAILED", input.error);
      x402.setStatus(charge.id, "FAILED");
      ledger({
        ownerId: charge.ownerId,
        cardId: charge.cardId,
        chargeId: charge.id,
        type: "CHARGE_FAILED",
        actor: `signer:${auth.user.id}`,
        summary: input.error ?? "Settlement failed",
        data: { error: input.error },
      });
      return next;
    })();

    if (input.body !== undefined) x402.setBody(charge.id, input.body);

    bus.broadcast(charge.ownerId, "charge.failed", {
      type: "charge.failed",
      charge: failed,
    });

    return c.json({ charge: failed });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Demo reset
   * ────────────────────────────────────────────────────────────────────────── */

  api.post("/demo/reset", (c) => {
    const auth = requireMutation(c, repo, config);
    if (!auth.ok) return auth.response;
    repo.resetDemo();
    clearSessionMeta(repo);
    repo.db.prepare(`DELETE FROM meta WHERE key LIKE 'charge_token:%'`).run();
    ensureX402Merchant(repo);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Mount
   * ────────────────────────────────────────────────────────────────────────── */

  app.route("/api/v1", api);
  app.get("/health", (c) => c.json(healthPayload()));
  app.get("/", (c) =>
    c.json({ name: "TAB API", health: "/api/v1/health" }),
  );

  app.notFound((c) => notFound(c, "Route not found."));
  app.onError((err, c) => {
    // Never log request bodies, tokens or keys.
    console.error("[tab/api]", err instanceof Error ? err.message : String(err));
    return fail(c, 500, "INTERNAL", "Unexpected server error.");
  });

  return app;
}
