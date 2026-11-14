import {
  cmpMoney,
  formatUsd,
  fromUnits,
  toUnits,
  type Card,
  type Charge,
  type LedgerEvent,
  type Money,
  type PolicyCode,
} from "@tab/shared";

/** Display-only USD. Money math never goes through this helper. */
export function usd(amount: Money | string): string {
  return formatUsd(amount);
}

/** Compact USD for tight card surfaces: $25 not $25.00. */
export function compactUsd(amount: Money | string): string {
  return formatUsd(amount).replace(/\.00$/, "");
}

/**
 * Rolling 24h committed amount for a card: settled + reserved, per LIMITS.md.
 * Sums with bigint units, never floats.
 */
export function dailyCommitted(charges: Charge[], cardId: string, now = Date.now()): Money {
  const cutoff = now - 24 * 60 * 60 * 1000;
  let total = 0n;
  for (const charge of charges) {
    if (charge.cardId !== cardId) continue;
    if (
      charge.status !== "SETTLED" &&
      charge.status !== "QUEUED" &&
      charge.status !== "SIGNING" &&
      charge.status !== "AWAITING_APPROVAL"
    ) {
      continue;
    }
    const created = new Date(charge.createdAt).getTime();
    if (!Number.isFinite(created) || created < cutoff) continue;
    total += toUnits(charge.amount);
  }
  return fromUnits(total);
}

/** A receipt amount is on-chain, not USD: keep the asset explicit. */
export function onchainAmount(amount: Money | string, asset: string): string {
  const [whole, frac = ""] = String(amount).split(".");
  const shown = frac ? `${whole}.${frac.slice(0, asset === "XLM" ? 7 : 6)}` : whole;
  return `${shown} ${asset}`;
}

export function shortHash(hash: string, lead = 8, tail = 6): string {
  if (hash.length <= lead + tail + 1) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) return "Today";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function expiryLabel(iso: string): string {
  return new Date(iso)
    .toLocaleDateString("en-GB", { month: "2-digit", year: "2-digit" })
    .replace("/", "/");
}

export function expiryWords(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function budgetLeft(card: Card): Money {
  const left =
    toUnits(card.budget.total) - toUnits(card.budget.spent) - toUnits(card.budget.reserved);
  return fromUnits(left > 0n ? left : 0n);
}

export function budgetUsedPct(card: Card): number {
  const total = toUnits(card.budget.total);
  if (total <= 0n) return 0;
  const used = toUnits(card.budget.spent) + toUnits(card.budget.reserved);
  return Math.min(100, Math.max(0, Number((used * 1000n) / total) / 10));
}

/** autoApproveUnder <= perCharge <= daily <= budget, per LIMITS.md. */
export function limitLadder(card: Card): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const per = card.limits.perCharge;
  const daily = card.limits.daily;
  const total = card.budget.total;
  const auto = card.limits.autoApproveUnder;
  if (cmpMoney(per, daily) > 0) warnings.push("Max per charge is above the daily cap, so it can never bind.");
  if (cmpMoney(auto, per) > 0) warnings.push("The approval line is above the per-charge cap, so it can never bind.");
  if (cmpMoney(daily, total) > 0) warnings.push("The daily cap is above the tab budget, so it can never bind.");
  return { ok: warnings.length === 0, warnings };
}

export type ChargeLike = Charge & { onchainVerified?: boolean | null };

/**
 * The API records verification on the receipt (`receipt.onchainVerified`).
 * A top-level flag is accepted too, for forward compatibility.
 */
export function receiptVerified(charge: ChargeLike): boolean | null {
  const receipt = charge.receipt as
    | (NonNullable<Charge["receipt"]> & { onchainVerified?: boolean | null })
    | null;
  const value = receipt?.onchainVerified ?? charge.onchainVerified;
  return typeof value === "boolean" ? value : null;
}

export function isUnverified(charge: ChargeLike): boolean {
  return receiptVerified(charge) === false;
}

export function isVerified(charge: ChargeLike): boolean {
  return receiptVerified(charge) === true;
}

export function verificationWord(charge: ChargeLike): "verified" | "unverified" | "unchecked" {
  const value = receiptVerified(charge);
  if (value === true) return "verified";
  if (value === false) return "unverified";
  return "unchecked";
}

export function chargeStatusLabel(status: Charge["status"]): string {
  switch (status) {
    case "AWAITING_APPROVAL":
      return "Needs you";
    case "QUEUED":
      return "Queued";
    case "SIGNING":
      return "Signing";
    case "SETTLED":
      return "Settled";
    case "DECLINED":
      return "Declined";
    case "FAILED":
      return "Failed";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

/**
 * The one-sentence reason a human reads. The server writes `decision.message`;
 * use it when present, otherwise fall back to a stable local sentence.
 */
export function decisionSentence(charge: Charge): string {
  const message = charge.decision?.message?.trim();
  if (message) return message;
  return codeSentence(charge.decision?.code ?? "OK");
}

export function codeSentence(code: PolicyCode): string {
  switch (code) {
    case "OK":
      return "Within limits.";
    case "OK_APPROVAL_REQUIRED":
      return "Above the approval line. Waiting for you.";
    case "CARD_NOT_FOUND":
      return "That card does not exist.";
    case "CARD_REVOKED":
      return "This card is revoked.";
    case "CARD_PAUSED":
      return "This card is paused.";
    case "CARD_EXPIRED":
      return "This card expired.";
    case "CARD_EXHAUSTED":
      return "This card's budget is used up.";
    case "AGENT_REVOKED":
      return "This agent is revoked.";
    case "AGENT_PAUSED":
      return "This agent is paused.";
    case "AMOUNT_INVALID":
      return "The amount is not a valid decimal.";
    case "AMOUNT_ABOVE_PER_CHARGE":
      return "Above the max per charge.";
    case "AMOUNT_ABOVE_DAILY_LIMIT":
      return "Above today's cap.";
    case "AMOUNT_ABOVE_BUDGET":
      return "Above what is left on the tab.";
    case "MERCHANT_NOT_ALLOWED":
      return "This merchant is not on the card.";
    case "TOKEN_INVALID":
      return "The charge token is not valid.";
    case "TOKEN_EXPIRED":
      return "The charge token expired.";
    case "TOKEN_ALREADY_USED":
      return "The charge token was already used.";
    case "TOKEN_MERCHANT_MISMATCH":
      return "The token is bound to another merchant.";
    case "TOKEN_AMOUNT_EXCEEDED":
      return "The token's cap is lower than this charge.";
    case "ASSET_MISMATCH":
      return "The settlement asset does not match the card.";
    case "SIGNER_OFFLINE":
      return "The signer is offline. Open the console.";
    case "INSUFFICIENT_BALANCE":
      return "The wallet balance is too low.";
    case "SETTLEMENT_ERROR":
      return "Settlement failed.";
    default:
      return String(code).replaceAll("_", " ").toLowerCase();
  }
}

export function decisionTone(code: PolicyCode): "ok" | "attention" | "blocked" {
  if (code === "OK") return "ok";
  if (code === "OK_APPROVAL_REQUIRED") return "attention";
  return "blocked";
}

export function ledgerTone(type: LedgerEvent["type"]): string {
  if (type === "CHARGE_FAILED" || type === "CARD_REVOKED" || type === "CHARGE_DECLINED") {
    return "red";
  }
  return "";
}

export function isPendingCharge(charge: Charge): boolean {
  return (
    charge.status === "AWAITING_APPROVAL" ||
    charge.status === "QUEUED" ||
    charge.status === "SIGNING"
  );
}
