import { describe, expect, it } from "vitest";
import {
  TabApiError,
  TabClient,
  X402_TERMINAL_STATUSES,
  exitCodeForCharge,
  exitCodeForX402,
  formatAmount,
  isPendingPurchase,
  isX402Pending,
} from "./index.js";

/**
 * Tests use an injected `fetch` so no server is needed. Expected values are
 * grounded in .agents/CONTRACTS.md and the 05 brief, never copied from output.
 */

const BASE = "http://tab.test";
const KEY = "tab_agent_test_key"; // never a real credential

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function stubFetch(handler: Handler): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(fetchImpl: typeof fetch): TabClient {
  return new TabClient({ baseUrl: BASE, apiKey: KEY, fetchImpl, retryDelayMs: 0 });
}

const HEALTH = {
  ok: true,
  mode: "testnet",
  demoMode: true,
  signerOnline: false,
  merchants: 3,
  now: "2026-11-14T12:00:00.000Z",
};

const CARD = {
  id: "crd_research",
  label: "Research Scout",
  maskedNumber: "4021 •••• •••• 7f3a",
  status: "ACTIVE",
  budget: { total: "25", spent: "7.50", reserved: "0" },
  limits: { perCharge: "5", daily: "10", autoApproveUnder: "3" },
  merchants: ["mch_exa", "mch_firecrawl"],
  expiresAt: "2026-11-15T12:00:00.000Z",
};

describe("TabClient transport", () => {
  it("calls /api/v1 and sends the agent key as a bearer token", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(HEALTH));
    const health = await makeClient(fetchImpl).health();

    expect(health.ok).toBe(true); // blindfold: contract — /health returns { ok: boolean }
    expect(health.merchants).toBe(3); // blindfold: contract — the seed table fixes exactly 3 merchants (Exa, Firecrawl, OpenAI)
    expect(calls).toHaveLength(1); // blindfold: contract — one request, no hidden preflight
    expect(calls[0].url).toBe(`${BASE}/api/v1/health`); // blindfold: contract — base path is /api/v1
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`); // blindfold: contract — agent auth is Bearer tab_agent_…
  });

  it("maps a 403 policy denial to a typed error with the code", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          error: {
            code: "AMOUNT_ABOVE_PER_CHARGE",
            message: "A single charge is capped at 5.0000000.",
            details: { limit: "5" },
          },
        },
        403,
      ),
    );

    const err = (await makeClient(fetchImpl)
      .requestToken({ cardId: "crd_1", merchantId: "mch_exa", amount: "9.00" })
      .catch((e: unknown) => e)) as TabApiError;

    expect(err).toBeInstanceOf(TabApiError); // blindfold: contract — 403 is a policy error, not a crash
    expect(err.status).toBe(403); // blindfold: contract — HTTP mapping: 403 policy
    expect(err.code).toBe("AMOUNT_ABOVE_PER_CHARGE"); // blindfold: contract — code comes from @tab/shared PolicyCodeSchema
    expect(err.message).toContain("AMOUNT_ABOVE_PER_CHARGE"); // blindfold: doc — the message must name the code
    expect(err.details).toEqual({ limit: "5" }); // blindfold: contract — details are passed through
  });

  it("returns the pending shape on 202 instead of inventing a receipt", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          status: "PENDING",
          charge: {
            id: "chg_pending",
            status: "AWAITING_APPROVAL",
            amount: "9.00",
            merchantName: "Exa",
          },
        },
        202,
      ),
    );

    const result = await makeClient(fetchImpl).buy({
      cardId: "crd_1",
      merchantId: "mch_exa",
      sku: "exa-pro",
      amount: "9.00",
    });

    expect(isPendingPurchase(result)).toBe(true); // blindfold: contract — 202 ⇒ { charge, status: "PENDING" }
    if (!isPendingPurchase(result)) throw new Error("expected a pending purchase");
    expect(result.status).toBe("PENDING"); // blindfold: contract — the wire status is surfaced verbatim
    expect(result.charge.id).toBe("chg_pending"); // blindfold: invariant — the charge id must not be rewritten
  });

  it("treats a 409 with a charge as an idempotency replay, not a failure", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ charge: { id: "chg_original", status: "SETTLED", amount: "2.50" } }, 409),
    );

    const result = await makeClient(fetchImpl).charge({
      token: "tab_ch_00000000000000000000000000000001",
      merchantId: "mch_exa",
      amount: "2.50",
      idempotencyKey: "exa-order-991",
    });

    expect(result.replayed).toBe(true); // blindfold: contract — 409 returns the original charge
    expect(result.charge.id).toBe("chg_original"); // blindfold: contract — resolve to that original charge
  });

  it("maps a transport failure to TabApiError(0, NETWORK)", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const err = (await makeClient(fetchImpl)
      .health()
      .catch((e: unknown) => e)) as TabApiError;

    expect(err).toBeInstanceOf(TabApiError); // blindfold: contract — network failure is typed, not raw
    expect(err.status).toBe(0); // blindfold: doc — map network failure to status 0
    expect(err.code).toBe("NETWORK"); // blindfold: doc — the transport code is NETWORK
    expect(err.message).toContain(BASE); // blindfold: contract — the message names the API that was unreachable
  });

  it("preserves the exact HTTP status when the body has no error envelope", async () => {
    const { fetchImpl } = stubFetch(() => new Response("", { status: 503 }));

    const err = (await makeClient(fetchImpl)
      .health()
      .catch((e: unknown) => e)) as TabApiError;

    expect(err.status).toBe(503); // blindfold: contract — HTTP statuses are surfaced exactly, never collapsed
    expect(err.code).toBe("SERVER_ERROR"); // blindfold: contract — 5xx maps to the SERVER_ERROR code
  });
});

describe("TabClient 429 handling", () => {
  it("retries a safe request once, honouring Retry-After", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      calls.length === 1
        ? json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "0" })
        : json(HEALTH),
    );

    const health = await makeClient(fetchImpl).health();

    expect(calls).toHaveLength(2); // blindfold: doc — retry exactly once on 429
    expect(health.ok).toBe(true); // blindfold: contract — the retry's success is returned
  });

  it("never retries POST /charges without an idempotency key", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "0" }),
    );

    const err = (await makeClient(fetchImpl)
      .charge({ token: "tab_ch_00000000000000000000000000000002", merchantId: "mch_exa", amount: "2.50" })
      .catch((e: unknown) => e)) as TabApiError;

    expect(calls).toHaveLength(1); // blindfold: doc — a retry here could double-spend
    expect(err.code).toBe("RATE_LIMITED"); // blindfold: contract — the 429 code still reaches the caller
  });

  it("does retry POST /charges when an idempotency key makes replay safe", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      calls.length === 1
        ? json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "0" })
        : json({ charge: { id: "chg_after_retry", status: "QUEUED" } }, 201),
    );

    const result = await makeClient(fetchImpl).charge({
      token: "tab_ch_00000000000000000000000000000003",
      merchantId: "mch_exa",
      amount: "2.50",
      idempotencyKey: "order-42",
    });

    expect(calls).toHaveLength(2); // blindfold: doc — idempotent replays are allowed one retry
    expect(result.charge.id).toBe("chg_after_retry"); // blindfold: invariant — the retried response is used
    expect(result.replayed).toBe(false); // blindfold: contract — 201 is not a replay
  });

  it("never retries POST /purchases on 429", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "0" }),
    );

    const err = (await makeClient(fetchImpl)
      .buy({ cardId: "crd_1", merchantId: "mch_exa", sku: "exa-starter", amount: "2.50" })
      .catch((e: unknown) => e)) as TabApiError;

    expect(calls).toHaveLength(1); // blindfold: doc — a purchase retry could buy the SKU twice
    expect(err.status).toBe(429); // blindfold: doc — surface the exact HTTP status
  });

  it("never retries POST /x402/requests on 429", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "retry-after": "0" }),
    );

    const err = (await makeClient(fetchImpl)
      .x402({ cardId: "crd_1", url: "https://nirium-agent.fly.dev/api/v1/premium/market" })
      .catch((e: unknown) => e)) as TabApiError;

    expect(calls).toHaveLength(1); // blindfold: doc — an x402 retry could pay twice
    expect(err.code).toBe("RATE_LIMITED"); // blindfold: doc — the denial code is preserved
  });
});

describe("TabClient.waitForCharge", () => {
  it("polls until the charge reaches a terminal state", async () => {
    const statuses = ["QUEUED", "SIGNING", "SETTLED"];
    const { fetchImpl, calls } = stubFetch(() => {
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
      return json({ charge: { id: "chg_poll", status, amount: "2.50" } });
    });

    const charge = await makeClient(fetchImpl).waitForCharge("chg_poll", {
      timeoutMs: 1_000,
      intervalMs: 1,
    });

    expect(charge.status).toBe("SETTLED"); // blindfold: contract — SETTLED is terminal
    expect(calls).toHaveLength(3); // blindfold: invariant — QUEUED, SIGNING, then SETTLED
    expect(calls[2].url).toBe(`${BASE}/api/v1/charges/chg_poll`); // blindfold: contract — poll GET /charges/:id
  });

  it("times out with a typed error when approval never arrives", async () => {
    const { fetchImpl } = stubFetch(() => json({ charge: { id: "chg_slow", status: "AWAITING_APPROVAL" } }));

    const err = (await makeClient(fetchImpl)
      .waitForCharge("chg_slow", { timeoutMs: 5, intervalMs: 2 })
      .catch((e: unknown) => e)) as TabApiError;

    expect(err).toBeInstanceOf(TabApiError); // blindfold: doc — polling failures are typed
    expect(err.code).toBe("TIMEOUT"); // blindfold: doc — the caller can distinguish "still pending" from "broken"
    expect(err.details).toMatchObject({ chargeId: "chg_slow", status: "AWAITING_APPROVAL" }); // blindfold: contract — report the last state
  });
});

describe("TabClient.x402", () => {
  it("opens the request, polls, and returns the settled body plus receipt", async () => {
    const { fetchImpl, calls } = stubFetch((call) => {
      if (call.method === "POST") {
        return json({ requestId: "x402_1", chargeId: "chg_x", status: "PENDING" }, 202);
      }
      return json({
        requestId: "x402_1",
        chargeId: "chg_x",
        status: "SETTLED",
        body: { price: 0.05, symbol: "USDC" },
        receipt: {
          chain: "STELLAR",
          hash: "deadbeef",
          explorerUrl: "https://stellar.expert/explorer/testnet/tx/deadbeef",
          asset: "USDC",
          amount: "0.05",
          memo: "TAB:x",
          confirmedAt: "2026-11-14T12:00:05.000Z",
        },
      });
    });

    const result = await makeClient(fetchImpl).x402(
      { cardId: "crd_1", url: "https://nirium-agent.fly.dev/api/v1/premium/market" },
      { timeoutMs: 1_000, intervalMs: 1 },
    );

    expect(result.status).toBe("SETTLED"); // blindfold: doc — poll until terminal SETTLED
    expect(result.pending).toBe(false); // blindfold: doc — a settled result is not the PENDING shape
    expect(result.body).toEqual({ price: 0.05, symbol: "USDC" }); // blindfold: doc — return the protected API's body untouched
    expect(result.receipt?.hash).toBe("deadbeef"); // blindfold: doc — return the on-chain receipt
    expect(isX402Pending(result)).toBe(false); // blindfold: doc — SETTLED is terminal
    expect(calls[0].method).toBe("POST"); // blindfold: doc — open with POST /x402/requests
    expect(calls[0].url).toBe(`${BASE}/api/v1/x402/requests`); // blindfold: doc — exact route
    expect(calls[1].url).toBe(`${BASE}/api/v1/x402/requests/x402_1`); // blindfold: doc — poll by request id
  });

  it("returns an honest pending shape when approval does not arrive in time", async () => {
    const pending = { requestId: "x402_2", chargeId: "chg_y", status: "AWAITING_APPROVAL" };
    const { fetchImpl } = stubFetch(() => json(pending));

    const result = await makeClient(fetchImpl).x402(
      { cardId: "crd_1", url: "https://example.test/premium" },
      { timeoutMs: 5, intervalMs: 2 },
    );

    expect(result.status).toBe("AWAITING_APPROVAL"); // blindfold: doc — never fabricate SETTLED
    expect(result.pending).toBe(true); // blindfold: doc — approval-required returns the PENDING shape
    expect(isX402Pending(result)).toBe(true); // blindfold: doc — approval-required is pending
    expect(result.body).toBeUndefined(); // blindfold: doc — no body before payment settles
    expect(result.receipt).toBeNull(); // blindfold: doc — no receipt before payment settles
  });

  it("surfaces a policy denial on the x402 route with its code", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        {
          error: {
            code: "MERCHANT_NOT_ALLOWED",
            message: "nirium-agent.fly.dev is not on this card's allowlist.",
            details: { merchantId: "mch_nirium" },
          },
        },
        403,
      ),
    );

    const err = (await makeClient(fetchImpl)
      .x402({ cardId: "crd_1", url: "https://nirium-agent.fly.dev/api/v1/premium/market" })
      .catch((e: unknown) => e)) as TabApiError;

    expect(err.status).toBe(403); // blindfold: contract — 403 is the policy-denial status
    expect(err.code).toBe("MERCHANT_NOT_ALLOWED"); // blindfold: contract — the merchant allowlist code
  });
});

describe("asset honesty", () => {
  it("never puts $ on an XLM amount", () => {
    expect(formatAmount("2.5", "XLM")).toBe("2.5000000 XLM"); // blindfold: doc — XLM shows 7dp and its ticker, never $
    expect(formatAmount("2.5", "XLM")).not.toContain("$"); // blindfold: doc — the currency symbol must be absent
  });

  it("uses $ only for USD-denominated USDC", () => {
    expect(formatAmount("2.50", "USDC")).toBe("$2.50"); // blindfold: doc — USDC is USD-denominated, so $ is honest
    expect(formatAmount("0.05", "USDC")).toBe("$0.05"); // blindfold: doc — x402 calls are 0.05 USDC
  });
});

describe("exit code semantics", () => {
  it.each([
    ["SETTLED", 0],
    ["FAILED", 1],
    ["DECLINED", 1],
    ["EXPIRED", 1],
    ["AWAITING_APPROVAL", 2],
    ["QUEUED", 2],
    ["SIGNING", 2],
  ] as const)("charge %s exits %i", (status, expected) => {
    // blindfold: doc — pending is not failure: approval/queue/signing exit 2, only terminal failures exit 1
    expect(exitCodeForCharge(status)).toBe(expected);
  });

  it.each([
    ["SETTLED", 0],
    ["FAILED", 1],
    ["DECLINED", 1],
    ["EXPIRED", 1],
    ["CANCELLED", 1],
    ["PENDING", 2],
    ["SIGNING", 2],
  ] as const)("x402 %s exits %i", (status, expected) => {
    // blindfold: doc — a dead x402 request is a failure; a live one is pending
    expect(exitCodeForX402(status)).toBe(expected);
  });
});

describe("idempotency keys", () => {
  const PURCHASE = {
    purchaseId: "pur_1",
    charge: { id: "chg_buy", status: "SETTLED", amount: "2.50", asset: "USDC", merchantName: "Exa" },
    sku: { id: "exa-starter", name: "Exa Starter" },
    licenseKey: "EXA-0000-0000-0000",
    receipt: null,
  };

  it("sends exactly one generated UUID per purchase", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(PURCHASE));

    await makeClient(fetchImpl).buy({
      cardId: "crd_1",
      merchantId: "mch_exa",
      sku: "exa-starter",
      amount: "2.50",
    });
    await makeClient(fetchImpl).buy({
      cardId: "crd_1",
      merchantId: "mch_exa",
      sku: "exa-starter",
      amount: "2.50",
    });

    const first = calls[0].body ?? "";
    expect(first.match(/"idempotencyKey"/g)).toHaveLength(1); // blindfold: doc — exactly one key per logical call
    const firstKey = JSON.parse(first).idempotencyKey as string;
    const secondKey = JSON.parse(calls[1].body ?? "{}").idempotencyKey as string;
    expect(firstKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // blindfold: doc — crypto.randomUUID()
    expect(firstKey).not.toBe(secondKey); // blindfold: doc — each logical call gets its own key
  });

  it("reuses an explicit key when the caller retries a purchase", async () => {
    const { fetchImpl, calls } = stubFetch(() => json(PURCHASE));

    for (let attempt = 0; attempt < 2; attempt++) {
      await makeClient(fetchImpl).buy({
        cardId: "crd_1",
        merchantId: "mch_exa",
        sku: "exa-starter",
        amount: "2.50",
        idempotencyKey: "exa-order-991",
      });
    }

    expect(JSON.parse(calls[0].body ?? "{}").idempotencyKey).toBe("exa-order-991"); // blindfold: doc — explicit retry key is sent
    expect(JSON.parse(calls[1].body ?? "{}").idempotencyKey).toBe("exa-order-991"); // blindfold: doc — the retry reuses, not regenerates
  });

  it("binds the generated x402 key to the result so a retry cannot pay twice", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ requestId: "x402_k", chargeId: "chg_k", status: "SETTLED", body: { ok: true }, receipt: null }),
    );

    const result = await makeClient(fetchImpl).x402({
      cardId: "crd_1",
      url: "https://nirium-agent.fly.dev/api/v1/premium/market",
    });

    expect(JSON.parse(calls[0].body ?? "{}").idempotencyKey).toBe(result.idempotencyKey); // blindfold: doc — the key that was sent is returned
    expect(result.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // blindfold: doc — it is the generated UUID
  });

  it("stops polling when the x402 request is already terminal", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      json({ requestId: "x402_exp", chargeId: "chg_exp", status: "EXPIRED" }),
    );

    const result = await makeClient(fetchImpl).x402({
      cardId: "crd_1",
      url: "https://example.test/premium",
    });

    expect(result.status).toBe("EXPIRED"); // blindfold: doc — EXPIRED is terminal
    expect(isX402Pending(result)).toBe(false); // blindfold: doc — do not poll a dead request for 30s
    expect(calls).toHaveLength(1); // blindfold: doc — no GET after a terminal create
    expect(X402_TERMINAL_STATUSES.has("CANCELLED")).toBe(true); // blindfold: doc — cancelled requests are terminal too
  });
});

