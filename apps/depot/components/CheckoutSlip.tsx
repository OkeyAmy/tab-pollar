"use client";

import { useId, type ReactNode } from "react";
import type { CatalogMerchant } from "@/lib/catalogue";
import { maskToken, money } from "@/lib/format";
import type { ManualFields, SlipMode, SlipOrder, SlipPhase } from "@/lib/slip";
import { isRetryable } from "@/lib/policy";
import DecisionBlock from "./DecisionBlock";
import { ChargeStatePanel, ErrorPanel, SendingPanel } from "./SlipStates";

type CheckoutSlipProps = {
  phase: SlipPhase;
  mode: SlipMode;
  onModeChange: (mode: SlipMode) => void;
  order: SlipOrder;
  token: string;
  onTokenChange: (value: string) => void;
  submittedToken: string | null;
  manual: ManualFields;
  onManualChange: (patch: Partial<ManualFields>) => void;
  merchants: CatalogMerchant[];
  busy: boolean;
  formError: string | null;
  timedOut: boolean;
  elapsedSec: number;
  fulfilmentKey: string | null;
  consoleUrl: string;
  sheetOpen: boolean;
  onClose: () => void;
  onPresent: () => void;
  onRetry: () => void;
  onCheckAgain: () => void;
  onNewSale: () => void;
  onEdit: () => void;
};

export default function CheckoutSlip(props: CheckoutSlipProps) {
  const {
    phase,
    mode,
    onModeChange,
    order,
    token,
    onTokenChange,
    submittedToken,
    manual,
    onManualChange,
    merchants,
    busy,
    formError,
    timedOut,
    elapsedSec,
    fulfilmentKey,
    consoleUrl,
    sheetOpen,
    onClose,
    onPresent,
    onRetry,
    onCheckAgain,
    onNewSale,
    onEdit,
  } = props;

  const uid = useId();
  const tokenId = `${uid}-token`;
  const merchantFieldId = `${uid}-merchant`;
  const amountFieldId = `${uid}-amount`;
  const descriptionFieldId = `${uid}-description`;

  const editable = phase.kind === "idle" || phase.kind === "error";
  const manualAsset =
    merchants.find((merchant) => merchant.id === manual.merchantId)?.asset ?? null;
  const slipNumber =
    phase.kind === "live" ? phase.charge.id.slice(-4).toUpperCase() : phase.kind === "sending" ? "0002" : "0001";

  return (
    <aside
      id="checkout-slip"
      aria-label="Checkout slip"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      className={[
        "border border-ink bg-paper-raised",
        sheetOpen
          ? "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-40 max-lg:max-h-[92dvh] max-lg:overflow-y-auto max-lg:overscroll-contain max-lg:border-x-0 max-lg:border-b-0"
          : "max-lg:hidden",
        "lg:sticky lg:top-6",
      ].join(" ")}
    >
      <div className="no-print flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 lg:hidden">
        <div className="flex items-center gap-2.5">
          <span className="sheet-handle" aria-hidden="true" />
          <span className="mono-label">Checkout slip</span>
        </div>
        <button type="button" onClick={onClose} className="link-mono">
          Close
        </button>
      </div>

      <div className="px-5 pb-6 pt-5 sm:px-6">
        <div className="text-center">
          <p className="font-serif text-[21px] uppercase leading-none tracking-[0.18em]">Agent Depot</p>
          <p className="mono-label mt-2">Checkout slip · Station 01</p>
          <p className="mono-label mt-1 text-muted">No. {slipNumber}</p>
        </div>

        <div className="slip-dot mt-4" />

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onPresent();
          }}
        >
          <div className="mt-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mono-label">Item</p>
              <p className="mt-1 font-serif text-[19px] leading-[1.1]">{order.title}</p>
              <p className="mono-label mt-1.5 truncate text-muted">
                {order.merchantName}
                {order.unit ? ` · ${order.unit}` : ""}
              </p>
            </div>

            {editable ? (
              <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
                <ModeButton active={mode === "item"} onClick={() => onModeChange("item")}>
                  Item
                </ModeButton>
                <span aria-hidden="true" className="text-[10px] text-line">
                  /
                </span>
                <ModeButton active={mode === "manual"} onClick={() => onModeChange("manual")}>
                  Merchant
                </ModeButton>
              </div>
            ) : null}
          </div>

          {editable && mode === "manual" ? (
            <div className="mt-3 space-y-2.5">
              <label htmlFor={merchantFieldId} className="block">
                <span className="mono-label">Supplier</span>
                <select
                  id={merchantFieldId}
                  value={manual.merchantId}
                  onChange={(event) => onManualChange({ merchantId: event.target.value })}
                  className="mt-1 w-full border border-line bg-paper-raised px-2.5 py-2 font-mono text-[13px]"
                >
                  {merchants.map((merchant) => (
                    <option key={merchant.id} value={merchant.id}>
                      {merchant.name}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor={amountFieldId} className="block">
                <span className="mono-label">
                  Amount{manualAsset ? `, ${manualAsset}` : ""}
                </span>
                <input
                  id={amountFieldId}
                  value={manual.amount}
                  onChange={(event) => onManualChange({ amount: event.target.value })}
                  inputMode="decimal"
                  placeholder="2.50"
                  autoComplete="off"
                  className="mt-1 w-full border border-line bg-paper-raised px-2.5 py-2 font-mono text-[16px] tnum sm:text-[13px]"
                />
              </label>

              <label htmlFor={descriptionFieldId} className="block">
                <span className="mono-label">Description</span>
                <input
                  id={descriptionFieldId}
                  value={manual.description}
                  onChange={(event) => onManualChange({ description: event.target.value })}
                  maxLength={120}
                  placeholder="Merchant redemption"
                  className="mt-1 w-full border border-line bg-paper-raised px-2.5 py-2 text-[16px] sm:text-[13px]"
                />
              </label>

              <p className="border-l-2 border-line pl-2 text-[10.5px] leading-relaxed text-muted">
                Same redemption path. The token is posted to TAB exactly as a catalogue sale; the
                only difference is that the supplier and amount come from this slip.
              </p>
            </div>
          ) : null}

          <div className="slip-dot mt-4" />

          <div className="mt-3 space-y-1.5 font-mono text-[12px] tnum">
            <TotalRow label="Unit" value={money(order.amount, order.asset)} />
            <TotalRow label="Quantity" value="1" />
          </div>

          <div className="mt-3 flex items-baseline justify-between border-t border-ink pt-2">
            <span className="mono-label">{order.asset ? `Total, ${order.asset}` : "Total"}</span>
            <span className="font-mono text-[22px] leading-none tnum">
              {money(order.amount, order.asset)}
            </span>
          </div>

          <div className="relative mt-5">
            <div className="slip-dash" />
            <span className="mono-label absolute -top-1.5 left-1/2 -translate-x-1/2 bg-paper-raised px-2 text-muted">
              {editable ? "Present below" : "Tab"}
            </span>
          </div>

          {editable ? (
            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={tokenId} className="mono-label">
                  Tab token
                </label>
                <span className="mono-label text-muted">single use · 5 min</span>
              </div>
              <input
                id={tokenId}
                value={token}
                onChange={(event) => onTokenChange(event.target.value)}
                placeholder="tab_ch_…"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mt-2 w-full border border-ink bg-transparent px-3 py-2.5 font-mono text-[16px] tracking-[0.02em] placeholder:tracking-normal sm:text-[12.5px]"
              />
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
                Starts with tab_ch_. The agent gets it from TAB; the till redeems it once.
              </p>
              {formError ? (
                <p
                  role="alert"
                  className="mt-2 border-l-2 border-signal pl-2 text-[12px] leading-relaxed"
                >
                  {formError}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 flex items-baseline justify-between gap-3">
              <span className="mono-label">Token</span>
              <span className="break-all text-right font-mono text-[10.5px] leading-relaxed text-muted">
                {submittedToken ? maskToken(submittedToken) : "—"}
              </span>
            </div>
          )}

          {editable ? (
            <button
              type="submit"
              disabled={busy || token.trim().length === 0}
              className="mt-4 w-full border border-ink bg-acid px-3 py-3 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors hover:bg-ink hover:text-acid disabled:border-line disabled:bg-paper disabled:text-muted disabled:hover:bg-paper disabled:hover:text-muted active:translate-y-px disabled:active:translate-y-0"
            >
              {busy ? "Presenting…" : "Present the tab"}
            </button>
          ) : null}
        </form>

        {phase.kind === "live" ? (
          <DecisionBlock decision={phase.charge.decision} />
        ) : phase.kind === "error" ? (
          <DecisionBlock
            decision={phase.decision}
            code={phase.code}
            message={phase.message}
          />
        ) : null}

        {phase.kind === "sending" ? <SendingPanel /> : null}

        {phase.kind === "live" ? (
          <ChargeStatePanel
            charge={phase.charge}
            order={order}
            fulfilmentKey={fulfilmentKey}
            consoleUrl={consoleUrl}
            timedOut={timedOut}
            elapsedSec={elapsedSec}
            onCheckAgain={onCheckAgain}
            onNewSale={onNewSale}
          />
        ) : null}

        {phase.kind === "error" ? (
          <ErrorPanel
            code={phase.code}
            message={phase.message}
            httpStatus={phase.httpStatus}
            retryable={isRetryable(phase.code, phase.httpStatus)}
            onRetry={onRetry}
            onEdit={onEdit}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`font-mono text-[9px] uppercase tracking-[0.12em] underline-offset-4 ${
        active ? "text-ink underline decoration-1" : "text-muted hover:text-ink hover:underline"
      }`}
    >
      {children}
    </button>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}
