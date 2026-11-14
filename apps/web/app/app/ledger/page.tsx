"use client";

import { AppShell } from "@/components/app-shell";
import { LedgerPage } from "@/components/ledger-page";

export default function LedgerRoute() {
  return (
    <AppShell>
      <LedgerPage />
    </AppShell>
  );
}
