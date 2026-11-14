"use client";

import type { Agent, Card, Charge } from "@tab/shared";
import { useState } from "react";
import { useConsoleUI } from "@/components/console-ui";
import { useTab } from "@/components/tab-store";
import {
  ApiError,
  demoPurchase,
  type DemoChallenge,
  type DemoScenario,
} from "@/lib/api";
import { decisionSentence, shortHash, usd } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────────
 * Start here — the first-time path, with one honest shortcut
 * ──────────────────────────────────────────────────────────────────────────── */

export function StartHereStrip({
  hasAgent,
  hasCard,
}: {
  hasAgent: boolean;
  hasCard: boolean;
}) {
  const { agents, merchants, createAgent, createCard, toast } = useTab();
  const { openAgent, openTab } = useConsoleUI();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hasAgent && hasCard) return null;

  const setupDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      let agentId = agents[0]?.id ?? null;
      if (!agentId) {
        const created = await createAgent({
          name: "Scout",
          description: "buys research data",
          emoji: "🔭",
        });
        agentId = created.agent.id;
      }

      const known = new Set(merchants.map((merchant) => merchant.id));
      const preferred = ["mch_exa", "mch_firecrawl"].filter(
        (id) => known.size === 0 || known.has(id),
      );
      const allowlist =
        preferred.length > 0 ? preferred : merchants.slice(0, 2).map((merchant) => merchant.id);

      if (allowlist.length === 0) {
        throw new Error("The merchant catalogue has not loaded. Retry in a moment.");
      }

      await createCard({
        agentId,
        label: "Research Scout",
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: allowlist,
        expiresInHours: 24,
        chain: "STELLAR",
      });
      toast("Demo ready: Scout has a $25 card. Now press the $2.50 button.");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.sentence
          : err instanceof Error
            ? err.message
            : "The demo setup failed.";
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const stepState = (done: boolean, current: boolean) =>
    done ? "demo-step is-done" : current ? "demo-step is-current" : "demo-step";

  return (
    <section className="start-here" aria-label="Start here">
      <div className="start-here-head">
        <div>
          <span className="micro">Start here</span>
          <h2>Three steps to a settled payment.</h2>
        </div>
        <button className="btn btn-sm btn-primary" onClick={() => void setupDemo()} disabled={busy}>
          {busy ? "Setting up…" : hasAgent ? "Create the demo card" : "Set up the demo for me"}
        </button>
      </div>

      <ol className="demo-steps">
        <li className={stepState(hasAgent, !hasAgent)}>
          <span className="demo-step-n">1</span>
          <div>
            <b>Create an agent</b>
            <p>It gets a key that can ask for charges. It never sees your card or wallet.</p>
            {hasAgent ? null : (
              <button className="link-btn" onClick={openAgent}>
                Create an agent myself →
              </button>
            )}
          </div>
        </li>
        <li className={stepState(hasCard, hasAgent && !hasCard)}>
          <span className="demo-step-n">2</span>
          <div>
            <b>Open a tab</b>
            <p>Pick a budget, a per-purchase cap, the stores it may use, and when it expires.</p>
            {hasCard || !hasAgent ? null : (
              <button className="link-btn" onClick={() => openTab(agents[0]?.id ?? null)}>
                Open a tab myself →
              </button>
            )}
          </div>
        </li>
        <li className={stepState(false, hasAgent && hasCard)}>
          <span className="demo-step-n">3</span>
          <div>
            <b>Try a purchase</b>
            <p>
              Use <strong>Try it as the agent</strong> below. No Claude, no MCP, no API key.
            </p>
          </div>
        </li>
      </ol>

      <p className="signer-note">
        The shortcut creates agent <strong>Scout</strong> and a $25 test card with the standard
        limits: $5 per purchase, $10 per day, approval above $3, Exa + Firecrawl. You can rotate the
        agent key later if you want to connect Claude.
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Try it as the agent — five clicks a judge can make with no setup
 * ──────────────────────────────────────────────────────────────────────────── */

interface Scenario {
  id: DemoScenario;
  title: string;
  caption: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "auto",
    title: "$2.50 — auto-approved",
    caption: "Exa Starter. Under your $3 approval line; your wallet signs it.",
  },
  {
    id: "approval",
    title: "$4.00 — asks you first",
    caption: "Firecrawl 1K. Above $3, under the $5 per-purchase cap.",
  },
  {
    id: "overcharge",
    title: "$9.00 — over the per-purchase cap",
    caption: "Exa Pro. Blocked before any money moves.",
  },
  {
    id: "merchant",
    title: "Not an approved store",
    caption: "OpenAI $5. Outside this card's store list.",
  },
  {
    id: "x402",
    title: "Pay a real third-party API — 0.05 USDC",
    caption: "Nirium market data. A live merchant, not our demo data.",
  },
];

type ResultPhase = "settled" | "approval" | "denied" | "x402" | "pending" | "error";

interface DemoResult {
  scenario: DemoScenario;
  phase: ResultPhase;
  sentence: string;
  state: string;
  detail: string;
  code?: string;
  charge?: Charge;
  challenge?: DemoChallenge;
  requestId?: string;
  licenseKey?: string;
}

function denialSentence(code: string): string {
  switch (code) {
    case "AMOUNT_ABOVE_PER_CHARGE":
      return "Denied: this is over the per-purchase cap.";
    case "MERCHANT_NOT_ALLOWED":
      return "Denied: this store is not on the card.";
    case "AMOUNT_ABOVE_DAILY_LIMIT":
      return "Denied: this would go over today's cap.";
    case "AMOUNT_ABOVE_BUDGET":
      return "Denied: the tab does not have enough left.";
    case "CARD_REVOKED":
      return "Denied: this card was revoked.";
    case "CARD_PAUSED":
      return "Denied: this card is paused.";
    default:
      return "Denied by the card's limits.";
  }
}

export function AgentDemoPanel({
  card,
  agent,
  firstRun = false,
}: {
  card: Card;
  agent: Agent | null;
  firstRun?: boolean;
}) {
  const { refresh } = useTab();
  const { openReceipt } = useConsoleUI();
  const [busy, setBusy] = useState<DemoScenario | null>(null);
  const [result, setResult] = useState<DemoResult | null>(null);

  const run = async (scenario: DemoScenario) => {
    setBusy(scenario);
    setResult(null);
    try {
      const res = await demoPurchase(card.id, scenario);
      await refresh();

      if (scenario === "x402") {
        const amount = res.challenge?.amount ? `${res.challenge.amount} USDC` : "a small USDC amount";
        setResult({
          scenario,
          phase: "x402",
          sentence: `A real merchant asked for ${amount}.`,
          state: `Payment request ${res.requestId ?? "created"} · your wallet is paying it now.`,
          detail:
            "Nirium is a third-party paid API on Stellar testnet. The challenge above is supplied by the merchant; the browser signs the exact amount.",
          challenge: res.challenge,
          requestId: res.requestId,
        });
        return;
      }

      const charge = res.charge;
      if (!charge) {
        setResult({
          scenario,
          phase: "error",
          sentence: "The API returned no charge.",
          state: "Nothing settled",
          detail: "Reload the console and try again.",
        });
        return;
      }

      if (charge.status === "AWAITING_APPROVAL") {
        setResult({
          scenario,
          phase: "approval",
          sentence: decisionSentence(charge),
          state: "Waiting for your approval — the charge drawer is open.",
          detail: `Approve ${usd(charge.amount)} at ${charge.merchantName || charge.merchantId} and your wallet will sign it.`,
          code: charge.decision?.code,
          charge,
        });
        openReceipt(charge);
        return;
      }

      if (charge.status === "SETTLED") {
        setResult({
          scenario,
          phase: "settled",
          sentence: decisionSentence(charge),
          state: `Settled. Receipt ${charge.receipt ? shortHash(charge.receipt.hash, 8, 6) : "ready"}.`,
          detail: res.licenseKey
            ? `License ${res.licenseKey}. The receipt drawer is open; the hash is a testnet transaction.`
            : "The receipt drawer is open; the hash is a testnet transaction.",
          code: charge.decision?.code,
          charge,
          licenseKey: res.licenseKey,
        });
        openReceipt(charge);
        return;
      }

      setResult({
        scenario,
        phase: "pending",
        sentence: decisionSentence(charge),
        state: `Queued as ${charge.status}. Your wallet has not signed yet.`,
        detail:
          "The payment console in the right column claims the job and asks your wallet. Keep this tab open.",
        code: charge.decision?.code,
        charge,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setResult({
          scenario,
          phase: err.status === 0 || err.status >= 500 ? "error" : "denied",
          sentence:
            err.status === 0 || err.status >= 500
              ? "The demo could not reach the API."
              : err.sentence,
          state:
            err.status === 0 || err.status >= 500
              ? "Nothing settled"
              : `${denialSentence(err.code)} Code ${err.code}.`,
          detail:
            err.status === 0 || err.status >= 500
              ? err.sentence
              : "The card's limits rejected it before the wallet was asked to sign.",
          code: err.code,
        });
      } else {
        setResult({
          scenario,
          phase: "error",
          sentence: "The demo failed before a charge was created.",
          state: "Nothing settled",
          detail: err instanceof Error ? err.message : "Unknown error.",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="demo-panel" aria-label="Try it as the agent">
      <div className="section-head" style={{ marginBottom: 4 }}>
        <div>
          <span className="micro">No agent key needed</span>
          <h2>Try it as the agent</h2>
        </div>
        <span className="chip chip-quiet">same API as Claude/MCP</span>
      </div>
      {firstRun ? (
        <p className="next-hint">
          <span className="chip chip-ink">Next click</span> Press{" "}
          <strong>$2.50 — auto-approved</strong> below. No agent key, Claude or MCP needed.
        </p>
      ) : null}
      <p className="signer-note" style={{ maxWidth: "72ch" }}>
        {agent ? `${agent.name} asks to buy` : "Your agent asks to buy"} from this card. Every button
        goes through the same policy check, charge token and wallet signature as a real agent
        purchase. The demo only chooses the scenario; the server chooses the merchant, SKU and
        price.
      </p>

      <div className="demo-grid">
        {SCENARIOS.map((scenario) => (
          <button
            key={scenario.id}
            className={`demo-scenario${busy === scenario.id ? " is-busy" : ""}`}
            onClick={() => void run(scenario.id)}
            disabled={busy !== null || card.status !== "ACTIVE"}
            aria-busy={busy === scenario.id}
          >
            <b>{scenario.title}</b>
            <span>{scenario.caption}</span>
            <span className="demo-scenario-action">
              {busy === scenario.id ? "Running…" : "Ask the card →"}
            </span>
          </button>
        ))}
      </div>

      <p className="demo-warning" role="note">
        These buttons spend testnet USDC from your card. Nothing is charged on mainnet. No test
        USDC? Use{" "}
        <a
          className="demo-warning-link"
          href="https://faucet.circle.com"
          target="_blank"
          rel="noreferrer"
        >
          Get test USDC ↗
        </a>{" "}
        next to your wallet address.
      </p>
      {card.status !== "ACTIVE" ? (
        <p className="field-error">
          This card is {card.status.toLowerCase()}. Resume it, or open a new tab, to use the demo.
        </p>
      ) : null}

      {result ? (
        <div className={`demo-result is-${result.phase}`} role="status" aria-live="polite">
          <div className="demo-result-head">
            <span className="micro">Decision</span>
            {result.code ? <span className="chip chip-quiet mono">{result.code}</span> : null}
          </div>
          <b className="demo-sentence">{result.sentence}</b>
          <span className="demo-state">State: {result.state}</span>
          <p className="demo-detail">{result.detail}</p>

          {result.phase === "settled" && result.charge?.receipt ? (
            <div className="demo-result-actions">
              <button className="btn btn-sm btn-quiet" onClick={() => openReceipt(result.charge!)}>
                Open receipt ↗
              </button>
              {result.licenseKey ? (
                <span className="mono" style={{ fontSize: 10 }}>
                  {result.licenseKey}
                </span>
              ) : null}
            </div>
          ) : null}

          {result.phase === "approval" && result.charge ? (
            <div className="demo-result-actions">
              <button className="btn btn-sm btn-primary" onClick={() => openReceipt(result.charge!)}>
                Review and approve
              </button>
              <span className="mono" style={{ fontSize: 10 }}>
                {result.charge.id}
              </span>
            </div>
          ) : null}

          {result.phase === "x402" && result.challenge ? (
            <dl className="kv" style={{ marginTop: 8 }}>
              <div className="kv-row">
                <dt>Merchant</dt>
                <dd>Nirium · nirium-agent.fly.dev</dd>
              </div>
              <div className="kv-row">
                <dt>Challenge</dt>
                <dd className="mono">{result.challenge.amount ?? "—"} USDC</dd>
              </div>
              <div className="kv-row">
                <dt>Request</dt>
                <dd className="mono">{result.requestId ?? "—"}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
