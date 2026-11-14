"use client";

import { useState, type ReactNode } from "react";
import type { Chain, Charge } from "@tab/shared";
import { isHttpsUrl, money, stampDay, utcStamp } from "@/lib/format";
import { isVerifiedReceipt } from "@/lib/receipt";
import type { SlipOrder } from "@/lib/slip";

type ReceiptProps = {
  charge: Charge;
  order: SlipOrder;
  fulfilmentKey: string | null;
  onNewSale: () => void;
};

export default function Receipt({ charge, order, fulfilmentKey, onNewSale }: ReceiptProps) {
  const receipt = charge.receipt;
  const explorer = receipt && isHttpsUrl(receipt.explorerUrl) ? receipt.explorerUrl : null;
  const confirmedAt = receipt?.confirmedAt ?? charge.updatedAt;
  const verified = isVerifiedReceipt(charge);
  const displayAsset = receipt?.asset ?? charge.asset;

  return (
    <section className="print-slip mt-5 animate-state" aria-label="Receipt">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mono-label">{verified ? "Settled" : "Settled · not verified"}</p>
          <p className="mt-1 font-mono text-[30px] leading-none tracking-[-0.01em] tnum">
            {money(charge.amount, displayAsset)}
          </p>
          <p className="mono-label mt-2">
            {receipt ? `${receipt.asset} · ${chainLabel(receipt.chain)}` : charge.asset}
          </p>
        </div>
        {verified ? (
          <div className="paid-stamp stamp-in mt-0.5 shrink-0 px-2.5 py-1.5 text-center">
            <span className="block font-serif text-[22px] leading-none tracking-[0.08em]">
              PAID
            </span>
            <span className="mt-1 block font-mono text-[8px] leading-none tracking-[0.16em]">
              {stampDay(confirmedAt)}
            </span>
          </div>
        ) : (
          <div className="stamp-in mt-0.5 shrink-0 border border-signal px-2 py-1.5 text-center">
            <span className="mono-label">Unverified</span>
          </div>
        )}
      </div>

      {!verified ? (
        <p className="mt-3 border-l-2 border-signal pl-2 text-[11.5px] leading-relaxed">
          TAB has not confirmed this transaction on-chain. Keep the slip, but do not treat it as
          paid until the console verifies the hash.
        </p>
      ) : null}

      <dl className="mt-5 space-y-2 border-t border-ink pt-3 font-mono text-[11px] leading-relaxed tnum">
        <Row label="Item">{order.title}</Row>
        <Row label="Supplier">{charge.merchantName || order.merchantName}</Row>
        <Row label="Charge">{charge.id}</Row>
        <Row label="Memo" value={receipt?.memo ?? "—"} wrap />
        <Row label="Hash" value={receipt?.hash ?? "not returned"} wrap />
        <Row label="Confirmed">{utcStamp(confirmedAt)}</Row>
      </dl>

      {explorer ? (
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="link-mono mt-3 inline-block"
        >
          View the transaction ↗
        </a>
      ) : (
        <p className="mt-3 border-l-2 border-signal pl-2 text-[11.5px] leading-relaxed">
          {receipt
            ? receipt.explorerUrl
              ? "The explorer link was not HTTPS, so it is not clickable. Use the hash above."
              : "The wallet returned a receipt without an explorer link."
            : "The charge reports settled without a receipt attached. Ask the TAB console for the transaction."}
        </p>
      )}

      {verified && fulfilmentKey ? (
        <div className="mt-5 border border-ink bg-paper p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="mono-label">Fulfilment key</span>
            <CopyButton value={fulfilmentKey} />
          </div>
          <p className="mt-2 break-all border-l-2 border-acid pl-2 font-mono text-[14px] leading-snug tracking-[0.04em]">
            {fulfilmentKey}
          </p>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
            Issued by Agent Depot when the payment settled. It is what the agent came for.
          </p>
        </div>
      ) : null}

      {!verified ? (
        <div className="mt-5 border border-signal bg-paper p-3">
          <p className="mono-label">Fulfilment held</p>
          <p className="mt-1.5 text-[12px] leading-relaxed">
            Fulfilment held until TAB verifies the transaction.
          </p>
          <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-muted">
            {charge.id}
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
        <button
          type="button"
          onClick={() => window.print()}
          className="link-mono no-print inline-block"
        >
          Print receipt
        </button>
        <button type="button" onClick={onNewSale} className="link-mono no-print inline-block">
          New sale
        </button>
        <span className="mono-label text-muted">Keep this slip</span>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  wrap = false,
  children,
}: {
  label: string;
  value?: string;
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={`min-w-0 text-right ${wrap ? "break-all" : "truncate"}`}>
        {children ?? value}
      </dd>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The key is still on screen; no need to shout about the clipboard.
    }
  }

  return (
    <button type="button" onClick={copy} className="link-mono no-print" aria-label="Copy fulfilment key">
      {copied ? "Copied" : "Copy"}
      <span aria-live="polite" className="sr-only">
        {copied ? "Fulfilment key copied" : ""}
      </span>
    </button>
  );
}

function chainLabel(chain: Chain): string {
  return chain === "SOLANA" ? "Solana devnet" : "Stellar testnet";
}
