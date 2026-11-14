import type { SlipPhase } from "@/lib/slip";
import { statusCopy } from "@/lib/policy";
import { money } from "@/lib/format";

type MobileBarProps = {
  phase: SlipPhase;
  amount: string | null;
  asset: string | null;
  sheetOpen: boolean;
  onOpen: () => void;
};

export default function MobileBar({ phase, amount, asset, sheetOpen, onOpen }: MobileBarProps) {
  const headline =
    phase.kind === "live"
      ? phase.charge.status === "QUEUED" || phase.charge.status === "SIGNING"
        ? "Still pending"
        : statusCopy(phase.charge.status).label
      : phase.kind === "sending"
        ? "Presenting the tab"
        : phase.kind === "error"
          ? "Not charged"
          : "Checkout slip";

  const buttonLabel = sheetOpen
    ? "Slip open"
    : phase.kind === "live" && phase.charge.status === "SETTLED"
      ? "View receipt"
      : phase.kind === "live"
        ? "View status"
        : "Open slip";

  return (
    <div
      className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-ink bg-paper px-5 pt-3 lg:hidden"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="mono-label truncate">{headline}</p>
          <p className="mt-1 font-mono text-[15px] leading-none tnum">{money(amount, asset)}</p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          aria-controls="checkout-slip"
          aria-expanded={sheetOpen}
          className="shrink-0 border border-ink bg-acid px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors hover:bg-ink hover:text-acid active:translate-y-px"
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
