"use client";

import type { Card, Charge } from "@tab/shared";
import { toUnits } from "@tab/shared";
import { useId } from "react";
import {
  budgetLeft,
  budgetUsedPct,
  compactUsd,
  dailyCommitted,
  expiryLabel,
  expiryWords,
  limitLadder,
  usd,
} from "@/lib/format";

/* ── guilloche: repeating arcs, 5% opacity, the only texture on the card ─── */

function Guilloche() {
  const rawId = useId();
  const id = `g${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="card-guilloche" aria-hidden="true" focusable="false">
      <defs>
        <pattern
          id={id}
          width="96"
          height="96"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(24)"
        >
          <g fill="none" stroke="currentColor" strokeWidth="0.7">
            <ellipse cx="48" cy="48" rx="46" ry="22" />
            <ellipse cx="48" cy="48" rx="38" ry="30" />
            <ellipse cx="48" cy="48" rx="22" ry="38" />
            <ellipse cx="48" cy="48" rx="30" ry="46" />
            <circle cx="48" cy="48" r="40" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/* ── the card object ─────────────────────────────────────────────────────── */

export function PhysicalCard({
  card,
  agentName,
  mini = false,
}: {
  card: Card;
  agentName?: string | null;
  mini?: boolean;
}) {
  const ladder = limitLadder(card);
  const paused = card.status === "PAUSED";
  const revoked = card.status === "REVOKED";
  const expired = card.status === "EXPIRED";
  const exhausted = card.status === "EXHAUSTED";
  const band = paused ? "PAUSED" : expired ? "EXPIRED" : exhausted ? "SPENT" : null;

  return (
    <div
      className={`card-object${mini ? " is-mini" : ""}${revoked ? " is-revoked" : ""}`}
      role="img"
      aria-label={`${card.label}. ${card.maskedNumber}. ${card.status.toLowerCase()}. Expires ${expiryWords(card.expiresAt)}.`}
    >
      <Guilloche />
      <div className="card-face">
        <div className="card-top">
          <div className="card-brand">
            <b>TAB</b>
            <span>{mini ? "Agent card" : "Virtual agent card"}</span>
          </div>
          <span className="card-chain">
            {card.chain} · {card.asset}
          </span>
        </div>

        <div>
          <div className="card-chip" aria-hidden="true" />
        </div>

        <div className="card-num">{card.maskedNumber}</div>

        {!mini ? (
          <div
            className="mono"
            style={{
              fontSize: 8,
              letterSpacing: "0.09em",
              color: ladder.ok ? "rgb(242 239 230 / 0.55)" : "#ff8a70",
              textTransform: "uppercase",
            }}
            title={ladder.ok ? "Creation ladder: approval line ≤ per charge ≤ daily ≤ budget." : ladder.warnings.join(" ")}
          >
            {ladder.ok ? "Limits " : "Ladder invalid · "}
            {compactUsd(card.limits.perCharge)} ≤ {compactUsd(card.limits.daily)} ≤{" "}
            {compactUsd(card.budget.total)}
          </div>
        ) : null}

        <div className="card-bottom">
          <div className="card-holder">
            <span>Cardholder</span>
            <b>{agentName ?? card.label}</b>
          </div>
          <div className="card-exp">
            <span>Expires</span>
            <b>{expiryLabel(card.expiresAt)}</b>
          </div>
        </div>
      </div>

      {band ? (
        <div className="card-status-band">
          <span>{band}</span>
        </div>
      ) : null}
      {revoked ? (
        <div className="card-void">
          <b>VOID</b>
        </div>
      ) : null}
    </div>
  );
}

/* ── budget meter (spent / reserved / left, always mono) ─────────────────── */

export function BudgetMeter({ card }: { card: Card }) {
  const total = toUnits(card.budget.total);
  const spent = toUnits(card.budget.spent);
  const reserved = toUnits(card.budget.reserved);
  const left = budgetLeft(card);

  const pct = (units: bigint) =>
    total === 0n ? 0 : Math.min(100, Math.max(0, Number((units * 10000n) / total) / 100));

  const spentPct = pct(spent);
  const reservedPct = pct(reserved);
  const leftPct = Math.max(0, 100 - spentPct - reservedPct);

  return (
    <div className="meter">
      <div className="meter-top">
        <div className="meter-left">
          <span className="micro">Tab budget · left</span>
          <div className="meter-big">
            {usd(left)}
            <small>of {usd(card.budget.total)}</small>
          </div>
        </div>
        <div style={{ textAlign: "right", display: "grid", gap: 4 }}>
          <span className="micro">Expires</span>
          <span className="mono" style={{ fontSize: 12 }}>
            {expiryWords(card.expiresAt)}
          </span>
          <span className="mono muted" style={{ fontSize: 10 }}>
            {expiryLabel(card.expiresAt)}
          </span>
        </div>
      </div>

      <div
        className="meter-bar"
        role="img"
        aria-label={`Budget: ${usd(card.budget.spent)} paid, ${usd(card.budget.reserved)} on hold, ${usd(left)} left of ${usd(card.budget.total)}.`}
      >
        <div className="meter-seg spent" style={{ width: `${spentPct}%` }} />
        <div className="meter-seg reserved" style={{ width: `${reservedPct}%` }} />
        <div className="meter-seg left" style={{ width: `${leftPct}%` }} />
      </div>

      <div className="meter-nums">
        <div className="stat">
          <span>Paid</span>
          <b>{usd(card.budget.spent)}</b>
        </div>
        <div className="stat">
          <span>On hold</span>
          <b>{usd(card.budget.reserved)}</b>
        </div>
        <div className="stat">
          <span>Left</span>
          <b>{usd(left)}</b>
        </div>
        <div className="stat">
          <span>Total</span>
          <b>{usd(card.budget.total)}</b>
        </div>
      </div>

      <div className="meter-foot">
        <span>
          {usd(card.budget.spent)} paid · {usd(card.budget.reserved)} on hold · {usd(left)} left
        </span>
        <span className="mono" style={{ fontSize: 10 }}>
          {budgetUsedPct(card).toFixed(1)}% committed
        </span>
      </div>
    </div>
  );
}

/* ── the policy gate: four numbers, four scopes ──────────────────────────── */

export function PolicyGate({ card, charges }: { card: Card; charges: Charge[] }) {
  const daily = dailyCommitted(charges, card.id);
  const left = budgetLeft(card);
  const ladder = limitLadder(card);

  return (
    <section className="meter" aria-label="Spending limits">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="micro">What this card can spend</span>
        <span className={ladder.ok ? "chip chip-quiet" : "chip chip-red"}>
          {ladder.ok ? "Limits look right" : "Limits do not line up"}
        </span>
      </div>

      <div className="grid-2" style={{ gap: 0 }}>
        <div
          className="stat"
          style={{ padding: "10px 12px 10px 0", borderTop: "1px solid var(--line)", borderRight: "1px solid var(--line)" }}
        >
          <span>Max per purchase</span>
          <b style={{ fontSize: 17 }}>{usd(card.limits.perCharge)}</b>
          <small>one purchase, hard cap</small>
        </div>
        <div
          className="stat"
          style={{ padding: "10px 0 10px 12px", borderTop: "1px solid var(--line)" }}
        >
          <span>Daily cap</span>
          <b style={{ fontSize: 17 }}>{usd(card.limits.daily)}</b>
          <small>{usd(daily)} used · last 24h, including holds</small>
        </div>
        <div
          className="stat"
          style={{ padding: "10px 12px 0 0", borderRight: "1px solid var(--line)" }}
        >
          <span>Tab budget</span>
          <b style={{ fontSize: 17 }}>{usd(card.budget.total)}</b>
          <small>{usd(left)} left</small>
        </div>
        <div className="stat" style={{ padding: "10px 0 0 12px" }}>
          <span>Needs your approval above</span>
          <b style={{ fontSize: 17 }}>{usd(card.limits.autoApproveUnder)}</b>
          <small>Below it, TAB doesn&apos;t ask — your wallet still signs.</small>
        </div>
      </div>

      {!ladder.ok ? (
        <div className="field-error" role="status">
          {ladder.warnings.join(" ")}
        </div>
      ) : null}
    </section>
  );
}

/* ── mini card for the rail ──────────────────────────────────────────────── */

export function RailCard({
  card,
  agentName,
  selected,
  onSelect,
}: {
  card: Card;
  agentName?: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className="rail-card-object"
      aria-current={selected}
      onClick={onSelect}
      aria-label={`Select ${card.label}, ${usd(budgetLeft(card))} left`}
    >
      <PhysicalCard card={card} agentName={agentName} mini />
      <span className="rail-card-meta">
        <b>{card.label}</b>
        <span>{usd(budgetLeft(card))} left</span>
      </span>
    </button>
  );
}
