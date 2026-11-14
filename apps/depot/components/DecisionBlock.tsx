import type { PolicyDecision } from "@tab/shared";
import { decisionChipClass, isPolicyCode, policySentence, policyTone } from "@/lib/policy";

type DecisionBlockProps = {
  decision: PolicyDecision | null;
  /** Present when the API refused the charge outright. */
  code?: string;
  message?: string;
};

export default function DecisionBlock({ decision, code, message }: DecisionBlockProps) {
  const resolvedCode = decision?.code ?? (code && isPolicyCode(code) ? code : null);
  if (!resolvedCode) return null;

  const sentence =
    policySentence(resolvedCode) ??
    decision?.message ??
    message ??
    "TAB refused the charge.";

  const tone = policyTone(resolvedCode);
  const serverMessage = decision?.message ?? message ?? "";
  const showDetail =
    resolvedCode !== "OK" &&
    serverMessage.length > 0 &&
    serverMessage !== sentence &&
    /\d/.test(serverMessage);

  return (
    <section className="mt-5 animate-state" aria-label="Policy decision">
      <div className="flex items-center justify-between gap-3">
        <span className="mono-label">Policy decision</span>
        <span
          className={`max-w-[70%] truncate px-1.5 py-0.5 font-mono text-[9px] leading-tight tracking-[0.06em] ${decisionChipClass(tone)}`}
          title={resolvedCode}
        >
          {resolvedCode}
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-snug">{sentence}</p>
      {showDetail ? (
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted">{serverMessage}</p>
      ) : null}
      {decision?.requiresApproval && resolvedCode === "OK_APPROVAL_REQUIRED" ? (
        <p className="mono-label mt-1.5 text-muted">Above the tap line</p>
      ) : null}
    </section>
  );
}
