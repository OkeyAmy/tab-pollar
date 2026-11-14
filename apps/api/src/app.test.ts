/**
 * API integration tests. Everything runs against `openDb(":memory:")` and
 * Hono's `app.request()` — no browser, no network.
 */
import { describe, expect, it } from "vitest";
import { openDb, Repo } from "@tab/db";
import {
  receiptMemo,
  toUnits,
  type Agent,
  type Card,
  type Charge,
  type User,
} from "@tab/shared";
import { createApp } from "./app.js";
import { hashToken, sessionMetaKey } from "./auth.js";
import { loadConfig, type ApiConfig } from "./env.js";
import { expireStaleCharges } from "./expiry.js";
import { createSignerBus } from "./signer-bus.js";
import type { DnsLookup } from "./ssrf.js";
import { createX402Store } from "./x402.js";

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

const APP_ID = "app_test";
const USDC_ISSUER = "GISSUER";
const EXA_ADDRESS = "GEXAMERCHANT";
const FIRECRAWL_ADDRESS = "GFIRECRAWL";
const X402_PAY_TO = "GX402PAYTO";
const WEB_ORIGIN = "http://localhost:3000";

const future = () => Date.now() + 60 * 60_000; // Pollar returns a Unix ms timestamp
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function verifiedPayload(token: string) {
  return {
    content: {
      userId: token,
      wallet: { type: "internal", address: `G${token.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}` },
      applicationId: APP_ID,
      network: "testnet",
      expiresAt: future(),
      profile: { email: `${token}@example.com`, name: token },
    },
  };
}

interface Fakes {
  verify?: (token: string) => unknown | Response;
  tx?: (hash: string) => unknown;
  ops?: (hash: string) => unknown;
  x402?: (url: string) => Response;
}

function challenge(overrides: Record<string, unknown> = {}): unknown {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "500000",
        asset: "USDC",
        payTo: X402_PAY_TO,
        maxTimeoutSeconds: 60,
        ...overrides,
      },
    ],
  };
}

function challengeResponse(overrides: Record<string, unknown> = {}): Response {
  const encoded = Buffer.from(JSON.stringify(challenge(overrides))).toString(
    "base64",
  );
  return new Response(null, {
    status: 402,
    headers: { "payment-required": encoded },
  });
}

function makeFetch(fakes: Fakes): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes("/v3/tokens/verify")) {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        token?: string;
      };
      const fake = fakes.verify?.(parsed.token ?? "");
      if (fake instanceof Response) return fake;
      if (fake !== undefined) return json(fake);
      return json(verifiedPayload(parsed.token ?? ""));
    }

    if (url.includes("/transactions/") && url.endsWith("/operations")) {
      const hash = url.split("/transactions/")[1]!.replace("/operations", "");
      return json(fakes.ops?.(hash) ?? { _embedded: { records: [] } });
    }

    if (url.includes("/transactions/")) {
      const hash = url.split("/transactions/")[1]!;
      return json(
        fakes.tx?.(hash) ?? {
          successful: true,
          memo_type: "none",
          created_at: new Date().toISOString(),
          hash,
        },
      );
    }

    if (url.startsWith("https://nirium-agent.fly.dev")) {
      return fakes.x402?.(url) ?? challengeResponse();
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function seed(repo: Repo): void {
  const at = new Date().toISOString();
  repo.upsertMerchant({
    id: "mch_exa",
    name: "Exa",
    domain: "exa.ai",
    emoji: "🔎",
    category: "data",
    settlementAddress: EXA_ADDRESS,
    settlementChain: "STELLAR",
    createdAt: at,
  });
  repo.upsertMerchant({
    id: "mch_firecrawl",
    name: "Firecrawl",
    domain: "firecrawl.dev",
    emoji: "🔥",
    category: "data",
    settlementAddress: FIRECRAWL_ADDRESS,
    settlementChain: "STELLAR",
    createdAt: at,
  });
  repo.upsertMerchant({
    id: "mch_openai",
    name: "OpenAI",
    domain: "openai.com",
    emoji: "🧠",
    category: "compute",
    settlementAddress: "GOPENAI",
    settlementChain: "STELLAR",
    createdAt: at,
  });

  repo.upsertSku({
    id: "exa-starter",
    merchantId: "mch_exa",
    name: "Exa Starter",
    description: "1k searches",
    price: "2.50",
    unit: "month",
    licensePrefix: "EXA",
  });
  repo.upsertSku({
    id: "exa-pro",
    merchantId: "mch_exa",
    name: "Exa Pro",
    description: "10k searches",
    price: "9.00",
    unit: "month",
    licensePrefix: "EXA",
  });
  repo.upsertSku({
    id: "firecrawl-1k",
    merchantId: "mch_firecrawl",
    name: "Firecrawl 1k",
    description: "1k credits",
    price: "4.00",
    unit: "month",
    licensePrefix: "FIR",
  });
  repo.upsertSku({
    id: "openai-5",
    merchantId: "mch_openai",
    name: "OpenAI $5",
    description: "API credit",
    price: "5.00",
    unit: "$5 credit",
    licensePrefix: "OAI",
  });
}

const publicLookup: DnsLookup = async () => [
  { address: "1.1.1.1", family: 4 },
];
const loopbackLookup: DnsLookup = async () => [
  { address: "127.0.0.1", family: 4 },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Harness
 * ──────────────────────────────────────────────────────────────────────────── */

type App = ReturnType<typeof createApp>;

interface ReqOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  csrf?: string;
  token?: string;
  headers?: Record<string, string>;
}

function request(app: App, path: string, opts: ReqOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers["x-tab-csrf"] = opts.csrf;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  return app.request(`/api/v1${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers,
  });
}

interface Harness {
  app: App;
  repo: Repo;
  bus: ReturnType<typeof createSignerBus>;
  x402: ReturnType<typeof createX402Store>;
  config: ApiConfig;
  fakes: Fakes;
  cookie: string;
  csrf: string;
  user: User;
  agent: Agent;
  apiKey: string;
  card: Card;
}

async function boot(opts: {
  config?: Partial<ApiConfig>;
  fakes?: Fakes;
  lookup?: DnsLookup;
  card?: boolean;
} = {}): Promise<Harness> {
  const db = openDb(":memory:");
  const repo = new Repo(db);
  seed(repo);

  const bus = createSignerBus();
  const x402 = createX402Store();
  const fakes = opts.fakes ?? {};
  const config = loadConfig({
    network: "testnet",
    pollarSecretKey: "sec_testnet_test",
    pollarVerifyUrl: "http://pollar.test/v3/tokens/verify",
    pollarApplicationId: APP_ID,
    sessionSecret: "test_session_secret",
    onchainVerify: false,
    allowUnverifiedSettlement: true,
    horizonUrl: "http://horizon.test",
    usdcIssuer: USDC_ISSUER,
    x402AllowedHosts: ["nirium-agent.fly.dev"],
    rateLimits: {
      sessionPerMin: 100,
      tokensPerMin: 100,
      chargesPerMin: 100,
      x402PerMin: 100,
    },
    enableLogger: false,
    ...(opts.config ?? {}),
  });

  const app = createApp({
    repo,
    bus,
    config,
    fetchImpl: makeFetch(fakes),
    dnsLookup: opts.lookup ?? publicLookup,
    x402Store: x402,
  });

  const sessionRes = await request(app, "/session", {
    body: { accessToken: "pollar-user-1" },
  });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
  expect(sessionRes.status).toBe(200);
  const sessionBody = (await sessionRes.json()) as {
    user: User;
    csrfToken: string;
  };
  const cookie = sessionRes.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = sessionBody.csrfToken;

  const agentRes = await request(app, "/agents", {
    cookie,
    csrf,
    body: { name: "Scout", description: "buys research data" },
  });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
  expect(agentRes.status).toBe(201);
  const agentBody = (await agentRes.json()) as { agent: Agent; apiKey: string };

  let card = {} as Card;
  if (opts.card !== false) {
    const cardRes = await request(app, "/cards", {
      cookie,
      csrf,
      body: {
        agentId: agentBody.agent.id,
        label: "Research Scout",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa", "mch_firecrawl", "mch_x402"],
        expiresInHours: 24,
        chain: "STELLAR",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(cardRes.status).toBe(201);
    card = ((await cardRes.json()) as { card: Card }).card;
  }

  return {
    app,
    repo,
    bus,
    x402,
    config,
    fakes,
    cookie,
    csrf,
    user: sessionBody.user,
    agent: agentBody.agent,
    apiKey: agentBody.apiKey,
    card,
  };
}

async function issueToken(
  h: Harness,
  input: { amount: string; cardId?: string; merchantId?: string },
) {
  const res = await request(h.app, "/tokens", {
    token: h.apiKey,
    body: {
      cardId: input.cardId ?? h.card.id,
      merchantId: input.merchantId ?? "mch_exa",
      amount: input.amount,
      description: "test",
    },
  });
  return { res, body: (await res.json()) as any };
}

async function redeem(
  h: Harness,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await request(h.app, "/charges", {
    body: {
      token,
      merchantId: "mch_exa",
      amount: "2.50",
      description: "Exa starter",
      ...overrides,
    },
  });
  return { res, body: (await res.json()) as any };
}

function approve(h: Harness, chargeId: string) {
  return request(h.app, `/charges/${chargeId}/approve`, {
    method: "POST",
    cookie: h.cookie,
    csrf: h.csrf,
    token: "pollar-user-1",
  });
}

function decline(h: Harness, chargeId: string) {
  return request(h.app, `/charges/${chargeId}/decline`, {
    cookie: h.cookie,
    csrf: h.csrf,
    token: "pollar-user-1",
    body: { reason: "not now" },
  });
}

function settle(
  h: Harness,
  chargeId: string,
  hash = "a".repeat(64),
  extra: Record<string, unknown> = {},
) {
  return request(h.app, "/signer/result", {
    cookie: h.cookie,
    csrf: h.csrf,
    body: {
      chargeId,
      status: "success",
      hash,
      explorerUrl: "https://evil.example/tx",
      error: null,
      signedAt: new Date().toISOString(),
      ...extra,
    },
  });
}

async function waitForPending(
  h: Harness,
  predicate: (charge: Charge) => boolean,
): Promise<{ charge: Charge; payment: any }> {
  for (let i = 0; i < 120; i += 1) {
    const res = await request(h.app, "/signer/pending", { cookie: h.cookie });
    const body = (await res.json()) as {
      pending: Array<{ charge: Charge; payment: any }>;
    };
    const match = body.pending.find((entry) => predicate(entry.charge));
    if (match) return match;
    await sleep(25);
  }
  throw new Error("No pending signer job appeared.");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Health + session
 * ──────────────────────────────────────────────────────────────────────────── */

describe("health", () => {
  it("serves /api/v1/health and the root alias, and reports signer presence", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/health");
    // blindfold: contract — the agent-kit client calls /api/v1/health.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.signerOnline).toBe(false);

    const root = await h.app.request("/health");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(root.status).toBe(200);

    h.bus.add({
      id: "ses_test",
      ownerId: h.user.id,
      controller: {
        enqueue() {},
        close() {},
      } as unknown as ReadableStreamDefaultController<Uint8Array>,
    });
    const online = await request(h.app, "/health");
    expect(((await online.json()) as any).signerOnline).toBe(true);
  });

  it("serves public merchants including the x402 rail", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/merchants");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.merchants.some((m: any) => m.id === "mch_x402")).toBe(true);
    expect(body.skus.some((s: any) => s.id === "exa-starter")).toBe(true);
  });
});

describe("session verification", () => {
  it("verifies through Pollar, sets a Strict HttpOnly cookie and returns CSRF", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/session", {
      body: { accessToken: "pollar-user-2" },
    });
    // blindfold: contract (SECURITY.md) — verified login returns a session + per-session CSRF.
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/tab_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const body = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(typeof body.csrfToken).toBe("string");
    expect(body.csrfToken.length).toBeGreaterThan(0);

    const me = await request(h.app, "/me", { cookie: h.cookie });
    const meBody = (await me.json()) as any;
    expect(meBody.csrfToken).toBe(h.csrf);
  });

  it("rejects a token Pollar refuses", async () => {
    const h = await boot({
      card: false,
      fakes: {
        verify: (token) =>
          token === "bad"
            ? new Response("no", { status: 401 })
            : undefined,
      },
    });
    const res = await request(h.app, "/session", {
      body: { accessToken: "bad" },
    });
    // blindfold: spec (addendum) — never fall back to trusting the client body.
    expect(res.status).toBe(401);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("POLLAR_VERIFY_FAILED");
  });

  it("rejects a token from another application", async () => {
    const h = await boot({
      card: false,
      fakes: {
        verify: (token) =>
          token === "wrong-app"
            ? {
                content: {
                  ...verifiedPayload(token).content,
                  applicationId: "someone-else",
                },
              }
            : undefined,
      },
    });
    const res = await request(h.app, "/session", {
      body: { accessToken: "wrong-app" },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(
      "POLLAR_APPLICATION_MISMATCH",
    );
  });

  it("rejects a mainnet token in a testnet app", async () => {
    const h = await boot({
      card: false,
      fakes: {
        verify: (token) =>
          token === "wrong-network"
            ? {
                content: {
                  ...verifiedPayload(token).content,
                  network: "mainnet",
                },
              }
            : undefined,
      },
    });
    const res = await request(h.app, "/session", {
      body: { accessToken: "wrong-network" },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(
      "POLLAR_NETWORK_MISMATCH",
    );
  });

  it("rejects an expired Pollar token", async () => {
    const h = await boot({
      card: false,
      fakes: {
        verify: (token) =>
          token === "expired"
            ? {
                content: {
                  ...verifiedPayload(token).content,
                  expiresAt: Date.now() - 60_000,
                },
              }
            : undefined,
      },
    });
    const res = await request(h.app, "/session", {
      body: { accessToken: "expired" },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(401);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("POLLAR_TOKEN_EXPIRED");
  });
});

describe("CSRF and Origin", () => {
  it("rejects a cookie mutation without x-tab-csrf", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/cards", {
      cookie: h.cookie,
      body: {
        agentId: h.agent.id,
        label: "No CSRF",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa"],
        expiresInHours: 24,
      },
    });
    // blindfold: contract (SECURITY.md) — every mutating route requires the CSRF token.
    expect(res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("CSRF_INVALID");
  });

  it("rejects a disallowed Origin even with a valid CSRF token", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/cards", {
      cookie: h.cookie,
      csrf: h.csrf,
      headers: { origin: "https://evil.example" },
      body: {
        agentId: h.agent.id,
        label: "Evil",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa"],
        expiresInHours: 24,
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("accepts a mutation with the session CSRF token", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/cards", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: {
        agentId: h.agent.id,
        label: "Good",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa"],
        expiresInHours: 24,
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(201);
  });
});

describe("rate limits", () => {
  it("returns 429 + Retry-After on /session", async () => {
    const h = await boot({
      card: false,
      config: {
        rateLimits: {
          sessionPerMin: 2,
          tokensPerMin: 100,
          chargesPerMin: 100,
          x402PerMin: 100,
        },
      },
    });
    // boot consumed the first slot.
    const second = await request(h.app, "/session", {
      body: { accessToken: "pollar-user-2" },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(second.status).toBe(200);

    const third = await request(h.app, "/session", {
      body: { accessToken: "pollar-user-3" },
    });
    // blindfold: spec (addendum) — session limit is 10/min in prod; this test lowers it to 2.
    expect(third.status).toBe(429);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await third.json()) as any).error.code).toBe("RATE_LIMITED");
    expect(third.headers.get("retry-after")).toBeTruthy();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Cards + tokens + charges
 * ──────────────────────────────────────────────────────────────────────────── */

describe("card validation", () => {
  it("rejects an unreachable limit ladder instead of clamping", async () => {
    const h = await boot({ card: false });
    const res = await request(h.app, "/cards", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: {
        agentId: h.agent.id,
        label: "Bad ladder",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "6",
        merchants: ["mch_exa"],
        expiresInHours: 24,
      },
    });
    // blindfold: contract (LIMITS.md) — autoApproveUnder <= perCharge is mandatory.
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.error.code).toBe("INVALID_LIMITS");
    expect(body.error.details.reason).toContain("autoApproveUnder");
  });
});

describe("tokens and charges", () => {
  it("rejects a token replay with TOKEN_ALREADY_USED", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2.50" });
    const first = await redeem(h, body.token);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(first.res.status).toBe(201);

    const second = await redeem(h, body.token);
    // blindfold: contract (CONTRACTS.md) — single-use token.
    expect(second.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(second.body.error.code).toBe("TOKEN_ALREADY_USED");
  });

  it("rejects a merchant mismatch before consuming the token", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2.50" });
    const res = await redeem(h, body.token, { merchantId: "mch_firecrawl" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.body.error.code).toBe("TOKEN_MERCHANT_MISMATCH");
  });

  it("enforces the per-charge cap at token issue", async () => {
    const h = await boot();
    const { res, body } = await issueToken(h, { amount: "6" });
    // blindfold: contract (LIMITS.md) — demo card per-charge cap is $5.
    expect(res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.error.code).toBe("AMOUNT_ABOVE_PER_CHARGE");
  });

  it("enforces the token's own max amount", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2" });
    const res = await redeem(h, body.token, { amount: "3" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.body.error.code).toBe("TOKEN_AMOUNT_EXCEEDED");
  });

  it("returns TOKEN_INVALID for an unknown token", async () => {
    const h = await boot();
    const res = await request(h.app, "/charges", {
      body: {
        token: `tab_ch_${"0".repeat(32)}`,
        merchantId: "mch_exa",
        amount: "1.00",
        description: "nope",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("TOKEN_INVALID");
  });

  it("returns 409 with the original charge on idempotency replay", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2.50" });
    const first = await redeem(h, body.token, { idempotencyKey: "order-1" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(first.res.status).toBe(201);

    const second = await redeem(h, body.token, { idempotencyKey: "order-1" });
    // blindfold: spec (audit addendum) — 409 with the original charge.
    expect(second.res.status).toBe(409);
    expect(second.body.charge.id).toBe(first.body.charge.id);
    expect(h.repo.listChargesForCard(h.card.id).length).toBe(1);
  });
});

describe("merchant token polling", () => {
  it("lets a USED token read only the one charge it created", async () => {
    const h = await boot();
    const issued = await issueToken(h, { amount: "2.50" });
    const redeemed = await redeem(h, issued.body.token);
    const charge = redeemed.body.charge as Charge;

    // blindfold: contract (Depot audit) — redemption marks the token USED.
    expect(h.repo.getTokenByHash(hashToken(issued.body.token))!.status).toBe(
      "USED",
    );

    const headerPoll = await request(h.app, `/charges/${charge.id}`, {
      headers: { "x-tab-token": issued.body.token },
    });
    // blindfold: contract (Depot audit) — a USED token may poll its own charge.
    expect(headerPoll.status).toBe(200);
    const headerBody = (await headerPoll.json()) as any;
    expect(headerBody.charge.id).toBe(charge.id);

    const queryPoll = await request(
      h.app,
      `/charges/${charge.id}?token=${encodeURIComponent(issued.body.token)}`,
    );
    // blindfold: contract (Depot audit) — ?token= is the fallback.
    expect(queryPoll.status).toBe(200);

    const other = await issueToken(h, { amount: "2.50" });
    const cross = await request(h.app, `/charges/${charge.id}`, {
      headers: { "x-tab-token": other.body.token },
    });
    // blindfold: contract (Depot audit) — never another charge.
    expect(cross.status).toBe(404);
  });
});

describe("approval, settlement, decline, revoke", () => {
  it("approves above the threshold, settles, and recomputes the explorer URL", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "4" });
    const redeemed = await redeem(h, body.token, { amount: "4" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(redeemed.res.status).toBe(201);
    const charge = redeemed.body.charge as Charge;

    // blindfold: contract (CONTRACTS.md) — above $3 requires approval and exposes a deep link.
    expect(charge.status).toBe("AWAITING_APPROVAL");
    expect(redeemed.body.approvalUrl).toBe(
      `${WEB_ORIGIN}/app?charge=${charge.id}`,
    );
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("4");

    const approved = await approve(h, charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(approved.status).toBe(200);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await approved.json()) as any).charge.status).toBe("QUEUED");

    const res = await settle(h, charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
    const settled = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.charge.status).toBe("SETTLED");
    expect(settled.charge.receipt.explorerUrl).toBe(
      `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`,
    );
    expect(settled.charge.receipt.onchainVerified).toBe(false);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.charge.receipt.settlement).toBe("mock");

    const card = h.repo.getCard(h.card.id)!;
    expect(toUnits(card.budget.spent)).toBe(toUnits("4"));
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(card.budget.reserved).toBe("0");

    const ledger = await request(h.app, "/ledger", { cookie: h.cookie });
    const events = ((await ledger.json()) as any).events as any[];
    expect(events.some((event) => event.type === "CHARGE_SETTLED")).toBe(true);
  });

  it("declines an approval and releases the reservation", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "4" });
    const redeemed = await redeem(h, body.token, { amount: "4" });
    const charge = redeemed.body.charge as Charge;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("4");

    const res = await decline(h, charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).charge.status).toBe("DECLINED");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("0");
  });

  it("revokes the card, expires open charges, revokes tokens and releases budget", async () => {
    const h = await boot();
    const first = await issueToken(h, { amount: "2.50" });
    const chargeRes = await redeem(h, first.body.token);
    const charge = chargeRes.body.charge as Charge;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(charge.status).toBe("QUEUED");

    const second = await issueToken(h, { amount: "2.50" });

    const revoke = await request(h.app, `/cards/${h.card.id}/revoke`, {
      method: "POST",
      cookie: h.cookie,
      csrf: h.csrf,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(revoke.status).toBe(200);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await revoke.json()) as any).card.status).toBe("REVOKED");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("0");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCharge(charge.id)!.status).toBe("EXPIRED");
    expect(h.repo.hasQueuedJobs()).toBe(false);

    const blocked = await issueToken(h, { amount: "1" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(blocked.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(blocked.body.error.code).toBe("CARD_REVOKED");

    const deadToken = await redeem(h, second.body.token);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(deadToken.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(deadToken.body.error.code).toBe("TOKEN_INVALID");
  });

  it("returns 404 for another owner's card and charge", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2.50" });
    const redeemed = await redeem(h, body.token);
    const charge = redeemed.body.charge as Charge;

    const second = await request(h.app, "/session", {
      body: { accessToken: "pollar-user-2" },
    });
    const cookie2 = second.headers.get("set-cookie")!.split(";")[0]!;
    const csrf2 = ((await second.json()) as any).csrfToken as string;

    const card = await request(h.app, `/cards/${h.card.id}`, { cookie: cookie2 });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(card.status).toBe(404);
    const oneCharge = await request(h.app, `/charges/${charge.id}`, {
      cookie: cookie2,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(oneCharge.status).toBe(404);
    const revoke = await request(h.app, `/cards/${h.card.id}/revoke`, {
      method: "POST",
      cookie: cookie2,
      csrf: csrf2,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(revoke.status).toBe(404);
  });
});

describe("daily cap counts reservations", () => {
  it("blocks the second of two $6 charges against a $10 daily cap", async () => {
    const h = await boot({ card: false });
    const cardRes = await request(h.app, "/cards", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: {
        agentId: h.agent.id,
        label: "Wide",
        budget: "25",
        perCharge: "6",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa"],
        expiresInHours: 24,
      },
    });
    const card = ((await cardRes.json()) as any).card as Card;

    const a = await issueToken(h, { cardId: card.id, amount: "6" });
    const b = await issueToken(h, { cardId: card.id, amount: "6" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(a.res.status).toBe(201);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(b.res.status).toBe(201);

    const first = await redeem(h, a.body.token, { amount: "6" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(first.res.status).toBe(201);
    const second = await redeem(h, b.body.token, { amount: "6" });
    // blindfold: contract (LIMITS.md) — daily = settled + reserved; 6 reserved + 6 > 10.
    expect(second.res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(second.body.error.code).toBe("AMOUNT_ABOVE_DAILY_LIMIT");
  });
});

describe("approval TTL", () => {
  it("expires a 10-minute-old AWAITING_APPROVAL and releases the reservation", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "4" });
    const redeemed = await redeem(h, body.token, { amount: "4" });
    const charge = redeemed.body.charge as Charge;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(charge.status).toBe("AWAITING_APPROVAL");

    h.repo.db
      .prepare("UPDATE charges SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), charge.id);

    const count = expireStaleCharges({
      repo: h.repo,
      bus: h.bus,
      x402: h.x402,
      config: h.config,
    });
    expect(count).toBeGreaterThanOrEqual(1);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCharge(charge.id)!.status).toBe("EXPIRED");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("0");
  });
});

describe("signer expiry window", () => {
  it("does not expire a freshly approved charge because of its original createdAt", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "4" });
    const redeemed = await redeem(h, body.token, { amount: "4" });
    const charge = redeemed.body.charge as Charge;

    h.repo.db
      .prepare("UPDATE charges SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 9 * 60_000).toISOString(), charge.id);

    const approved = await approve(h, charge.id);
    // blindfold: contract (LIMITS.md) — 9 minutes is inside the 10-minute approval TTL.
    expect(approved.status).toBe(200);
    // blindfold: contract — approval moves AWAITING_APPROVAL to QUEUED.
    expect(((await approved.json()) as any).charge.status).toBe("QUEUED");

    const count = expireStaleCharges({
      repo: h.repo,
      bus: h.bus,
      x402: h.x402,
      config: h.config,
    });
    // blindfold: invariant — the 2-minute signer window starts at approval time.
    expect(count).toBe(0);
    // blindfold: invariant — a freshly approved charge is still signable.
    expect(h.repo.getCharge(charge.id)!.status).toBe("QUEUED");
  });
});

describe("sensitive-action re-verification", () => {
  it("requires a fresh Pollar token on the first signer claim after expiry", async () => {
    const h = await boot();
    const { body } = await issueToken(h, { amount: "2.50" });
    const redeemed = await redeem(h, body.token);
    const charge = redeemed.body.charge as Charge;

    const rawSession = h.cookie.replace(/^tab_session=/, "");
    const key = sessionMetaKey(hashToken(rawSession));
    const meta = JSON.parse(h.repo.getMeta(key)!) as { pollarExpiresAt: string };
    meta.pollarExpiresAt = new Date(Date.now() - 1000).toISOString();
    h.repo.setMeta(key, JSON.stringify(meta));

    const without = await request(h.app, `/signer/claim/${charge.id}`, {
      method: "POST",
      cookie: h.cookie,
      csrf: h.csrf,
    });
    // blindfold: spec (addendum) — after Pollar expiry, a fresh verification is required.
    expect(without.status).toBe(401);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await without.json()) as any).error.code).toBe("REVERIFY_REQUIRED");

    const withFresh = await request(h.app, `/signer/claim/${charge.id}`, {
      method: "POST",
      cookie: h.cookie,
      csrf: h.csrf,
      token: "pollar-user-1",
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(withFresh.status).toBe(200);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await withFresh.json()) as any).charge.status).toBe("SIGNING");
  });
});

describe("agent auth", () => {
  it("rejects a paused agent", async () => {
    const h = await boot();
    h.repo.setAgentStatus(h.agent.id, "PAUSED");
    const { res, body } = await issueToken(h, { amount: "1" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(403);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.error.code).toBe("AGENT_PAUSED");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Purchases
 * ──────────────────────────────────────────────────────────────────────────── */

describe("purchases", () => {
  it("waits for settlement and returns a license + real receipt", async () => {
    const h = await boot();
    const purchasePromise = request(h.app, "/purchases", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        merchantId: "mch_exa",
        sku: "exa-starter",
        amount: "2.50",
      },
    });

    const pending = await waitForPending(
      h,
      (charge) => charge.description === "Exa Starter",
    );
    const claim = await request(h.app, `/signer/claim/${pending.charge.id}`, {
      method: "POST",
      cookie: h.cookie,
      csrf: h.csrf,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(claim.status).toBe(200);
    const settled = await settle(h, pending.charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.status).toBe(200);

    const res = await purchasePromise;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // blindfold: contract (CONTRACTS.md) — licence is <prefix>-4-4-4.
    expect(body.licenseKey).toMatch(/^EXA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.charge.status).toBe("SETTLED");
    expect(body.receipt.hash).toBe("a".repeat(64));
    expect(body.receipt.onchainVerified).toBe(false);
  });

  it("returns 202 for approval and exposes the license when polled after settlement", async () => {
    const h = await boot();
    const res = await request(h.app, "/purchases", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        merchantId: "mch_firecrawl",
        sku: "firecrawl-1k",
        amount: "4.00",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.status).toBe("PENDING");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.charge.status).toBe("AWAITING_APPROVAL");
    expect(body.approvalUrl).toBe(
      `${WEB_ORIGIN}/app?charge=${body.charge.id}`,
    );

    const approved = await approve(h, body.charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(approved.status).toBe(200);
    const settled = await settle(h, body.charge.id);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.status).toBe(200);

    const poll = await request(h.app, `/charges/${body.charge.id}`, {
      token: h.apiKey,
    });
    const pollBody = (await poll.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(pollBody.charge.status).toBe("SETTLED");
    expect(pollBody.purchase.licenseKey).toMatch(
      /^FIR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );
  });

  it("rejects a client amount that does not match the SKU", async () => {
    const h = await boot();
    const res = await request(h.app, "/purchases", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        merchantId: "mch_exa",
        sku: "exa-starter",
        amount: "2.00",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(400);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await res.json()) as any).error.code).toBe("AMOUNT_MISMATCH");
  });

  it("replays a purchase without creating a second charge", async () => {
    const h = await boot();
    const input = {
      cardId: h.card.id,
      merchantId: "mch_firecrawl",
      sku: "firecrawl-1k",
      amount: "4.00",
      idempotencyKey: "pur-1",
    };
    const first = await request(h.app, "/purchases", {
      token: h.apiKey,
      body: input,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as any;

    const replay = await request(h.app, "/purchases", {
      token: h.apiKey,
      body: input,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.charge.id).toBe(firstBody.charge.id);
    expect(h.repo.listChargesForCard(h.card.id).length).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * One-click judge demo
 * ──────────────────────────────────────────────────────────────────────────── */

describe("demo purchase", () => {
  it("auto buys Exa Starter for $2.50 and settles through the signer", async () => {
    const h = await boot();
    const pendingPurchase = request(h.app, "/demo/purchase", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: { cardId: h.card.id, scenario: "auto" },
    });

    const pending = await waitForPending(
      h,
      (charge) => charge.description === "Exa Starter",
    );
    const claim = await request(h.app, `/signer/claim/${pending.charge.id}`, {
      method: "POST",
      cookie: h.cookie,
      csrf: h.csrf,
    });
    // blindfold: contract — the demo uses the same signer claim path.
    expect(claim.status).toBe(200);

    const settled = await settle(h, pending.charge.id);
    // blindfold: contract — the demo uses the same settlement path.
    expect(settled.status).toBe(200);

    const res = await pendingPurchase;
    // blindfold: contract — $2.50 is below the $3 approval line.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.charge.status).toBe("SETTLED");
    expect(body.charge.decision.code).toBe("OK");
    expect(toUnits(body.charge.amount)).toBe(toUnits("2.50"));
    expect(body.receipt.onchainVerified).toBe(false);
    expect(body.licenseKey).toMatch(/^EXA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("approval asks for $4.00 and returns AWAITING_APPROVAL", async () => {
    const h = await boot();
    const res = await request(h.app, "/demo/purchase", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: { cardId: h.card.id, scenario: "approval" },
    });
    // blindfold: contract — $4.00 is above the $3 line and under the $5 cap.
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.charge.status).toBe("AWAITING_APPROVAL");
    expect(body.charge.decision.code).toBe("OK_APPROVAL_REQUIRED");
    expect(toUnits(body.charge.amount)).toBe(toUnits("4.00"));
    expect(body.approvalUrl).toBe(`${WEB_ORIGIN}/app?charge=${body.charge.id}`);
  });

  it("overcharge denies $9.00 with AMOUNT_ABOVE_PER_CHARGE", async () => {
    const h = await boot();
    const res = await request(h.app, "/demo/purchase", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: { cardId: h.card.id, scenario: "overcharge" },
    });
    // blindfold: contract — LIMITS.md: $9 > the $5 per-charge cap.
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("AMOUNT_ABOVE_PER_CHARGE");
    expect(body.error.details.decision.code).toBe("AMOUNT_ABOVE_PER_CHARGE");
    expect(h.repo.listChargesForCard(h.card.id).length).toBe(0);
  });

  it("merchant denies OpenAI with MERCHANT_NOT_ALLOWED", async () => {
    const h = await boot();
    const res = await request(h.app, "/demo/purchase", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: { cardId: h.card.id, scenario: "merchant" },
    });
    // blindfold: contract — the demo card allows Exa + Firecrawl only.
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("MERCHANT_NOT_ALLOWED");
    expect(h.repo.listChargesForCard(h.card.id).length).toBe(0);
  });

  it("x402 returns the live challenge and a request id", async () => {
    const h = await boot({ fakes: { x402: () => challengeResponse() } });
    const res = await request(h.app, "/demo/purchase", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: { cardId: h.card.id, scenario: "x402" },
    });
    // blindfold: contract — Nirium's fixture asks for 0.05 USDC.
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.requestId).toMatch(/^pur_/);
    expect(body.challenge.amount).toBe("0.05");
    expect(body.challenge.asset).toBe("USDC");
    expect(h.repo.getCharge(body.chargeId)!.merchantId).toBe("mch_x402");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * x402
 * ──────────────────────────────────────────────────────────────────────────── */

describe("x402", () => {
  it("parses a fixture 402 challenge to 0.05 USDC and denies it against a $1 committed cap", async () => {
    const h = await boot({ fakes: { x402: () => challengeResponse() } });

    const ok = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        url: "https://nirium-agent.fly.dev/paid",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as any;
    // blindfold: golden (x402 fixture) — amount 500000 base units at 7dp is 0.05 USDC.
    expect(okBody.challenge.amount).toBe("0.05");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(okBody.challenge.asset).toBe("USDC");
    expect(okBody.challenge.payTo).toBe(X402_PAY_TO);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCharge(okBody.chargeId)!.merchantId).toBe("mch_x402");

    // A second, $1 card: reserve 0.96 first, then a 0.05 request must be denied.
    const tinyRes = await request(h.app, "/cards", {
      cookie: h.cookie,
      csrf: h.csrf,
      body: {
        agentId: h.agent.id,
        label: "Tiny",
        budget: "1",
        perCharge: "1",
        daily: "1",
        autoApproveUnder: "0.5",
        merchants: ["mch_exa", "mch_x402"],
        expiresInHours: 24,
      },
    });
    const tiny = ((await tinyRes.json()) as any).card as Card;
    const token = await issueToken(h, { cardId: tiny.id, amount: "0.96" });
    const reserved = await redeem(h, token.body.token, { amount: "0.96" });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(reserved.res.status).toBe(201);

    const denied = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: {
        cardId: tiny.id,
        url: "https://nirium-agent.fly.dev/paid",
      },
    });
    // blindfold: contract (LIMITS.md) — $1 cap already has $0.96 committed.
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(deniedBody.error.code).toBe("AMOUNT_ABOVE_DAILY_LIMIT");
  });

  it("blocks SSRF: HTTP metadata, non-allowlisted hosts, and private DNS", async () => {
    const h = await boot({ fakes: { x402: () => challengeResponse() } });

    const metadata = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        url: "http://169.254.169.254/latest/meta-data",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(metadata.status).toBe(400);
    expect(((await metadata.json()) as any).error.code).toBe(
      "X402_HTTPS_REQUIRED",
    );

    const evil = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: { cardId: h.card.id, url: "https://evil.example/paid" },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(evil.status).toBe(400);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(((await evil.json()) as any).error.code).toBe("X402_HOST_NOT_ALLOWED");

    const rebound = await boot({
      fakes: { x402: () => challengeResponse() },
      lookup: loopbackLookup,
    });
    const privateDns = await request(rebound.app, "/x402/requests", {
      token: rebound.apiKey,
      body: {
        cardId: rebound.card.id,
        url: "https://nirium-agent.fly.dev/paid",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(privateDns.status).toBe(400);
    expect(((await privateDns.json()) as any).error.code).toBe(
      "X402_BLOCKED_ADDRESS",
    );
  });

  it("replays an x402 request without a second charge", async () => {
    const h = await boot({ fakes: { x402: () => challengeResponse() } });
    const input = {
      cardId: h.card.id,
      url: "https://nirium-agent.fly.dev/paid",
      idempotencyKey: "x402-1",
    };
    const first = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: input,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as any;

    const replay = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: input,
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.requestId).toBe(firstBody.requestId);
    expect(replayBody.chargeId).toBe(firstBody.chargeId);
    expect(h.repo.listChargesForCard(h.card.id).length).toBe(1);
  });

  it("verifies the x402 settlement tx and records facilitator", async () => {
    const hash = "b".repeat(64);
    const h = await boot({
      fakes: {
        x402: () => challengeResponse(),
        tx: () => ({
          successful: true,
          memo_type: "none",
          created_at: new Date().toISOString(),
          hash,
        }),
        ops: () => ({
          _embedded: {
            records: [
              {
                type: "payment",
                to: X402_PAY_TO,
                amount: "0.0500000",
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: USDC_ISSUER,
              },
            ],
          },
        }),
      },
      config: {
        onchainVerify: true,
        allowUnverifiedSettlement: false,
      },
    });

    const created = await request(h.app, "/x402/requests", {
      token: h.apiKey,
      body: {
        cardId: h.card.id,
        url: "https://nirium-agent.fly.dev/paid",
      },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as any;

    const paymentResponse = Buffer.from(JSON.stringify({ hash })).toString(
      "base64",
    );
    const res = await settle(h, createdBody.chargeId, hash, {
      x402RequestId: createdBody.requestId,
      body: { "PAYMENT-RESPONSE": paymentResponse },
    });
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.charge.status).toBe("SETTLED");
    // blindfold: contract (SECURITY.md) — x402 is verified and recorded as facilitator.
    expect(body.charge.receipt.onchainVerified).toBe(true);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(body.charge.receipt.settlement).toBe("facilitator");

    const poll = await request(h.app, `/x402/requests/${createdBody.requestId}`, {
      token: h.apiKey,
    });
    const pollBody = (await poll.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(pollBody.status).toBe("SETTLED");
    expect(pollBody.body["PAYMENT-RESPONSE"]).toBe(paymentResponse);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * On-chain verification
 * ──────────────────────────────────────────────────────────────────────────── */

describe("on-chain verification", () => {
  it("accepts a matching Horizon payment and marks the receipt verified", async () => {
    const fakes: Fakes = {};
    const h = await boot({
      fakes,
      config: { onchainVerify: true, allowUnverifiedSettlement: false },
    });
    const { body } = await issueToken(h, { amount: "2.50" });
    const redeemed = await redeem(h, body.token);
    const charge = redeemed.body.charge as Charge;
    const hash = "c".repeat(64);

    fakes.tx = () => ({
      successful: true,
      memo_type: "text",
      memo: receiptMemo(charge.id),
      created_at: new Date().toISOString(),
      hash,
    });
    fakes.ops = () => ({
      _embedded: {
        records: [
          {
            type: "payment",
            to: EXA_ADDRESS,
            amount: "2.5000000",
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: USDC_ISSUER,
          },
        ],
      },
    });

    const res = await settle(h, charge.id, hash);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(res.status).toBe(200);
    const settled = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.charge.status).toBe("SETTLED");
    expect(settled.charge.receipt.onchainVerified).toBe(true);
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(settled.charge.receipt.settlement).toBe("direct");
    expect(toUnits(h.repo.getCard(h.card.id)!.budget.spent)).toBe(
      toUnits("2.50"),
    );
  });

  it("rejects a mismatched payment, fails the charge and releases the reservation", async () => {
    const fakes: Fakes = {};
    const h = await boot({
      fakes,
      config: { onchainVerify: true, allowUnverifiedSettlement: false },
    });
    const { body } = await issueToken(h, { amount: "2.50" });
    const redeemed = await redeem(h, body.token);
    const charge = redeemed.body.charge as Charge;
    const hash = "d".repeat(64);

    fakes.tx = () => ({
      successful: true,
      memo_type: "text",
      memo: receiptMemo(charge.id),
      created_at: new Date().toISOString(),
      hash,
    });
    fakes.ops = () => ({
      _embedded: {
        records: [
          {
            type: "payment",
            to: "GWRONGDESTINATION",
            amount: "2.5000000",
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: USDC_ISSUER,
          },
        ],
      },
    });

    const res = await settle(h, charge.id, hash);
    // blindfold: contract (SECURITY.md) — verification failure fails closed.
    expect(res.status).toBe(402);
    const failed = (await res.json()) as any;
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(failed.error.code).toBe("SETTLEMENT_ERROR");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(failed.error.details.verification.reason).toBe("PAYMENT_MISMATCH");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCharge(charge.id)!.status).toBe("FAILED");
  // blindfold: contract — expected value follows CONTRACTS.md / SECURITY.md / LIMITS.md.
    expect(h.repo.getCard(h.card.id)!.budget.reserved).toBe("0");

    const ledger = await request(h.app, "/ledger", { cookie: h.cookie });
    const events = ((await ledger.json()) as any).events as any[];
    expect(events.some((event) => event.type === "CHARGE_FAILED")).toBe(true);
  });
});
