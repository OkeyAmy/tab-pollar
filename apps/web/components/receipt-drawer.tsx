"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Charge } from "@tab/shared";
import { useEffect, useState } from "react";
import { isTokenError, useTab } from "@/components/tab-store";
import { CopyButton, Sheet } from "@/components/ui";
import { ApiError, getCharge, type ChargeDetail, type PurchaseInfo } from "@/lib/api";
import type { ChargeLike } from "@/lib/format";
import {
  clockTime,
  decisionSentence,
  isUnverified,
  isVerified,
  onchainAmount,
  shortHash,
  usd,
} from "@/lib/format";

function verification(charge: Charge): {
  label: string;
  className: string;
  detail: string;
} {
  if (isVerified(charge)) {
    return {
      label: "Verified on-chain",
      className: "chip chip-ok",
      detail: "The API fetched this transaction and matched destination, amount, asset and memo.",
    };
  }
  if (isUnverified(charge)) {
    return {
      label: "Unverified",
      className: "chip chip-red",
      detail:
        "The API could not verify this transaction on-chain. The hash is a claim, not proof.",
    };
  }
  return {
    label: "Not checked yet",
    className: "chip chip-quiet",
    detail: "The API has not reported an on-chain verification for this charge.",
  };
}

export function ReceiptDrawer({
  charge,
  open,
  onClose,
}: {
  charge: Charge | null;
  open: boolean;
  onClose: () => void;
}) {
  const { approve, decline, signOut } = useTab();
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [detail, setDetail] = useState<ChargeDetail | null>(null);

  const chargeId = charge?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setActionError(null);
    setNeedsSignIn(false);
    if (!open || !chargeId) return;
    let cancelled = false;
    getCharge(chargeId)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch(() => {
        // The list copy is enough; a detail failure must not blank the drawer.
      });
    return () => {
      cancelled = true;
    };
  }, [open, chargeId]);

  if (!charge) return null;

  const merged = {
    ...charge,
    ...(detail?.charge ?? {}),
    onchainVerified:
      detail?.onchainVerified ?? (charge as ChargeLike).onchainVerified ?? undefined,
  } as ChargeLike;
  const purchase: PurchaseInfo | null =
    detail?.purchase ?? ((charge as Charge & { purchase?: PurchaseInfo }).purchase ?? null);
  const approvalUrl: string | null =
    detail?.approvalUrl ?? (charge as Charge & { approvalUrl?: string }).approvalUrl ?? null;

  const receipt = merged.receipt;
  const verificationReason = (
    receipt as (typeof receipt & { verificationReason?: string }) | null
  )?.verificationReason;
  const check = verification(merged);
  const awaiting = merged.status === "AWAITING_APPROVAL";

  const run = async (action: "approve" | "decline") => {
    setBusy(action);
    setActionError(null);
    setNeedsSignIn(false);
    try {
      if (action === "approve") await approve(merged.id);
      else await decline(merged.id);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      if (isTokenError(code)) {
        setNeedsSignIn(true);
      } else {
        setActionError(error instanceof Error ? error.message : "The action failed.");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={receipt ? "Receipt" : awaiting ? "Approval" : "Charge"}
      title={charge.merchantName || charge.merchantId}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 26, letterSpacing: "-0.02em" }}>
          {receipt ? onchainAmount(receipt.amount, receipt.asset) : usd(merged.amount)}
        </span>
        {receipt ? (
          <span className={check.className} title={check.detail}>
            {check.label}
          </span>
        ) : (
          <span className={awaiting ? "chip chip-ink" : "chip chip-quiet"}>
            {awaiting ? "Awaiting approval" : merged.status.replaceAll("_", " ").toLowerCase()}
          </span>
        )}
      </div>

      {awaiting ? (
        <div className="signer-window is-open">
          <div className="window-line">
            <span className="window-ring" aria-hidden="true" />
            Waiting for you
          </div>
          <p className="signer-note">
            Above your card&apos;s approval line. Approving moves it to the signer queue; your
            wallet still signs the payment itself.
          </p>
          <div className="approval-actions">
            <button
              className="btn btn-sm btn-danger"
              onClick={() => void run("decline")}
              disabled={busy !== null}
              aria-busy={busy === "decline"}
            >
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void run("approve")}
              disabled={busy !== null}
              aria-busy={busy === "approve"}
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
          </div>
          {needsSignIn ? (
            <div className="error-box" role="alert" style={{ padding: 10 }}>
              <div style={{ display: "grid", gap: 3 }}>
                <span className="code">POLLAR_TOKEN_EXPIRED</span>
                <p>Sign in again to approve.</p>
              </div>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  await signOut();
                  router.replace("/");
                }}
              >
                Sign in again
              </button>
            </div>
          ) : null}
          {actionError ? (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          ) : null}
          {approvalUrl ? (
            <a
              className="btn btn-sm btn-quiet"
              href={approvalUrl}
              target="_blank"
              rel="noreferrer"
            >
              Approval link ↗
            </a>
          ) : null}
        </div>
      ) : null}

      {receipt ? (
        <p className="signer-note">
          {check.detail}
          {verificationReason ? ` Reason: ${verificationReason}.` : ""}
        </p>
      ) : null}

      <dl className="kv">
        <div className="kv-row">
          <dt>Status</dt>
          <dd>{merged.status.replaceAll("_", " ")}</dd>
        </div>
        <div className="kv-row">
          <dt>Decision</dt>
          <dd title={merged.decision?.code}>
            {merged.decision?.code ?? "—"} · {decisionSentence(merged)}
          </dd>
        </div>
        <div className="kv-row">
          <dt>Description</dt>
          <dd>{merged.description || "—"}</dd>
        </div>
        <div className="kv-row">
          <dt>Tab amount</dt>
          <dd>{usd(merged.amount)}</dd>
        </div>
        {purchase ? (
          <div className="kv-row">
            <dt>License</dt>
            <dd>
              <code className="inline">{purchase.licenseKey}</code>
              <div className="copy-row" style={{ marginTop: 6 }}>
                <CopyButton value={purchase.licenseKey} label="Copy license" />
                <span className="mono muted" style={{ fontSize: 9 }}>
                  {purchase.skuId} · {purchase.purchaseId}
                </span>
              </div>
            </dd>
          </div>
        ) : null}
        {receipt ? (
          <>
            <div className="kv-row">
              <dt>Chain</dt>
              <dd>{receipt.chain}</dd>
            </div>
            <div className="kv-row">
              <dt>Asset</dt>
              <dd>{receipt.asset}</dd>
            </div>
            <div className="kv-row">
              <dt>On-chain amount</dt>
              <dd>{onchainAmount(receipt.amount, receipt.asset)}</dd>
            </div>
            <div className="kv-row">
              <dt>Memo</dt>
              <dd>{receipt.memo || "—"}</dd>
            </div>
            <div className="kv-row">
              <dt>Confirmed</dt>
              <dd>
                {receipt.confirmedAt
                  ? `${clockTime(receipt.confirmedAt)} · ${new Date(receipt.confirmedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                  : "—"}
              </dd>
            </div>
            <div className="kv-row">
              <dt>Tx hash</dt>
              <dd>
                <span>{shortHash(receipt.hash, 12, 10)}</span>
                <div className="copy-row" style={{ marginTop: 6 }}>
                  <CopyButton value={receipt.hash} label="Copy hash" />
                  {isUnverified(charge) ? (
                    <span className="mono" style={{ fontSize: 10, color: "var(--signal-red-ink)" }}>
                      Not proof — verification failed.
                    </span>
                  ) : receipt.explorerUrl ? (
                    <a
                      className="btn btn-sm btn-quiet"
                      href={receipt.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explorer ↗
                    </a>
                  ) : null}
                </div>
              </dd>
            </div>
          </>
        ) : (
          <div className="kv-row">
            <dt>Receipt</dt>
            <dd>
              {charge.status === "FAILED"
                ? charge.error || "Settlement failed. No budget was consumed."
                : "No settlement yet. The hash appears once the signer reports it."}
            </dd>
          </div>
        )}
      </dl>

      {receipt && receipt.asset === "XLM" ? (
        <p className="signer-note">
          This merchant settles in testnet XLM. The tab&apos;s budget is denominated in USD for
          display; the on-chain amount above is XLM.
        </p>
      ) : null}

      <div className="copy-row">
        <CopyButton value={merged.id} label="Copy charge id" />
        <span className="mono muted" style={{ fontSize: 10 }}>
          {merged.id}
        </span>
      </div>

      <Link className="btn btn-sm btn-quiet" href={`/app/cards/${merged.cardId}`} onClick={onClose}>
        View card ↗
      </Link>
    </Sheet>
  );
}
