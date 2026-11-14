"use client";

import { PollarProvider } from "@pollar/react";
import { useEffect, useState } from "react";
import { TabProvider } from "@/components/tab-store";

const apiKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? "";

/**
 * The Pollar client touches browser storage and a non-extractable WebCrypto key,
 * so it must not be constructed during prerender. Render a brand-consistent boot
 * frame on the server, then mount the provider in the browser.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <main id="main" className="setup-wrap" style={{ maxWidth: 720 }}>
        <div className="wordmark">
          <b>TAB</b>
          <span>Give your agent a budget</span>
        </div>
        <div className="skeleton" style={{ height: 44, width: "46%" }} />
        <div className="skeleton" style={{ height: 150 }} />
        <p className="signer-note">Loading the secure wallet session…</p>
      </main>
    );
  }

  return (
    <PollarProvider client={{ apiKey }}>
      <TabProvider>{children}</TabProvider>
    </PollarProvider>
  );
}
