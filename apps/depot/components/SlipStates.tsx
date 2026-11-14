"use client";

import type { Charge } from "@tab/shared";
import { isPolicyCode, policySentence, statusCopy } from "@/lib/policy";
import { utcStamp } from "@/lib/format";
import type { SlipOrder } from "@/lib/slip";
import Receipt from "./Receipt";

const CONSOLE_FALLBACK = "http://localhost:3000";

export function SendingPanel() {
  return (
    <div className="mt-5 border-t border-line pt-4 animate-state" aria-live="polite">
      <p className="mono-label">Presenting the tab</p>
      <p className="mt-2 font-serif text-[20px] leading-tight">
        Handing the token to TAB. <span className="blink">▌</span>
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        The policy check runs before any money moves.
      </p>
    </div>
  );
}

type ChargeStatePanelProps = {
  charge: Charge;
  order: SlipOrder;
  fulfilmentKey: string | null;
  consoleUrl?: string;
  timedOut: boolean;
  elapsedSec: number;
  onCheckAgain: () => void;
  onNewSale: () => void;
};

export function ChargeStatePanel({
  charge,
  order,
  fulfilmentKey,
  consoleUrl = CONSOLE_FALLBACK,
  timedOut,
  elapsedSec,
  onCheckAgain,
  onNewSale,
}: ChargeStatePanelProps) {
  if (charge.status === "SETTLED") {
    return (
      <Receipt
        charge={charge}
        order={order}
        fulfilmentKey={fulfilmentKey}
        onNewSale={onNewSale}
      />
    );
  }

  if (charge.status === "AWAITING_APPROVAL") {
    return (
      <section className="mt-5 border border-ink p-4 animate-state" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <span className="mono-label">Needs a human</span>
          <span className="mono-label text-muted">{elapsedSec}s</span>
        </div>
        <p className="mt-2 font-serif text-[23px] leading-[1.08]">
          The human has to approve this.
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          Above the auto-approve line. Nothing has been charged. This slip keeps checking.
        </p>
        <a
          href={consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mono-label mt-4 block border border-ink bg-acid px-3 py-2.5 text-center transition-colors hover:bg-ink hover:text-acid active:translate-y-px"
        >
          Open TAB to approve ↗
        </a>
        <p className="mt-2.5 truncate font-mono text-[10px] text-muted">{charge.id}</p>
      </section>
    );
  }

  if (charge.status === "DECLINED") {
    return (
      <TerminalPanel
        kicker="Declined"
        headline="The human said no."
        detail={charge.declineReason ?? "No reason was given."}
        note="Nothing moved. The token is spent; a new attempt needs a new token."
        onNewSale={onNewSale}
      />
    );
  }

  if (charge.status === "FAILED") {
    return (
      <TerminalPanel
        kicker="Failed"
        headline="The payment failed at settlement."
        detail={charge.error ?? "The wallet reported an error."}
        note="Nothing was confirmed. The token is spent; ask the agent for a new one."
        onNewSale={onNewSale}
      />
    );
  }

  if (charge.status === "EXPIRED") {
    return (
      <TerminalPanel
        kicker="Expired"
        headline="The charge expired before it settled."
        detail={`The window closed at ${utcStamp(charge.updatedAt)}.`}
        note="Nothing was settled. The token is spent; start a new sale."
        onNewSale={onNewSale}
      />
    );
  }

  const meta = statusCopy(charge.status);
  const signing = charge.status === "SIGNING";

  return (
    <section className="mt-5 border-t border-line pt-4 animate-state" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="mono-label">{timedOut ? "Still pending" : meta.label}</span>
        <span className="mono-label text-muted">
          {elapsedSec}s {timedOut ? null : <span className="blink">▌</span>}
        </span>
      </div>
      <p className="mt-2 font-serif text-[21px] leading-tight">
        {timedOut
          ? "Still pending. Nothing is confirmed."
          : signing
            ? "The wallet is signing."
            : "The tab cleared. The wallet is next."}
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        {timedOut
          ? "The slip stopped checking after 90 seconds. The charge may still settle in the wallet; this is not a receipt."
          : signing
            ? "Keep the human's TAB console open. This slip checks every two seconds."
            : "The payment is queued in the human's browser. Keep the TAB console open."}
      </p>
      <p className="mt-2.5 truncate font-mono text-[10px] text-muted">{charge.id}</p>

      {timedOut ? (
        <button type="button" onClick={onCheckAgain} className="link-mono mt-2 inline-block">
          Check once more
        </button>
      ) : null}
    </section>
  );
}

export function TerminalPanel({
  kicker,
  headline,
  detail,
  note,
  onNewSale,
}: {
  kicker: string;
  headline: string;
  detail: string;
  note: string;
  onNewSale: () => void;
}) {
  return (
    <section className="mt-5 border-l-2 border-signal pl-3 animate-state" aria-live="polite">
      <p className="mono-label">{kicker}</p>
      <p className="mt-1.5 font-serif text-[21px] leading-tight">{headline}</p>
      <p className="mt-1.5 text-[12.5px] leading-relaxed">{detail}</p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{note}</p>
      <button type="button" onClick={onNewSale} className="link-mono mt-3 inline-block">
        Start a new sale
      </button>
    </section>
  );
}

export function ErrorPanel({
  code,
  message,
  httpStatus,
  retryable,
  onRetry,
  onEdit,
}: {
  code: string;
  message: string;
  httpStatus: number;
  retryable: boolean;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const policy = isPolicyCode(code);
  const sentence = policy ? policySentence(code) : null;
  const headline =
    code === "NETWORK" || code === "TIMEOUT"
      ? "TAB did not answer."
      : policy
        ? "The tab was refused."
        : "The charge did not go through.";
  // The decision block above already carries the policy sentence. Only repeat
  // the server message here when it adds a concrete detail (e.g. a limit).
  const detail = policy
    ? /\d/.test(message) && message !== sentence
      ? message
      : null
    : message;

  return (
    <section className="mt-5 border-l-2 border-signal pl-3 animate-state" role="alert">
      <p className="mono-label">Not charged</p>
      <p className="mt-1.5 font-serif text-[21px] leading-tight">{headline}</p>
      {detail ? (
        <p className="mt-1.5 text-[12.5px] leading-relaxed">{detail}</p>
      ) : null}
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
        Code · {code}
        {httpStatus > 0 ? ` · HTTP ${httpStatus}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {retryable ? (
          <button type="button" onClick={onRetry} className="link-mono inline-block">
            Try again
          </button>
        ) : null}
        <button type="button" onClick={onEdit} className="link-mono inline-block">
          Edit the slip
        </button>
      </div>
      {code === "TOKEN_ALREADY_USED" ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          A token buys exactly one charge. The agent has to ask TAB for another.
        </p>
      ) : null}
    </section>
  );
}
