/**
 * @tab/agent-kit — the agent-facing client.
 *
 * OWNER: agent-kit agent. Keep this dependency-free (fetch + types only)
 * so it can run in Node, Bun, Deno, a worker, or an MCP server.
 *
 * The whole security model is here: an agent holds a scoped, revocable
 * `tab_agent_…` key — never a private key and never a card number. It may
 * request a single-use token; a merchant redeems that token; the human's
 * browser signs. See .agents/ARCHITECTURE.md.
 */
import type {
  Card,
  Charge,
  ChargeStatus,
  CreateCardInput,
  HealthResponse,
  Merchant,
  PolicyDecision,
  PurchaseResponse,
  Sku,
  TokenResponse,
  TxReceipt,
} from "@tab/shared";

export interface TabClientOptions {
  /** e.g. http://localhost:4000 — the `/api/v1` prefix is added for you. */
  baseUrl?: string;
  /** `tab_agent_<40 hex>`. Never logged by this client. */
  apiKey?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Delay used when a 429 carries no usable Retry-After header. */
  retryDelayMs?: number;
}

/** Statuses after which a charge will never change again. */
export const TERMINAL_CHARGE_STATUSES: readonly ChargeStatus[] = [
  "SETTLED",
  "DECLINED",
  "FAILED",
  "EXPIRED",
];

/** `POST /purchases` answered 202 — the human must approve, or the signer is slow. */
export interface PendingPurchase {
  status: "PENDING";
  charge: Charge;
}

export type PurchaseResult = PurchaseResponse | PendingPurchase;

export function isPendingPurchase(result: PurchaseResult): result is PendingPurchase {
  return (result as PendingPurchase).status === "PENDING";
}

export interface ChargeResult {
  charge: Charge;
  /** True when the API returned 409 and the original charge (idempotency replay). */
  replayed: boolean;
}

/** x402 request states that will never change again. */
export const X402_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "SETTLED",
  "FAILED",
  "DECLINED",
  "EXPIRED",
  "CANCELLED",
  "CANCELED",
]);

/** Result of `POST /x402/requests` and its polling endpoint. */
export interface X402Result {
  requestId: string;
  chargeId: string;
  /** Known: PENDING | AWAITING_APPROVAL | QUEUED | SIGNING | SETTLED | FAILED | DECLINED | EXPIRED. */
  status: string;
  /** True until the request reaches a terminal state. Never a fake receipt. */
  pending: boolean;
  /** The protected API's response, once the payment settled. */
  body?: unknown;
  /** On-chain proof of payment, once settled. */
  receipt?: TxReceipt | null;
  /** The key sent on POST, so an explicit retry cannot open a second request. */
  idempotencyKey: string;
}

export function isX402Pending(result: X402Result): boolean {
  return result.pending;
}

/**
 * Display an amount honestly. USDC is USD-denominated, so it may use `$`.
 * XLM is a different asset: seven decimals and its own ticker, never `$`.
 */
export function formatAmount(amount: string, asset: string = "USDC"): string {
  if (asset === "XLM") {
    const [whole = "0", fraction = ""] = String(amount).split(".");
    const padded = (fraction + "0".repeat(7)).slice(0, 7);
    return `${whole}.${padded} XLM`;
  }
  const numeric = Number(amount);
  const text = Number.isFinite(numeric)
    ? numeric.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(amount);
  return `$${text}`;
}

/**
 * Exit code for a charge, shared by the CLI and any script wrapping it.
 * Pending is not failure: 2 means "a human or the signer still owes an action".
 */
export function exitCodeForCharge(status: ChargeStatus): 0 | 1 | 2 {
  if (status === "SETTLED") return 0;
  if (status === "FAILED" || status === "DECLINED" || status === "EXPIRED") return 1;
  return 2;
}

/** Same rule for x402 requests, whose status set is slightly wider. */
export function exitCodeForX402(status: string): 0 | 1 | 2 {
  if (status === "SETTLED") return 0;
  if (X402_TERMINAL_STATUSES.has(status)) return 1;
  return 2;
}

/** A per-attempt idempotency key; no dependency on Node's crypto module. */
function newIdempotencyKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Accept either `{ ... }` or `{ request: { ... } }` from the x402 route. */
function normalizeX402(raw: any, idempotencyKey: string): X402Result {
  const r = raw?.request ?? raw ?? {};
  const receipt = r.receipt ?? r.charge?.receipt ?? null;
  const status = String(r.status ?? "PENDING").toUpperCase();
  return {
    requestId: String(r.requestId ?? r.id ?? ""),
    chargeId: String(r.chargeId ?? r.charge?.id ?? ""),
    status,
    pending: !X402_TERMINAL_STATUSES.has(status),
    body: r.body,
    receipt: receipt ?? null,
    idempotencyKey,
  };
}

/** One HTTP response, already parsed, with HTTP errors deferred to the caller. */
interface ParsedResponse<T> {
  status: number;
  body: T;
}

interface RequestOptions {
  /** Return the body instead of throwing for these statuses (e.g. 409 replay). */
  accept?: (status: number, body: any) => boolean;
}

/**
 * A failed TAB call. `status === 0` means the request never reached the API.
 * `code` is a `PolicyCode` for policy denials, a transport code
 * (`NETWORK`, `TIMEOUT`, `RATE_LIMITED`, `BAD_RESPONSE`) otherwise.
 */
export class TabApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "TabApiError";
    Object.setPrototypeOf(this, TabApiError.prototype);
  }

  toJSON() {
    return { code: this.code, status: this.status, message: this.message, details: this.details };
  }
}

/** HTTP status → stable code for responses that do not carry an error envelope. */
function fallbackCode(status: number): string {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 402) return "PAYMENT_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  return "HTTP_ERROR";
}

/** Browser-safe env read: no `node:process` import in this file. */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either delta-seconds or an HTTP date. Capped so a bad value cannot hang a CLI. */
function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 10_000));
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 10_000));
  return fallbackMs;
}

function bodyHasIdempotencyKey(body: BodyInit | null | undefined): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as { idempotencyKey?: unknown };
    return typeof parsed.idempotencyKey === "string" && parsed.idempotencyKey.length > 0;
  } catch {
    return false;
  }
}

export class TabClient {
  /** Public so CLIs can print it. Never contains the key. */
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly f: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(opts: TabClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? readEnv("TAB_API_URL") ?? "http://localhost:4000").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? readEnv("TAB_API_KEY") ?? "";
    this.f = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
  }

  /** Build a client from `TAB_API_URL` / `TAB_API_KEY`. */
  static fromEnv(opts: Omit<TabClientOptions, "baseUrl" | "apiKey"> = {}): TabClient {
    return new TabClient(opts);
  }

  /** False when no agent key is configured — CLI/MCP can fail with a helpful hint. */
  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Retry policy for 429: safe methods always; POST only when replaying it
   * cannot double-spend. `POST /charges` needs an idempotency key; purchases
   * and token issuance are never retried because a retry could buy twice.
   */
  private mayRetry(method: string, path: string, init: RequestInit): boolean {
    if (method !== "POST") return true;
    if (path === "/charges") return bodyHasIdempotencyKey(init.body);
    return false;
  }

  private async requestParsed<T>(
    path: string,
    init: RequestInit = {},
    opts: RequestOptions = {},
  ): Promise<ParsedResponse<T>> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const method = (init.method ?? "GET").toUpperCase();

    const headers = new Headers(init.headers ?? {});
    headers.set("accept", "application/json");
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);

    const send = async (): Promise<Response> => {
      try {
        return await this.f(url, { ...init, method, headers });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new TabApiError(
          0,
          "NETWORK",
          `NETWORK — Cannot reach the TAB API at ${this.baseUrl} (${reason}). Start it with: pnpm dev:api`,
          { url, cause: reason },
        );
      }
    };

    let res = await send();
    if (res.status === 429 && this.mayRetry(method, path, init)) {
      await sleep(retryAfterMs(res.headers.get("retry-after"), this.retryDelayMs));
      res = await send();
    }

    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new TabApiError(
          res.status,
          "BAD_RESPONSE",
          `BAD_RESPONSE — The TAB API returned non-JSON at ${path} (HTTP ${res.status}).`,
          { path },
        );
      }
    }

    if (res.ok || opts.accept?.(res.status, body)) return { status: res.status, body: body as T };

    const envelope = body?.error ?? {};
    const code = typeof envelope.code === "string" && envelope.code ? envelope.code : fallbackCode(res.status);
    const reason =
      typeof envelope.message === "string" && envelope.message
        ? envelope.message
        : res.statusText || "The request failed.";
    const hint = res.status === 429 ? " Retry after a short pause." : "";
    throw new TabApiError(res.status, code, `${code} — ${reason}${hint}`, envelope.details);
  }

  private async request<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
    const { body } = await this.requestParsed<T>(path, init, opts);
    return body;
  }

  /* ── read ─────────────────────────────────────────────────────────────── */

  health(): Promise<HealthResponse> {
    return this.request("/health");
  }

  listCards(): Promise<{ cards: Card[] }> {
    return this.request("/cards");
  }

  getCard(cardId: string): Promise<{ card: Card }> {
    return this.request(`/cards/${encodeURIComponent(cardId)}`);
  }

  listMerchants(): Promise<{ merchants: Merchant[]; skus: Sku[] }> {
    return this.request("/merchants");
  }

  listCharges(cardId?: string): Promise<{ charges: Charge[] }> {
    const query = cardId ? `?cardId=${encodeURIComponent(cardId)}` : "";
    return this.request(`/charges${query}`);
  }

  getCharge(chargeId: string): Promise<{ charge: Charge }> {
    return this.request(`/charges/${encodeURIComponent(chargeId)}`);
  }

  /* ── spend ────────────────────────────────────────────────────────────── */

  /** Agent asks for a single-use token (5 min TTL). A 403 is a policy denial. */
  requestToken(input: {
    cardId: string;
    merchantId: string;
    amount: string;
    description?: string;
  }): Promise<TokenResponse> {
    return this.request("/tokens", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * Merchant redemption of a token. A 409 with a charge body is an
   * idempotency replay and resolves to that original charge, not an error.
   */
  async charge(input: {
    token: string;
    merchantId: string;
    amount: string;
    description?: string;
    idempotencyKey?: string;
  }): Promise<ChargeResult> {
    const parsed = await this.requestParsed<{ charge: Charge }>("/charges", {
      method: "POST",
      body: JSON.stringify(input),
    }, {
      accept: (status, body) => status === 409 && typeof body?.charge?.id === "string",
    });
    return { charge: parsed.body.charge, replayed: parsed.status === 409 };
  }

  /**
   * One-shot SKU purchase. 200 → settled receipt; 202 → `status: "PENDING"`
   * (approval required or signer offline) — poll with `waitForCharge`.
   */
  buy(input: {
    cardId: string;
    merchantId: string;
    sku: string;
    amount: string;
    description?: string;
    /** Reuse across a manual retry so the API dedupes instead of buying twice. */
    idempotencyKey?: string;
  }): Promise<PurchaseResult> {
    const { idempotencyKey, ...purchase } = input;
    return this.request("/purchases", {
      method: "POST",
      body: JSON.stringify({ ...purchase, idempotencyKey: idempotencyKey ?? newIdempotencyKey() }),
    });
  }

  /**
   * Pay a real x402-protected resource. The API opens a request, issues a
   * token and drives the merchant handshake; this polls until the request
   * settles. Returns the last honest state — on approval/timeout the shape is
   * still pending, never a fabricated receipt.
   *
   * Every call carries an idempotency key; pass one explicitly to retry after a
   * timeout without opening a second charge.
   */
  async x402(
    input: { cardId: string; url: string; idempotencyKey?: string },
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<X402Result> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const { idempotencyKey, ...request } = input;
    const key = idempotencyKey ?? newIdempotencyKey();

    const created = await this.requestParsed<unknown>("/x402/requests", {
      method: "POST",
      body: JSON.stringify({ ...request, idempotencyKey: key }),
    });
    let current = normalizeX402(created.body, key);
    if (!current.requestId) {
      throw new TabApiError(
        created.status,
        "BAD_RESPONSE",
        "BAD_RESPONSE — The x402 request did not include a requestId, so it cannot be polled.",
        { body: created.body },
      );
    }

    const deadline = Date.now() + timeoutMs;
    while (!X402_TERMINAL_STATUSES.has(current.status) && current.requestId) {
      if (Date.now() + intervalMs > deadline) return current;
      await sleep(intervalMs);
      const polled = await this.requestParsed<unknown>(
        `/x402/requests/${encodeURIComponent(current.requestId)}`,
      );
      current = normalizeX402(polled.body, key);
    }
    return current;
  }

  /** Poll `GET /charges/:id` until the charge reaches a terminal state. */
  async waitForCharge(
    chargeId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<Charge> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const { charge } = await this.getCharge(chargeId);
      if (TERMINAL_CHARGE_STATUSES.includes(charge.status)) return charge;
      if (Date.now() + intervalMs > deadline) {
        throw new TabApiError(
          0,
          "TIMEOUT",
          `TIMEOUT — Charge ${chargeId} is still ${charge.status} after ${timeoutMs}ms.`,
          { chargeId, status: charge.status },
        );
      }
      await sleep(intervalMs);
    }
  }
}

export type {
  Card,
  Charge,
  ChargeStatus,
  CreateCardInput,
  HealthResponse,
  Merchant,
  PolicyDecision,
  PurchaseResponse,
  Sku,
  TokenResponse,
  TxReceipt,
};
