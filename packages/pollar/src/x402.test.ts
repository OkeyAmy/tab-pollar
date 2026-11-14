import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOROBAN_RPC_URL,
  createX402Payer,
  readX402Settlement,
  type X402PollarClient,
} from "./index";

const PAYER = "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC";

function fakePollar(overrides: Partial<X402PollarClient> = {}): X402PollarClient {
  return {
    address: PAYER,
    signAuthEntry: async () => ({ status: "signed", signedAuthEntry: "AAAA" }),
    ...overrides,
  };
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

/** Exact request the wrapper handed to the injected fetch. */
function toRequest(call: FetchCall): Request {
  return call.input instanceof Request ? call.input : new Request(call.input, call.init);
}

/** A fetch stand-in that records calls and always returns the given response. */
function fakeFetch(response: Response | (() => Response)) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return typeof response === "function" ? response() : response;
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("readX402Settlement", () => {
  it("decodes PAYMENT-RESPONSE into tx hash, network, payer and amount", () => {
    const headers = new Headers({
      "PAYMENT-RESPONSE": encode({
        success: true,
        transaction: "a".repeat(64),
        network: "stellar:testnet",
        payer: PAYER,
        amount: "500000",
      }),
    });
    expect(readX402Settlement(headers)).toEqual({
      success: true,
      txHash: "a".repeat(64),
      network: "stellar:testnet",
      payer: PAYER,
      amount: "500000",
    });
  });

  it("accepts the legacy X-PAYMENT-RESPONSE header", () => {
    const headers = new Headers({
      "X-PAYMENT-RESPONSE": encode({
        success: true,
        transaction: "b",
        network: "stellar:testnet",
      }),
    });
    expect(readX402Settlement(headers).txHash).toBe("b");
  });

  it("returns empty settlement fields when the header is absent", () => {
    expect(readX402Settlement(new Headers())).toEqual({
      success: null,
      txHash: null,
      network: null,
      payer: null,
      amount: null,
    });
  });

  it("does not throw on a malformed header", () => {
    const headers = new Headers({ "PAYMENT-RESPONSE": "!!! not base64 !!!" });
    expect(readX402Settlement(headers).txHash).toBeNull();
  });

  it("keeps success=false visible so callers can report a rejected settlement", () => {
    const headers = new Headers({
      "PAYMENT-RESPONSE": encode({
        success: false,
        transaction: "",
        network: "stellar:testnet",
      }),
    });
    expect(readX402Settlement(headers).success).toBe(false);
    expect(readX402Settlement(headers).txHash).toBeNull();
  });
});

describe("createX402Payer", () => {
  it("exposes the default testnet Soroban RPC", () => {
    expect(DEFAULT_SOROBAN_RPC_URL).toBe("https://soroban-testnet.stellar.org");
  });

  it("returns the paid body and the settlement hash from a plain 200", async () => {
    const body = { market: { baseFee: 100 } };
    const { calls, fetchImpl } = fakeFetch(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": encode({
            success: true,
            transaction: "c".repeat(64),
            network: "stellar:testnet",
            payer: PAYER,
          }),
        },
      }),
    );

    const payer = createX402Payer(fakePollar(), { fetchImpl });
    const result = await payer.fetchPaid("https://nirium-agent.example/api/v1/premium/market");

    expect(calls).toHaveLength(1);
    // @x402/fetch normalizes the call into a Request before invoking fetch.
    const request = toRequest(calls[0]!);
    expect(request.url).toBe("https://nirium-agent.example/api/v1/premium/market");
    expect(request.method).toBe("GET");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body,
      txHash: "c".repeat(64),
      network: "stellar:testnet",
      payer: PAYER,
    });
  });

  it("parses a non-JSON body as text instead of throwing", async () => {
    const { fetchImpl } = fakeFetch(new Response("hello", { status: 200 }));
    const result = await createX402Payer(fakePollar(), { fetchImpl }).fetchPaid(
      "https://example.test/x",
    );
    expect(result.body).toBe("hello");
    expect(result.txHash).toBeNull();
  });

  it("returns a null body for an empty response", async () => {
    const { fetchImpl } = fakeFetch(new Response(null, { status: 204 }));
    const result = await createX402Payer(fakePollar(), { fetchImpl }).fetchPaid(
      "https://example.test/x",
    );
    expect(result.body).toBeNull();
    expect(result.ok).toBe(true);
  });

  it("passes the request init through unchanged", async () => {
    const { calls, fetchImpl } = fakeFetch(new Response("{}", { status: 200 }));
    const payer = createX402Payer(fakePollar(), { fetchImpl });
    await payer.fetchPaid("https://example.test/x", {
      method: "POST",
      body: JSON.stringify({ q: 1 }),
      headers: { "content-type": "application/json" },
    });
    const request = toRequest(calls[0]!);
    expect(request.method).toBe("POST");
    expect(await request.text()).toBe(JSON.stringify({ q: 1 }));
  });

  it("refuses a pubnet config without an explicit RPC url", () => {
    expect(() =>
      createX402Payer(fakePollar(), { network: "stellar:pubnet" }),
    ).toThrow(/sorobanRpcUrl|RPC/i);
  });

  it("does not touch fetch until the first paid request (lazy signer init)", () => {
    const { calls, fetchImpl } = fakeFetch(new Response("{}", { status: 200 }));
    const payer = createX402Payer(fakePollar(), { fetchImpl });
    expect(payer.kind).toBe("x402");
    expect(calls).toHaveLength(0);
  });

  it("reuses one wrapped fetch across calls", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("{}", { status: 200 }));
    const payer = createX402Payer(fakePollar(), { fetchImpl });
    const [a, b] = await Promise.all([
      payer.fetchPaid("https://example.test/a"),
      payer.fetchPaid("https://example.test/b"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
