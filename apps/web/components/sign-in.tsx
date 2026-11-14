"use client";

import Link from "next/link";
import { usePollar } from "@pollar/react";
import { useState } from "react";

/**
 * The only sign-in path: Google via Pollar. The SDK creates the wallet and keeps
 * the DPoP key in this browser. `configStatus === 'error'` almost always means
 * the origin is not allowlisted in the Pollar dashboard — link to /app/setup.
 */
export function SignInPanel({ compact = false }: { compact?: boolean }) {
  const { login, configStatus, retryConfig, isAuthenticated, wallet, verified, getClient, openTxHistoryModal } =
    usePollar();
  const [started, setStarted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const walletReady =
    Boolean(wallet?.address) && (wallet?.provisioning === "READY" || wallet?.provisioning === undefined);

  const checkWallet = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await getClient().refreshWalletState();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : "The wallet state could not be refreshed.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="signin-box">
      <header>
        <span className="micro">{isAuthenticated ? "Session" : "Sign in"}</span>
        <span className="mono" style={{ fontSize: 9, letterSpacing: "0.1em", color: "var(--muted)" }}>
          GOOGLE · EMBEDDED WALLET
        </span>
      </header>
      <div className="body">
        {configStatus === "loading" ? (
          <>
            <p>Reading the Pollar application config…</p>
            <div className="skeleton" style={{ height: 44 }} />
          </>
        ) : configStatus === "error" ? (
          <>
            <p style={{ color: "var(--ink)" }}>
              Pollar refused this origin, or the config endpoint is unreachable. TAB can&apos;t start
              a wallet without it.
            </p>
            <div className="meta-strip">
              <span className="chip chip-red">Config unavailable</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn-sm" onClick={() => void retryConfig()}>
                Retry config
              </button>
              <Link className="btn btn-sm btn-quiet" href="/app/setup">
                Open setup checklist
              </Link>
            </div>
          </>
        ) : isAuthenticated ? (
          <>
            <p>
              {wallet
                ? walletReady
                  ? "Wallet ready. TAB verifies your Pollar token on the server before it trusts this session."
                  : wallet.provisioning === "FAILED"
                    ? "Pollar could not finish creating this wallet."
                    : "Pollar is creating your wallet. This usually takes a few seconds."
                : "Signed in. Waiting for Pollar to attach a wallet."}
            </p>
            {wallet ? (
              <>
                <div className="field">
                  <label>Wallet</label>
                  <code className="inline" style={{ fontSize: 11 }}>
                    {wallet.address}
                  </code>
                </div>
                <div className="faucet-hint">
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
              </>
            ) : null}
            {wallet && !walletReady ? (
              <button className="btn btn-sm" onClick={() => void checkWallet()} disabled={checking}>
                {checking ? "Checking…" : "Check wallet again"}
              </button>
            ) : null}
            {wallet && walletReady && !verified ? (
              <p className="field-hint">Verifying the Pollar session with the token server…</p>
            ) : null}
            {checkError ? <p className="field-error">{checkError}</p> : null}
            {compact && walletReady ? (
              <Link className="btn btn-primary btn-block" href="/app">
                Continue to console ↗
              </Link>
            ) : null}
            {wallet ? (
              <button className="link-cta" onClick={() => openTxHistoryModal()}>
                Pollar history →
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p>
              One click. No seed phrase, no extension, no gas. Pollar creates the wallet and keeps the
              signing key in this browser session.
            </p>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={() => {
                setStarted(true);
                login({ provider: "google" });
              }}
            >
              Continue with Google
            </button>
            {started ? (
              <p className="field-hint" aria-live="polite">
                A Google window should be open. If nothing appeared, allow popups and try again.
              </p>
            ) : null}
            <div className="meta-strip">
              <span className="chip chip-quiet">No seed phrase</span>
              <span className="chip chip-quiet">Sponsored fees</span>
              <span className="chip chip-quiet">Testnet</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
