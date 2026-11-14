"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Card } from "@tab/shared";
import { useTab } from "@/components/tab-store";
import { PhysicalCard } from "@/components/card";
import { SignInPanel } from "@/components/sign-in";

const SPECIMEN: Card = {
  id: "crd_specimen",
  ownerId: "usr_specimen",
  agentId: "agt_scout",
  label: "Research Scout",
  maskedNumber: "4021 •••• •••• 7F3A",
  status: "ACTIVE",
  chain: "STELLAR",
  asset: "USDC",
  budget: { total: "25", spent: "7.50", reserved: "2.50" },
  limits: { perCharge: "5", daily: "10", autoApproveUnder: "3" },
  merchants: ["mch_exa", "mch_firecrawl"],
  expiresAt: "2026-12-14T12:00:00.000Z",
  createdAt: "2026-11-14T12:00:00.000Z",
  updatedAt: "2026-11-14T12:00:00.000Z",
};

const STEPS = [
  {
    n: "01",
    title: "Sign in with Google",
    body: "A wallet is created. No seed phrase, no extension, no gas.",
    value: "one click",
  },
  {
    n: "02",
    title: "Open a tab",
    body: "Pick a budget, a per-purchase cap, the stores it may use, and when it expires.",
    value: "$25 · $5 · 24h",
  },
  {
    n: "03",
    title: "Your agent buys",
    body: "Via Claude/MCP or the one-click demo. Anything above your line asks you first.",
    value: "> $3 asks you",
  },
];

export function LoginScreen() {
  const router = useRouter();
  const { phase, user } = useTab();

  useEffect(() => {
    if (phase === "ready") router.replace("/app");
  }, [phase, router]);

  return (
    <>
      <header className="site-head">
        <div className="wordmark">
          <b>TAB</b>
          <span>Give your agent a budget</span>
        </div>
        <div className="site-head-actions">
          <span className="chip chip-quiet">Demo · Stellar testnet · USDC</span>
          <Link className="link-cta" href="/app/setup">
            Open setup →
          </Link>
          <Link className="link-cta" href="/app">
            Console →
          </Link>
        </div>
      </header>

      <main className="site-body" id="main">
        <div className="login-gallery">
          <section className="login-hero">
            <div className="eyebrow">Spend management & virtual cards for AI agents</div>
            <h1>
              Give your AI agent a budget.
              <br />
              <em>Not your card.</em>
            </h1>
            <p className="lede">
              Create a card for your agent in 30 seconds. Set a budget, choose where it can spend,
              approve big purchases, and revoke it instantly. Payments settle in USDC on Stellar
              through your Pollar wallet.
            </p>
            <p className="hero-buy">
              <strong>What it can buy:</strong> API credits, datasets, compute, market data.
            </p>
          </section>

          <section className="login-steps" aria-label="How it works">
            <div className="login-steps-head">
              <span className="micro">Three steps</span>
              <span className="micro">About 30 seconds</span>
            </div>
            <ol>
              {STEPS.map((step) => (
                <li className="login-step" key={step.n}>
                  <span className="login-step-n">{step.n}</span>
                  <div>
                    <h2>{step.title}</h2>
                    <p>{step.body}</p>
                  </div>
                  <span className="login-step-v">{step.value}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="login-cta" aria-label="Sign in">
            <div className="login-panel">
              <SignInPanel compact />
              <p className="signer-note">
                {user
                  ? `Signed in as ${user.email ?? user.name ?? "you"}.`
                  : "Pollar runs the login, the wallet and the signature. TAB never stores a key."}
              </p>
            </div>
            <div className="login-specimen">
              <div className="card-stack">
                <PhysicalCard card={SPECIMEN} agentName="Scout" />
                <div className="card-caption">
                  <span>Specimen · not issued</span>
                  <span>340 × 214</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <details className="dev-details">
          <summary>How it works / for developers</summary>
          <div className="dev-details-body">
            <p>
              The agent never holds a private key or a card number. It asks TAB for a single-use
              charge token inside the card&apos;s policy: budget, per-charge cap, daily cap, store
              allowlist and expiry. The JIT policy gate returns a stable reason code such as{" "}
              <span className="mono">AMOUNT_ABOVE_PER_CHARGE</span> or{" "}
              <span className="mono">MERCHANT_NOT_ALLOWED</span>.
            </p>
            <p>
              A passing charge reserves budget and creates a signer job. The human&apos;s browser
              claims the job over SSE and signs the exact Stellar payment with the Pollar session
              (DPoP-bound). The API has no keys. It verifies destination, amount, asset and memo on
              Horizon before marking the charge <span className="mono">SETTLED</span>.
            </p>
            <p>
              Above the approval line, the charge waits for a human click before it reaches the
              signer. The live x402 rail pays a third-party merchant&apos;s HTTP 402 challenge
              directly from the browser (Nirium market data, 0.05 USDC) with host allowlisting and
              SSRF checks on the API side.
            </p>
            <p>
              MCP tools: <span className="mono">list_cards</span>,{" "}
              <span className="mono">get_budget</span>, <span className="mono">buy</span>,{" "}
              <span className="mono">x402_fetch</span>, <span className="mono">list_charges</span>.
              Agent keys are shown once and stored hashed. Card states are{" "}
              <span className="mono">open</span>, <span className="mono">paused</span>,{" "}
              <span className="mono">revoked</span> and <span className="mono">spent</span>.
            </p>
          </div>
        </details>

        <footer className="site-foot">
          <span className="micro">
            Pollar embedded wallet · sponsored fees · Stellar testnet · USDC
          </span>
          <span className="micro">The card is simulated. The payment is not.</span>
        </footer>
      </main>
    </>
  );
}
