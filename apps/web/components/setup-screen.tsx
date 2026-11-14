"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePollar } from "@pollar/react";
import { SignInPanel } from "@/components/sign-in";

/**
 * The origin to whitelist is whatever the browser is on. Hardcoding local
 * hosts on a deployed app would tell the operator to whitelist the wrong
 * thing. The value is filled in after hydration so the server and client
 * markup agree.
 */
function useCurrentOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  return origin;
}

function Item({
  n,
  title,
  children,
  done,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
  done?: boolean;
}) {
  return (
    <div className="check-item">
      <span className="check-mark" aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      <div>
        <h3>
          {n} · {title}
        </h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function SetupScreen() {
  const { configStatus, retryConfig, isAuthenticated, appConfig } = usePollar();
  const keyLoaded = Boolean(process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY);
  const origin = useCurrentOrigin();

  return (
    <main id="main" className="setup-wrap">
      <div className="site-head setup-head-bar">
        <div className="wordmark">
          <b>TAB</b>
          <span>Setup</span>
        </div>
        <div className="site-head-actions">
          <Link className="link-cta" href="/">
            Home →
          </Link>
          <Link className="link-cta" href="/app">
            Console →
          </Link>
        </div>
      </div>

      <div className="setup-head">
        <div className="eyebrow">Connection</div>
        <h1>
          {configStatus === "ready"
            ? "Pollar is reachable."
            : configStatus === "loading"
              ? "Checking the Pollar connection…"
              : "Pollar is not answering this origin."}
        </h1>
        <p className="lede">
          TAB needs the Pollar application config to render login and the wallet. If this screen is
          what you see instead of the console, fix the two dashboard items below. Nothing is mocked —
          the app will not fake a session.
        </p>
        <div className="meta-strip setup-meta">
          <span
            className={
              configStatus === "ready"
                ? "chip chip-ok"
                : configStatus === "loading"
                  ? "chip chip-quiet"
                  : "chip chip-red"
            }
          >
            {configStatus === "ready"
              ? "Config 200"
              : configStatus === "loading"
                ? "Reading config"
                : "Config failed"}
          </span>
          <span className={keyLoaded ? "chip chip-ink" : "chip chip-red"}>
            {keyLoaded ? "Publishable key loaded" : "Publishable key missing"}
          </span>
          <span className="chip chip-quiet">Origin {origin ?? "…"}</span>
        </div>
        <div className="setup-actions">
          <button className="btn btn-primary" onClick={() => void retryConfig()}>
            Retry connection
          </button>
          <a
            className="btn btn-quiet"
            href="https://dashboard.pollar.xyz"
            target="_blank"
            rel="noreferrer"
          >
            Open Pollar dashboard ↗
          </a>
        </div>
      </div>

      {configStatus === "ready" ? <SignInPanel /> : null}

      <section aria-label="Checklist">
        <div className="section-head">
          <h2>{configStatus === "ready" ? "Dashboard settings" : "Two fixes, then it works"}</h2>
          <span className="count">Developers → Websites / Redirect URIs</span>
        </div>
        <div className="checklist">
          <Item n="01" title="Add this origin">
            Developers → <strong>Websites</strong>. The config route returns{" "}
            <span className="mono">403 ORIGIN_NOT_ALLOWED</span> when the current origin is missing.
            Add this origin:
            <span className="values">
              <code>{origin ?? "…"}</code>
            </span>
          </Item>
          <Item n="02" title="Add the OAuth redirect URIs">
            Developers → <strong>Redirect URIs</strong>. An empty list refuses every login with{" "}
            <span className="mono">APPLICATION_HAS_NO_REDIRECT_URIS</span>. Add both forms, with and
            without a trailing slash:
            <span className="values">
              <code>{origin ?? "…"}</code>
              <code>{origin ? `${origin}/` : "…"}</code>
            </span>
          </Item>
          <Item n="03" title="Keep Stellar on; create wallets at login">
            Wallets → Settings → <strong>Enabled chains: Stellar</strong>. Wallet creation:{" "}
            <strong>At login</strong>. Starting balance / funding mode: <strong>Immediate</strong> so
            the demo can transact right away.
          </Item>
          <Item n="04" title="Signature confirmation: ask once per window">
            Wallets → Settings → <strong>Signature confirmation</strong>. Recommended for the demo:
            <span className="mono"> WINDOW · 300 s · $50</span>. TAB has its own approval layer; this
            is the second signature. The console renders Pollar&apos;s prompt — it is never hidden.
            {appConfig?.application?.signConfirmation ? (
              <>
                <br />
                <span className="mono" style={{ fontSize: 11 }}>
                  Current app setting: {appConfig.application.signConfirmation.mode} ·{" "}
                  {appConfig.application.signConfirmation.windowSeconds}s · $
                  {appConfig.application.signConfirmation.maxUsd}
                </span>
              </>
            ) : null}
          </Item>
          <Item n="05" title="Testnet USDC enabled, fees sponsored">
            Assets → testnet USDC issuer <span className="mono">GBBD47IF…H3ZLLFLA5</span>, 7
            decimals. Sponsorship ON, app on credits. The human needs no XLM for fees.
          </Item>
          <Item n="06" title="Fund the human wallet with test USDC">
            Faucet: <span className="mono">faucet.circle.com</span> → Stellar testnet → the wallet
            address shown in the console. Without a balance the settlement fails with{" "}
            <span className="mono">INSUFFICIENT_BALANCE</span>.
          </Item>
          <Item n="07" title="Leave Cards, KYC and ramps OFF">
            Pollar Cards is Live-only and requires KYC. TAB simulates the card rail on testnet with
            one-time charge tokens. That is a deliberate product boundary, not a missing feature.
          </Item>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Verify</h2>
          <span className="count">Run these locally</span>
        </div>
        <pre className="json-view">{`pnpm smoke                 # key + origin
curl -s "$TAB_API_URL/health" | jq
open ${origin ?? "<this origin>"}`}</pre>
        <p className="signer-note" style={{ marginTop: 10 }}>
          Success looks like: <span className="mono">GET /v3/applications/config → 200</span>, the
          Google window opens, and <span className="mono">wallet.provisioning === &quot;READY&quot;</span>{" "}
          within ten seconds.
        </p>
      </section>

      {isAuthenticated ? (
        <p className="signer-note">
          You are signed in to Pollar but not to the TAB API.{" "}
          <Link href="/app" className="inline-link">
            Retry the console
          </Link>
          .
        </p>
      ) : null}
    </main>
  );
}
