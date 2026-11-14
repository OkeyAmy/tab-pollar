"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { Charge } from "@tab/shared";
import { useTab } from "@/components/tab-store";
import { ConsoleUIContext } from "@/components/console-ui";
import { Rail } from "@/components/rail";
import { SignerConsole, SignerInlineBar } from "@/components/signer-console";
import { CreateAgentDialog, OpenTabDialog } from "@/components/tab-dialogs";
import { ReceiptDrawer } from "@/components/receipt-drawer";
import { ErrorBox, Toasts } from "@/components/ui";
import { SignInPanel } from "@/components/sign-in";

function GateScreen() {
  const router = useRouter();
  const { phase, bootError, retrySession, signOut } = useTab();

  return (
    <main id="main" className="setup-wrap" style={{ maxWidth: 560 }}>
      <div className="wordmark">
        <b>TAB</b>
        <span>Console</span>
      </div>

      {phase === "signed-out" ? (
        <>
          <div style={{ display: "grid", gap: 10 }}>
            <h1 className="display" style={{ fontSize: 44 }}>
              Sign in to give your agent a budget.
            </h1>
            <p className="lede">
              Use Google. Pollar creates the wallet; there is no seed phrase, no extension and no gas.
              Then create an agent, open a tab, and try a purchase.
            </p>
          </div>
          <SignInPanel />
          <Link className="btn btn-sm btn-quiet" href="/app/setup">
            Setup checklist
          </Link>
        </>
      ) : phase === "waiting-wallet" ? (
        <>
          <h1 className="display" style={{ fontSize: 40 }}>
            Creating your wallet.
          </h1>
          <p className="lede">
            Pollar is setting up the Stellar wallet for this session. This usually takes a few
            seconds.
          </p>
          <div className="skeleton" style={{ height: 120 }} />
          <button className="btn btn-sm" onClick={() => retrySession()}>
            Check again
          </button>
        </>
      ) : phase === "verifying" ? (
        <>
          <h1 className="display" style={{ fontSize: 40 }}>
            Checking your sign-in.
          </h1>
          <p className="lede">
            TAB verifies the sign-in with Pollar before it loads your agents and cards. Nothing is
            trusted from the browser alone.
          </p>
          <div className="skeleton" style={{ height: 80 }} />
        </>
      ) : (
        <>
          <h1 className="display" style={{ fontSize: 40 }}>
            The sign-in was not accepted.
          </h1>
          <p className="lede">
            The API rejected the Pollar token, or it could not be reached. Sign in again — nothing
            falls back to a browser-supplied wallet.
          </p>
          {bootError ? <ErrorBox error={bootError} onRetry={() => retrySession()} retryLabel="Retry" /> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await signOut();
                router.replace("/");
              }}
            >
              Sign in again
            </button>
            <Link className="btn btn-quiet" href="/app/setup">
              Setup checklist
            </Link>
          </div>
          {bootError?.code === "API_UNREACHABLE" ? (
            <p className="signer-note">
              The web app is running, but the TAB API is not answering. Start it with{" "}
              <span className="mono">pnpm dev:api</span>.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { phase, charges, csrfReady } = useTab();
  const [agentOpen, setAgentOpen] = useState(false);
  const [tabOpen, setTabOpen] = useState(false);
  const [tabAgent, setTabAgent] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [signerOpen, setSignerOpen] = useState(false);

  const openTab = useCallback((agentId?: string | null) => {
    setTabAgent(agentId ?? null);
    setTabOpen(true);
  }, []);
  const openAgent = useCallback(() => setAgentOpen(true), []);
  const openReceipt = useCallback((charge: Charge) => setReceiptId(charge.id), []);
  const openSigner = useCallback(() => setSignerOpen(true), []);

  const ui = useMemo(
    () => ({ openTab, openAgent, openReceipt, openSigner }),
    [openTab, openAgent, openReceipt, openSigner],
  );

  if (phase !== "ready") {
    return (
      <>
        <GateScreen />
        <Toasts />
      </>
    );
  }

  const receipt = receiptId ? charges.find((charge) => charge.id === receiptId) ?? null : null;

  return (
    <ConsoleUIContext.Provider value={ui}>
      <div className="shell">
        <Rail />
        <main className="main" id="main">
          <SignerInlineBar onOpen={openSigner} />
          {!csrfReady ? (
            <div className="error-box" role="status" style={{ margin: "12px 16px 0" }}>
              <div style={{ display: "grid", gap: 4 }}>
                <span className="code">NO_CSRF_TOKEN</span>
                <p>
                  The API returned a session without a <span className="mono">csrfToken</span>.
                  Mutations (approve, revoke, signer claim/result) will be rejected. Reload, or sign in
                  again.
                </p>
              </div>
            </div>
          ) : null}
          {children}
        </main>
        {signerOpen ? (
          <button
            className="signer-scrim"
            aria-label="Close signer console"
            onClick={() => setSignerOpen(false)}
          />
        ) : null}
        <SignerConsole open={signerOpen} onClose={() => setSignerOpen(false)} />
      </div>

      <CreateAgentDialog open={agentOpen} onClose={() => setAgentOpen(false)} onCreated={() => setAgentOpen(false)} />
      <OpenTabDialog open={tabOpen} onClose={() => setTabOpen(false)} defaultAgentId={tabAgent} />
      <ReceiptDrawer charge={receipt} open={Boolean(receipt)} onClose={() => setReceiptId(null)} />
      <Toasts />
    </ConsoleUIContext.Provider>
  );
}
