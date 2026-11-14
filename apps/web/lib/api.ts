/**
 * TAB API client (browser).
 *
 * Same-origin: next.config.ts rewrites `/api/*` to the API on :4000, so the
 * `tab_session` HttpOnly cookie travels with every call. Mutations must carry
 * the per-session `x-tab-csrf` token issued by `POST /session`.
 */
import type {
  Agent,
  Card,
  Charge,
  HealthResponse,
  LedgerEvent,
  Merchant,
  SessionResponse,
  Sku,
  User,
} from "@tab/shared";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Human sentence for an error box. Never claims success. */
  get sentence(): string {
    if (this.status === 0) return "Can't reach the TAB API.";
    return this.message || `Request failed (${this.status}).`;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

interface RequestOptions {
  /** Pollar access token, only for POST /session. */
  bearer?: string | null;
  /** Adds the CSRF header. Set for every state-changing call. */
  mutation?: boolean;
  signal?: AbortSignal;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Recover a lost CSRF token from the API (POST /session → GET /me → here). */
async function recoverCsrf(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/session/csrf`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { csrfToken?: unknown };
    if (typeof body?.csrfToken === "string" && body.csrfToken.length > 0) {
      csrfToken = body.csrfToken;
      return body.csrfToken;
    }
  } catch {
    // fall through
  }
  return null;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const send = async (csrf: string | null): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
    if (options.mutation && csrf) headers.set("x-tab-csrf", csrf);
    return fetch(`${BASE}${path}`, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
    });
  };

  let res: Response;
  try {
    res = await send(csrfToken);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "API_UNREACHABLE", "Can't reach the TAB API.");
  }

  let text = await res.text();

  // A lost in-memory CSRF token is recoverable without a new login. Retry once.
  if (!res.ok && res.status === 403 && options.mutation) {
    const first = parseBody(text) as { error?: { code?: string } } | null;
    if (first?.error?.code === "CSRF_INVALID") {
      const fresh = await recoverCsrf();
      if (fresh) {
        res = await send(fresh);
        text = await res.text();
      }
    }
  }

  const body = parseBody(text);

  if (!res.ok) {
    const envelope = body as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message =
      envelope?.error?.message ??
      (res.status === 404
        ? `No API route for ${path}. The API may not be running the latest build.`
        : `Request failed with HTTP ${res.status}.`);
    throw new ApiError(res.status, code, message, envelope?.error?.details);
  }

  return body as T;
}

/* ── tolerant response normalisers ─────────────────────────────────────────
   The contract fixes payload shapes; these helpers accept both the documented
   envelope and a bare array so a small API drift never blanks the console.
   ──────────────────────────────────────────────────────────────────────── */

function listOf<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    for (const key of keys) {
      const value = (body as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

function objectOf<T>(body: unknown, ...keys: string[]): T | null {
  if (body && typeof body === "object") {
    for (const key of keys) {
      const value = (body as Record<string, unknown>)[key];
      if (value && typeof value === "object") return value as T;
    }
  }
  return null;
}

/* ── session ─────────────────────────────────────────────────────────────── */

export interface VerifiedSession {
  user: User;
  agents: Agent[];
  cards: Card[];
  charges: Charge[];
  ledger: LedgerEvent[];
  csrfToken: string | null;
  sessionExpiresAt: string | null;
}

/**
 * Exchange a Pollar access token for a TAB session.
 * The API verifies the token with Pollar; it ignores client-supplied identity.
 */
export async function createSession(accessToken: string): Promise<VerifiedSession> {
  const body = await request<
    Partial<SessionResponse> & {
      csrfToken?: string;
      charges?: Charge[];
      ledger?: LedgerEvent[];
      sessionExpiresAt?: string;
    }
  >(
    "/session",
    { method: "POST", body: JSON.stringify({ accessToken }) },
    { bearer: accessToken, mutation: false },
  );
  const user = objectOf<User>(body, "user");
  if (!user) {
    throw new ApiError(500, "SESSION_INVALID", "The API verified the session but returned no user.");
  }
  return {
    user,
    agents: listOf<Agent>(body, "agents"),
    cards: listOf<Card>(body, "cards"),
    charges: listOf<Charge>(body, "charges"),
    ledger: listOf<LedgerEvent>(body, "ledger", "events"),
    csrfToken: typeof body?.csrfToken === "string" ? body.csrfToken : null,
    sessionExpiresAt: typeof body?.sessionExpiresAt === "string" ? body.sessionExpiresAt : null,
  };
}

export async function logoutSession(): Promise<void> {
  await request<unknown>("/session/logout", { method: "POST" }, { mutation: true });
}

export interface MeResponse {
  user: User | null;
  agents: Agent[];
  cards: Card[];
  csrfToken: string | null;
  sessionExpiresAt: string | null;
}

export async function getMe(signal?: AbortSignal): Promise<MeResponse> {
  const body = await request<
    Partial<SessionResponse> & { csrfToken?: string; sessionExpiresAt?: string }
  >("/me", {}, { signal });
  return {
    user: objectOf<User>(body, "user"),
    agents: listOf<Agent>(body, "agents"),
    cards: listOf<Card>(body, "cards"),
    csrfToken: typeof body?.csrfToken === "string" ? body.csrfToken : null,
    sessionExpiresAt: typeof body?.sessionExpiresAt === "string" ? body.sessionExpiresAt : null,
  };
}

/* ── agents ──────────────────────────────────────────────────────────────── */

export interface CreateAgentResult {
  agent: Agent;
  apiKey: string;
}

export async function createAgent(input: {
  name: string;
  description?: string;
  emoji?: string;
}): Promise<CreateAgentResult> {
  const body = await request<{ agent?: Agent; apiKey?: string }>(
    "/agents",
    { method: "POST", body: JSON.stringify(input) },
    { mutation: true },
  );
  if (!body?.agent || !body.apiKey) {
    throw new ApiError(500, "AGENT_RESPONSE_INVALID", "The API created an agent but returned no key.");
  }
  return { agent: body.agent, apiKey: body.apiKey };
}

export async function patchAgent(
  agentId: string,
  patch: { name?: string; status?: "ACTIVE" | "PAUSED" },
): Promise<Agent> {
  const body = await request<{ agent?: Agent }>(
    `/agents/${encodeURIComponent(agentId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    { mutation: true },
  );
  const agent = objectOf<Agent>(body, "agent");
  if (!agent) throw new ApiError(500, "AGENT_RESPONSE_INVALID", "The API returned no agent.");
  return agent;
}

export async function rotateAgentKey(agentId: string): Promise<string> {
  const body = await request<{ apiKey?: string }>(
    `/agents/${encodeURIComponent(agentId)}/rotate-key`,
    { method: "POST" },
    { mutation: true },
  );
  if (!body?.apiKey) {
    throw new ApiError(500, "AGENT_RESPONSE_INVALID", "The API rotated the key but returned no key.");
  }
  return body.apiKey;
}

/* ── cards ───────────────────────────────────────────────────────────────── */

export interface CreateCardInput {
  agentId: string;
  label: string;
  budget: string;
  perCharge: string;
  daily: string;
  autoApproveUnder: string;
  merchants: string[];
  expiresInHours: number;
  chain: "STELLAR" | "SOLANA";
}

export async function createCard(input: CreateCardInput): Promise<Card> {
  const body = await request<{ card?: Card }>(
    "/cards",
    { method: "POST", body: JSON.stringify(input) },
    { mutation: true },
  );
  const card = objectOf<Card>(body, "card");
  if (!card) throw new ApiError(500, "CARD_RESPONSE_INVALID", "The API returned no card.");
  return card;
}

export async function getCard(cardId: string, signal?: AbortSignal): Promise<Card> {
  const body = await request<{ card?: Card }>(
    `/cards/${encodeURIComponent(cardId)}`,
    {},
    { signal },
  );
  const card = objectOf<Card>(body, "card");
  if (!card) throw new ApiError(404, "CARD_NOT_FOUND", "That card does not exist.");
  return card;
}

export async function cardAction(
  cardId: string,
  action: "pause" | "resume" | "revoke",
): Promise<Card> {
  const body = await request<{ card?: Card }>(
    `/cards/${encodeURIComponent(cardId)}/${action}`,
    { method: "POST" },
    { mutation: true },
  );
  const card = objectOf<Card>(body, "card");
  if (!card) throw new ApiError(500, "CARD_RESPONSE_INVALID", "The API returned no card.");
  return card;
}

/* ── charges ─────────────────────────────────────────────────────────────── */

export async function getCharges(signal?: AbortSignal): Promise<Charge[]> {
  const body = await request<unknown>("/charges", {}, { signal });
  return listOf<Charge>(body, "charges");
}

export async function getCardCharges(cardId: string, signal?: AbortSignal): Promise<Charge[]> {
  const body = await request<unknown>(
    `/cards/${encodeURIComponent(cardId)}/charges`,
    {},
    { signal },
  );
  return listOf<Charge>(body, "charges");
}

/**
 * Approve/decline need BOTH the session cookie + CSRF and a fresh Pollar Bearer
 * token. The API re-verifies the token with Pollar before flipping an approval.
 */
export async function approveCharge(chargeId: string, bearer: string): Promise<Charge> {
  const body = await request<{ charge?: Charge }>(
    `/charges/${encodeURIComponent(chargeId)}/approve`,
    { method: "POST" },
    { mutation: true, bearer },
  );
  const charge = objectOf<Charge>(body, "charge");
  if (!charge) throw new ApiError(500, "CHARGE_RESPONSE_INVALID", "The API returned no charge.");
  return charge;
}

export async function declineCharge(
  chargeId: string,
  bearer: string,
  reason?: string,
): Promise<Charge> {
  const body = await request<{ charge?: Charge }>(
    `/charges/${encodeURIComponent(chargeId)}/decline`,
    { method: "POST", body: JSON.stringify(reason ? { reason } : {}) },
    { mutation: true, bearer },
  );
  const charge = objectOf<Charge>(body, "charge");
  if (!charge) throw new ApiError(500, "CHARGE_RESPONSE_INVALID", "The API returned no charge.");
  return charge;
}

/** One charge with the optional purchase (license) and verification extras. */
export interface ChargeDetail {
  charge: Charge;
  purchase: PurchaseInfo | null;
  approvalUrl: string | null;
  onchainVerified?: boolean | null;
}

export interface PurchaseInfo {
  purchaseId: string;
  skuId: string;
  licenseKey: string;
}

export async function getCharge(
  chargeId: string,
  signal?: AbortSignal,
): Promise<ChargeDetail> {
  const body = await request<
    | (Partial<Charge> & {
        charge?: Charge;
        purchase?: PurchaseInfo;
        approvalUrl?: string;
        onchainVerified?: boolean | null;
      })
    | null
  >(`/charges/${encodeURIComponent(chargeId)}`, {}, { signal });

  const container = body as {
    charge?: Charge;
    purchase?: PurchaseInfo;
    approvalUrl?: string;
    onchainVerified?: boolean | null;
  };

  const charge: Charge | null =
    (container?.charge as Charge | undefined) ??
    (body && typeof body === "object" && "id" in body ? (body as unknown as Charge) : null);

  if (!charge) {
    throw new ApiError(404, "CHARGE_NOT_FOUND", "That charge does not exist.");
  }

  return {
    charge,
    purchase: container?.purchase ?? null,
    approvalUrl:
      container?.approvalUrl ??
      (charge as Charge & { approvalUrl?: string }).approvalUrl ??
      null,
    onchainVerified:
      container?.onchainVerified ??
      (charge as Charge & { onchainVerified?: boolean | null }).onchainVerified ??
      (charge.receipt as (NonNullable<Charge["receipt"]> & { onchainVerified?: boolean | null }) | null)
        ?.onchainVerified ??
      null,
  };
}

/* ── one-click judge demo ────────────────────────────────────────────────── */

export type DemoScenario = "auto" | "approval" | "overcharge" | "merchant" | "x402";

export interface DemoChallenge {
  url?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  network?: string;
  maxTimeoutSeconds?: number;
}

export interface DemoPurchaseResult {
  charge?: Charge;
  purchaseId?: string;
  sku?: Sku;
  licenseKey?: string;
  receipt?: Charge["receipt"];
  status?: "PENDING";
  approvalUrl?: string;
  requestId?: string;
  chargeId?: string;
  challenge?: DemoChallenge;
}

/**
 * Owner-cookie + CSRF demo path. The server resolves the merchant, SKU and
 * amount for the scenario; this client never sends a price.
 */
export async function demoPurchase(
  cardId: string,
  scenario: DemoScenario,
): Promise<DemoPurchaseResult> {
  return request<DemoPurchaseResult>(
    "/demo/purchase",
    { method: "POST", body: JSON.stringify({ cardId, scenario }) },
    { mutation: true },
  );
}

/* ── ledger, merchants, health ───────────────────────────────────────────── */

export async function getLedger(signal?: AbortSignal): Promise<LedgerEvent[]> {
  const body = await request<unknown>("/ledger", {}, { signal });
  return listOf<LedgerEvent>(body, "events", "ledger");
}

export interface Catalogue {
  merchants: Merchant[];
  skus: Sku[];
}

export async function getMerchants(signal?: AbortSignal): Promise<Catalogue> {
  const body = await request<unknown>("/merchants", {}, { signal });
  const merchants = listOf<Merchant & { skus?: Sku[] }>(body, "merchants");
  const skus = listOf<Sku>(body, "skus", "products");
  if (skus.length === 0) {
    for (const merchant of merchants) {
      if (Array.isArray(merchant.skus)) skus.push(...merchant.skus);
    }
  }
  return { merchants, skus };
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/health", {}, { signal });
}

/* ── signer bus ──────────────────────────────────────────────────────────── */

/** Extended payment payload: x402 jobs carry a URL instead of a raw payment. */
export interface SignerPaymentExt {
  chargeId: string;
  chain: "STELLAR" | "SOLANA";
  destination: string;
  amount: string;
  asset: "USDC" | "XLM";
  assetIssuer: string | null;
  memo: string | null;
  merchantName: string;
  description: string;
  x402Url?: string | null;
  x402Challenge?: unknown;
}

export async function getSignerPending(signal?: AbortSignal): Promise<SignerPaymentExt[]> {
  const body = await request<unknown>("/signer/pending", {}, { signal });

  // Preferred shape: { pending: [{ charge, payment, x402Url?, x402Challenge? }] }
  const entries = listOf<{
    payment?: SignerPaymentExt;
    x402Url?: string;
    x402Challenge?: unknown;
  }>(body, "pending");
  if (entries.length > 0) {
    return entries
      .filter((entry): entry is typeof entry & { payment: SignerPaymentExt } => Boolean(entry.payment))
      .map((entry) => ({
        ...entry.payment,
        x402Url: entry.x402Url ?? entry.payment.x402Url ?? null,
        x402Challenge: entry.x402Challenge ?? entry.payment.x402Challenge,
      }));
  }

  const direct = listOf<SignerPaymentExt>(body, "payments");
  if (direct.length > 0) return direct;

  const jobs = listOf<{ payment?: SignerPaymentExt }>(body, "jobs");
  return jobs.map((job) => job.payment).filter((p): p is SignerPaymentExt => Boolean(p));
}

export async function claimSignerJob(chargeId: string, bearer: string): Promise<void> {
  await request<unknown>(
    `/signer/claim/${encodeURIComponent(chargeId)}`,
    { method: "POST" },
    { mutation: true, bearer },
  );
}

export interface SignerResultBody {
  chargeId: string;
  status: "success" | "pending" | "error";
  hash: string | null;
  explorerUrl: string | null;
  error: string | null;
  signedAt: string;
  /** x402 only: the paid response body and the merchant's request id. */
  body?: unknown;
  x402RequestId?: string | null;
}

export async function postSignerResult(
  payload: SignerResultBody,
  bearer: string,
): Promise<Charge | null> {
  const body = await request<{ charge?: Charge }>(
    "/signer/result",
    { method: "POST", body: JSON.stringify(payload) },
    { mutation: true, bearer },
  );
  return objectOf<Charge>(body, "charge");
}

/* ── x402 (real merchant rail) ───────────────────────────────────────────── */

/**
 * Nirium's premium endpoint. SUPERVISED/real path: the browser calls it
 * directly (CORS reflects the app origin and allows PAYMENT-SIGNATURE). Do not
 * proxy this through the TAB API.
 */
export const X402_MARKET_URL = "https://nirium-agent.fly.dev/api/v1/premium/market";
