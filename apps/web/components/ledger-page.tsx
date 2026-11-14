"use client";

import { useMemo, useState } from "react";
import { fromUnits, toUnits, type Charge, type LedgerEvent } from "@tab/shared";
import { useTab } from "@/components/tab-store";
import { useConsoleUI } from "@/components/console-ui";
import { DecisionChip, StatusChip, UnverifiedChip } from "@/components/charges";
import { EmptyState, ErrorBox, SkeletonRows } from "@/components/ui";
import {
  clockTime,
  dayKey,
  dayLabel,
  decisionSentence,
  isUnverified,
  onchainAmount,
  verificationWord,
  relativeTime,
  shortHash,
  usd,
} from "@/lib/format";

type Filter = "all" | "settled" | "needs" | "declined" | "events";

interface Row {
  kind: "charge";
  at: string;
  charge: Charge;
}

interface EventRow {
  kind: "event";
  at: string;
  event: LedgerEvent;
}

function matchesFilter(charge: Charge, filter: Filter): boolean {
  if (filter === "settled") return charge.status === "SETTLED";
  if (filter === "needs") return charge.status === "AWAITING_APPROVAL";
  if (filter === "declined")
    return charge.status === "DECLINED" || charge.status === "FAILED" || charge.status === "EXPIRED";
  if (filter === "events") return false;
  return true;
}

export function LedgerPage() {
  const { charges, ledger, loading, dataError, refresh, agents } = useTab();
  const { openReceipt } = useConsoleUI();
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const chargeRows: Row[] = charges
      .filter((charge) => matchesFilter(charge, filter))
      .map((charge) => ({ kind: "charge", at: charge.createdAt, charge }));

    const eventRows: EventRow[] =
      filter === "all" || filter === "events"
        ? ledger
            .filter((event) => !event.chargeId)
            .map((event) => ({ kind: "event", at: event.createdAt, event }))
        : [];

    return [...chargeRows, ...eventRows].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [charges, ledger, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, (Row | EventRow)[]>();
    for (const row of rows) {
      const key = dayKey(row.at);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [rows]);

  const totals = useMemo(() => {
    let settled = 0n;
    let declined = 0n;
    for (const charge of charges) {
      if (charge.status === "SETTLED") settled += toUnits(charge.amount);
      if (charge.status === "DECLINED" || charge.status === "FAILED" || charge.status === "EXPIRED") {
        declined += toUnits(charge.amount);
      }
    }
    return { settled: fromUnits(settled), declined: fromUnits(declined) };
  }, [charges]);

  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "agent";

  return (
    <>
      <header className="main-head">
        <div>
          <h1>Ledger</h1>
          <div className="sub">
            <span>Every decision and every hash</span>
            <span aria-hidden="true">·</span>
            <span className="mono" style={{ fontSize: 11 }}>
              {charges.length} charges · {ledger.length} events
            </span>
          </div>
        </div>
        <div className="main-head-actions">
          <button className="btn btn-sm btn-quiet" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <div className="main-body">
        {dataError ? <ErrorBox error={dataError} onRetry={() => void refresh()} /> : null}

        <div className="ledger-tools">
          <div className="filter-row" role="group" aria-label="Filter the ledger">
            {(
              [
                ["all", "All"],
                ["settled", "Settled"],
                ["needs", "Needs you"],
                ["declined", "Declined"],
                ["events", "Events"],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
              SETTLED {usd(totals.settled)}
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
              DECLINED {usd(totals.declined)}
            </span>
          </div>
        </div>

        {loading && charges.length === 0 ? (
          <div className="charges">
            <SkeletonRows rows={5} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title={
              charges.length === 0
                ? "No activity yet."
                : "Nothing matches this filter."
            }
            body={
              charges.length === 0
                ? "Create an agent, open a tab, then ask it to buy something from Agent Depot. Every request lands here with a named reason, whether it clears or fails."
                : "Switch the filter back to All. A charge only appears under Settled once the API has verified the transaction on-chain."
            }
          />
        ) : (
          <div>
            {groups.map(([key, groupRows]) => (
              <section key={key} aria-label={dayLabel(groupRows[0].at)}>
                <div className="day-head">
                  <b>{dayLabel(groupRows[0].at)}</b>
                  <span>{groupRows.length} entries</span>
                </div>
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>Time</th>
                      <th>Merchant / event</th>
                      <th style={{ width: 104, textAlign: "right" }}>Tab amount</th>
                      <th style={{ width: 122 }}>Decision</th>
                      <th style={{ width: 112 }}>Status</th>
                      <th style={{ width: 104 }} className="hide-sm">
                        Hash
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((row) =>
                      row.kind === "charge" ? (
                        <ChargeLedgerRow
                          key={`c-${row.charge.id}`}
                          charge={row.charge}
                          agent={agentName(row.charge.agentId)}
                          onOpen={() => openReceipt(row.charge)}
                        />
                      ) : (
                        <EventLedgerRow key={`e-${row.event.id}`} event={row.event} />
                      ),
                    )}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ChargeLedgerRow({
  charge,
  agent,
  onOpen,
}: {
  charge: Charge;
  agent: string;
  onOpen: () => void;
}) {
  const receipt = charge.receipt;
  const unverified = isUnverified(charge);
  return (
    <tr>
      <td className="when">{clockTime(charge.createdAt)}</td>
      <td>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{charge.merchantName || charge.merchantId}</span>
          <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
            {charge.description} · {agent}
          </span>
        </div>
      </td>
      <td className="amount">
        {usd(charge.amount)}
        {receipt ? (
          <div className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
            {onchainAmount(receipt.amount, receipt.asset)}
          </div>
        ) : null}
      </td>
      <td>
        <div style={{ display: "grid", gap: 3 }}>
          <DecisionChip charge={charge} />
          <span style={{ fontSize: 10, color: "var(--muted)" }} title={charge.decision?.code}>
            {decisionSentence(charge)}
          </span>
        </div>
      </td>
      <td>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <StatusChip charge={charge} />
          {unverified ? <UnverifiedChip /> : null}
        </div>
      </td>
      <td className="hide-sm">
        {receipt ? (
          <div style={{ display: "grid", gap: 2 }}>
            <button className="ledger-link" onClick={onOpen} title={receipt.hash}>
              {shortHash(receipt.hash, 6, 4)} ↗
            </button>
            <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
              {verificationWord(charge)}
            </span>
          </div>
        ) : (
          <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
            {charge.status === "QUEUED" ? "waiting for signer" : "—"}
          </span>
        )}
      </td>
    </tr>
  );
}

function actorLabel(actor: string): string {
  if (actor.startsWith("user:")) return "you";
  if (actor.startsWith("signer:")) return "signer";
  if (actor.startsWith("agent:")) return "agent";
  return actor;
}

function EventLedgerRow({ event }: { event: LedgerEvent }) {
  const toneClass =
    event.type === "CARD_REVOKED" || event.type === "CHARGE_FAILED" ? "chip chip-red" : "chip chip-quiet";
  return (
    <tr>
      <td className="when">{clockTime(event.createdAt)}</td>
      <td>
        <div style={{ display: "grid", gap: 2 }}>
          <span className="summary">{event.summary}</span>
          <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
            {actorLabel(event.actor)} · {event.type}
          </span>
        </div>
      </td>
      <td className="amount">—</td>
      <td>
        <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
          —
        </span>
      </td>
      <td>
        <span className={toneClass}>{event.type.replaceAll("_", " ")}</span>
      </td>
      <td className="hide-sm">
        <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
          {event.id}
        </span>
      </td>
    </tr>
  );
}
