"use client";

import { useEffect, useId, useRef } from "react";
import { useTab } from "@/components/tab-store";
import type { GateError } from "@/components/tab-store";

/* ── small typographic glyphs (no icon font, no emoji) ───────────────────── */

export function Arrow({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={className}>
      ↗
    </span>
  );
}

export function Times() {
  return <span aria-hidden="true">×</span>;
}

/* ── dialog ──────────────────────────────────────────────────────────────── */

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export function Dialog({ open, onClose, title, eyebrow, children, footer, width }: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const selector =
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

    const firstField = panel?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    (firstField ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}
      >
        <div className="dialog-head">
          <div style={{ display: "grid", gap: 4 }}>
            {eyebrow ? <span className="micro">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <Times />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </>
  );
}

/* ── side sheet ──────────────────────────────────────────────────────────── */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function Sheet({ open, onClose, title, eyebrow, children, footer }: SheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const selector =
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="sheet-head">
          <div style={{ display: "grid", gap: 4 }}>
            {eyebrow ? <span className="micro">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close panel">
            <Times />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </aside>
    </>
  );
}

/* ── states ──────────────────────────────────────────────────────────────── */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function ErrorBox({
  error,
  onRetry,
  retryLabel = "Retry",
}: {
  error: GateError;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="error-box" role="alert">
      <div style={{ display: "grid", gap: 4 }}>
        <span className="code">{error.code}</span>
        <p>{error.message}</p>
      </div>
      {onRetry ? (
        <button className="btn btn-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="sk-row" key={i}>
          <div className="skeleton sk-line" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
          <div className="skeleton sk-line" />
          <div className="skeleton sk-line" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
          <div className="skeleton sk-line" />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/* ── copy ────────────────────────────────────────────────────────────────── */

export function CopyButton({
  value,
  label = "Copy",
  className = "btn btn-sm btn-quiet",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { toast } = useTab();
  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast("Copied.");
        } catch {
          toast("The clipboard is blocked in this browser.", "error");
        }
      }}
      aria-label={`${label}: ${value}`}
    >
      {label}
    </button>
  );
}

/* ── toasts ──────────────────────────────────────────────────────────────── */

export function Toasts() {
  const { toasts, dismissToast } = useTab();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.tone === "error" ? " is-error" : ""}`}>
          <span className="dot" />
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            className="icon-btn"
            style={{
              width: 20,
              height: 20,
              borderColor: "rgb(242 239 230 / 0.3)",
              color: "var(--paper)",
            }}
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss message"
          >
            <Times />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── gate badges ─────────────────────────────────────────────────────────── */

export function SignatureBadge({ compact = false }: { compact?: boolean }) {
  const { signatureGate } = useTab();
  const toneClass =
    signatureGate.tone === "red"
      ? "chip chip-red"
      : signatureGate.tone === "ink"
        ? "chip chip-ink"
        : "chip chip-quiet";

  return (
    <span
      className={toneClass}
      title={signatureGate.detail}
      aria-label={`Approval: ${signatureGate.label}. ${signatureGate.detail}`}
    >
      <span
        className={`dot ${signatureGate.tone === "red" ? "dot-red" : "dot-live"}`}
        aria-hidden="true"
      />
      {compact ? "Wallet approval" : `Approval · ${signatureGate.label}`}
    </span>
  );
}
