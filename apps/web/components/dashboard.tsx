"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Card } from "@tab/shared";
import { useTab } from "@/components/tab-store";
import { useConsoleUI } from "@/components/console-ui";
import { AgentDemoPanel, StartHereStrip } from "@/components/agent-demo";
import { BudgetMeter, PhysicalCard, PolicyGate } from "@/components/card";
import { ApprovalPanel, ChargesTable, PendingCount } from "@/components/charges";
import { Dialog, EmptyState, ErrorBox, SignatureBadge, SkeletonRows } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { budgetLeft, relativeTime, usd } from "@/lib/format";

function headFor(card: Card | null, agentName: string | null) {
  if (!card) return "Open your first tab";
  return agentName ? `${agentName}'s card` : card.label;
}

function statusWord(status: Card["status"]): string {
  switch (status) {
    case "ACTIVE":
      return "Open";
    case "PAUSED":
      return "Paused";
    case "REVOKED":
      return "Revoked";
    case "EXPIRED":
      return "Expired";
    case "EXHAUSTED":
      return "Spent";
    default:
      return status;
  }
}

export function Dashboard({ focusChargeId }: { focusChargeId?: string | null }) {
  const {
    loading,
    dataError,
    agents,
    cards,
    charges,
    selectedCardId,
    selectCard,
    signatureGate,
    refresh,
    pauseCard,
    resumeCard,
    revokeCard,
    toast,
  } = useTab();
  const { openTab, openReceipt } = useConsoleUI();
  const router = useRouter();

  const card = cards.find((item) => item.id === selectedCardId) ?? cards[0] ?? null;
  const agent = card ? agents.find((item) => item.id === card.agentId) ?? null : null;

  const cardCharges = useMemo(() => {
    if (!card) return [];
    return charges
      .filter((charge) => charge.cardId === card.id)
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [charges, card]);

  const deepCharge = focusChargeId ? charges.find((charge) => charge.id === focusChargeId) : null;

  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<{ code: string; message: string } | null>(null);
  const [actionBusy, setActionBusy] = useState<"pause" | "resume" | null>(null);

  /* deep link: /app?charge=chg_… selects the card and opens the drawer */
  useEffect(() => {
    if (!deepCharge) return;
    selectCard(deepCharge.cardId);
    openReceipt(deepCharge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepCharge?.id]);

  const togglePause = async () => {
    if (!card) return;
    const action = card.status === "PAUSED" ? "resume" : "pause";
    setActionBusy(action);
    try {
      if (action === "pause") await pauseCard(card.id);
      else await resumeCard(card.id);
    } catch (error) {
      const err =
        error instanceof ApiError
          ? { code: error.code, message: error.sentence }
          : { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unknown error." };
      toast(`${err.code}: ${err.message}`, "error");
    } finally {
      setActionBusy(null);
    }
  };

  const confirmRevoke = async () => {
    if (!card) return;
    setRevokeBusy(true);
    setRevokeError(null);
    try {
      await revokeCard(card.id);
      setRevokeOpen(false);
    } catch (error) {
      setRevokeError(
        error instanceof ApiError
          ? { code: error.code, message: error.sentence }
          : { code: "UNEXPECTED", message: error instanceof Error ? error.message : "Unknown error." },
      );
    } finally {
      setRevokeBusy(false);
    }
  };

  const pending = cardCharges.filter((charge) => charge.status === "AWAITING_APPROVAL");

  return (
    <>
      <header className="main-head">
        <div>
          <h1>{headFor(card, agent?.name ?? null)}</h1>
          <div className="sub">
            {card ? (
              <span>
                {agent ? `${agent.name} can spend ` : "This card can spend "}
                <span className="mono">{usd(budgetLeft(card))}</span> of{" "}
                <span className="mono">{usd(card.budget.total)}</span>.{" "}
                <span className="mono">{usd(card.limits.autoApproveUnder)}</span> needs your tap.
              </span>
            ) : (
              <span>Create an agent, give it a budget, then try a purchase.</span>
            )}
            {card ? (
              <>
                <span className="mono" style={{ fontSize: 10 }}>
                  {statusWord(card.status)} · Stellar testnet · pays in {card.asset}
                </span>
              </>
            ) : null}
            {pending.length > 0 ? <PendingCount charges={cardCharges} /> : null}
          </div>
        </div>
        <div className="main-head-actions">
          {card ? (
            <>
              <SignatureBadge compact />
              <button
                className="btn btn-sm btn-quiet"
                onClick={() => void togglePause()}
                disabled={
                  actionBusy !== null ||
                  (card.status !== "ACTIVE" && card.status !== "PAUSED")
                }
                aria-busy={actionBusy !== null}
              >
                {actionBusy === "pause"
                  ? "Pausing…"
                  : actionBusy === "resume"
                    ? "Resuming…"
                    : card.status === "PAUSED"
                      ? "Resume"
                      : "Pause"}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setRevokeError(null);
                  setRevokeOpen(true);
                }}
                disabled={card.status === "REVOKED"}
              >
                Revoke
              </button>
            </>
          ) : null}
          <button className="btn btn-sm btn-primary" onClick={() => openTab(agent?.id ?? null)}>
            New tab
          </button>
        </div>
      </header>

      <div className="main-body">
        {dataError ? <ErrorBox error={dataError} onRetry={() => void refresh()} /> : null}

        {focusChargeId && !loading && !deepCharge ? (
          <div className="error-box" role="alert">
            <div style={{ display: "grid", gap: 4 }}>
              <span className="code">CHARGE_NOT_FOUND</span>
              <p>
                No charge <span className="mono">{focusChargeId}</span> on this account. The link may
                be from another session, or the demo data was reset.
              </p>
            </div>
            <button className="btn btn-sm" onClick={() => router.replace("/app")}>
              Back to overview
            </button>
          </div>
        ) : null}

        {loading && cards.length === 0 ? (
          <div className="charges">
            <div className="sk-row">
              <div className="skeleton sk-line" style={{ width: 220, height: 150 }} />
              <div className="skeleton sk-line" style={{ width: 260, height: 150 }} />
              <div className="skeleton sk-line" style={{ width: 200, height: 150 }} />
            </div>
          </div>
        ) : !card ? (
          <>
            <StartHereStrip hasAgent={agents.length > 0} hasCard={false} />
            <EmptyState
              title={agents.length === 0 ? "Create an agent first." : "Open your first tab."}
              body={
                agents.length === 0
                  ? "An agent gets a key that can only ask for charges. It never sees your wallet. Create one, then open a tab."
                  : "A tab is a budget with a store list. Pick $25, $5 per purchase, approval above $3, and Scout can buy research without ever holding your card."
              }
            />
          </>
        ) : (
          <>
            <section className="dash-overview" aria-label="Tab overview">
              <div className="card-stack">
                <PhysicalCard card={card} agentName={agent?.name ?? null} />
                <div className="card-caption">
                  <span>{card.maskedNumber}</span>
                  <span>{statusWord(card.status)}</span>
                </div>
              </div>
              <div className="dash-glance">
                <span className="micro">Tab budget · left</span>
                <div className="dash-glance-big">
                  {usd(budgetLeft(card))}
                  <small>of {usd(card.budget.total)}</small>
                </div>
                <p className="signer-note">
                  {usd(card.budget.spent)} paid · {usd(card.budget.reserved)} on hold ·{" "}
                  {usd(card.budget.total)} total. Money is held when a purchase starts, not when it
                  finishes.
                </p>
                <div className="dash-glance-meta">
                  <span className="mono">{statusWord(card.status)}</span>
                  <span className="mono">
                    {card.chain} · {card.asset}
                  </span>
                </div>
              </div>
            </section>

            {cardCharges.length === 0 && pending.length === 0 ? (
              <AgentDemoPanel card={card} agent={agent} firstRun />
            ) : (
              <AgentDemoPanel card={card} agent={agent} />
            )}

            <div className="dash-pair">
              <BudgetMeter card={card} />
              <PolicyGate card={card} charges={charges} />
            </div>

            <ApprovalPanel
              charges={cardCharges}
              agents={agents}
              approveUnder={card.limits.autoApproveUnder}
              onOpenReceipt={openReceipt}
            />

            <section aria-label="Charges and decisions">
              <div className="section-head">
                <h2>Charges &amp; decisions</h2>
                <span className="count">
                  {cardCharges.length} on this tab · {charges.length} total
                </span>
              </div>
              {dataError ? null : loading && cardCharges.length === 0 ? (
                <div className="charges">
                  <SkeletonRows rows={3} />
                </div>
              ) : (
                <ChargesTable charges={cardCharges} agents={agents} onOpenReceipt={openReceipt} />
              )}
            </section>

            <div className="dash-footer">
              <Link className="link-cta" href="/app/ledger">
                Full ledger →
              </Link>
              <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
                Last update {relativeTime(new Date().toISOString())} · auto-refresh 4s
              </span>
            </div>

            <details className="dev-details">
              <summary>How it works / for developers</summary>
              <div className="dev-details-body">
                <p>
                  <b>Policy gate.</b> The API enforces the budget, per-charge cap, daily cap,
                  store list, card status and expiry. A failed check returns a stable code such as{" "}
                  <span className="mono">AMOUNT_ABOVE_PER_CHARGE</span> or{" "}
                  <span className="mono">MERCHANT_NOT_ALLOWED</span>.
                </p>
                <p>
                  <b>Charge token.</b> The agent asks for a single-use <span className="mono">tab_ch_…</span>{" "}
                  token bound to one store and one maximum amount. It expires after five minutes and
                  is stored hashed.
                </p>
                <p>
                  <b>Signature gate.</b> {signatureGate.label}. {signatureGate.detail} The browser
                  holds the Pollar session and signs the exact payment; the API has no key and cannot
                  move funds.
                </p>
                <p>
                  <b>Reservation and settlement.</b> A charge reserves budget immediately.{" "}
                  <span className="mono">QUEUED</span>, <span className="mono">SIGNING</span> and{" "}
                  <span className="mono">AWAITING_APPROVAL</span> are held;{" "}
                  <span className="mono">SETTLED</span> moves the amount to spent;{" "}
                  <span className="mono">DECLINED</span>, <span className="mono">FAILED</span> and{" "}
                  <span className="mono">EXPIRED</span> release it. The API verifies the Stellar
                  transaction against the intent before marking it settled.
                </p>
                <p>
                  <b>x402.</b> The live merchant rail fetches a third-party HTTP 402 challenge,
                  allowlists the host, runs the same policy check, and lets the browser sign the exact
                  USDC amount. The returned market JSON belongs to Nirium, not to this demo.
                </p>
                <p>
                  <b>MCP / Claude.</b> The agent uses{" "}
                  <span className="mono">Authorization: Bearer tab_agent_…</span> and calls{" "}
                  <span className="mono">list_cards</span>, <span className="mono">get_budget</span>,{" "}
                  <span className="mono">buy</span>, <span className="mono">x402_fetch</span> and{" "}
                  <span className="mono">list_charges</span>. Rotate the key from the agent row to
                  reveal a fresh one.
                </p>
              </div>
            </details>
          </>
        )}
      </div>

      <Dialog
        open={revokeOpen}
        onClose={() => {
          if (revokeBusy) return;
          setRevokeOpen(false);
        }}
        eyebrow="Kill switch"
        title={`Revoke ${card?.label ?? "this card"}?`}
        footer={
          <>
            <button className="btn btn-quiet" onClick={() => setRevokeOpen(false)} disabled={revokeBusy}>
              Keep it
            </button>
            <button
              className="btn btn-danger"
              onClick={() => void confirmRevoke()}
              disabled={revokeBusy}
              aria-busy={revokeBusy}
            >
              {revokeBusy ? "Revoking…" : "Revoke card"}
            </button>
          </>
        }
      >
        <p className="signer-note" style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          Every outstanding charge token dies immediately. The agent&apos;s next request fails with{" "}
          <span className="mono">CARD_REVOKED</span>. Queued payments are cancelled and held money is
          released. This cannot be undone.
        </p>
        {revokeError ? (
          <div className="error-box" role="alert">
            <div style={{ display: "grid", gap: 4 }}>
              <span className="code">{revokeError.code}</span>
              <p>{revokeError.message}</p>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
