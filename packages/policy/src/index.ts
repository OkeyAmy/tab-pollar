/**
 * @tab/policy — the spending policy engine.
 *
 * Pure, deterministic, no I/O. This is the code that decides whether an AI
 * agent may spend a human's money. Every rule is a named check so the UI can
 * show *why* a charge was approved or declined.
 */
import {
  MoneySchema,
  cmpMoney,
  isPositive,
  remainingBudget,
  toUnits,
  type Agent,
  type Card,
  type Money,
  type PolicyCheck,
  type PolicyCode,
  type PolicyDecision,
} from "@tab/shared";

export interface PolicyInput {
  card: Card;
  agent: Agent;
  merchantId: string;
  amount: Money;
  /**
   * Settled + reserved in the rolling 24h window (caller supplies). Preferred:
   * reservations count against the daily cap, so two concurrent charges cannot
   * both pass it.
   */
  dailyCommitted?: Money;
  /**
   * Legacy settled-only figure. Still accepted so existing callers keep
   * working; `dailyCommitted` wins when both are present.
   * @deprecated pass `dailyCommitted`.
   */
  dailySpent?: Money;
  now?: Date;
}

export interface LimitsInput {
  perCharge: Money;
  daily: Money;
  total: Money;
  autoApproveUnder: Money;
}

export interface LimitsValidation {
  ok: boolean;
  reason: string | null;
}

/**
 * Pure creation-time check for the spending ladder:
 * `autoApproveUnder <= perCharge <= daily <= total`, all > 0, all ≤ 7dp.
 * Export name is stable; the API calls this before creating a card.
 */
export function validateLimits(input: LimitsInput): LimitsValidation {
  const fields: Array<[keyof LimitsInput, string, Money]> = [
    ["autoApproveUnder", "autoApproveUnder", input.autoApproveUnder],
    ["perCharge", "perCharge", input.perCharge],
    ["daily", "daily", input.daily],
    ["total", "total", input.total],
  ];

  for (const [, label, value] of fields) {
    const parsed = MoneySchema.safeParse(String(value).trim());
    if (!parsed.success) {
      return { ok: false, reason: `${label} must be a decimal string with at most 7 decimal places.` };
    }
    if (parsed.data === "0" || !isPositive(parsed.data)) {
      return { ok: false, reason: `${label} must be greater than zero.` };
    }
  }

  if (cmpMoney(input.autoApproveUnder, input.perCharge) > 0) {
    return { ok: false, reason: "autoApproveUnder must be at or below perCharge." };
  }
  if (cmpMoney(input.perCharge, input.daily) > 0) {
    return { ok: false, reason: "perCharge must be at or below daily." };
  }
  if (cmpMoney(input.daily, input.total) > 0) {
    return { ok: false, reason: "daily must be at or below total." };
  }

  return { ok: true, reason: null };
}

const CHECKS: Array<{ code: PolicyCode; ok: boolean; detail?: string }> = [];

export function evaluateCharge(input: PolicyInput): PolicyDecision {
  const { card, agent, merchantId, amount } = input;
  const now = input.now ?? new Date();
  const dailyCommitted = input.dailyCommitted ?? input.dailySpent ?? "0";
  const checks: PolicyCheck[] = [];
  const add = (code: PolicyCode, ok: boolean, detail?: string) => {
    checks.push({ code, ok, detail });
    return ok;
  };

  const fail = (code: PolicyCode, message: string): PolicyDecision => ({
    allowed: false,
    requiresApproval: false,
    code,
    message,
    checks,
  });

  // 1. Amount shape.
  if (!add("AMOUNT_INVALID", isPositive(amount), amount === "0" ? "amount must be greater than zero" : undefined)) {
    return fail("AMOUNT_INVALID", "Amount must be a positive decimal.");
  }

  // 2. Card lifecycle.
  if (!add("CARD_REVOKED", card.status !== "REVOKED", card.status)) return fail("CARD_REVOKED", "This card was revoked.");
  if (!add("CARD_PAUSED", card.status !== "PAUSED", card.status)) return fail("CARD_PAUSED", "This card is paused.");
  if (!add("CARD_EXPIRED", new Date(card.expiresAt).getTime() > now.getTime(), card.expiresAt)) {
    return fail("CARD_EXPIRED", "This card has expired.");
  }
  if (!add("CARD_EXHAUSTED", toUnits(remainingBudget(card)) > 0n, card.budget.total)) {
    return fail("CARD_EXHAUSTED", "This card has no budget left.");
  }

  // 3. Agent lifecycle.
  if (!add("AGENT_REVOKED", agent.status !== "REVOKED", agent.status)) return fail("AGENT_REVOKED", "This agent was revoked.");
  if (!add("AGENT_PAUSED", agent.status !== "PAUSED", agent.status)) return fail("AGENT_PAUSED", "This agent is paused.");

  // 4. Merchant allowlist.
  if (!add("MERCHANT_NOT_ALLOWED", card.merchants.includes(merchantId), merchantId)) {
    return fail("MERCHANT_NOT_ALLOWED", `This card cannot pay ${merchantId}.`);
  }

  // 5. Per-charge cap.
  if (!add("AMOUNT_ABOVE_PER_CHARGE", cmpMoney(amount, card.limits.perCharge) <= 0, card.limits.perCharge)) {
    return fail("AMOUNT_ABOVE_PER_CHARGE", `A single charge is capped at ${card.limits.perCharge}.`);
  }

  // 6. Rolling daily cap: settled + reserved, so concurrent charges cannot both pass.
  const dailyTotal = toUnits(dailyCommitted) + toUnits(amount);
  if (!add("AMOUNT_ABOVE_DAILY_LIMIT", dailyTotal <= toUnits(card.limits.daily), card.limits.daily)) {
    return fail("AMOUNT_ABOVE_DAILY_LIMIT", `This would exceed the ${card.limits.daily} daily limit.`);
  }

  // 7. Remaining budget (spent + reserved already reflected in remainingBudget).
  if (!add("AMOUNT_ABOVE_BUDGET", cmpMoney(amount, remainingBudget(card)) <= 0, remainingBudget(card))) {
    return fail("AMOUNT_ABOVE_BUDGET", "This would exceed the card's remaining budget.");
  }

  const requiresApproval = cmpMoney(amount, card.limits.autoApproveUnder) > 0;
  add("OK", true);

  return {
    allowed: true,
    requiresApproval,
    code: requiresApproval ? "OK_APPROVAL_REQUIRED" : "OK",
    message: requiresApproval
      ? `Within limits, but above the ${card.limits.autoApproveUnder} auto-approve threshold.`
      : "Within limits.",
    checks,
  };
}

/**
 * A token can be issued ahead of a purchase only if the *maximum* amount is
 * already allowed. The final charge re-runs the full policy.
 */
export function evaluateTokenRequest(input: PolicyInput): PolicyDecision {
  return evaluateCharge(input);
}

export function describeDecision(d: PolicyDecision): string {
  if (!d.allowed) return d.message;
  return d.requiresApproval ? "Needs your approval" : "Approved";
}

/** Kept for the frozen `CHECKS` export contract; do not use in new code. */
export { CHECKS };
