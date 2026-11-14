"use client";

import type { Agent, Charge } from "@tab/shared";
import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { isTokenError, useTab } from "@/components/tab-store";
import { ApiError } from "@/lib/api";
import {
  chargeStatusLabel,
  decisionSentence,
  decisionTone,
  isPendingCharge,
  isUnverified,
  onchainAmount,
  relativeTime,
  shortHash,
  usd,
} from "@/lib/format";

export function DecisionChip({ charge }: { charge: Charge }) {
  const tone = decisionTone(charge.decision?.code ?? "OK");
  const label =
    tone === "ok" ? "OK" : tone === "attention" ? "Above line" : "Blocked";
  const className = tone === "ok" ? "chip chip-ok" : tone === "attention" ? "chip chip-ink" : "chip chip-red";
  return (
    <span className={className} title={`${charge.decision?.code}: ${decisionSentence(charge)}`}>
      {label}
    </span>
  );
}

export function StatusChip({ charge }: { charge: Charge }) {
  switch (charge.status) {
    case "SETTLED":
      return (
        <span className="chip chip-ok">
          <span className="dot" aria-hidden="true" />
          Settled
        </span>
      );
    case "QUEUED":
    case "SIGNING":
      return (
        <span className="chip chip-ink">
          <span className="dot dot-pulse" aria-hidden="true" />
          {chargeStatusLabel(charge.status)}
        </span>
      );
    case "AWAITING_APPROVAL":
      return (
        <span className="chip chip-ink">
          <span className="dot dot-pulse" aria-hidden="true" />
          Needs you
        </span>
      );
    case "DECLINED":
    case "FAILED":
    case "EXPIRED":
      return (
        <span className="chip chip-red">
          <span className="dot dot-red" aria-hidden="true" />
          {chargeStatusLabel(charge.status)}
        </span>
      );
    default:
      return <span className="chip chip-quiet">{charge.status}</span>;
  }
}

export function UnverifiedChip() {
  return (
    <span
      className="chip chip-red"
      title="The API has not verified this transaction on-chain. Treat the hash as a claim, not proof."
    >
      Unverified
    </span>
  );
}

/* ── one row ─────────────────────────────────────────────────────────────── */

export function ChargeRow({
  charge,
  index = 0,
  agent,
  onOpenReceipt,
}: {
  charge: Charge;
  index?: number;
  agent?: Agent | null;
  onOpenReceipt?: (charge: Charge) => void;
}) {
  const unverified = isUnverified(charge);
  const receipt = charge.receipt;

  return (
    <div className="charge-row" style={{ "--i": index } as CSSProperties}>
      <div className="charge-merchant">
        <b>{charge.merchantName || charge.merchantId}</b>
        <span title={charge.description}>
          {charge.description}
          {agent ? ` · ${agent.name}` : ""}
        </span>
      </div>

      <div className="charge-amount">
        {usd(charge.amount)}
        {receipt ? (
          <div className="mono" style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 0 }}>
            {onchainAmount(receipt.amount, receipt.asset)}
          </div>
        ) : null}
      </div>

      <div className="charge-decision">
        <DecisionChip charge={charge} />
        <span title={decisionSentence(charge)}>{decisionSentence(charge)}</span>
      </div>

      <div className="charge-status" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
        <StatusChip charge={charge} />
        {unverified ? <UnverifiedChip /> : null}
      </div>

      <div className="charge-time">
        <div>{relativeTime(charge.updatedAt || charge.createdAt)}</div>
        {receipt && onOpenReceipt ? (
          <button
            className="charge-hash"
            style={{ border: 0, background: "none", padding: 0, cursor: "pointer" }}
            onClick={() => onOpenReceipt(charge)}
            title={`Open receipt · ${receipt.hash}`}
          >
            {shortHash(receipt.hash, 4, 4)} ↗
          </button>
        ) : (
          <div className="mono" style={{ fontSize: 9 }}>
            {charge.status === "QUEUED" ? "waiting" : "—"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the list, with honest states ────────────────────────────────────────── */

export function ChargesTable({
  charges,
  agents,
  onOpenReceipt,
  emptyTitle = "No purchases yet.",
  emptyBody = "Use Try it as the agent above — no key needed — or let Claude/MCP ask for a charge. Every decision lands here with a named reason.",
}: {
  charges: Charge[];
  agents: Agent[];
  onOpenReceipt?: (charge: Charge) => void;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (charges.length === 0) {
    return (
      <div className="charges">
        <div className="charges-head" aria-hidden="true">
          <span>Merchant</span>
          <span style={{ textAlign: "right" }}>Amount</span>
          <span>Why</span>
          <span>Status</span>
          <span style={{ textAlign: "right" }}>Time</span>
        </div>
        <div className="empty" style={{ border: 0 }}>
          <h3>{emptyTitle}</h3>
          <p>{emptyBody}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="charges">
      <div className="charges-head" aria-hidden="true">
        <span>Merchant</span>
        <span style={{ textAlign: "right" }}>Amount</span>
        <span>Why</span>
        <span>Status</span>
        <span style={{ textAlign: "right" }}>Time</span>
      </div>
      {charges.map((charge, index) => (
        <ChargeRow
          key={charge.id}
          charge={charge}
          index={index}
          agent={agents.find((agent) => agent.id === charge.agentId) ?? null}
          onOpenReceipt={onOpenReceipt}
        />
      ))}
    </div>
  );
}

/* ── approvals ───────────────────────────────────────────────────────────── */

export function ApprovalPanel({
  charges,
  agents,
  approveUnder,
  onOpenReceipt,
}: {
  charges: Charge[];
  agents: Agent[];
  approveUnder: string;
  onOpenReceipt?: (charge: Charge) => void;
}) {
  const { approve, decline, signOut } = useTab();
  const router = useRouter();
  const [busy, setBusy] = useState<Record<string, "approve" | "decline" | undefined>>({});
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const awaiting = charges.filter((charge) => charge.status === "AWAITING_APPROVAL");
  if (awaiting.length === 0) return null;

  const run = async (charge: Charge, action: "approve" | "decline") => {
    setBusy((current) => ({ ...current, [charge.id]: action }));
    setNeedsSignIn(false);
    try {
      if (action === "approve") await approve(charge.id);
      else await decline(charge.id);
    } catch (error) {
      if (error instanceof ApiError && isTokenError(error.code)) {
        setNeedsSignIn(true);
      }
      // The store already surfaced every other error sentence in a toast.
    } finally {
      setBusy((current) => ({ ...current, [charge.id]: undefined }));
    }
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {needsSignIn ? (
        <div className="error-box" role="alert">
          <div style={{ display: "grid", gap: 4 }}>
            <span className="code">POLLAR_TOKEN_EXPIRED</span>
            <p>
              Sign in again to approve. The API needs a fresh Pollar token in addition to the
              session cookie, and this tab no longer has one.
            </p>
          </div>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await signOut();
              router.replace("/");
            }}
          >
            Sign in again
          </button>
        </div>
      ) : null}
      {awaiting.map((charge) => {
        const agent = agents.find((item) => item.id === charge.agentId);
        const isBusy = Boolean(busy[charge.id]);
        return (
          <section className="approval" key={charge.id} aria-label="Charge waiting for approval">
            <header className="approval-head">
              <span className="micro">Needs your approval</span>
              <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                {relativeTime(charge.createdAt)}
              </span>
            </header>
            <div className="approval-body">
              <div className="approval-what">
                <b>
                  {agent?.name ?? "Your agent"} asks {usd(charge.amount)} at{" "}
                  {charge.merchantName || charge.merchantId}
                </b>
                <span className="why">
                  Above your {usd(approveUnder)} approval line. Approving lets your wallet pay; you
                  still confirm the payment itself.
                </span>
              </div>
              <div className="approval-amount mono">{usd(charge.amount)}</div>
              <div className="approval-actions">
                {onOpenReceipt ? (
                  <button
                    className="btn btn-sm btn-quiet"
                    onClick={() => onOpenReceipt(charge)}
                    disabled={isBusy}
                  >
                    Details
                  </button>
                ) : null}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void run(charge, "decline")}
                  disabled={isBusy}
                  aria-busy={busy[charge.id] === "decline"}
                >
                  Decline
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void run(charge, "approve")}
                  disabled={isBusy}
                  aria-busy={busy[charge.id] === "approve"}
                >
                  {busy[charge.id] === "approve" ? "Approving…" : "Approve"}
                </button>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ── compact counters used by the dashboard header ───────────────────────── */

export function PendingCount({ charges }: { charges: Charge[] }) {
  const pending = charges.filter(isPendingCharge).length;
  if (pending === 0) return null;
  return (
    <span className="chip chip-ink">
      <span className="dot dot-pulse" aria-hidden="true" />
      {pending} in flight
    </span>
  );
}
