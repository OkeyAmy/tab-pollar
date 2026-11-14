"use client";

import { MoneySchema, cmpMoney } from "@tab/shared";
import { useEffect, useState } from "react";
import { useTab } from "@/components/tab-store";
import { ApiError } from "@/lib/api";
import { Dialog, CopyButton } from "@/components/ui";
import { PhysicalCard } from "@/components/card";

/* ── create an agent; the key is shown once ──────────────────────────────── */

export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (agentId: string) => void;
}) {
  const { createAgent } = useTab();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("🔭");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setEmoji("🔭");
      setError(null);
      setApiKey(null);
      setAgentId(null);
      setConfirmed(false);
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (name.trim().length < 2) {
      setError({ code: "INVALID_NAME", message: "Give the agent a name of at least 2 characters." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await createAgent({
        name: name.trim(),
        description: description.trim() || undefined,
        emoji: emoji.trim() || undefined,
      });
      setApiKey(result.apiKey);
      setAgentId(result.agent.id);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.code, message: err.sentence }
          : { code: "UNEXPECTED", message: err instanceof Error ? err.message : "Unknown error." },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Agents"
      title={apiKey ? "Store this key now" : "Create an agent"}
      footer={
        apiKey ? (
          <>
            <label className="check" style={{ marginRight: "auto" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span style={{ fontSize: 12 }}>I&apos;ve stored it in a safe place.</span>
            </label>
            <button
              className="btn btn-primary"
              disabled={!confirmed}
              onClick={() => {
                if (!confirmed) return;
                if (agentId) onCreated?.(agentId);
                onClose();
              }}
            >
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-quiet" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} aria-busy={busy}>
              {busy ? "Creating…" : "Create agent"}
            </button>
          </>
        )
      }
    >
      {apiKey ? (
        <>
          <div className="key-reveal">
            <span className="micro">Agent API key · shown once</span>
            <code>{apiKey}</code>
            <p>
              This is the only time TAB will show it. It is stored hashed. The key can request
              charges inside a card&apos;s limits — it can never touch your wallet or sign a payment.
            </p>
            <CopyButton value={apiKey} label="Copy key" className="btn btn-sm btn-primary" />
          </div>
          <div className="field">
            <label>Hand it to the agent</label>
            <pre className="json-view">{`TAB_API_URL=${
              typeof window === "undefined" ? "<this origin>" : window.location.origin
            }/api/v1
TAB_AGENT_KEY=${apiKey}`}</pre>
            <span className="field-hint">
              Claude Code or the MCP server reads these two values. Nothing else is needed.
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="agent-name">Name</label>
              <input
                id="agent-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Scout"
                maxLength={40}
                autoFocus
              />
              <span className="field-hint">The cardholder name on the physical card.</span>
            </div>
            <div className="field">
              <label htmlFor="agent-emoji">Mark</label>
              <input
                id="agent-emoji"
                className="input"
                value={emoji}
                onChange={(event) => setEmoji(event.target.value)}
                maxLength={8}
                aria-describedby="agent-emoji-hint"
              />
              <span className="field-hint" id="agent-emoji-hint">
                One character. Optional.
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="agent-description">What does it buy?</label>
            <input
              id="agent-description"
              className="input"
              style={{ fontFamily: "var(--font-ui)" }}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="research data, API credits, datasets"
              maxLength={200}
            />
            <span className="field-hint">A note for you. The policy engine does not read it.</span>
          </div>
          {error ? (
            <div className="error-box" role="alert">
              <div style={{ display: "grid", gap: 4 }}>
                <span className="code">{error.code}</span>
                <p>{error.message}</p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  );
}

/* ── open a tab ──────────────────────────────────────────────────────────── */

const EXPIRY_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

export function OpenTabDialog({
  open,
  onClose,
  defaultAgentId,
}: {
  open: boolean;
  onClose: () => void;
  defaultAgentId?: string | null;
}) {
  const { agents, merchants, createCard, refresh } = useTab();
  const [agentId, setAgentId] = useState(defaultAgentId ?? agents[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [budget, setBudget] = useState("25");
  const [perCharge, setPerCharge] = useState("5");
  const [daily, setDaily] = useState("10");
  const [approval, setApproval] = useState("3");
  const [selectedMerchants, setSelectedMerchants] = useState<string[]>([]);
  const [expiryHours, setExpiryHours] = useState(24);
  const [chain, setChain] = useState<"STELLAR" | "SOLANA">("STELLAR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!open) {
      setHydrated(false);
      setError(null);
      setFieldErrors({});
      setBusy(false);
      return;
    }
    if (hydrated) return;
    if (agents.length === 0 && merchants.length === 0) return;
    setAgentId(defaultAgentId ?? agents[0]?.id ?? "");
    setLabel(agents[0] ? `${agents[0].name} card` : "");
    setSelectedMerchants(merchants.slice(0, 2).map((merchant) => merchant.id));
    setHydrated(true);
  }, [open, hydrated, defaultAgentId, agents, merchants]);

  const money = (value: string) => MoneySchema.safeParse(value.trim());

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!agentId) errors.agentId = "Pick an agent. A card belongs to one agent.";
    if (label.trim().length < 2) errors.label = "Give the tab a label of at least 2 characters.";
    for (const [key, value] of Object.entries({ budget, perCharge, daily, approval })) {
      if (!money(value).success) errors[key] = "Use a decimal like 25 or 2.50 (≤7 dp).";
    }
    if (selectedMerchants.length === 0) errors.merchants = "Pick at least one merchant.";

    if (Object.keys(errors).length === 0) {
      const b = budget.trim();
      const p = perCharge.trim();
      const d = daily.trim();
      const a = approval.trim();
      if (cmpMoney(b, "0") <= 0) errors.budget = "The tab budget must be greater than zero.";
      if (cmpMoney(p, b) > 0) errors.perCharge = "Max per charge cannot exceed the tab budget.";
      if (cmpMoney(a, p) > 0) errors.approval = "The approval line cannot exceed the per-charge cap.";
      if (cmpMoney(d, b) > 0) errors.daily = "The daily cap cannot exceed the tab budget.";
      if (cmpMoney(d, p) < 0) errors.daily = "The daily cap cannot be below the per-charge cap.";
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      await createCard({
        agentId,
        label: label.trim(),
        budget: budget.trim(),
        perCharge: perCharge.trim(),
        daily: daily.trim(),
        autoApproveUnder: approval.trim(),
        merchants: selectedMerchants,
        expiresInHours: expiryHours,
        chain,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.code, message: err.sentence }
          : { code: "UNEXPECTED", message: err instanceof Error ? err.message : "Unknown error." },
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleMerchant = (id: string) => {
    setSelectedMerchants((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const canSubmit = agents.length > 0 && merchants.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="New tab"
      title="Open a tab"
      width={760}
      footer={
        <>
          <button className="btn btn-quiet" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
            aria-busy={busy}
          >
            {busy ? "Opening…" : "Open tab"}
          </button>
        </>
      }
    >
      {agents.length === 0 ? (
        <div className="empty">
          <h3>Create an agent first.</h3>
          <p>A tab is scoped to one agent. Create one, store its key, then come back.</p>
        </div>
      ) : merchants.length === 0 ? (
        <div className="empty">
          <h3>The merchant list is empty.</h3>
          <p>
            The tab needs an allowlist from <code className="inline">GET /merchants</code>. The
            catalogue has not loaded — is the API running and seeded?
          </p>
          <button className="btn btn-sm" onClick={() => void refresh()}>
            Retry catalogue
          </button>
        </div>
      ) : (
        <div className="wizard">
          <div className="wizard-fields">
            <div className="grid-2">
              <div className="field">
                <label htmlFor="tab-agent">Agent</label>
                <div className="select-wrap">
                  <select
                    id="tab-agent"
                    className="select"
                    style={{ fontFamily: "var(--font-ui)" }}
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </div>
                {fieldErrors.agentId ? <span className="field-error">{fieldErrors.agentId}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="tab-label">Label</label>
                <input
                  id="tab-label"
                  className="input"
                  style={{ fontFamily: "var(--font-ui)" }}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="Research Scout"
                  maxLength={40}
                />
                {fieldErrors.label ? <span className="field-error">{fieldErrors.label}</span> : null}
              </div>
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="tab-budget">Tab budget · total</label>
                <input
                  id="tab-budget"
                  className="input"
                  inputMode="decimal"
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <span className="field-hint">The card can never lose more than this.</span>
                {fieldErrors.budget ? <span className="field-error">{fieldErrors.budget}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="tab-expiry">Expires</label>
                <div className="select-wrap">
                  <select
                    id="tab-expiry"
                    className="select"
                    style={{ fontFamily: "var(--font-ui)" }}
                    value={expiryHours}
                    onChange={(event) => setExpiryHours(Number(event.target.value))}
                  >
                    {EXPIRY_OPTIONS.map((option) => (
                      <option key={option.hours} value={option.hours}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="grid-3">
              <div className="field">
                <label htmlFor="tab-per">Max per charge</label>
                <input
                  id="tab-per"
                  className="input"
                  inputMode="decimal"
                  value={perCharge}
                  onChange={(event) => setPerCharge(event.target.value)}
                />
                {fieldErrors.perCharge ? (
                  <span className="field-error">{fieldErrors.perCharge}</span>
                ) : (
                  <span className="field-hint">One charge, hard cap.</span>
                )}
              </div>
              <div className="field">
                <label htmlFor="tab-daily">Daily cap</label>
                <input
                  id="tab-daily"
                  className="input"
                  inputMode="decimal"
                  value={daily}
                  onChange={(event) => setDaily(event.target.value)}
                />
                {fieldErrors.daily ? (
                  <span className="field-error">{fieldErrors.daily}</span>
                ) : (
                  <span className="field-hint">Settled + reserved, 24h.</span>
                )}
              </div>
              <div className="field">
                <label htmlFor="tab-approval">Needs you above</label>
                <input
                  id="tab-approval"
                  className="input"
                  inputMode="decimal"
                  value={approval}
                  onChange={(event) => setApproval(event.target.value)}
                />
                {fieldErrors.approval ? (
                  <span className="field-error">{fieldErrors.approval}</span>
                ) : (
                  <span className="field-hint">TAB asks; your wallet still signs.</span>
                )}
              </div>
            </div>

            <div className="field">
              <label>Merchants</label>
              <div className="merchant-grid" role="group" aria-label="Merchant allowlist">
                {merchants.map((merchant) => {
                  const pressed = selectedMerchants.includes(merchant.id);
                  return (
                    <button
                      key={merchant.id}
                      type="button"
                      className="merchant-pick"
                      aria-pressed={pressed}
                      onClick={() => toggleMerchant(merchant.id)}
                    >
                      <span aria-hidden="true">{merchant.emoji}</span>
                      {merchant.name}
                    </button>
                  );
                })}
              </div>
              {fieldErrors.merchants ? (
                <span className="field-error">{fieldErrors.merchants}</span>
              ) : (
                <span className="field-hint">
                  Not &ldquo;the internet&rdquo;. A charge to any other merchant fails with
                  MERCHANT_NOT_ALLOWED.
                </span>
              )}
            </div>

            <div className="field">
              <label>Settlement chain</label>
              <div className="seg" role="group" aria-label="Settlement chain">
                <button
                  type="button"
                  aria-pressed={chain === "STELLAR"}
                  onClick={() => setChain("STELLAR")}
                >
                  Stellar
                </button>
                <button
                  type="button"
                  aria-pressed={chain === "SOLANA"}
                  onClick={() => setChain("SOLANA")}
                >
                  Solana
                </button>
              </div>
              <span className="field-hint">
                {chain === "SOLANA"
                  ? "Solana devnet is OFF for this Pollar app. The card is still created, but settlement will fail — use Stellar for the demo."
                  : "Stellar testnet, sponsored fees. The wallet needs testnet USDC or XLM."}
              </span>
            </div>

            {error ? (
              <div className="error-box" role="alert">
                <div style={{ display: "grid", gap: 4 }}>
                  <span className="code">{error.code}</span>
                  <p>{error.message}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div className="wizard-preview">
            <span className="micro">Preview · not issued</span>
            <PhysicalCard
              card={{
                id: "crd_preview",
                ownerId: "usr_preview",
                agentId,
                label: label || "Preview",
                maskedNumber: "4021 •••• •••• ••••",
                status: "ACTIVE",
                chain,
                asset: "USDC",
                budget: {
                  total: MoneySchema.safeParse(budget).success ? budget : "0",
                  spent: "0",
                  reserved: "0",
                },
                limits: {
                  perCharge: MoneySchema.safeParse(perCharge).success ? perCharge : "0",
                  daily: MoneySchema.safeParse(daily).success ? daily : "0",
                  autoApproveUnder: MoneySchema.safeParse(approval).success ? approval : "0",
                },
                merchants: selectedMerchants,
                expiresAt: new Date(Date.now() + expiryHours * 3600_000).toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }}
              agentName={agents.find((agent) => agent.id === agentId)?.name ?? "Agent"}
            />
            <div className="wizard-summary">
              <span>
                Budget <b>${budget || "0"}</b>
              </span>
              <span>
                Per charge <b>${perCharge || "0"}</b>
              </span>
              <span>
                Daily <b>${daily || "0"}</b>
              </span>
              <span>
                Approval above <b>${approval || "0"}</b>
              </span>
              <span>
                Merchants <b>{selectedMerchants.length}</b>
              </span>
              <span>
                Ladder{" "}
                <b>
                  {approval || "0"} ≤ {perCharge || "0"} ≤ {daily || "0"} ≤ {budget || "0"}
                </b>
              </span>
            </div>
            <p className="signer-note">
              Opening a tab is not a payment. Funds stay in your wallet until a merchant redeems a
              charge token and you sign.
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
}
