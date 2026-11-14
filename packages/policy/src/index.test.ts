import { describe, expect, it } from "vitest";
import type { Agent, Card } from "@tab/shared";
import { evaluateCharge, validateLimits } from "./index.js";

const now = new Date("2026-11-14T12:00:00.000Z");

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

const agent: Agent = {
  id: "agt_test",
  ownerId: "usr_test",
  name: "Scout",
  description: null,
  emoji: "🤖",
  status: "ACTIVE",
  keyPrefix: "tab_agent_ab",
  lastSeenAt: null,
  createdAt: "2026-11-14T00:00:00.000Z",
};

const base = { card: card(), agent, merchantId: "mch_exa", now, dailySpent: "0" };

describe("evaluateCharge", () => {
  it("auto-approves a small allowed charge", () => {
    const d = evaluateCharge({ ...base, amount: "2.50" });
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
    // blindfold: contract — PolicyCode.OK is the allowed/no-approval code.
    expect(d.code).toBe("OK");
  });

  it("requires approval above the auto-approve threshold", () => {
    const d = evaluateCharge({ ...base, amount: "4" });
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
    // blindfold: contract — PolicyCode.OK_APPROVAL_REQUIRED marks the soft threshold.
    expect(d.code).toBe("OK_APPROVAL_REQUIRED");
  });

  it("blocks a merchant outside the allowlist", () => {
    const d = evaluateCharge({ ...base, merchantId: "mch_openai", amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.MERCHANT_NOT_ALLOWED for off-allowlist merchants.
    expect(d.code).toBe("MERCHANT_NOT_ALLOWED");
  });

  it("blocks a charge above the per-charge cap", () => {
    const d = evaluateCharge({ ...base, amount: "6" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AMOUNT_ABOVE_PER_CHARGE for the one-charge cap.
    expect(d.code).toBe("AMOUNT_ABOVE_PER_CHARGE");
  });

  it("blocks when the daily limit would be exceeded", () => {
    const d = evaluateCharge({ ...base, amount: "4", dailySpent: "8" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AMOUNT_ABOVE_DAILY_LIMIT for the rolling cap.
    expect(d.code).toBe("AMOUNT_ABOVE_DAILY_LIMIT");
  });

  it("blocks a revoked card", () => {
    const d = evaluateCharge({ ...base, card: card({ status: "REVOKED" }), amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.CARD_REVOKED is the kill-switch failure.
    expect(d.code).toBe("CARD_REVOKED");
  });

  it("blocks when reserved budget consumes the remainder", () => {
    const d = evaluateCharge({ ...base, card: card({ budget: { total: "25", spent: "22", reserved: "2.5" } }), amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AMOUNT_ABOVE_BUDGET for lifetime budget.
    expect(d.code).toBe("AMOUNT_ABOVE_BUDGET");
  });

  it("blocks a revoked agent", () => {
    const d = evaluateCharge({ ...base, agent: { ...agent, status: "REVOKED" }, amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AGENT_REVOKED blocks the agent credential.
    expect(d.code).toBe("AGENT_REVOKED");
  });
});

describe("policy boundaries and card lifecycle", () => {
  it("allows a charge exactly at the per-charge cap", () => {
    // blindfold: contract — "a single charge is capped at 5" means 5 is allowed.
    const d = evaluateCharge({ ...base, amount: "5" });
    expect(d.allowed).toBe(true);
    // blindfold: contract — 5 is above the 3 auto-approve threshold.
    expect(d.code).toBe("OK_APPROVAL_REQUIRED");
    expect(d.requiresApproval).toBe(true);
  });

  it("does not require approval exactly at the auto-approve threshold", () => {
    // blindfold: contract — autoApproveUnder means *at or below* needs no approval.
    const d = evaluateCharge({ ...base, amount: "3" });
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(false);
    // blindfold: contract — exactly at autoApproveUnder is still PolicyCode.OK.
    expect(d.code).toBe("OK");
  });

  it("allows a charge that lands exactly on the daily limit", () => {
    // blindfold: math — 6 already spent + 4 = 10, which equals the daily cap.
    const d = evaluateCharge({ ...base, amount: "4", dailySpent: "6" });
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it("allows a charge that lands exactly on the remaining budget", () => {
    // blindfold: math — $25 total, $24 spent, $1 left: a $1 charge is affordable.
    const d = evaluateCharge({ ...base, card: card({ budget: { total: "25", spent: "24", reserved: "0" } }), amount: "1" });
    expect(d.allowed).toBe(true);
  });

  it("blocks a paused card", () => {
    const d = evaluateCharge({ ...base, card: card({ status: "PAUSED" }), amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.CARD_PAUSED blocks a paused card.
    expect(d.code).toBe("CARD_PAUSED");
  });

  it("blocks a card at its expiry instant", () => {
    // blindfold: contract — once the expiry time is reached the card is no longer usable.
    const d = evaluateCharge({ ...base, card: card({ expiresAt: "2026-11-14T12:00:00.000Z" }), amount: "1" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.CARD_EXPIRED at the expiry instant.
    expect(d.code).toBe("CARD_EXPIRED");
  });

  it("blocks an exhausted card before checking the amount", () => {
    // blindfold: math — spent 20 + reserved 5 = 25 of 25, so nothing remains.
    const d = evaluateCharge({
      ...base,
      card: card({ budget: { total: "25", spent: "20", reserved: "5" } }),
      amount: "1",
    });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.CARD_EXHAUSTED when remaining budget is zero.
    expect(d.code).toBe("CARD_EXHAUSTED");
  });

  it("rejects a zero amount", () => {
    const d = evaluateCharge({ ...base, amount: "0" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AMOUNT_INVALID for a zero amount.
    expect(d.code).toBe("AMOUNT_INVALID");
  });
});

describe("daily cap counts reservations", () => {
  it("blocks the second of two concurrent $6 charges against a $10 cap", () => {
    const wide = card({ limits: { perCharge: "6", daily: "10", autoApproveUnder: "3" } });

    // Charge A: nothing committed yet, so $6 of $10 fits.
    const first = evaluateCharge({ ...base, card: wide, amount: "6", dailyCommitted: "0" });
    expect(first.allowed).toBe(true);
    expect(first.requiresApproval).toBe(true);

    // Charge B arrives while A is reserved: 6 + 6 > 10, so it must fail.
    // blindfold: contract (LIMITS.md) — daily = settled + reserved, rolling 24h.
    const second = evaluateCharge({ ...base, card: wide, amount: "6", dailyCommitted: "6" });
    expect(second.allowed).toBe(false);
    // blindfold: contract — 6 committed + 6 requested > 10 daily.
    expect(second.code).toBe("AMOUNT_ABOVE_DAILY_LIMIT");
  });

  it("still accepts the legacy dailySpent field", () => {
    // blindfold: contract — dailySpent remains a compatibility alias for settled-only callers.
    const d = evaluateCharge({ ...base, amount: "4", dailySpent: "8" });
    expect(d.allowed).toBe(false);
    // blindfold: contract — PolicyCode.AMOUNT_ABOVE_DAILY_LIMIT for the rolling cap.
    expect(d.code).toBe("AMOUNT_ABOVE_DAILY_LIMIT");
  });
});

describe("validateLimits", () => {
  const valid = { perCharge: "5", daily: "10", total: "25", autoApproveUnder: "3" };

  it("accepts the demo ladder", () => {
    // blindfold: contract — 3 <= 5 <= 10 <= 25 is the seeded demo card.
    expect(validateLimits(valid)).toEqual({ ok: true, reason: null });
  });

  it("accepts every exact boundary (<=)", () => {
    // blindfold: contract — the ladder comparison is inclusive at each rung.
    expect(validateLimits({ perCharge: "10", daily: "10", total: "10", autoApproveUnder: "10" })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it("rejects one unit over the auto-approve rung", () => {
    // blindfold: contract — autoApproveUnder must not exceed perCharge; one 7dp unit over is invalid.
    const result = validateLimits({ ...valid, autoApproveUnder: "5.0000001" });
    expect(result.ok).toBe(false);
    // blindfold: contract — the ladder's first rung message.
    expect(result.reason).toBe("autoApproveUnder must be at or below perCharge.");
  });

  it("rejects perCharge above daily", () => {
    // blindfold: contract — a per-charge cap above the daily cap can never bind.
    const result = validateLimits({ ...valid, perCharge: "11" });
    expect(result.ok).toBe(false);
    // blindfold: contract — the ladder's second rung message.
    expect(result.reason).toBe("perCharge must be at or below daily.");
  });

  it("rejects daily above the total budget", () => {
    // blindfold: contract — daily must fit inside the lifetime budget.
    const result = validateLimits({ ...valid, daily: "26" });
    expect(result.ok).toBe(false);
    // blindfold: contract — the ladder's third rung message.
    expect(result.reason).toBe("daily must be at or below total.");
  });

  it("rejects zero and sub-cent precision", () => {
    // blindfold: contract — all four values must be > 0.
    expect(validateLimits({ ...valid, autoApproveUnder: "0" }).ok).toBe(false);
    // blindfold: contract — money is capped at 7 decimal places.
    expect(validateLimits({ ...valid, perCharge: "5.00000001" }).ok).toBe(false);
  });
});
