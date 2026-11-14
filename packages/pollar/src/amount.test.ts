import { describe, expect, it } from "vitest";
import {
  STELLAR_MEMO_MAX_BYTES,
  TESTNET_USDC_ISSUER,
  settlementAsset,
  settlementAssetIssuer,
  toSolanaAmount,
  toStellarPaymentParams,
} from "./index";
import { intent } from "./intent.fixture";

describe("toStellarPaymentParams", () => {
  it("builds a native XLM payment with no issuer", () => {
    const params = toStellarPaymentParams(intent({ asset: "XLM", assetIssuer: null }));
    expect(params).toEqual({
      destination: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC",
      amount: "2.50",
      asset: { type: "native" },
    });
  });

  it("builds a credit_alphanum4 USDC payment from the intent issuer", () => {
    const params = toStellarPaymentParams(intent());
    expect(params.asset).toEqual({
      type: "credit_alphanum4",
      code: "USDC",
      issuer: TESTNET_USDC_ISSUER,
    });
    expect(params.amount).toBe("2.50");
  });

  it("falls back to NEXT_PUBLIC_USDC_ISSUER when the intent has no issuer", () => {
    const previous = process.env.NEXT_PUBLIC_USDC_ISSUER;
    process.env.NEXT_PUBLIC_USDC_ISSUER = TESTNET_USDC_ISSUER;
    try {
      const params = toStellarPaymentParams(intent({ assetIssuer: null }));
      expect(params.asset).toEqual({
        type: "credit_alphanum4",
        code: "USDC",
        issuer: TESTNET_USDC_ISSUER,
      });
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_USDC_ISSUER;
      else process.env.NEXT_PUBLIC_USDC_ISSUER = previous;
    }
  });

  it("refuses a USDC payment with no issuer instead of sending an invalid asset", () => {
    const previous = process.env.NEXT_PUBLIC_USDC_ISSUER;
    delete process.env.NEXT_PUBLIC_USDC_ISSUER;
    try {
      expect(() => toStellarPaymentParams(intent({ assetIssuer: null }))).toThrow(
        /issuer/i,
      );
    } finally {
      if (previous !== undefined) process.env.NEXT_PUBLIC_USDC_ISSUER = previous;
    }
  });

  it("rejects an issuer that is not a Stellar account id", () => {
    expect(() => toStellarPaymentParams(intent({ assetIssuer: "not-an-issuer" }))).toThrow(
      /issuer/i,
    );
  });

  it("rejects a malformed destination", () => {
    expect(() => toStellarPaymentParams(intent({ destination: "GABC" }))).toThrow(
      /destination/i,
    );
  });

  it("rejects more than 7 decimal places", () => {
    expect(() => toStellarPaymentParams(intent({ amount: "2.50000001" }))).toThrow(
      /7|decimal/i,
    );
  });

  it("rejects zero, negative and non-numeric amounts", () => {
    for (const amount of ["0", "0.00", "-1", "1e3", "two"]) {
      expect(() => toStellarPaymentParams(intent({ amount: amount as never }))).toThrow();
    }
  });

  it("accepts a whole-dollar amount", () => {
    expect(toStellarPaymentParams(intent({ amount: "25" })).amount).toBe("25");
  });
});

describe("toSolanaAmount", () => {
  it("converts USDC with 6 decimals", () => {
    expect(toSolanaAmount("2.50", "USDC")).toBe("2500000");
    expect(toSolanaAmount("0.05", "USDC")).toBe("50000");
    expect(toSolanaAmount("25", "USDC")).toBe("25000000");
  });

  it("converts native SOL with 9 decimals", () => {
    expect(toSolanaAmount("1", "XLM")).toBe("1000000000");
    expect(toSolanaAmount("0.000000001", "XLM")).toBe("1");
  });

  it("does not lose precision on large amounts", () => {
    expect(toSolanaAmount("123456789.123456", "USDC")).toBe("123456789123456");
  });

  it("keeps every digit past Number.MAX_SAFE_INTEGER (float detector)", () => {
    // 9007199254.740993 → 9007199254740993 units, one above 2^53. Any
    // implementation that touches `Number` rounds this to ...992.
    expect(toSolanaAmount("9007199254.740993", "USDC")).toBe("9007199254740993");
    expect(toStellarPaymentParams(intent({ amount: "1.0000001" })).amount).toBe("1.0000001");
  });

  it("rejects more precision than the chain can represent", () => {
    expect(() => toSolanaAmount("0.0000001", "USDC")).toThrow(/6|decimal/i);
    expect(() => toSolanaAmount("0.0000000001", "XLM")).toThrow(/9|decimal/i);
  });

  it("rejects non-numeric amounts", () => {
    for (const amount of ["", " ", "1,5", "1e6", "NaN", "-2"]) {
      expect(() => toSolanaAmount(amount as never, "USDC")).toThrow();
    }
  });
});

describe("memo limits", () => {
  it("documents the 28-byte Stellar memo cap", () => {
    expect(STELLAR_MEMO_MAX_BYTES).toBe(28);
  });

  it("guards the verified testnet USDC decision", () => {
    const previousAsset = process.env.NEXT_PUBLIC_SETTLEMENT_ASSET;
    const previousIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
    try {
      delete process.env.NEXT_PUBLIC_SETTLEMENT_ASSET;
      expect(settlementAsset()).toBe("USDC");
      process.env.NEXT_PUBLIC_SETTLEMENT_ASSET = "XLM";
      expect(settlementAsset()).toBe("XLM");
      expect(settlementAssetIssuer()).toBeNull();

      process.env.NEXT_PUBLIC_SETTLEMENT_ASSET = "USDC";
      process.env.NEXT_PUBLIC_USDC_ISSUER = TESTNET_USDC_ISSUER;
      expect(settlementAssetIssuer()).toBe(TESTNET_USDC_ISSUER);
    } finally {
      if (previousAsset === undefined) delete process.env.NEXT_PUBLIC_SETTLEMENT_ASSET;
      else process.env.NEXT_PUBLIC_SETTLEMENT_ASSET = previousAsset;
      if (previousIssuer === undefined) delete process.env.NEXT_PUBLIC_USDC_ISSUER;
      else process.env.NEXT_PUBLIC_USDC_ISSUER = previousIssuer;
    }
  });
});
