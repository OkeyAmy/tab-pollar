"use client";

import { usePollar } from "@pollar/react";
import {
  createBrowserPayer,
  createMockPayer,
  type PollarClientLike,
} from "@tab/pollar";
import { explorerUrl, fromUnits, type SignerEvent } from "@tab/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTab } from "@/components/tab-store";
import { CopyButton, Sheet, SignatureBadge } from "@/components/ui";
import {
  ApiError,
  claimSignerJob,
  getSignerPending,
  postSignerResult,
  X402_MARKET_URL,
  type SignerPaymentExt,
} from "@/lib/api";
import { clockTime, onchainAmount, shortHash } from "@/lib/format";

/* ── x402 helper (lazy: the research agent ships it in parallel) ─────────── */

interface X402Outcome {
  ok: boolean;
  status: number;
  body: unknown;
  txHash?: string | null;
  error?: string | null;
  requestId?: string | null;
  challenge?: unknown;
}

interface X402Payer {
  fetchPaid(url: string): Promise<X402Outcome>;
}

type X402Factory = (client: unknown) => X402Payer;

let x402FactoryPromise: Promise<X402Factory | null> | null = null;

function loadX402Factory(): Promise<X402Factory | null> {
  if (!x402FactoryPromise) {
    x402FactoryPromise = import("@tab/pollar")
      .then((module) => {
        const candidate = (module as unknown as Record<string, unknown>).createX402Payer;
        return typeof candidate === "function" ? (candidate as X402Factory) : null;
      })
      .catch(() => null);
  }
  return x402FactoryPromise;
}

const MOCK_SIGNER = process.env.NEXT_PUBLIC_TAB_SIGNER_MODE === "mock";

/* ── job model ───────────────────────────────────────────────────────────── */

type JobPhase = "queued" | "claimed" | "signing" | "waiting" | "settled" | "failed" | "cancelled";

interface Job {
  chargeId: string;
  payment: SignerPaymentExt;
  phase: JobPhase;
  error?: string | null;
  hash?: string | null;
  at: number;
}

interface LastSignature {
  chargeId: string;
  merchantName: string;
  amount: string;
  asset: string;
  hash: string | null;
  explorer: string | null;
  at: string;
  kind: "stellar" | "x402";
  verified?: boolean;
}

type Connection = "idle" | "connecting" | "online" | "offline";

function errorText(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.sentence };
  if (error instanceof Error) {
    const match = error.message.match(/\b([A-Z][A-Z0-9_]{3,})\b/);
    return { code: match?.[1] ?? "SIGNER_ERROR", message: error.message };
  }
  return { code: "SIGNER_ERROR", message: String(error) };
}

function paymentChainLabel(payment: SignerPaymentExt): string {
  return payment.chain === "SOLANA" ? "Solana devnet" : "Stellar testnet";
}

/* ── the console ─────────────────────────────────────────────────────────── */

export function SignerConsole({
  open = true,
  onClose,
}: {
  open?: boolean;
  onClose?: () => void;
}) {
  const { phase, health, refresh, agents, signatureGate } = useTab();
  const { getClient, confirmations } = usePollar();

  const [windowOpen, setWindowOpen] = useState(true);
  const [connection, setConnection] = useState<Connection>("idle");
  const [signerId, setSignerId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [last, setLast] = useState<LastSignature | null>(null);
  const [signerError, setSignerError] = useState<{ code: string; message: string } | null>(null);
  const [x402Receipt, setX402Receipt] = useState<{
    chargeId: string;
    merchantName: string;
    amount: string;
    asset: string;
    body: unknown;
    hash: string | null;
    challenge: unknown;
  } | null>(null);

  const queueRef = useRef<SignerPaymentExt[]>([]);
  const processingRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const cancelledRef = useRef<Set<string>>(new Set());
  const enabled = phase === "ready";

  /**
   * Signer calls need a fresh Pollar Bearer token too (the API checks it after
   * the stored expiry). Refresh once, then give up with a clear sentence.
   */
  const freshBearer = useCallback(async (): Promise<string> => {
    const client = getClient();
    const read = (): string | null => {
      const auth = client.getAuthState();
      return auth.step === "authenticated" ? (auth.session.token.accessToken ?? null) : null;
    };
    let token = read();
    if (!token) {
      try {
        await client.refresh();
      } catch {
        // fall through to the error below
      }
      token = read();
    }
    if (!token) {
      throw new Error("Sign in again to sign. The Pollar access token is missing or expired.");
    }
    return token;
  }, [getClient]);

  /**
   * Retry once after an SDK refresh when the API rejects a stale Bearer token.
   * The API re-verifies the Pollar token on claim/result after the stored expiry.
   */
  const withFreshAuth = useCallback(
    async <T,>(fn: (bearer: string) => Promise<T>): Promise<T> => {
      let bearer = await freshBearer();
      try {
        return await fn(bearer);
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 ||
            error.code === "POLLAR_TOKEN_EXPIRED" ||
            error.code === "UNAUTHORIZED")
        ) {
          try {
            await getClient().refresh();
          } catch {
            // fall through: freshBearer throws the sign-in sentence
          }
          bearer = await freshBearer();
          return fn(bearer);
        }
        throw error;
      }
    },
    [freshBearer, getClient],
  );

  const updateJob = useCallback((chargeId: string, patch: Partial<Job>) => {
    setJobs((current) => {
      const index = current.findIndex((job) => job.chargeId === chargeId);
      if (index === -1) return current;
      const next = [...current];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  /* ── the signing loop ─────────────────────────────────────────────────── */

  const processNext = useCallback(async () => {
    if (processingRef.current) return;
    if (!windowOpen) return;
    const payment = queueRef.current.shift();
    if (!payment) return;

    if (cancelledRef.current.has(payment.chargeId)) {
      updateJob(payment.chargeId, { phase: "cancelled" });
      void processNext();
      return;
    }

    processingRef.current = true;
    let claimed = false;
    setSignerError(null);

    try {
      updateJob(payment.chargeId, { phase: "claimed" });
      try {
        await withFreshAuth((bearer) => claimSignerJob(payment.chargeId, bearer));
        claimed = true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          updateJob(payment.chargeId, {
            phase: "failed",
            error:
              error.code === "ALREADY_CLAIMED"
                ? "ALREADY_CLAIMED: another signing window claimed this job."
                : `${error.code}: ${error.message}`,
          });
          return;
        }
        throw error;
      }

      updateJob(payment.chargeId, { phase: "signing" });

      if (payment.x402Url) {
        const factory = await loadX402Factory();
        if (!factory) {
          throw new Error(
            "x402 module loading: createX402Payer is not in @tab/pollar yet. Reload after the package updates.",
          );
        }
        const payer = factory(getClient());
        const outcome = await payer.fetchPaid(payment.x402Url);
        const hash = outcome.txHash ?? null;
        await withFreshAuth((bearer) =>
          postSignerResult(
            {
              chargeId: payment.chargeId,
              status: outcome.ok ? "success" : "error",
              hash,
              explorerUrl: hash ? explorerUrl(payment.chain, hash) : null,
              error: outcome.ok ? null : (outcome.error ?? `Merchant answered HTTP ${outcome.status}.`),
              signedAt: new Date().toISOString(),
              body: outcome.body,
              x402RequestId: outcome.requestId ?? null,
            },
            bearer,
          ),
        );
        updateJob(payment.chargeId, {
          phase: outcome.ok ? "settled" : "failed",
          hash,
          error: outcome.ok ? null : (outcome.error ?? null),
        });
        if (outcome.ok) {
          setLast({
            chargeId: payment.chargeId,
            merchantName: payment.merchantName,
            amount: payment.amount,
            asset: payment.asset,
            hash,
            explorer: hash ? explorerUrl(payment.chain, hash) : null,
            at: new Date().toISOString(),
            kind: "x402",
          });
          setX402Receipt({
            chargeId: payment.chargeId,
            merchantName: payment.merchantName,
            amount: payment.amount,
            asset: payment.asset,
            body: outcome.body,
            hash,
            challenge: outcome.challenge ?? payment.x402Challenge ?? null,
          });
        } else {
          setSignerError({
            code: "X402_FAILED",
            message: outcome.error ?? `The merchant answered HTTP ${outcome.status}.`,
          });
        }
      } else {
        const payer = MOCK_SIGNER
          ? createMockPayer({ delayMs: 450 })
          : createBrowserPayer(getClient() as unknown as PollarClientLike, {
              usdcIssuer: process.env.NEXT_PUBLIC_USDC_ISSUER,
            });

        const outcome = await payer.pay({
          ...payment,
          assetIssuer: payment.assetIssuer ?? process.env.NEXT_PUBLIC_USDC_ISSUER ?? null,
        });

        await withFreshAuth((bearer) =>
          postSignerResult(
            {
              chargeId: payment.chargeId,
              status: outcome.status,
              hash: outcome.hash,
              explorerUrl: outcome.explorerUrl,
              error: outcome.error,
              signedAt: new Date().toISOString(),
            },
            bearer,
          ),
        );

        updateJob(payment.chargeId, {
          phase: outcome.status === "error" ? "failed" : "settled",
          hash: outcome.hash,
          error: outcome.error,
        });

        if (outcome.status === "error") {
          setSignerError({
            code: outcome.error?.includes("SDK_CONFIRMATION_UNAVAILABLE")
              ? "SDK_CONFIRMATION_UNAVAILABLE"
              : "SETTLEMENT_ERROR",
            message: outcome.error ?? "The payment failed.",
          });
        } else {
          setLast({
            chargeId: payment.chargeId,
            merchantName: payment.merchantName,
            amount: payment.amount,
            asset: payment.asset,
            hash: outcome.hash,
            explorer: outcome.explorerUrl,
            at: new Date().toISOString(),
            kind: "stellar",
          });
        }
      }

      await refresh();
    } catch (error) {
      const err = errorText(error);
      updateJob(payment.chargeId, { phase: "failed", error: err.message });
      setSignerError(err);
      if (claimed) {
        try {
          await withFreshAuth((bearer) =>
            postSignerResult(
              {
                chargeId: payment.chargeId,
                status: "error",
                hash: null,
                explorerUrl: null,
                error: err.message,
                signedAt: new Date().toISOString(),
              },
              bearer,
            ),
          );
          await refresh();
        } catch {
          // The console stays alive; the job will expire on the server.
        }
      }
    } finally {
      processingRef.current = false;
      if (queueRef.current.length > 0) {
        // Yield so the UI can paint the phase change before the next modal.
        window.setTimeout(() => void processNext(), 60);
      }
    }
  }, [freshBearer, getClient, refresh, updateJob, windowOpen, withFreshAuth]);

  const enqueue = useCallback(
    (payment: SignerPaymentExt) => {
      if (seenRef.current.has(payment.chargeId)) return;
      seenRef.current.add(payment.chargeId);
      setJobs((current) => [
        {
          chargeId: payment.chargeId,
          payment,
          phase: "queued",
          at: Date.now(),
        },
        ...current,
      ]);
      queueRef.current.push(payment);
      void processNext();
    },
    [processNext],
  );

  const recoverPending = useCallback(async () => {
    if (!enabled) return;
    try {
      const pending = await getSignerPending();
      for (const payment of pending) {
        if (cancelledRef.current.has(payment.chargeId)) continue;
        enqueue(payment);
      }
    } catch (error) {
      setSignerError(errorText(error));
    }
  }, [enabled, enqueue]);

  /* ── SSE ──────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!enabled || !windowOpen) {
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    const source = new EventSource("/api/v1/signer/stream");

    const parse = (event: MessageEvent): SignerEvent | null => {
      try {
        return JSON.parse(event.data) as SignerEvent;
      } catch {
        return null;
      }
    };

    source.onopen = () => setConnection("online");
    source.onerror = () => setConnection("offline");

    source.addEventListener("hello", (event) => {
      const parsed = parse(event as MessageEvent);
      if (parsed?.type === "hello") setSignerId(parsed.signerId);
      setConnection("online");
      setSignerError(null);
      void recoverPending();
    });

    source.addEventListener("payment.queued", (event) => {
      const parsed = parse(event as MessageEvent);
      if (parsed?.type !== "payment.queued") return;
      // The API puts x402Url/x402Challenge NEXT TO payment, not inside it.
      const raw = parsed as unknown as {
        payment: SignerPaymentExt;
        x402Url?: string;
        x402Challenge?: unknown;
      };
      enqueue({
        ...raw.payment,
        x402Url: raw.x402Url ?? raw.payment.x402Url ?? null,
        x402Challenge: raw.x402Challenge ?? raw.payment.x402Challenge,
      });
    });

    source.addEventListener("payment.cancelled", (event) => {
      const parsed = parse(event as MessageEvent);
      if (parsed?.type !== "payment.cancelled") return;
      cancelledRef.current.add(parsed.chargeId);
      setJobs((current) =>
        current.map((job) =>
          job.chargeId === parsed.chargeId && (job.phase === "queued" || job.phase === "claimed")
            ? { ...job, phase: "cancelled" }
            : job,
        ),
      );
    });

    source.addEventListener("charge.settled", () => void refresh());
    source.addEventListener("charge.failed", () => void refresh());

    return () => {
      source.close();
      setConnection("idle");
    };
  }, [enabled, windowOpen, generation, enqueue, recoverPending, refresh]);

  /* ── reflect Pollar's confirmation prompt in the job phase ───────────── */

  useEffect(() => {
    setJobs((current) =>
      current.map((job) => {
        if (confirmations.length > 0 && job.phase === "signing") return { ...job, phase: "waiting" };
        if (confirmations.length === 0 && job.phase === "waiting") return { ...job, phase: "signing" };
        return job;
      }),
    );
  }, [confirmations.length]);

  /* ── reopening the window resumes anything already queued ────────────── */

  useEffect(() => {
    if (windowOpen && enabled && queueRef.current.length > 0) {
      void processNext();
    }
  }, [windowOpen, enabled, processNext]);

  /* ── derived ──────────────────────────────────────────────────────────── */

  const counts = useMemo(() => {
    let pending = 0;
    let signed = 0;
    let failed = 0;
    for (const job of jobs) {
      if (job.phase === "queued" || job.phase === "claimed" || job.phase === "signing") pending += 1;
      else if (job.phase === "settled") signed += 1;
      else if (job.phase === "failed") failed += 1;
    }
    return { pending, signed, failed };
  }, [jobs]);

  const badge = MOCK_SIGNER
    ? "SIMULATED"
    : health?.mode === "mainnet"
      ? "MAINNET"
      : "LIVE TESTNET";

  const connectionLabel =
    connection === "online"
      ? "Online"
      : connection === "connecting"
        ? "Connecting"
        : connection === "offline"
          ? "Offline"
          : "Closed";

  const retryJob = (job: Job) => {
    seenRef.current.delete(job.chargeId);
    cancelledRef.current.delete(job.chargeId);
    updateJob(job.chargeId, { phase: "queued", error: null });
    queueRef.current.push(job.payment);
    seenRef.current.add(job.chargeId);
    void processNext();
  };

  return (
    <aside className="signer" aria-label="Payment console" data-open={open}>
      <div className="signer-head">
        <div className="signer-title">
          <h2>Payment console</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="conn" aria-live="polite">
              <span
                className={`dot ${
                  connection === "online"
                    ? "dot-live"
                    : connection === "offline"
                      ? "dot-red"
                      : "dot-muted"
                }`}
              />
              {connectionLabel}
            </span>
            {onClose ? (
              <button className="icon-btn signer-close" onClick={onClose} aria-label="Close payment console">
                ×
              </button>
            ) : null}
          </div>
        </div>
        <div className="meta-strip">
          <span className={MOCK_SIGNER ? "chip chip-red" : "chip chip-ink"}>{badge}</span>
          <SignatureBadge compact />
        </div>
        <p className="signer-note">
          Approval: {signatureGate.label}. {signatureGate.detail}
        </p>
      </div>

      <div className="signer-body">
        <div className={`signer-window${windowOpen ? " is-open" : ""}`}>
          <div className="window-line">
            <span className="window-ring" aria-hidden="true" />
            {windowOpen ? "Ready to sign" : "Signing paused"}
          </div>
          <p className="signer-note">
            {windowOpen
              ? "This tab signs approved payments with your wallet. Close it and queued payments wait."
              : "This console is paused. Queued payments wait until you resume it."}
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              className={windowOpen ? "btn btn-sm" : "btn btn-sm btn-primary"}
              onClick={() => setWindowOpen((open) => !open)}
            >
              {windowOpen ? "Pause payments" : "Resume payments"}
            </button>
            <button
              className="btn btn-sm btn-quiet"
              onClick={() => setGeneration((n) => n + 1)}
              disabled={!windowOpen}
            >
              Reconnect
            </button>
          </div>
        </div>

        {confirmations.length > 0 ? (
          <div className="signer-window is-open" role="status">
            <div className="window-line">
              <span className="dot dot-pulse" aria-hidden="true" />
              Pollar is asking for your signature
            </div>
            <p className="signer-note">
              {confirmations[0].operation ?? "A payment"} on {confirmations[0].network}. Answer the
              Pollar prompt that the provider renders over this console — do not hide it.
            </p>
          </div>
        ) : null}

        <div className="signer-counts">
          <div className="signer-count">
            <span>Pending</span>
            <b>{counts.pending}</b>
          </div>
          <div className="signer-count">
            <span>Signed</span>
            <b>{counts.signed}</b>
          </div>
          <div className="signer-count">
            <span>Failed</span>
            <b style={{ color: counts.failed ? "var(--signal-red-ink)" : undefined }}>{counts.failed}</b>
          </div>
        </div>

        <div className="signer-block">
          <span className="micro">Last payment</span>
          {last ? (
            <div className="last-sig">
              <div className="last-sig-head">
                <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                  {last.kind === "x402" ? "x402 · NIRIUM" : "STELLAR PAYMENT"}
                </span>
                <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
                  {clockTime(last.at)}
                </span>
              </div>
              <b>{onchainAmount(last.amount, last.asset)}</b>
              <span style={{ fontSize: 11 }}>{last.merchantName}</span>
              {last.hash ? (
                <div className="copy-row">
                  <span className="hash" title={last.hash}>
                    {shortHash(last.hash, 10, 6)}
                  </span>
                  {last.explorer ? (
                    <a
                      className="btn btn-sm btn-quiet"
                      href={last.explorer}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explorer ↗
                    </a>
                  ) : null}
                </div>
              ) : (
                <span className="signer-note">Reported without a hash.</span>
              )}
              <span className="signer-note">Reported by this browser. The API verifies it on-chain.</span>
            </div>
          ) : (
            <p className="signer-note">No payment yet. Use Try it as the agent to make one.</p>
          )}
        </div>

        {signerError ? (
          <div className="error-box" role="alert" style={{ padding: 10 }}>
            <div style={{ display: "grid", gap: 3 }}>
              <span className="code">{signerError.code}</span>
              <p>{signerError.message}</p>
            </div>
            <button className="btn btn-sm" onClick={() => setSignerError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="signer-block">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="micro">Jobs · this window</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
              {signerId ? signerId.slice(0, 12) : "—"}
            </span>
          </div>
          {jobs.length === 0 ? (
            <p className="signer-note">
              Connected to the payment bus. Nothing queued. Charges with a passing policy gate land
              here as single-use jobs.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {jobs.slice(0, 6).map((job) => (
                <div className="job" key={job.chargeId}>
                  <div className="job-top">
                    <b>{job.payment.merchantName}</b>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {onchainAmount(job.payment.amount, job.payment.asset)}
                    </span>
                  </div>
                  <div className="job-meta">
                    <span>{paymentChainLabel(job.payment)}</span>
                    <span>
                      {job.phase === "waiting"
                        ? "waiting for you"
                        : job.phase.toUpperCase()}
                    </span>
                  </div>
                  {job.payment.x402Url ? (
                    <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
                      x402 · {new URL(job.payment.x402Url).host}
                    </span>
                  ) : null}
                  {job.error ? <span className="job-error">{job.error}</span> : null}
                  {job.phase === "failed" ? (
                    <button className="btn btn-sm btn-quiet" onClick={() => retryJob(job)}>
                      Retry
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <X402Panel />

        <p className="signer-note" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          Two checks. TAB enforces the card limits; your wallet signs the payment. Passing the limits
          never moves money on its own.
        </p>
        {agents.length === 0 ? null : (
          <p className="signer-note">
            {agents.length} agent{agents.length === 1 ? "" : "s"} can request charges. None of them
            can sign.
          </p>
        )}
      </div>

      <Sheet
        open={Boolean(x402Receipt)}
        onClose={() => setX402Receipt(null)}
        eyebrow="x402 settlement"
        title={x402Receipt?.merchantName ?? "Merchant response"}
      >
        {x402Receipt ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="mono" style={{ fontSize: 22 }}>
                {onchainAmount(x402Receipt.amount, x402Receipt.asset)}
              </span>
              <span className="chip chip-ok">Paid</span>
            </div>
            <dl className="kv">
              <div className="kv-row">
                <dt>Charge</dt>
                <dd>{x402Receipt.chargeId}</dd>
              </div>
              <div className="kv-row">
                <dt>Settlement</dt>
                <dd>
                  {x402Receipt.hash ? (
                    <div className="copy-row">
                      <span>{shortHash(x402Receipt.hash, 12, 10)}</span>
                      <CopyButton value={x402Receipt.hash} label="Copy hash" />
                      <a
                        className="btn btn-sm btn-quiet"
                        href={explorerUrl("STELLAR", x402Receipt.hash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Explorer ↗
                      </a>
                    </div>
                  ) : (
                    "No hash reported."
                  )}
                </dd>
              </div>
            </dl>
            {x402Receipt.challenge ? (
              <div>
                <span className="micro">Merchant challenge</span>
                <pre className="json-view">{pretty(x402Receipt.challenge)}</pre>
              </div>
            ) : null}
            <div>
              <span className="micro">Returned JSON</span>
              <pre className="json-view">{pretty(x402Receipt.body)}</pre>
            </div>
          </>
        ) : null}
      </Sheet>
    </aside>
  );
}

/* ── real merchant panel (browser-direct x402) ───────────────────────────── */

interface ChallengeSummary {
  scheme?: string;
  network?: string;
  price?: string;
  payTo?: string;
  asset?: string;
  resource?: string;
}

type X402Phase =
  | { phase: "idle" }
  | { phase: "probing" }
  | {
      phase: "ready";
      summary: ChallengeSummary | null;
      raw: unknown;
      status: number;
    }
  | { phase: "signing" }
  | {
      phase: "done";
      body: unknown;
      hash: string | null;
      status: number;
    }
  | { phase: "error"; code: string; message: string };

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 6000 ? `${text.slice(0, 6000)}\n… truncated` : text;
  } catch {
    return String(value);
  }
}

function decodePaymentRequired(headers: Headers): unknown {
  const raw =
    headers.get("payment-required") ??
    headers.get("x-payment-required") ??
    headers.get("www-authenticate");
  if (!raw) return null;
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(atob(padded));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}

function summarizeChallenge(challenge: unknown): ChallengeSummary | null {
  if (!challenge || typeof challenge !== "object") return null;
  const root = challenge as Record<string, unknown>;
  const accepts = Array.isArray(root.accepts) ? root.accepts : null;
  const selected = (accepts?.[0] ?? root) as Record<string, unknown>;
  const amountRaw = selected.maxAmountRequired ?? selected.amount ?? selected.price;
  let price: string | undefined;
  if (typeof amountRaw === "string" && /^\d+$/.test(amountRaw)) {
    try {
      price = `${fromUnits(BigInt(amountRaw), 7)} USDC`;
    } catch {
      price = amountRaw;
    }
  } else if (amountRaw !== undefined) {
    price = String(amountRaw);
  }
  const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    scheme: asString(selected.scheme),
    network: asString(selected.network) ?? asString(selected.chain),
    price,
    payTo: asString(selected.payTo) ?? asString(selected.destination),
    asset: asString(selected.asset),
    resource: asString(selected.resource) ?? asString(root.resource),
  };
}

function X402Panel() {
  const { cards, selectedCardId, toast } = useTab();
  const { getClient } = usePollar();
  const [state, setState] = useState<X402Phase>({ phase: "idle" });
  const card = cards.find((item) => item.id === selectedCardId) ?? cards[0] ?? null;

  const probe = async () => {
    setState({ phase: "probing" });
    try {
      const response = await fetch(X402_MARKET_URL, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const challenge = decodePaymentRequired(response.headers);
      setState({
        phase: "ready",
        summary: summarizeChallenge(challenge),
        raw: challenge,
        status: response.status,
      });
      if (response.status !== 402) {
        toast(`Nirium answered HTTP ${response.status}, not 402.`, "error");
      }
    } catch (error) {
      const err = errorText(error);
      setState({ phase: "error", code: err.code, message: err.message });
    }
  };

  const signAndPay = async () => {
    setState({ phase: "signing" });
    const factory = await loadX402Factory();
    if (!factory) {
      setState({
        phase: "error",
        code: "X402_MODULE_LOADING",
        message:
          "x402 module loading: createX402Payer is not in @tab/pollar yet. Reload after the research agent ships it.",
      });
      return;
    }
    try {
      const payer = factory(getClient());
      const outcome = await payer.fetchPaid(X402_MARKET_URL);
      if (!outcome.ok) {
        const message =
          outcome.error ??
          `The merchant answered HTTP ${outcome.status}. Check the signature policy and retry.`;
        const bodyCode =
          typeof outcome.body === "object" &&
          outcome.body !== null &&
          typeof (outcome.body as Record<string, unknown>).code === "string"
            ? ((outcome.body as Record<string, unknown>).code as string)
            : null;
        const code = bodyCode ?? message.match(/\b([A-Z][A-Z0-9_]{4,})\b/)?.[1] ?? `X402_HTTP_${outcome.status}`;
        setState({ phase: "error", code, message });
        return;
      }
      setState({
        phase: "done",
        body: outcome.body,
        hash: outcome.txHash ?? null,
        status: outcome.status,
      });
    } catch (error) {
      const err = errorText(error);
      setState({ phase: "error", code: err.code, message: err.message });
    }
  };

  return (
    <div className="x402">
      <div className="x402-head">
        <span className="micro">Real third-party merchant</span>
        <span className="chip chip-quiet">live · direct</span>
      </div>
      <p className="signer-note">
        Nirium is a third-party merchant, not our depot. It answers HTTP 402 and takes 0.05 USDC on
        Stellar testnet. The browser signs directly; nothing is proxied through the TAB API.
      </p>
      <div className="x402-body">
        <div className={`x402-step${state.phase !== "idle" && state.phase !== "probing" ? " done" : ""}`}>
          <span className="tick">{state.phase === "idle" || state.phase === "probing" ? "" : "1"}</span>
          <div>
            <b>Payment challenge</b>
            <span>
              {state.phase === "ready"
                ? `HTTP ${state.status} · ${state.summary?.price ?? "price in challenge"}`
                : state.phase === "probing"
                  ? "Reading the 402…"
                  : state.phase === "idle"
                    ? "Not fetched yet"
                    : "See result below"}
            </span>
          </div>
        </div>

        {state.phase === "ready" && state.summary ? (
          <div className="json-view">
            {[
              ["scheme", state.summary.scheme],
              ["network", state.summary.network],
              ["price", state.summary.price],
              ["payTo", state.summary.payTo],
              ["asset", state.summary.asset],
              ["resource", state.summary.resource],
            ]
              .filter(([, value]) => Boolean(value))
              .map(([label, value]) => `${label}: ${value}`)
              .join("\n")}
          </div>
        ) : null}

        {state.phase === "ready" && !state.summary ? (
          <div className="x402-step">
            <span className="tick">!</span>
            <div>
              <b>Challenge header not readable</b>
              <span>
                The merchant returned HTTP {state.status} but did not expose the payment header to
                this origin. The payer still receives it during the paid retry.
              </span>
            </div>
          </div>
        ) : null}

        {state.phase === "ready" && state.status !== 402 ? (
          <div className="x402-step fail">
            <span className="tick">!</span>
            <div>
              <b style={{ color: "var(--signal-red-ink)" }}>No payment required</b>
              <span>
                Nirium answered HTTP {state.status} without a 402 challenge. There is nothing to
                sign right now.
              </span>
            </div>
          </div>
        ) : null}

        {state.phase === "done" ? (
          <>
            <div className="x402-step done">
              <span className="tick">2</span>
              <div>
                <b>Signature accepted</b>
                <span>HTTP {state.status}</span>
              </div>
            </div>
            <div className="json-view">{pretty(state.body)}</div>
            <div className="x402-step done">
              <span className="tick">3</span>
              <div>
                <b>Settlement</b>
                {state.hash ? (
                  <a
                    className="btn btn-sm btn-quiet"
                    href={explorerUrl("STELLAR", state.hash)}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginTop: 4 }}
                  >
                    {shortHash(state.hash, 10, 6)} ↗
                  </a>
                ) : (
                  <span>No tx hash returned.</span>
                )}
              </div>
            </div>
          </>
        ) : null}

        {state.phase === "error" ? (
          <div className="x402-step fail">
            <span className="tick">!</span>
            <div>
              <b style={{ color: "var(--signal-red-ink)" }}>{state.code}</b>
              <span>{state.message}</span>
              {state.code === "SOROBAN_AUTH_NO_POLICY" ? (
                <span>
                  Pollar has no policy for this contract. Add the x402 authorization policy to the
                  app, then retry — this is a signature-policy failure, not a merchant failure.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {state.phase === "idle" || state.phase === "error" ? (
          <button className="btn btn-sm btn-ink" onClick={() => void probe()}>
            Pay Nirium · 0.05 USDC
          </button>
        ) : null}
        {state.phase === "probing" ? (
          <button className="btn btn-sm" disabled>
            Reading challenge…
          </button>
        ) : null}
        {state.phase === "ready" ? (
          <>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void signAndPay()}
              disabled={state.status !== 402}
              title={
                state.status === 402
                  ? "Sign the merchant's challenge with your Pollar session."
                  : "The merchant did not return a 402 challenge."
              }
            >
              Sign &amp; pay {state.summary?.price ?? "the challenge"}
            </button>
            <button className="btn btn-sm btn-quiet" onClick={() => void probe()}>
              Re-fetch
            </button>
          </>
        ) : null}
        {state.phase === "signing" ? (
          <button className="btn btn-sm" disabled aria-busy="true">
            Waiting for your signature…
          </button>
        ) : null}
        {state.phase === "done" ? (
          <button className="btn btn-sm btn-quiet" onClick={() => setState({ phase: "idle" })}>
            Run again
          </button>
        ) : null}
      </div>
      <p className="signer-note">
        {card
          ? `Selected card ${card.label} stays the policy control for TAB charges. This direct call is outside the tab ledger; it proves the merchant rail and the wallet signature.`
          : "No card selected. This direct call only needs the wallet."}
      </p>
    </div>
  );
}

/* ── compact bar for narrow viewports ────────────────────────────────────── */

export function SignerInlineBar({ onOpen }: { onOpen: () => void }) {
  const { health } = useTab();
  return (
    <div className="signer-inline-bar">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span className={`dot ${health?.signerOnline ? "dot-live" : "dot-muted"}`} />
        Wallet signer {health?.signerOnline ? "online" : "offline"}
      </span>
      <button className="btn btn-sm" onClick={onOpen}>
        Open payment console
      </button>
    </div>
  );
}
