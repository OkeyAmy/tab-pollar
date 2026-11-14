"use client";

import { usePollar } from "@pollar/react";
import type { Agent, Card, Charge, HealthResponse, LedgerEvent, Merchant, Sku, User } from "@tab/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  cardAction,
  createAgent,
  createCard,
  declineCharge,
  approveCharge,
  createSession,
  getCharges,
  getHealth,
  getLedger,
  getMe,
  getMerchants,
  logoutSession,
  rotateAgentKey,
  setCsrfToken,
  type CreateCardInput,
} from "@/lib/api";

/* ────────────────────────────────────────────────────────────────────────────
 * Phases
 * ──────────────────────────────────────────────────────────────────────────── */

export type Phase =
  | "signed-out"
  | "waiting-wallet"
  | "verifying"
  | "ready"
  | "error";

export interface GateError {
  code: string;
  message: string;
}

export interface SignatureGate {
  mode: "PROMPT" | "WINDOW" | "AUTO" | "UNKNOWN";
  label: string;
  detail: string;
  tone: "ink" | "quiet" | "red";
}

export interface Toast {
  id: number;
  message: string;
  tone: "ok" | "error";
}

interface TabState {
  phase: Phase;
  bootError: GateError | null;
  user: User | null;
  agents: Agent[];
  cards: Card[];
  charges: Charge[];
  ledger: LedgerEvent[];
  merchants: Merchant[];
  skus: Sku[];
  health: HealthResponse | null;
  loading: boolean;
  refreshing: boolean;
  dataError: GateError | null;
  selectedCardId: string | null;
  signatureGate: SignatureGate;
  csrfReady: boolean;
  sessionExpiresAt: string | null;
  toasts: Toast[];
}

interface TabActions {
  selectCard: (cardId: string) => void;
  refresh: () => Promise<void>;
  retrySession: () => void;
  signOut: () => Promise<void>;
  createAgent: (input: { name: string; description?: string; emoji?: string }) => Promise<{
    agent: Agent;
    apiKey: string;
  }>;
  rotateAgentKey: (agentId: string) => Promise<string>;
  createCard: (input: CreateCardInput) => Promise<Card>;
  pauseCard: (cardId: string) => Promise<void>;
  resumeCard: (cardId: string) => Promise<void>;
  revokeCard: (cardId: string) => Promise<void>;
  approve: (chargeId: string) => Promise<void>;
  decline: (chargeId: string) => Promise<void>;
  toast: (message: string, tone?: "ok" | "error") => void;
  dismissToast: (id: number) => void;
}

type TabContextValue = TabState & TabActions;

const TabContext = createContext<TabContextValue | null>(null);

function errorOf(error: unknown): GateError {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.sentence };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED", message: error.message };
  }
  return { code: "UNEXPECTED", message: "Something went wrong." };
}

function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

/** Codes that mean "the Pollar token is gone; sign in again" — not a policy failure. */
export function isTokenError(code: string): boolean {
  return (
    code === "POLLAR_TOKEN_EXPIRED" ||
    code === "POLLAR_TOKEN_INVALID" ||
    code === "SESSION_TOKEN_MISSING" ||
    code === "UNAUTHORIZED"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSignatureGate(appConfig: unknown): SignatureGate {
  const confirmation = (
    appConfig as
      | {
          application?: {
            signConfirmation?: { mode?: string; windowSeconds?: number; maxUsd?: string };
          };
        }
      | undefined
  )?.application?.signConfirmation;

  if (confirmation?.mode === "PROMPT") {
    return {
      mode: "PROMPT",
      label: "Ask every time",
      detail: "Your wallet confirms every payment. Nothing is hidden.",
      tone: "ink",
    };
  }
  if (confirmation?.mode === "WINDOW") {
    const seconds = confirmation.windowSeconds ?? 300;
    const minutes = Math.max(1, Math.round(seconds / 60));
    return {
      mode: "WINDOW",
      label: `Ask once per ${minutes}-min window`,
      detail: `One confirmation covers payments up to $${confirmation.maxUsd ?? "—"} for ${minutes} min.`,
      tone: "ink",
    };
  }
  if (confirmation?.mode === "AUTO") {
    return {
      mode: "AUTO",
      label: "Never ask (unattended)",
      detail: "Your wallet will not ask. The card limits are the only cap.",
      tone: "red",
    };
  }
  return {
    mode: "UNKNOWN",
    label: "Ask every time",
    detail:
      "Your wallet did not report a confirmation mode. Expect a prompt on every payment.",
    tone: "quiet",
  };
}

export function TabProvider({ children }: { children: React.ReactNode }) {
  const pollar = usePollar();
  const { isAuthenticated, verified, wallet, getClient, logout, appConfig } = pollar;

  const [phase, setPhase] = useState<Phase>("signed-out");
  const [bootError, setBootError] = useState<GateError | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dataError, setDataError] = useState<GateError | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [csrfReady, setCsrfReady] = useState(false);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sessionAttempt, setSessionAttempt] = useState(0);

  const bootingRef = useRef(false);
  const liveInFlightRef = useRef(false);
  const healthAtRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const signatureGate = useMemo(() => readSignatureGate(appConfig), [appConfig]);

  const toast = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      if (!mountedRef.current) return;
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  /* ── data load ─────────────────────────────────────────────────────────── */

  const loadCatalogue = useCallback(async () => {
    try {
      const catalogue = await getMerchants();
      if (!mountedRef.current) return;
      setMerchants(catalogue.merchants);
      setSkus(catalogue.skus);
    } catch {
      // Catalogue is optional for the console; the wizard shows an empty state.
      if (!mountedRef.current) return;
      setMerchants([]);
      setSkus([]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDataError(null);
    const [meResult, chargesResult, ledgerResult, healthResult] = await Promise.allSettled([
      getMe(),
      getCharges(),
      getLedger(),
      getHealth(),
    ]);

    if (!mountedRef.current) return;

    if (meResult.status === "rejected") {
      const err = errorOf(meResult.reason);
      setDataError(err);
      if (meResult.reason instanceof ApiError && meResult.reason.status === 401) {
        setPhase("error");
        setBootError(err);
      }
      setLoading(false);
      return;
    }

    const me = meResult.value;
    if (me.csrfToken) {
      setCsrfToken(me.csrfToken);
      setCsrfReady(true);
    }
    setUser(me.user);
    setAgents(me.agents);
    setCards(me.cards);
    if (me.sessionExpiresAt) setSessionExpiresAt(me.sessionExpiresAt);
    setSelectedCardId((current) => {
      if (current && me.cards.some((card) => card.id === current)) return current;
      return me.cards[0]?.id ?? null;
    });

    if (chargesResult.status === "fulfilled") setCharges(chargesResult.value);
    if (ledgerResult.status === "fulfilled") setLedger(ledgerResult.value);
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
      healthAtRef.current = Date.now();
    }

    const firstRejection = [chargesResult, ledgerResult].find((r) => r.status === "rejected");
    if (firstRejection && firstRejection.status === "rejected") {
      setDataError(errorOf(firstRejection.reason));
    }

    setLoading(false);
    await loadCatalogue();
  }, [loadCatalogue]);

  const refreshLive = useCallback(async () => {
    if (liveInFlightRef.current) return;
    liveInFlightRef.current = true;
    try {
      setRefreshing(true);
      const [meResult, chargesResult, ledgerResult] = await Promise.allSettled([
        getMe(),
        getCharges(),
        getLedger(),
      ]);
      if (!mountedRef.current) return;

      if (meResult.status === "rejected" && meResult.reason instanceof ApiError && meResult.reason.status === 401) {
        setPhase("error");
        setBootError(errorOf(meResult.reason));
        return;
      }
      if (meResult.status === "fulfilled") {
        const me = meResult.value;
        if (me.csrfToken) setCsrfToken(me.csrfToken);
        setUser(me.user);
        setAgents(me.agents);
        setCards(me.cards);
        if (me.sessionExpiresAt) setSessionExpiresAt(me.sessionExpiresAt);
        setSelectedCardId((current) => {
          if (current && me.cards.some((card) => card.id === current)) return current;
          return me.cards[0]?.id ?? null;
        });
      }
      if (chargesResult.status === "fulfilled") setCharges(chargesResult.value);
      if (ledgerResult.status === "fulfilled") setLedger(ledgerResult.value);

      const failure = [meResult, chargesResult, ledgerResult].find((r) => r.status === "rejected");
      if (failure && failure.status === "rejected") {
        const err = errorOf(failure.reason);
        // A single transient failure keeps the last good data on screen.
        setDataError(err.code === "API_UNREACHABLE" ? err : null);
      } else {
        setDataError(null);
      }

      if (Date.now() - healthAtRef.current > 15_000) {
        healthAtRef.current = Date.now();
        getHealth()
          .then((next) => {
            if (mountedRef.current) setHealth(next);
          })
          .catch(() => {
            /* health is advisory */
          });
      }
    } finally {
      liveInFlightRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    await refreshLive();
  }, [refreshLive]);

  /* ── session bootstrap ────────────────────────────────────────────────── */

  useEffect(() => {
    if (!isAuthenticated) {
      setPhase("signed-out");
      setBootError(null);
      setUser(null);
      return;
    }
    if (!wallet) {
      setPhase("waiting-wallet");
      return;
    }
    const walletReady = wallet.provisioning === "READY" || wallet.provisioning === undefined;
    if (!walletReady) {
      setPhase("waiting-wallet");
      return;
    }
    if (bootingRef.current || phase === "ready") return;

    bootingRef.current = true;
    let cancelled = false;

    const boot = async () => {
      setPhase("verifying");
      setBootError(null);
      setLoading(true);
      try {
        const client = getClient();
        let auth = client.getAuthState();
        for (let attempt = 0; attempt < 12 && auth.step !== "authenticated"; attempt++) {
          await delay(300);
          auth = client.getAuthState();
        }
        if (auth.step !== "authenticated") {
          throw new ApiError(
            0,
            "SESSION_TOKEN_MISSING",
            "Pollar has not issued a verified access token in this tab yet.",
          );
        }
        const accessToken = auth.session.token.accessToken;
        if (!accessToken) {
          throw new ApiError(0, "SESSION_TOKEN_MISSING", "The Pollar access token is empty.");
        }

        let session: Awaited<ReturnType<typeof createSession>> | null = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            session = await createSession(accessToken);
            break;
          } catch (error) {
            lastError = error;
            if (attempt === 0 && isRetryable(error)) {
              await delay(650);
              continue;
            }
            throw error;
          }
        }
        if (!session) throw lastError ?? new Error("Session verification failed.");

        if (cancelled || !mountedRef.current) return;
        setCsrfToken(session.csrfToken);
        setCsrfReady(Boolean(session.csrfToken));
        setUser(session.user);
        setAgents(session.agents);
        setCards(session.cards);
        setCharges(session.charges);
        setLedger(session.ledger);
        setSessionExpiresAt(session.sessionExpiresAt);
        setSelectedCardId(session.cards[0]?.id ?? null);
        setPhase("ready");
        await loadAll();
      } catch (error) {
        if (cancelled || !mountedRef.current) return;
        setBootError(errorOf(error));
        setPhase("error");
        setLoading(false);
      } finally {
        bootingRef.current = false;
      }
    };

    void boot();
    return () => {
      cancelled = true;
      bootingRef.current = false;
    };
    // `phase` is intentionally excluded: boot must not re-run on its own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAuthenticated,
    wallet?.address,
    wallet?.provisioning,
    getClient,
    loadAll,
    sessionAttempt,
  ]);

  /* ── polling ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (phase !== "ready") return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refreshLive();
    };
    const id = window.setInterval(tick, 4000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phase, refreshLive]);

  /* ── actions ──────────────────────────────────────────────────────────── */

  const selectCard = useCallback((cardId: string) => {
    setSelectedCardId(cardId);
  }, []);

  /**
   * The Pollar access token at call time. Approve/decline/signer calls need it
   * in addition to the cookie; a restored-but-unauthenticated tab has none.
   */
  const freshAccessToken = useCallback((): string | null => {
    try {
      const auth = getClient().getAuthState();
      if (auth.step !== "authenticated") return null;
      return auth.session.token.accessToken ?? null;
    } catch {
      return null;
    }
  }, [getClient]);

  const retrySession = useCallback(() => {
    bootingRef.current = false;
    setSessionAttempt((n) => n + 1);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutSession();
    } catch {
      // The cookie may already be gone; the Pollar logout is what matters.
    }
    setCsrfToken(null);
    setCsrfReady(false);
    setUser(null);
    setAgents([]);
    setCards([]);
    setCharges([]);
    setLedger([]);
    setPhase("signed-out");
    logout();
  }, [logout]);

  const handleCreateAgent = useCallback(
    async (input: { name: string; description?: string; emoji?: string }) => {
      const result = await createAgent(input);
      await refreshLive();
      return result;
    },
    [refreshLive],
  );

  const handleRotateKey = useCallback(
    async (agentId: string) => {
      const key = await rotateAgentKey(agentId);
      await refreshLive();
      return key;
    },
    [refreshLive],
  );

  const handleCreateCard = useCallback(
    async (input: CreateCardInput) => {
      const card = await createCard(input);
      await refreshLive();
      setSelectedCardId(card.id);
      toast(`Tab opened for ${card.label}.`);
      return card;
    },
    [refreshLive, toast],
  );

  const runCardAction = useCallback(
    async (cardId: string, action: "pause" | "resume" | "revoke") => {
      await cardAction(cardId, action);
      await refreshLive();
      if (action === "revoke") toast("Card revoked. Outstanding tokens are dead.");
      if (action === "pause") toast("Card paused. Nothing new will clear.");
      if (action === "resume") toast("Card resumed.");
    },
    [refreshLive, toast],
  );

  const pauseCard = useCallback(
    (cardId: string) => runCardAction(cardId, "pause"),
    [runCardAction],
  );
  const resumeCard = useCallback(
    (cardId: string) => runCardAction(cardId, "resume"),
    [runCardAction],
  );
  const revokeCard = useCallback(
    (cardId: string) => runCardAction(cardId, "revoke"),
    [runCardAction],
  );

  /**
   * Approve/decline carry a fresh Pollar Bearer token. If the API says it
   * expired, refresh the SDK session once and retry before asking for a login.
   */
  const withFreshPollar = useCallback(
    async <T,>(fn: (bearer: string) => Promise<T>): Promise<T> => {
      const first = freshAccessToken();
      if (!first) {
        throw new ApiError(401, "POLLAR_TOKEN_EXPIRED", "Sign in again to approve.");
      }
      try {
        return await fn(first);
      } catch (error) {
        if (error instanceof ApiError && isTokenError(error.code)) {
          try {
            await getClient().refresh();
          } catch {
            // fall through to the friendly error
          }
          const next = freshAccessToken();
          if (next) return fn(next);
        }
        throw error;
      }
    },
    [freshAccessToken, getClient],
  );

  const approve = useCallback(
    async (chargeId: string) => {
      if (!freshAccessToken()) {
        const error = new ApiError(401, "POLLAR_TOKEN_EXPIRED", "Sign in again to approve.");
        toast(error.message, "error");
        throw error;
      }
      setCharges((current) =>
        current.map((charge) => (charge.id === chargeId ? { ...charge, status: "QUEUED" } : charge)),
      );
      try {
        await withFreshPollar((bearer) => approveCharge(chargeId, bearer));
        await refreshLive();
        toast("Approved. The signer will pick it up.");
      } catch (error) {
        const err = errorOf(error);
        await refreshLive();
        const message = isTokenError(err.code) ? "Sign in again to approve." : err.message;
        toast(`${err.code}: ${message}`, "error");
        throw error instanceof ApiError ? new ApiError(error.status, error.code, message) : error;
      }
    },
    [freshAccessToken, refreshLive, toast, withFreshPollar],
  );

  const decline = useCallback(
    async (chargeId: string) => {
      if (!freshAccessToken()) {
        const error = new ApiError(401, "POLLAR_TOKEN_EXPIRED", "Sign in again to approve.");
        toast(error.message, "error");
        throw error;
      }
      setCharges((current) =>
        current.map((charge) => (charge.id === chargeId ? { ...charge, status: "DECLINED" } : charge)),
      );
      try {
        await withFreshPollar((bearer) => declineCharge(chargeId, bearer));
        await refreshLive();
        toast("Declined. The reservation is released.");
      } catch (error) {
        const err = errorOf(error);
        await refreshLive();
        const message = isTokenError(err.code) ? "Sign in again to approve." : err.message;
        toast(`${err.code}: ${message}`, "error");
        throw error instanceof ApiError ? new ApiError(error.status, error.code, message) : error;
      }
    },
    [freshAccessToken, refreshLive, toast, withFreshPollar],
  );

  const selectedCard = useMemo(
    () => cards.find((card) => card.id === selectedCardId) ?? null,
    [cards, selectedCardId],
  );

  const value: TabContextValue = {
    phase,
    bootError,
    user,
    agents,
    cards,
    charges,
    ledger,
    merchants,
    skus,
    health,
    loading,
    refreshing,
    dataError,
    selectedCardId: selectedCard?.id ?? selectedCardId,
    signatureGate,
    csrfReady,
    sessionExpiresAt,
    toasts,
    selectCard,
    refresh,
    retrySession,
    signOut,
    createAgent: handleCreateAgent,
    rotateAgentKey: handleRotateKey,
    createCard: handleCreateCard,
    pauseCard,
    resumeCard,
    revokeCard,
    approve,
    decline,
    toast,
    dismissToast,
  };

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

export function useTab(): TabContextValue {
  const context = useContext(TabContext);
  if (!context) throw new Error("useTab must be used inside <TabProvider>.");
  return context;
}
