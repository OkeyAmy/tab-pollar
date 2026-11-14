import { describe, expect, it } from "vitest";
import type { Card } from "./index.js";
import {
  MoneySchema,
  TxReceiptSchema,
  addMoney,
  cardExpiryLabel,
  cmpMoney,
  formatRelativeTime,
  formatUsd,
  fromUnits,
  maskCardNumber,
  receiptMemo,
  remainingBudget,
  subMoney,
  toUnits,
  truncateHash,
} from "./index.js";

const NOW = new Date("2026-11-14T12:00:00.000Z");

function card(over: Partial<Card> = {}): Card {
  return {
    id: "crd_test",
    ownerId: "usr_test",
    agentId: "agt_test",
    label: "Research Scout",
    maskedNumber: "4021 •••• •••• 0000",
    status: "ACTIVE",
    chain: "STELLAR",
    asset: "USDC",
    budget: { total: "25", spent: "0", reserved: "0" },
    limits: { perCharge: "5", daily: "10", autoApproveUnder: "3" },
    merchants: ["mch_exa"],
    expiresAt: "2026-11-15T12:00:00.000Z",
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    ...over,
  };
}

describe("money math", () => {
  it("scales a decimal string into 7dp base units", () => {
    // blindfold: spec — Stellar precision is 7dp and 2.5 × 10^7 = 25,000,000.
    expect(toUnits("2.50")).toBe(25_000_000n);
    // blindfold: spec — the smallest 7dp unit.
    expect(toUnits("0.0000001")).toBe(1n);
    // blindfold: spec — whole dollars carry seven zeros of base units.
    expect(toUnits("25")).toBe(250_000_000n);
  });

  it("renders base units back to a decimal string", () => {
    // blindfold: contract — fromUnits trims trailing zeroes but keeps the value.
    expect(fromUnits(25_000_000n)).toBe("2.5");
    // blindfold: spec — 1 is exactly one 7dp unit.
    expect(fromUnits(1n)).toBe("0.0000001");
    // blindfold: spec — zero units render as "0".
    expect(fromUnits(0n)).toBe("0");
  });

  it("round-trips without losing precision at 7dp", () => {
    const values = ["0.0000001", "0.1", "2.5", "9", "19", "25", "1234.5678901"];
    for (const v of values) {
      // blindfold: invariant — units → string → units is identity.
      expect(toUnits(fromUnits(toUnits(v)))).toBe(toUnits(v));
    }
  });

  it("adds and subtracts exactly, with no float drift", () => {
    // blindfold: math — 0.1 + 0.2 = 0.3 (float arithmetic famously says 0.30000000000000004).
    expect(addMoney("0.1", "0.2")).toBe("0.3");
    // blindfold: math — 0.3 − 0.1 = 0.2.
    expect(subMoney("0.3", "0.1")).toBe("0.2");
    // blindfold: math — ten additions of 0.1 reach exactly 1.
    let sum = "0";
    for (let i = 0; i < 10; i++) sum = addMoney(sum, "0.1");
    // blindfold: math — ten tenths is exactly one dollar.
    expect(sum).toBe("1");
    // blindfold: math — the smallest unit doubled is the second-smallest unit.
    expect(addMoney("0.0000001", "0.0000001")).toBe("0.0000002");
  });

  it("compares decimal strings by value, not lexicographically", () => {
    // blindfold: math — equal amounts compare 0.
    expect(cmpMoney("5", "5")).toBe(0);
    // blindfold: math — 5 < 5.0000001.
    expect(cmpMoney("5", "5.0000001")).toBe(-1);
    // blindfold: math — 10 > 9.9999999.
    expect(cmpMoney("10", "9.9999999")).toBe(1);
  });

  it("rejects money shapes that cannot be represented exactly", () => {
    // blindfold: contract — at most 7 fractional digits.
    expect(MoneySchema.safeParse("1.23456789").success).toBe(false);
    // blindfold: contract — money is a positive decimal string.
    expect(MoneySchema.safeParse("-1").success).toBe(false);
    expect(MoneySchema.safeParse("2.50").success).toBe(true);
  });
});

describe("display helpers", () => {
  it("formats USD without passing money through Number()", () => {
    // blindfold: contract — USD display always shows two decimals.
    expect(formatUsd("25")).toBe("$25.00");
    // blindfold: contract — cents are kept.
    expect(formatUsd("2.5")).toBe("$2.50");
    // blindfold: contract — thousands are grouped.
    expect(formatUsd("1234.56")).toBe("$1,234.56");
    // blindfold: contract — zero is still a currency string.
    expect(formatUsd("0")).toBe("$0.00");
    // blindfold: math — third decimal 5 rounds half-up to the next cent.
    expect(formatUsd("2.505")).toBe("$2.51");
  });

  it("keeps receipt verification fields optional", () => {
    const base = {
      chain: "STELLAR" as const,
      hash: "abc",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc",
      asset: "USDC" as const,
      amount: "2.50",
      memo: null,
      confirmedAt: null,
    };
    // blindfold: contract — existing receipts without the new fields still parse.
    expect(TxReceiptSchema.safeParse(base).success).toBe(true);
    // blindfold: contract — the API may attach verification provenance.
    expect(
      TxReceiptSchema.safeParse({ ...base, onchainVerified: true, settlement: "facilitator" }).success,
    ).toBe(true);
    // blindfold: contract — settlement is a three-value enum.
    expect(TxReceiptSchema.safeParse({ ...base, settlement: "other" }).success).toBe(false);
  });

  it("masks a card number deterministically from the card id", () => {
    const a = maskCardNumber("crd_abc123");
    // blindfold: spec — same id always yields the same display number.
    expect(maskCardNumber("crd_abc123")).toBe(a);
    // blindfold: spec — shape is a fake Visa: 4021 + 12 masked digits + 4 hex-ish digits.
    expect(a).toMatch(/^4021 •••• •••• [0-9]{4}$/);
    // blindfold: spec — different cards must not share a display number.
    expect(maskCardNumber("crd_def456")).not.toBe(a);
  });

  it("builds a Stellar-safe receipt memo", () => {
    const memo = receiptMemo("chg_" + "a".repeat(64));
    // blindfold: spec — Stellar text memos are capped at 28 bytes.
    expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(28);
    // blindfold: spec — the memo prefix identifies TAB receipts.
    expect(memo.startsWith("TAB:")).toBe(true);
    // blindfold: spec — 28 bytes exactly: "TAB:" (4) + 24 hex chars.
    expect(Buffer.byteLength(memo, "utf8")).toBe(28);
  });

  it("never reports a negative remaining budget", () => {
    // blindfold: invariant — spent + reserved can exceed total only through a bug, but display clamps at 0.
    expect(remainingBudget(card({ budget: { total: "10", spent: "8", reserved: "5" } }))).toBe("0");
    // blindfold: math — 25 − 20 − 4 = 1.
    expect(remainingBudget(card({ budget: { total: "25", spent: "20", reserved: "4" } }))).toBe("1");
  });

  it("formats relative times in both directions", () => {
    // blindfold: spec — under 45s reads "just now".
    expect(formatRelativeTime("2026-11-14T11:59:50.000Z", NOW)).toBe("just now");
    // blindfold: spec — four minutes in the past reads "4m ago".
    expect(formatRelativeTime("2026-11-14T11:56:00.000Z", NOW)).toBe("4m ago");
    // blindfold: spec — 23 hours in the future reads "in 23h".
    expect(formatRelativeTime("2026-11-15T11:00:00.000Z", NOW)).toBe("in 23h");
  });

  it("truncates hashes only when there is something to cut", () => {
    // blindfold: spec — 6 leading and 4 trailing characters around an ellipsis.
    expect(truncateHash("abcdefghijklmno")).toBe("abcdef…lmno");
    // blindfold: spec — short ids are returned untouched.
    expect(truncateHash("abc")).toBe("abc");
  });

  it("labels card expiry from the remaining time", () => {
    // blindfold: spec — 23h remaining reads "Expires in 23h".
    expect(cardExpiryLabel("2026-11-15T11:00:00.000Z", NOW)).toBe("Expires in 23h");
    // blindfold: spec — 30 minutes remaining reads "Expires in 30m".
    expect(cardExpiryLabel("2026-11-14T12:30:00.000Z", NOW)).toBe("Expires in 30m");
    // blindfold: spec — the expiry instant itself is already expired.
    expect(cardExpiryLabel("2026-11-14T12:00:00.000Z", NOW)).toBe("Expired");
  });
});
