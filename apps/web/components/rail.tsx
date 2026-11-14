"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { usePollar } from "@pollar/react";
import { useEffect, useState } from "react";
import { useTab } from "@/components/tab-store";
import { useConsoleUI } from "@/components/console-ui";
import { CopyButton } from "@/components/ui";
import { RailCard } from "@/components/card";
import { clockTime, shortAddress } from "@/lib/format";

const NAV = [
  { href: "/app", label: "Overview", n: "01" },
  { href: "/app/ledger", label: "Ledger", n: "02" },
  { href: "/app/setup", label: "Setup", n: "03" },
];

function WalletStrip() {
  const { wallet, walletBalance, refreshWalletBalance, openTxHistoryModal } = usePollar();
  const { phase } = useTab();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (phase !== "ready") return;
    if (walletBalance.step !== "idle") return;
    void refreshWalletBalance().catch(() => {
      /* the state machine reports the failure */
    });
  }, [phase, walletBalance.step, refreshWalletBalance]);

  const balances =
    walletBalance.step === "loaded"
      ? walletBalance.data.balances.filter((record) => record.balance !== null)
      : [];
  const shown = balances.filter((record) => record.code === "USDC" || record.code === "XLM").slice(0, 2);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshWalletBalance();
    } catch {
      // The state machine already exposes the error.
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="rail-user">
        <b>{wallet ? shortAddress(wallet.address) : "No wallet yet"}</b>
        <span>{wallet ? `${wallet.custody} · Stellar` : "waiting for Pollar"}</span>
      </div>

      <div style={{ display: "grid", gap: 4 }}>
        <span className="micro">Wallet balance</span>
        {walletBalance.step === "loaded" ? (
          shown.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {shown.map((record) => (
                <span
                  key={`${record.chain ?? "STELLAR"}-${record.code}`}
                  className="mono"
                  style={{ fontSize: 11 }}
                  title={`${record.balance} ${record.code}${record.issuer ? ` · issuer ${record.issuer}` : ""}`}
                >
                  {record.balance} {record.code}
                </span>
              ))}
            </div>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
              No USDC or XLM yet
            </span>
          )
        ) : walletBalance.step === "error" ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--signal-red-ink)" }}>
            Balance unavailable
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
            {walletBalance.step === "loading" ? "Reading…" : "—"}
          </span>
        )}
        <button className="link-cta" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh balance"}
        </button>
        {wallet ? <CopyButton value={wallet.address} label="Copy address" className="link-cta" /> : null}
        <a
          className="link-cta faucet-link"
          href="https://faucet.circle.com"
          target="_blank"
          rel="noreferrer"
        >
          Get test USDC ↗
        </a>
        <span className="field-hint">Select Stellar testnet, paste your wallet address.</span>
      </div>

      <button className="link-cta" onClick={() => openTxHistoryModal()}>
        Pollar history →
      </button>
    </div>
  );
}

export function Rail() {
  const pathname = usePathname();
  const router = useRouter();
  const { agents, cards, selectedCardId, selectCard, user, signOut, health, sessionExpiresAt } =
    useTab();
  const { openTab, openAgent } = useConsoleUI();

  const activeCardId = selectedCardId ?? cards[0]?.id ?? null;

  return (
    <nav className="rail" aria-label="Console">
      <div className="rail-brand">
        <b>TAB</b>
        <span>{health?.mode === "mainnet" ? "Mainnet" : "Testnet"}</span>
      </div>

      <div className="rail-nav">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
              <span>{item.label}</span>
              <span className="n">{item.n}</span>
            </Link>
          );
        })}
      </div>

      <div className="rail-section">
        <div className="rail-section-head">
          <span className="micro">Agents · {agents.length}</span>
          <button className="rail-add" onClick={() => openAgent()}>
            + Agent
          </button>
        </div>
        <div className="rail-list">
          {agents.length === 0 ? (
            <p className="signer-note" style={{ padding: "6px 0" }}>
              No agents. Create one to get a key.
            </p>
          ) : (
            agents.map((agent) => {
              const count = cards.filter((card) => card.agentId === agent.id).length;
              const firstCard = cards.find((card) => card.agentId === agent.id);
              return (
                <button
                  key={agent.id}
                  className="rail-agent"
                  onClick={() => {
                    if (firstCard) {
                      selectCard(firstCard.id);
                      router.push(`/app/cards/${firstCard.id}`);
                    } else {
                      openTab(agent.id);
                    }
                  }}
                  title={`${agent.name} · ${count} card${count === 1 ? "" : "s"}`}
                >
                  <span
                    className={`dot ${
                      agent.status === "ACTIVE"
                        ? "dot-live"
                        : agent.status === "PAUSED"
                          ? "dot-muted"
                          : "dot-red"
                    }`}
                  />
                  <span className="rail-agent-name">{agent.name}</span>
                  <span className="count">{count}</span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="rail-section" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="rail-section-head">
          <span className="micro">Cards · {cards.length}</span>
          <button className="rail-add" onClick={() => openTab()}>
            + Tab
          </button>
        </div>
        <div className="rail-cards">
          {cards.length === 0 ? (
            <p className="signer-note" style={{ padding: "6px 0" }}>
              No cards. Open a tab with a budget and a merchant list.
            </p>
          ) : (
            cards.map((card) => (
              <RailCard
                key={card.id}
                card={card}
                agentName={agents.find((agent) => agent.id === card.agentId)?.name ?? null}
                selected={card.id === activeCardId}
                onSelect={() => {
                  selectCard(card.id);
                  router.push(`/app/cards/${card.id}`);
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="rail-foot">
        <WalletStrip />
        <div className="rail-user">
          <b>{user?.name ?? user?.email ?? "Signed in"}</b>
          <span>{user?.email ?? "no email"}</span>
          {sessionExpiresAt ? (
            <span>
              Session until{" "}
              {new Date(sessionExpiresAt).toDateString() === new Date().toDateString()
                ? clockTime(sessionExpiresAt)
                : new Date(sessionExpiresAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
            </span>
          ) : null}
        </div>
        <button
          className="btn btn-sm btn-quiet"
          onClick={async () => {
            await signOut();
            router.replace("/");
          }}
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
