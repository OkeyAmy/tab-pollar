"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, fetchCatalogue, getCharge, postCharge } from "@/lib/api";
import {
  PRINTED_CATALOGUE,
  groupCatalogue,
  type Catalogue,
} from "@/lib/catalogue";
import { clearsToken, isTerminal } from "@/lib/policy";
import { fulfilmentKey } from "@/lib/licence";
import { isVerifiedReceipt } from "@/lib/receipt";
import type { Attempt, ManualFields, SlipMode, SlipOrder, SlipPhase } from "@/lib/slip";
import Masthead from "./Masthead";
import Intro from "./Intro";
import CatalogueList from "./CatalogueList";
import CheckoutSlip from "./CheckoutSlip";
import MobileBar from "./MobileBar";

const CONSOLE_URL = process.env.NEXT_PUBLIC_TAB_CONSOLE_URL || "http://localhost:3000";
const POLL_DEADLINE_MS = 90_000;
const CHECK_AGAIN_MS = 20_000;

type DepotAppProps = {
  initialToken?: string;
  initialSkuId?: string;
  initialMerchantId?: string;
};

type BuildResult = { ok: true; attempt: Attempt } | { ok: false; error: string };

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `depot-${crypto.randomUUID()}`;
  }
  return `depot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidAmount(value: string): boolean {
  return /^\d{1,7}(\.\d{1,7})?$/.test(value) && Number(value) > 0;
}

export default function DepotApp({
  initialToken,
  initialSkuId,
  initialMerchantId,
}: DepotAppProps) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const [mode, setMode] = useState<SlipMode>("item");
  const [selectedSkuId, setSelectedSkuId] = useState(initialSkuId ?? "");
  const [manual, setManual] = useState<ManualFields>({
    merchantId: "",
    amount: "",
    description: "",
  });

  const [token, setToken] = useState((initialToken ?? "").trim());
  const [phase, setPhase] = useState<SlipPhase>({ kind: "idle" });
  const [formError, setFormError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(Boolean(initialToken));

  const attemptRef = useRef<Attempt | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const deadlineRef = useRef(0);
  const [pollNonce, setPollNonce] = useState(0);
  const [clock, setClock] = useState(() => Date.now());

  const loadCatalogue = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchCatalogue();
      setCatalogue(next);
      setOffline(false);
    } catch {
      setCatalogue(PRINTED_CATALOGUE);
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);

  useEffect(() => {
    if (!catalogue) return;
    setSelectedSkuId((previous) => {
      if (previous && catalogue.skus.some((sku) => sku.id === previous)) return previous;
      if (initialSkuId && catalogue.skus.some((sku) => sku.id === initialSkuId)) {
        return initialSkuId;
      }
      const fromMerchant = initialMerchantId
        ? catalogue.skus.find((sku) => sku.merchantId === initialMerchantId)
        : undefined;
      return fromMerchant?.id ?? catalogue.skus[0]?.id ?? "";
    });
    setManual((previous) => {
      if (previous.merchantId) return previous;
      const preferred =
        initialMerchantId && catalogue.merchants.some((merchant) => merchant.id === initialMerchantId)
          ? initialMerchantId
          : (catalogue.merchants[0]?.id ?? "");
      return { ...previous, merchantId: preferred };
    });
  }, [catalogue, initialSkuId, initialMerchantId]);

  const groups = useMemo(() => groupCatalogue(catalogue), [catalogue]);

  const catalogueAsset = useMemo(() => {
    const assets = new Set(
      (catalogue?.merchants ?? [])
        .map((merchant) => merchant.asset)
        .filter((asset): asset is string => Boolean(asset)),
    );
    return assets.size === 1 ? ([...assets][0] ?? null) : null;
  }, [catalogue]);

  const merchantById = useMemo(
    () => new Map((catalogue?.merchants ?? []).map((merchant) => [merchant.id, merchant])),
    [catalogue],
  );
  const skuById = useMemo(
    () => new Map((catalogue?.skus ?? []).map((sku) => [sku.id, sku])),
    [catalogue],
  );

  const selectedSku = useMemo(
    () =>
      catalogue?.skus.find((sku) => sku.id === selectedSkuId) ?? catalogue?.skus[0] ?? null,
    [catalogue, selectedSkuId],
  );

  const liveCharge = phase.kind === "live" ? phase.charge : null;
  const liveStatus = liveCharge?.status ?? null;
  const canEdit = phase.kind === "idle" || phase.kind === "error";
  const busy = phase.kind === "sending" || Boolean(liveStatus && !isTerminal(liveStatus));

  const order: SlipOrder = useMemo(() => {
    if (canEdit || !attempt) {
      if (mode === "manual") {
        const merchant = merchantById.get(manual.merchantId);
        const amount = manual.amount.trim();
        return {
          merchantName: merchant?.name ?? "—",
          title: "Merchant redemption",
          unit: null,
          amount: isValidAmount(amount) ? amount : null,
          asset: merchant?.asset ?? null,
          description: manual.description.trim() || "Merchant redemption",
        };
      }
      if (!selectedSku) {
        return {
          merchantName: "—",
          title: "No item selected",
          unit: null,
          amount: null,
          asset: null,
          description: "",
        };
      }
      return {
        merchantName: merchantById.get(selectedSku.merchantId)?.name ?? selectedSku.merchantId,
        title: selectedSku.name,
        unit: selectedSku.unit,
        amount: selectedSku.price,
        asset:
          selectedSku.asset ?? merchantById.get(selectedSku.merchantId)?.asset ?? null,
        description: selectedSku.description,
      };
    }

    const sku = attempt.skuId ? (skuById.get(attempt.skuId) ?? null) : null;
    const merchant = merchantById.get(attempt.merchantId);
    return {
      merchantName: liveCharge?.merchantName || merchant?.name || attempt.merchantId,
      title: sku?.name ?? (attempt.description || "Merchant redemption"),
      unit: sku?.unit ?? null,
      amount: liveCharge?.amount ?? attempt.amount,
      asset: liveCharge?.asset ?? sku?.asset ?? merchant?.asset ?? null,
      description: attempt.description,
    };
  }, [
    canEdit,
    attempt,
    mode,
    manual,
    merchantById,
    selectedSku,
    skuById,
    liveCharge,
  ]);

  const elapsedSec = useMemo(() => {
    if (!liveCharge) return 0;
    const created = Date.parse(liveCharge.createdAt);
    if (!Number.isFinite(created)) return 0;
    return Math.max(0, Math.floor((clock - created) / 1000));
  }, [liveCharge, clock]);

  const settledCharge = liveCharge && liveCharge.status === "SETTLED" ? liveCharge : null;
  const receiptKey = useMemo(() => {
    if (!settledCharge || !isVerifiedReceipt(settledCharge)) return null;
    const sku = attempt?.skuId ? (skuById.get(attempt.skuId) ?? null) : null;
    const merchant = merchantById.get(settledCharge.merchantId);
    const prefix = sku?.licensePrefix ?? merchant?.name ?? "DEPOT";
    return fulfilmentKey(prefix, settledCharge.id, attempt?.skuId ?? undefined);
  }, [settledCharge, attempt, skuById, merchantById]);

  /* ── polling ─────────────────────────────────────────────────────────── */

  const chargeId = liveCharge?.id ?? null;

  useEffect(() => {
    if (!chargeId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadlineRef.current) {
        setTimedOut(true);
        return;
      }
      const pollToken = attemptRef.current?.token ?? "";
      if (!pollToken) {
        setTimedOut(true);
        return;
      }
      try {
        const next = await getCharge(chargeId, pollToken);
        if (cancelled) return;
        setPhase((previous): SlipPhase =>
          previous.kind === "live" && previous.charge.id === chargeId
            ? { kind: "live", charge: next }
            : previous,
        );
        if (!isTerminal(next.status)) {
          timer = setTimeout(tick, 1700);
        }
      } catch {
        // A dropped poll is not a failed payment. Keep checking until the deadline.
        if (!cancelled) timer = setTimeout(tick, 2600);
      }
    };

    timer = setTimeout(tick, 900);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [chargeId, pollNonce]);

  useEffect(() => {
    if (!liveStatus || isTerminal(liveStatus) || timedOut) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [liveStatus, timedOut]);

  /* ── sheet ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!sheetOpen) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  /* ── actions ─────────────────────────────────────────────────────────── */

  function chooseSku(skuId: string) {
    if (!canEdit) return;
    setMode("item");
    setSelectedSkuId(skuId);
    setFormError(null);
    setPhase({ kind: "idle" });
    setAttempt(null);
    setSheetOpen(true);
  }

  function buildAttempt(): BuildResult {
    const cleanToken = token.trim();
    if (!cleanToken) return { ok: false, error: "Paste the tab token first." };
    if (!cleanToken.startsWith("tab_ch_")) {
      return { ok: false, error: "A tab token starts with tab_ch_. Check the paste." };
    }

    let merchantId: string;
    let amount: string;
    let description: string;
    let skuId: string | null;

    if (mode === "item") {
      if (!selectedSku) return { ok: false, error: "Pick an item from the price list." };
      merchantId = selectedSku.merchantId;
      amount = selectedSku.price;
      description = `${selectedSku.name} · ${selectedSku.unit}`.slice(0, 120);
      skuId = selectedSku.id;
    } else {
      merchantId = manual.merchantId;
      amount = manual.amount.trim();
      description = (manual.description.trim() || "Merchant redemption").slice(0, 120);
      skuId = null;
      if (!merchantId) return { ok: false, error: "Pick a supplier for this redemption." };
      if (!isValidAmount(amount)) {
        return { ok: false, error: "Enter the amount as a dollar figure, like 2.50." };
      }
    }

    const cleanDescription = description || "Merchant redemption";
    const signature = `${cleanToken}|${merchantId}|${amount}|${cleanDescription}`;
    const previous = attemptRef.current;
    const idempotencyKey =
      previous && previous.signature === signature ? previous.idempotencyKey : newIdempotencyKey();

    return {
      ok: true,
      attempt: {
        token: cleanToken,
        merchantId,
        amount,
        description: cleanDescription,
        idempotencyKey,
        skuId,
        signature,
      },
    };
  }

  async function present() {
    const built = buildAttempt();
    if (!built.ok) {
      setFormError(built.error);
      return;
    }

    const next = built.attempt;
    attemptRef.current = next;
    setAttempt(next);
    setFormError(null);
    setTimedOut(false);
    setPhase({ kind: "sending" });

    try {
      const charge = await postCharge({
        token: next.token,
        merchantId: next.merchantId,
        amount: next.amount,
        description: next.description,
        idempotencyKey: next.idempotencyKey,
      });
      deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
      setClock(Date.now());
      setPhase({ kind: "live", charge });
      setPollNonce((value) => value + 1);
      setSheetOpen(true);
    } catch (error) {
      if (error instanceof ApiFailure) {
        setPhase({
          kind: "error",
          code: error.code,
          message: error.message,
          httpStatus: error.httpStatus,
          decision: error.decision,
        });
      } else {
        setPhase({
          kind: "error",
          code: "NETWORK",
          message: "The till could not complete the charge.",
          httpStatus: 0,
          decision: null,
        });
      }
    }
  }

  function retry() {
    void present();
  }

  function checkAgain() {
    setTimedOut(false);
    deadlineRef.current = Date.now() + CHECK_AGAIN_MS;
    setPollNonce((value) => value + 1);
  }

  function newSale() {
    setPhase({ kind: "idle" });
    setAttempt(null);
    attemptRef.current = null;
    setTimedOut(false);
    setFormError(null);
    setToken("");
    setMode("item");
  }

  function editSlip() {
    const code = phase.kind === "error" ? phase.code : "";
    setPhase({ kind: "idle" });
    setAttempt(null);
    if (clearsToken(code)) setToken("");
    setTimedOut(false);
    setFormError(null);
  }

  function changeMode(next: SlipMode) {
    if (!canEdit) return;
    setMode(next);
    setFormError(null);
    if (phase.kind === "error") {
      setPhase({ kind: "idle" });
      setAttempt(null);
    }
    if (next === "manual" && !manual.merchantId && catalogue?.merchants[0]) {
      setManual((previous) => ({ ...previous, merchantId: catalogue.merchants[0].id }));
    }
  }

  const sheetAmount = liveCharge?.amount ?? order.amount;

  return (
    <div className="min-h-dvh">
      <div className="mx-auto w-full max-w-[1280px] px-5 sm:px-8">
        <Masthead consoleUrl={CONSOLE_URL} />

        <div className="grid items-start gap-10 pb-28 lg:grid-cols-[minmax(0,1fr)_396px] lg:gap-12 lg:pb-16 xl:gap-16">
          <main>
            <Intro
              itemCount={catalogue?.skus.length ?? null}
              merchantCount={catalogue?.merchants.length ?? null}
              asset={catalogueAsset}
            />

            {offline ? (
              <div className="mt-8 flex items-start justify-between gap-4 border-l-2 border-signal pl-3">
                <p className="max-w-[60ch] text-[12.5px] leading-relaxed">
                  The till cannot reach TAB, so this is the printed price list. Checkout will fail
                  until the API is up on port 4000.
                </p>
                <button type="button" onClick={() => void loadCatalogue()} className="link-mono shrink-0">
                  Retry
                </button>
              </div>
            ) : null}

            {loading && !catalogue ? (
              <CatalogueSkeleton />
            ) : (
              <CatalogueList
                groups={groups}
                selectedSkuId={selectedSku?.id ?? null}
                busy={!canEdit}
                onChoose={chooseSku}
                onRetry={() => void loadCatalogue()}
              />
            )}
          </main>

          <CheckoutSlip
            phase={phase}
            mode={mode}
            onModeChange={changeMode}
            order={order}
            token={token}
            onTokenChange={(value) => {
              setToken(value);
              if (formError) setFormError(null);
            }}
            submittedToken={attempt?.token ?? null}
            manual={manual}
            onManualChange={(patch) => setManual((previous) => ({ ...previous, ...patch }))}
            merchants={catalogue?.merchants ?? []}
            busy={busy}
            formError={formError}
            timedOut={timedOut}
            elapsedSec={elapsedSec}
            fulfilmentKey={receiptKey}
            consoleUrl={CONSOLE_URL}
            sheetOpen={sheetOpen}
            onClose={() => setSheetOpen(false)}
            onPresent={() => void present()}
            onRetry={retry}
            onCheckAgain={checkAgain}
            onNewSale={newSale}
            onEdit={editSlip}
          />
        </div>

        <footer className="mt-16 border-t border-ink pb-28 pt-4 lg:pb-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <p className="mono-label">
              Agent Depot · Station 01 · A demo merchant for TAB
            </p>
            <p className="mono-label text-muted">
              {catalogueAsset ? `Prices in ${catalogueAsset}` : "Prices as quoted"} · settles on
              Stellar testnet
            </p>
          </div>
        </footer>
      </div>

      <MobileBar
        phase={phase}
        amount={sheetAmount}
        asset={liveCharge?.asset ?? order.asset}
        sheetOpen={sheetOpen}
        onOpen={() => setSheetOpen(true)}
      />

      {sheetOpen ? (
        <div
          className="no-print fixed inset-0 z-30 bg-ink/45 lg:hidden"
          onClick={() => setSheetOpen(false)}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}

function CatalogueSkeleton() {
  return (
    <div className="mt-11" role="status" aria-live="polite">
      <p className="mono-label">
        Fetching the price list <span className="blink">▌</span>
      </p>
      <div className="mt-6 space-y-9" aria-hidden="true">
        {[0, 1, 2].map((group) => (
          <div key={group}>
            <div className="h-6 w-40 bg-line/70" />
            <div className="mt-4 h-px w-full bg-line" />
            {[0, 1].map((row) => (
              <div
                key={row}
                className="flex justify-between gap-6 border-b border-line py-6"
              >
                <div className="space-y-2">
                  <div className="h-4 w-52 max-w-full bg-line/70" />
                  <div className="h-3 w-72 max-w-full bg-line/50" />
                </div>
                <div className="h-4 w-14 shrink-0 bg-line/70" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
