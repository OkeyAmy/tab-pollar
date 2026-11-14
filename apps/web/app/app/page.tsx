"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";

function ConsoleRoute() {
  const params = useSearchParams();
  const charge = params.get("charge");
  return (
    <AppShell>
      <Dashboard focusChargeId={charge} />
    </AppShell>
  );
}

function Loading() {
  return (
    <main id="main" className="setup-wrap" style={{ maxWidth: 720 }}>
      <div className="skeleton" style={{ height: 48, width: "40%" }} />
      <div className="skeleton" style={{ height: 180 }} />
    </main>
  );
}

export default function ConsolePage() {
  return (
    <Suspense fallback={<Loading />}>
      <ConsoleRoute />
    </Suspense>
  );
}
