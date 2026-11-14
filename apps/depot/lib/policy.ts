import type { ChargeStatus, PolicyCode } from "@tab/shared";

export type Tone = "good" | "approval" | "stop" | "neutral";

type PolicyEntry = { sentence: string; tone: Tone };

/**
 * Human sentences for every policy code in `@tab/shared`. The Record is
 * exhaustive on purpose: adding a code without copy is a type error.
 */
const POLICY_COPY: Record<PolicyCode, PolicyEntry> = {
  OK: {
    sentence: "Within the tab's limits. No approval needed.",
    tone: "good",
  },
  OK_APPROVAL_REQUIRED: {
    sentence: "Above the auto-approve line. The human has to tap.",
    tone: "approval",
  },
  CARD_NOT_FOUND: {
    sentence: "That tab no longer exists.",
    tone: "stop",
  },
  CARD_REVOKED: {
    sentence: "The tab has been revoked. Nothing can be charged.",
    tone: "stop",
  },
  CARD_PAUSED: {
    sentence: "The tab is paused.",
    tone: "stop",
  },
  CARD_EXPIRED: {
    sentence: "The tab expired.",
    tone: "stop",
  },
  CARD_EXHAUSTED: {
    sentence: "The tab is spent.",
    tone: "stop",
  },
  AGENT_REVOKED: {
    sentence: "The agent's key was revoked.",
    tone: "stop",
  },
  AGENT_PAUSED: {
    sentence: "The agent is paused.",
    tone: "stop",
  },
  AMOUNT_INVALID: {
    sentence: "That amount is not a valid figure.",
    tone: "stop",
  },
  AMOUNT_ABOVE_PER_CHARGE: {
    sentence: "More than this tab allows for a single charge.",
    tone: "stop",
  },
  AMOUNT_ABOVE_DAILY_LIMIT: {
    sentence: "That would push today's spending over the daily limit.",
    tone: "stop",
  },
  AMOUNT_ABOVE_BUDGET: {
    sentence: "There is not enough left on the tab.",
    tone: "stop",
  },
  MERCHANT_NOT_ALLOWED: {
    sentence: "Agent Depot is not on this tab's merchant list.",
    tone: "stop",
  },
  TOKEN_INVALID: {
    sentence: "That is not a live tab token.",
    tone: "stop",
  },
  TOKEN_EXPIRED: {
    sentence: "The token expired. Tokens last five minutes.",
    tone: "stop",
  },
  TOKEN_ALREADY_USED: {
    sentence: "That token has already been redeemed. Tokens are single use.",
    tone: "stop",
  },
  TOKEN_MERCHANT_MISMATCH: {
    sentence: "That token was issued for a different merchant.",
    tone: "stop",
  },
  TOKEN_AMOUNT_EXCEEDED: {
    sentence: "The charge is larger than the token allows.",
    tone: "stop",
  },
  ASSET_MISMATCH: {
    sentence: "The tab is set to settle in a different asset.",
    tone: "stop",
  },
  SIGNER_OFFLINE: {
    sentence: "The human's wallet is not connected.",
    tone: "stop",
  },
  INSUFFICIENT_BALANCE: {
    sentence: "The human's wallet does not have the balance.",
    tone: "stop",
  },
  SETTLEMENT_ERROR: {
    sentence: "The payment failed at settlement.",
    tone: "stop",
  },
};

export function isPolicyCode(code: string): code is PolicyCode {
  return Object.prototype.hasOwnProperty.call(POLICY_COPY, code);
}

export function policySentence(code: string): string | null {
  return isPolicyCode(code) ? POLICY_COPY[code].sentence : null;
}

export function policyTone(code: string): Tone {
  return isPolicyCode(code) ? POLICY_COPY[code].tone : "stop";
}

export function decisionChipClass(tone: Tone): string {
  switch (tone) {
    case "good":
      return "border border-ink bg-acid text-ink";
    case "approval":
      return "border border-ink bg-paper text-ink";
    case "stop":
      return "border border-signal bg-paper text-ink";
    default:
      return "border border-line bg-paper text-muted";
  }
}

type StatusEntry = {
  label: string;
  sentence: string;
  tone: Tone;
};

const STATUS_COPY: Record<ChargeStatus, StatusEntry> = {
  AWAITING_APPROVAL: {
    label: "Awaiting the human",
    sentence: "The human has to approve this.",
    tone: "approval",
  },
  QUEUED: {
    label: "Queued for the wallet",
    sentence: "The tab cleared. The human's wallet is next.",
    tone: "neutral",
  },
  SIGNING: {
    label: "Signing",
    sentence: "The wallet is signing the payment.",
    tone: "neutral",
  },
  SETTLED: {
    label: "Paid",
    sentence: "The payment settled.",
    tone: "good",
  },
  DECLINED: {
    label: "Declined",
    sentence: "The human said no.",
    tone: "stop",
  },
  FAILED: {
    label: "Failed",
    sentence: "Settlement failed.",
    tone: "stop",
  },
  EXPIRED: {
    label: "Expired",
    sentence: "The charge expired before it settled.",
    tone: "stop",
  },
};

export function statusCopy(status: string): StatusEntry {
  return Object.prototype.hasOwnProperty.call(STATUS_COPY, status)
    ? STATUS_COPY[status as ChargeStatus]
    : { label: status, sentence: "The charge is in an unknown state.", tone: "neutral" };
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "SETTLED",
  "DECLINED",
  "FAILED",
  "EXPIRED",
]);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** A network or 5xx failure is worth retrying with the same idempotency key. */
export function isRetryable(code: string, httpStatus: number): boolean {
  if (httpStatus >= 500) return true;
  return (
    code === "NETWORK" ||
    code === "TIMEOUT" ||
    code === "SIGNER_OFFLINE" ||
    code === "SETTLEMENT_ERROR" ||
    code === "BAD_RESPONSE" ||
    code === "HTTP_429"
  );
}

/** Codes that mean the token itself is dead. Editing the slip should clear it. */
export function clearsToken(code: string): boolean {
  return (
    code === "TOKEN_INVALID" ||
    code === "TOKEN_EXPIRED" ||
    code === "TOKEN_ALREADY_USED" ||
    code === "UNAUTHORIZED"
  );
}
