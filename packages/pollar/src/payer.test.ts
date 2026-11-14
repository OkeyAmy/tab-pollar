import { describe, expect, it } from "vitest";
import {
  TESTNET_USDC_ISSUER,
  USDC_SOLANA_MINT,
  createBrowserPayer,
  createMockPayer,
  type PollarClientLike,
  type PollarSubmitOutcome,
} from "./index";
import { intent } from "./intent.fixture";

interface RunTxCall {
  operation: string;
  params: Record<string, unknown>;
  options?: { memo?: { type: "text"; value: string } };
}

interface SendPaymentCall {
  chain: "SOLANA";
  destination: string;
  amount: string;
  mint?: string;
}

/** A recording fake: no network, no SDK, no vi.fn typing games. */
function fakeClient(
  outcome: PollarSubmitOutcome | ((call: RunTxCall) => Promise<PollarSubmitOutcome>),
  sendOutcome?: PollarSubmitOutcome | ((call: SendPaymentCall) => Promise<PollarSubmitOutcome>),
) {
  const calls = { runTx: [] as RunTxCall[], sendPayment: [] as SendPaymentCall[] };
  const client: PollarClientLike & { calls: typeof calls; sendPayment?: unknown } = {
    calls,
    async runTx(operation, params, options) {
      const call = { operation, params, options };
      calls.runTx.push(call);
      return typeof outcome === "function" ? outcome(call) : outcome;
    },
  };
  if (sendOutcome !== undefined) {
    client.sendPayment = async (args: SendPaymentCall) => {
      calls.sendPayment.push(args);
      return typeof sendOutcome === "function" ? sendOutcome(args) : sendOutcome;
    };
  }
  return client;
}

describe("createBrowserPayer — Stellar", () => {
  it("calls runTx('payment') with the exact params and a 28-byte memo", async () => {
    const client = fakeClient({ status: "success", hash: "abc123" });
    const outcome = await createBrowserPayer(client).pay(intent());

    expect(client.calls.runTx).toHaveLength(1);
    const call = client.calls.runTx[0]!;
    expect(call.operation).toBe("payment");
    expect(call.params).toEqual({
      destination: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC",
      amount: "2.50",
      asset: { type: "credit_alphanum4", code: "USDC", issuer: TESTNET_USDC_ISSUER },
    });
    expect(call.options).toEqual({ memo: { type: "text", value: "TAB:0123456789abcdef" } });
    expect(outcome).toMatchObject({ status: "success", hash: "abc123", error: null });
    expect(outcome.explorerUrl).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc123",
    );
  });

  it("uses the payer's usdcIssuer option when the intent has none", async () => {
    const client = fakeClient({ status: "success", hash: "h" });
    await createBrowserPayer(client, { usdcIssuer: TESTNET_USDC_ISSUER }).pay(
      intent({ assetIssuer: null }),
    );
    expect(client.calls.runTx[0]!.params.asset).toEqual({
      type: "credit_alphanum4",
      code: "USDC",
      issuer: TESTNET_USDC_ISSUER,
    });
  });

  it("omits the memo option when the memo is null", async () => {
    const client = fakeClient({ status: "success", hash: "h" });
    await createBrowserPayer(client).pay(intent({ memo: null }));
    expect(client.calls.runTx[0]!.options).toBeUndefined();
  });

  it("maps 'pending' to pending and keeps the hash", async () => {
    const client = fakeClient({ status: "pending", hash: "0xdead" });
    const outcome = await createBrowserPayer(client).pay(intent());
    expect(outcome.status).toBe("pending");
    expect(outcome.hash).toBe("0xdead");
    expect(outcome.error).toBeNull();
  });

  it("maps cosign_pending to pending with a human-readable reason", async () => {
    const client = fakeClient({ status: "cosign_pending" });
    const outcome = await createBrowserPayer(client).pay(intent());
    expect(outcome.status).toBe("pending");
    expect(outcome.hash).toBeNull();
    expect(outcome.code).toBe("COSIGN_PENDING");
    expect(outcome.error).toMatch(/approve/i);
  });

  it("maps a wallet-not-ready outcome to a retryable coded error", async () => {
    const client = fakeClient({
      status: "error",
      code: "SDK_WALLET_NOT_READY",
      message: "wallet is still being prepared",
    });
    const outcome = await createBrowserPayer(client).pay(intent());
    expect(outcome.status).toBe("error");
    expect(outcome.code).toBe("SDK_WALLET_NOT_READY");
    expect(outcome.error).toBe("wallet is still being prepared");
  });

  it("prefers message, then details, then code for the error string", async () => {
    const cases: Array<[PollarSubmitOutcome, string]> = [
      [{ status: "error", message: "msg", details: "det", code: "CODE" }, "msg"],
      [{ status: "error", details: "det", code: "CODE" }, "det"],
      [{ status: "error", code: "CODE" }, "CODE"],
      [{ status: "error" }, "Payment failed"],
    ];
    for (const [result, expected] of cases) {
      const outcome = await createBrowserPayer(fakeClient(result)).pay(intent());
      expect(outcome.error).toBe(expected);
    }
  });

  it("turns a thrown SDK error into an error outcome with the code and message", async () => {
    const error = Object.assign(new Error("confirmation required"), {
      code: "SDK_CONFIRMATION_UNAVAILABLE",
    });
    const client = fakeClient(async () => {
      throw error;
    });
    const outcome = await createBrowserPayer(client).pay(intent());
    expect(outcome).toMatchObject({
      status: "error",
      hash: null,
      code: "SDK_CONFIRMATION_UNAVAILABLE",
      error: "confirmation required",
    });
  });

  it("rejects a memo longer than 28 UTF-8 bytes before touching the SDK", async () => {
    const client = fakeClient({ status: "success", hash: "h" });
    const outcome = await createBrowserPayer(client).pay(
      intent({ memo: "TAB:0123456789abcdef0123456789" }),
    );
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/28/);
    expect(client.calls.runTx).toHaveLength(0);
  });
});

describe("createBrowserPayer — Solana", () => {
  const SOL_DEST = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

  it("sends integer base units and the USDC mint", async () => {
    const client = fakeClient({ status: "success", hash: "unused" }, { status: "success", hash: "s1" });
    const outcome = await createBrowserPayer(client).pay(
      intent({ chain: "SOLANA", destination: SOL_DEST }),
    );

    expect(client.calls.runTx).toHaveLength(0);
    expect(client.calls.sendPayment[0]).toEqual({
      chain: "SOLANA",
      destination: SOL_DEST,
      amount: "2500000",
      mint: USDC_SOLANA_MINT,
    });
    expect(outcome.status).toBe("success");
    expect(outcome.explorerUrl).toContain("cluster=devnet");
  });

  it("omits the mint for native SOL", async () => {
    const client = fakeClient({ status: "success", hash: "unused" }, { status: "success", hash: "s2" });
    await createBrowserPayer(client).pay(
      intent({ chain: "SOLANA", asset: "XLM", destination: SOL_DEST }),
    );
    expect(client.calls.sendPayment[0]).not.toHaveProperty("mint");
    expect(client.calls.sendPayment[0]!.amount).toBe("2500000000");
  });

  it("fails cleanly when the client has no sendPayment()", async () => {
    const client = fakeClient({ status: "success", hash: "h" });
    const outcome = await createBrowserPayer(client).pay(
      intent({ chain: "SOLANA", destination: SOL_DEST }),
    );
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/sendPayment/);
  });
});

describe("createMockPayer", () => {
  it("returns a deterministic success with a 64-hex hash and explorer url", async () => {
    const payer = createMockPayer();
    const a = await payer.pay(intent());
    const b = await payer.pay(intent());
    expect(payer.kind).toBe("mock");
    expect(a.status).toBe("success");
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
    expect(a.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${a.hash}`);
  });

  it("changes the hash when the charge changes", async () => {
    const payer = createMockPayer();
    const a = await payer.pay(intent({ chargeId: "chg_aaaaaaaaaaaaaaaa" }));
    const b = await payer.pay(intent({ chargeId: "chg_bbbbbbbbbbbbbbbb" }));
    expect(a.hash).not.toBe(b.hash);
  });

  it("accepts an explicit hash for scripted demos", async () => {
    const payer = createMockPayer({ hash: "f".repeat(64) });
    expect((await payer.pay(intent())).hash).toBe("f".repeat(64));
  });
});
