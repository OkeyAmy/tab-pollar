"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";
import { useTab } from "@/components/tab-store";
import { EmptyState } from "@/components/ui";

function CardRoute() {
  const params = useParams<{ id: string }>();
  const cardId = typeof params?.id === "string" ? params.id : Array.isArray(params?.id) ? params.id[0] : null;
  const { phase, cards, selectCard, loading } = useTab();

  useEffect(() => {
    if (!cardId) return;
    if (!cards.some((card) => card.id === cardId)) return;
    selectCard(cardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, cards.length]);

  const exists = cardId ? cards.some((card) => card.id === cardId) : false;

  if (phase === "ready" && cardId && !exists && !loading) {
    return (
      <>
        <header className="main-head">
          <div>
            <h1>Card not found</h1>
            <div className="sub">
              <span className="mono" style={{ fontSize: 11 }}>
                {cardId}
              </span>
            </div>
          </div>
        </header>
        <div className="main-body">
          <EmptyState
            title="That card isn't on this account."
            body="The rail lists every card the API returned for your verified session. The link may come from another session, or the demo data was reset."
            action={
              <Link className="btn btn-sm btn-primary" href="/app">
                Back to the latest card
              </Link>
            }
          />
        </div>
      </>
    );
  }

  return <Dashboard />;
}

export default function CardPage() {
  return (
    <AppShell>
      <CardRoute />
    </AppShell>
  );
}
