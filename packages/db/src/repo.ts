/**
 * Repository layer. One file, explicit SQL, row mappers at the boundary.
 * No ORM. The API layer must only call these methods.
 *
 * OWNER: platform agent. Extend freely, keep the exported method names stable.
 */
import type { Db } from "./index.js";
import { fromUnits, maskCardNumber, toUnits } from "@tab/shared";
import type {
  Agent,
  AgentStatus,
  Card,
  CardStatus,
  CardToken,
  Charge,
  ChargeStatus,
  LedgerEvent,
  Merchant,
  PolicyDecision,
  PurchaseResponse,
  Sku,
  TxReceipt,
  User,
} from "@tab/shared";

type Row = Record<string, any>;

const j = <T>(v: string | null, fallback: T): T => {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

const mapUser = (r: Row): User => ({
  id: r.id,
  pollarUserId: r.pollar_user_id,
  email: r.email,
  name: r.name,
  stellarAddress: r.stellar_address,
  solanaAddress: r.solana_address,
  createdAt: r.created_at,
});

const mapAgent = (r: Row): Agent => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  description: r.description,
  emoji: r.emoji,
  status: r.status as AgentStatus,
  keyPrefix: r.key_prefix,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

const mapCard = (r: Row): Card => ({
  id: r.id,
  ownerId: r.owner_id,
  agentId: r.agent_id,
  label: r.label,
  // Display-only and derived from the id (CONTRACTS.md) — never stored, so it
  // can never drift from the card it belongs to.
  maskedNumber: maskCardNumber(r.id),
  status: r.status as CardStatus,
  chain: r.chain,
  asset: r.asset,
  budget: { total: r.budget_total, spent: r.budget_spent, reserved: r.budget_reserved },
  limits: { perCharge: r.per_charge, daily: r.daily, autoApproveUnder: r.auto_approve_under },
  merchants: j<string[]>(r.merchants_json, []),
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMerchant = (r: Row): Merchant => ({
  id: r.id,
  name: r.name,
  domain: r.domain,
  emoji: r.emoji,
  category: r.category,
  settlementAddress: r.settlement_address,
  settlementChain: r.settlement_chain,
  createdAt: r.created_at,
});

const mapSku = (r: Row): Sku => ({
  id: r.id,
  merchantId: r.merchant_id,
  name: r.name,
  description: r.description,
  price: r.price,
  unit: r.unit,
  licensePrefix: r.license_prefix,
});

const mapToken = (r: Row): CardToken => ({
  id: r.id,
  cardId: r.card_id,
  agentId: r.agent_id,
  merchantId: r.merchant_id,
  maxAmount: r.max_amount,
  status: r.status,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  createdAt: r.created_at,
});

const mapCharge = (r: Row): Charge => ({
  id: r.id,
  cardId: r.card_id,
  agentId: r.agent_id,
  ownerId: r.owner_id,
  merchantId: r.merchant_id,
  merchantName: r.merchant_name ?? "",
  amount: r.amount,
  asset: r.asset,
  description: r.description,
  status: r.status as ChargeStatus,
  decision: j<PolicyDecision>(r.decision_json, {
    allowed: false,
    requiresApproval: false,
    code: "SETTLEMENT_ERROR",
    message: "missing decision",
    checks: [],
  }),
  approvalRequired: Boolean(r.approval_required),
  approvedAt: r.approved_at,
  declinedAt: r.declined_at,
  declineReason: r.decline_reason,
  receipt: j<TxReceipt | null>(r.receipt_json, null),
  error: r.error,
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapEvent = (r: Row): LedgerEvent => ({
  id: r.id,
  ownerId: r.owner_id,
  cardId: r.card_id,
  chargeId: r.charge_id,
  type: r.type,
  actor: r.actor,
  summary: r.summary,
  data: j<Record<string, unknown>>(r.data_json, {}),
  createdAt: r.created_at,
});

export class Repo {
  constructor(public readonly db: Db) {}

  /* ── users ─────────────────────────────────────────────────────────────── */

  upsertUser(input: {
    id: string;
    pollarUserId: string;
    email: string | null;
    name: string | null;
    stellarAddress: string | null;
    solanaAddress: string | null;
    createdAt: string;
  }): User {
    this.db
      .prepare(
        `INSERT INTO users (id, pollar_user_id, email, name, stellar_address, solana_address, created_at)
         VALUES (@id, @pollarUserId, @email, @name, @stellarAddress, @solanaAddress, @createdAt)
         ON CONFLICT(pollar_user_id) DO UPDATE SET
           email = COALESCE(excluded.email, users.email),
           name = COALESCE(excluded.name, users.name),
           stellar_address = COALESCE(excluded.stellar_address, users.stellar_address),
           solana_address = COALESCE(excluded.solana_address, users.solana_address)`,
      )
      .run(input);
    return this.getUserByPollarId(input.pollarUserId)!;
  }

  getUserByPollarId(pollarUserId: string): User | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE pollar_user_id = ?`).get(pollarUserId) as Row | undefined;
    return r ? mapUser(r) : null;
  }

  getUserById(id: string): User | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapUser(r) : null;
  }

  /* ── sessions ──────────────────────────────────────────────────────────── */

  createSession(input: { id: string; userId: string; tokenHash: string; createdAt: string; expiresAt: string }): void {
    this.db.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt)`).run(input);
  }

  getUserBySessionHash(tokenHash: string): User | null {
    const r = this.db
      .prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(tokenHash, new Date().toISOString()) as Row | undefined;
    return r ? mapUser(r) : null;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  /* ── agents ────────────────────────────────────────────────────────────── */

  createAgent(input: {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    emoji: string;
    keyHash: string;
    keyPrefix: string;
    createdAt: string;
  }): Agent {
    this.db.prepare(`INSERT INTO agents (id, owner_id, name, description, emoji, status, key_hash, key_prefix, created_at)
      VALUES (@id, @ownerId, @name, @description, @emoji, 'ACTIVE', @keyHash, @keyPrefix, @createdAt)`).run(input);
    return this.getAgent(input.id)!;
  }

  getAgent(id: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapAgent(r) : null;
  }

  getAgentByKeyHash(keyHash: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE key_hash = ?`).get(keyHash) as Row | undefined;
    return r ? mapAgent(r) : null;
  }

  listAgents(ownerId: string): Agent[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId) as Row[]).map(mapAgent);
  }

  setAgentStatus(id: string, status: AgentStatus): void {
    this.db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(status, id);
  }

  touchAgent(id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  rotateAgentKey(id: string, keyHash: string, keyPrefix: string): void {
    this.db.prepare(`UPDATE agents SET key_hash = ?, key_prefix = ? WHERE id = ?`).run(keyHash, keyPrefix, id);
  }

  /* ── cards ─────────────────────────────────────────────────────────────── */

  createCard(input: {
    id: string;
    ownerId: string;
    agentId: string;
    label: string;
    /** Accepted for API symmetry; the stored display number is derived from `id`. */
    maskedNumber: string;
    chain: string;
    asset: string;
    budgetTotal: string;
    perCharge: string;
    daily: string;
    autoApproveUnder: string;
    merchants: string[];
    expiresAt: string;
    createdAt: string;
  }): Card {
    this.db.prepare(`INSERT INTO cards (id, owner_id, agent_id, label, status, chain, asset, budget_total, budget_spent, budget_reserved, per_charge, daily, auto_approve_under, merchants_json, expires_at, created_at, updated_at)
      VALUES (@id, @ownerId, @agentId, @label, 'ACTIVE', @chain, @asset, @budgetTotal, '0', '0', @perCharge, @daily, @autoApproveUnder, @merchantsJson, @expiresAt, @createdAt, @createdAt)`)
      .run({ ...input, merchantsJson: JSON.stringify(input.merchants) });
    return this.getCard(input.id)!;
  }

  getCard(id: string): Card | null {
    const r = this.db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapCard(r) : null;
  }

  listCards(ownerId: string): Card[] {
    return (this.db.prepare(`SELECT * FROM cards WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId) as Row[]).map(mapCard);
  }

  listCardsForAgent(agentId: string): Card[] {
    return (this.db.prepare(`SELECT * FROM cards WHERE agent_id = ? ORDER BY created_at DESC`).all(agentId) as Row[]).map(mapCard);
  }

  updateCard(id: string, patch: Partial<{
    label: string; status: CardStatus; asset: string; budgetTotal: string; perCharge: string; daily: string;
    autoApproveUnder: string; merchants: string[]; expiresAt: string;
  }>): Card {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };
    const map: Record<string, string> = {
      label: "label", status: "status", asset: "asset", budgetTotal: "budget_total", perCharge: "per_charge",
      daily: "daily", autoApproveUnder: "auto_approve_under", expiresAt: "expires_at",
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k as keyof typeof patch] !== undefined) {
        sets.push(`${col} = @${k}`);
        params[k] = patch[k as keyof typeof patch];
      }
    }
    if (patch.merchants !== undefined) {
      sets.push(`merchants_json = @merchantsJson`);
      params.merchantsJson = JSON.stringify(patch.merchants);
    }
    sets.push(`updated_at = @updatedAt`);
    this.db.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.getCard(id)!;
  }

  /**
   * Atomically reserve budget. Returns false when the card cannot cover it.
   * All arithmetic is bigint base-units in JS — no SQLite REAL, ever.
   */
  reserveBudget(cardId: string, amount: string): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`SELECT budget_total, budget_spent, budget_reserved, status FROM cards WHERE id = ?`).get(cardId) as Row | undefined;
      if (!r || r.status !== "ACTIVE") return false;
      const total = toUnits(r.budget_total);
      const used = toUnits(r.budget_spent) + toUnits(r.budget_reserved);
      const add = toUnits(amount);
      if (used + add > total) return false;
      this.db.prepare(`UPDATE cards SET budget_reserved = ?, updated_at = ? WHERE id = ?`).run(fromUnits(toUnits(r.budget_reserved) + add), new Date().toISOString(), cardId);
      return true;
    });
    return tx();
  }

  releaseBudget(cardId: string, amount: string): void {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`SELECT budget_reserved FROM cards WHERE id = ?`).get(cardId) as Row | undefined;
      if (!r) return;
      const next = toUnits(r.budget_reserved) - toUnits(amount);
      this.db.prepare(`UPDATE cards SET budget_reserved = ?, updated_at = ? WHERE id = ?`).run(fromUnits(next > 0n ? next : 0n), new Date().toISOString(), cardId);
    });
    tx();
  }

  settleBudget(cardId: string, amount: string): void {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(`SELECT budget_reserved, budget_spent FROM cards WHERE id = ?`).get(cardId) as Row | undefined;
      if (!r) return;
      const reserved = toUnits(r.budget_reserved) - toUnits(amount);
      this.db.prepare(`UPDATE cards SET budget_reserved = ?, budget_spent = ?, updated_at = ? WHERE id = ?`).run(
        fromUnits(reserved > 0n ? reserved : 0n),
        fromUnits(toUnits(r.budget_spent) + toUnits(amount)),
        new Date().toISOString(),
        cardId,
      );
    });
    tx();
  }

  /* ── merchants / skus ──────────────────────────────────────────────────── */

  upsertMerchant(m: Merchant): void {
    this.db.prepare(`INSERT INTO merchants (id, name, domain, emoji, category, settlement_address, settlement_chain, created_at)
      VALUES (@id, @name, @domain, @emoji, @category, @settlementAddress, @settlementChain, @createdAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain, emoji=excluded.emoji,
        category=excluded.category, settlement_address=excluded.settlement_address, settlement_chain=excluded.settlement_chain`).run(m);
  }

  listMerchants(): Merchant[] {
    return (this.db.prepare(`SELECT * FROM merchants ORDER BY name`).all() as Row[]).map(mapMerchant);
  }

  getMerchant(id: string): Merchant | null {
    const r = this.db.prepare(`SELECT * FROM merchants WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapMerchant(r) : null;
  }

  upsertSku(s: Sku): void {
    this.db.prepare(`INSERT INTO skus (id, merchant_id, name, description, price, unit, license_prefix)
      VALUES (@id, @merchantId, @name, @description, @price, @unit, @licensePrefix)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, price=excluded.price, unit=excluded.unit`).run(s);
  }

  listSkus(): Sku[] {
    return (this.db.prepare(`SELECT * FROM skus ORDER BY price`).all() as Row[]).map(mapSku);
  }

  getSku(id: string): Sku | null {
    const r = this.db.prepare(`SELECT * FROM skus WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapSku(r) : null;
  }

  /* ── card tokens ───────────────────────────────────────────────────────── */

  createToken(input: {
    id: string; cardId: string; agentId: string; merchantId: string | null;
    maxAmount: string; tokenHash: string; expiresAt: string; createdAt: string;
  }): CardToken {
    this.db.prepare(`INSERT INTO card_tokens (id, card_id, agent_id, merchant_id, max_amount, token_hash, status, expires_at, created_at)
      VALUES (@id, @cardId, @agentId, @merchantId, @maxAmount, @tokenHash, 'ACTIVE', @expiresAt, @createdAt)`).run(input);
    const r = this.db.prepare(`SELECT * FROM card_tokens WHERE id = ?`).get(input.id) as Row;
    return mapToken(r);
  }

  getTokenByHash(tokenHash: string): CardToken | null {
    const r = this.db.prepare(`SELECT * FROM card_tokens WHERE token_hash = ?`).get(tokenHash) as Row | undefined;
    return r ? mapToken(r) : null;
  }

  getToken(id: string): CardToken | null {
    const r = this.db.prepare(`SELECT * FROM card_tokens WHERE id = ?`).get(id) as Row | undefined;
    return r ? mapToken(r) : null;
  }

  markTokenUsed(id: string): boolean {
    return this.db.prepare(`UPDATE card_tokens SET status='USED', used_at=? WHERE id=? AND status='ACTIVE'`).run(new Date().toISOString(), id).changes === 1;
  }

  revokeTokensForCard(cardId: string): void {
    this.db.prepare(`UPDATE card_tokens SET status='REVOKED' WHERE card_id=? AND status='ACTIVE'`).run(cardId);
  }

  /* ── charges ───────────────────────────────────────────────────────────── */

  createCharge(input: {
    id: string; cardId: string; agentId: string; ownerId: string; merchantId: string;
    amount: string; asset: string; description: string; status: ChargeStatus;
    decision: PolicyDecision; approvalRequired: boolean; idempotencyKey: string | null; createdAt: string;
  }): Charge {
    this.db.prepare(`INSERT INTO charges (id, card_id, agent_id, owner_id, merchant_id, amount, asset, description, status, decision_json, approval_required, idempotency_key, created_at, updated_at)
      VALUES (@id, @cardId, @agentId, @ownerId, @merchantId, @amount, @asset, @description, @status, @decisionJson, @approvalRequired, @idempotencyKey, @createdAt, @createdAt)`)
      .run({ ...input, decisionJson: JSON.stringify(input.decision), approvalRequired: input.approvalRequired ? 1 : 0 });
    return this.getCharge(input.id)!;
  }

  getCharge(id: string): Charge | null {
    const r = this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.id = ?`).get(id) as Row | undefined;
    return r ? mapCharge(r) : null;
  }

  getChargeByIdempotency(cardId: string, key: string): Charge | null {
    const r = this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.card_id = ? AND c.idempotency_key = ?`).get(cardId, key) as Row | undefined;
    return r ? mapCharge(r) : null;
  }

  listCharges(ownerId: string, limit = 50): Charge[] {
    return (this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.owner_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(ownerId, limit) as Row[]).map(mapCharge);
  }

  listChargesForCard(cardId: string, limit = 50): Charge[] {
    return (this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.card_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(cardId, limit) as Row[]).map(mapCharge);
  }

  /** Charges belonging to one agent (agent-key auth on `GET /charges`). */
  listChargesForAgent(agentId: string, limit = 50): Charge[] {
    return (this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.agent_id = ? ORDER BY c.created_at DESC LIMIT ?`).all(agentId, limit) as Row[]).map(mapCharge);
  }

  /**
   * Signer backlog for reconnect recovery (`GET /signer/pending`).
   * Oldest first so the console drains in the order charges were created.
   */
  getChargesAwaitingSigner(ownerId: string, limit = 50): Charge[] {
    return (this.db.prepare(`SELECT c.*, m.name AS merchant_name FROM charges c LEFT JOIN merchants m ON m.id=c.merchant_id WHERE c.owner_id = ? AND c.status IN ('QUEUED','SIGNING') ORDER BY c.created_at ASC LIMIT ?`).all(ownerId, limit) as Row[]).map(mapCharge);
  }

  setChargeStatus(id: string, status: ChargeStatus, patch: { approvedAt?: string; declinedAt?: string; declineReason?: string; error?: string } = {}): Charge {
    const sets = [`status = @status`, `updated_at = @updatedAt`];
    const params: Record<string, unknown> = { id, status, updatedAt: new Date().toISOString() };
    for (const [k, col] of Object.entries({ approvedAt: "approved_at", declinedAt: "declined_at", declineReason: "decline_reason", error: "error" })) {
      if (patch[k as keyof typeof patch] !== undefined) { sets.push(`${col} = @${k}`); params[k] = patch[k as keyof typeof patch]; }
    }
    this.db.prepare(`UPDATE charges SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.getCharge(id)!;
  }

  setChargeReceipt(id: string, receipt: TxReceipt): Charge {
    this.db.prepare(`UPDATE charges SET receipt_json = ?, status = 'SETTLED', updated_at = ? WHERE id = ?`).run(JSON.stringify(receipt), new Date().toISOString(), id);
    return this.getCharge(id)!;
  }

  /**
   * Sum of settled charges for a card since an ISO timestamp, using settlement
   * time (`updated_at`), not creation time. A charge created before the window
   * but settled inside it still counts against the rolling daily cap.
   */
  settledSince(cardId: string, sinceIso: string): string {
    const rows = this.db.prepare(`SELECT amount FROM charges WHERE card_id = ? AND status = 'SETTLED' AND updated_at >= ?`).all(cardId, sinceIso) as { amount: string }[];
    return fromUnits(rows.reduce((acc, r) => acc + toUnits(r.amount), 0n));
  }

  /**
   * Daily-cap figure: settled amounts inside the window **plus** in-flight
   * reservations (AWAITING_APPROVAL/QUEUED/SIGNING) created inside it.
   *
   * Counting reservations is what stops two concurrent $6 charges from both
   * passing a $10 daily cap. bigint only, never SQLite REAL.
   */
  committedSince(cardId: string, sinceIso: string): string {
    const rows = this.db
      .prepare(
        `SELECT status, amount, created_at, updated_at FROM charges
         WHERE card_id = ? AND status IN ('SETTLED','AWAITING_APPROVAL','QUEUED','SIGNING')`,
      )
      .all(cardId) as Array<{ status: string; amount: string; created_at: string; updated_at: string }>;
    let total = 0n;
    for (const row of rows) {
      const at = row.status === "SETTLED" ? row.updated_at : row.created_at;
      if (at >= sinceIso) total += toUnits(row.amount);
    }
    return fromUnits(total);
  }

  countCharges(ownerId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM charges WHERE owner_id = ?`).get(ownerId) as { n: number }).n;
  }

  /* ── signer jobs ───────────────────────────────────────────────────────── */

  createSignerJob(input: { id: string; chargeId: string; createdAt: string }): void {
    this.db.prepare(`INSERT OR IGNORE INTO signer_jobs (id, charge_id, status, created_at) VALUES (@id, @chargeId, 'QUEUED', @createdAt)`).run(input);
  }

  claimSignerJob(chargeId: string): boolean {
    return this.db.prepare(`UPDATE signer_jobs SET status='CLAIMED', claimed_at=? WHERE charge_id=? AND status='QUEUED'`).run(new Date().toISOString(), chargeId).changes === 1;
  }

  completeSignerJob(chargeId: string, status: "SIGNED" | "FAILED", error: string | null = null): void {
    this.db.prepare(`UPDATE signer_jobs SET status=?, completed_at=?, error=? WHERE charge_id=?`).run(status, new Date().toISOString(), error, chargeId);
  }

  cancelSignerJob(chargeId: string): void {
    this.db.prepare(`UPDATE signer_jobs SET status='FAILED', completed_at=?, error='cancelled' WHERE charge_id=? AND status IN ('QUEUED','CLAIMED')`).run(new Date().toISOString(), chargeId);
  }

  hasQueuedJobs(): boolean {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM signer_jobs WHERE status IN ('QUEUED','CLAIMED')`).get() as { n: number };
    return r.n > 0;
  }

  /* ── purchases ─────────────────────────────────────────────────────────── */

  createPurchase(input: { id: string; chargeId: string; skuId: string; agentId: string; licenseKey: string; createdAt: string }): void {
    this.db.prepare(`INSERT INTO purchases (id, charge_id, sku_id, agent_id, license_key, created_at) VALUES (@id, @chargeId, @skuId, @agentId, @licenseKey, @createdAt)`).run(input);
  }

  /* ── ledger ────────────────────────────────────────────────────────────── */

  appendEvent(e: LedgerEvent): void {
    this.db.prepare(`INSERT INTO ledger_events (id, owner_id, card_id, charge_id, type, actor, summary, data_json, created_at)
      VALUES (@id, @ownerId, @cardId, @chargeId, @type, @actor, @summary, @dataJson, @createdAt)`).run({ ...e, dataJson: JSON.stringify(e.data ?? {}) });
  }

  listLedger(ownerId: string, limit = 100): LedgerEvent[] {
    return (this.db.prepare(`SELECT * FROM ledger_events WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`).all(ownerId, limit) as Row[]).map(mapEvent);
  }

  /* ── meta / demo ───────────────────────────────────────────────────────── */

  getMeta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  }

  resetDemo(): void {
    // Preserve the merchant catalogue and SKUs: the demo depends on them, and
    // a reset must never leave the app unable to make a sale.
    this.db.exec(`DELETE FROM purchases; DELETE FROM ledger_events; DELETE FROM signer_jobs; DELETE FROM charges; DELETE FROM card_tokens; DELETE FROM cards; DELETE FROM sessions; DELETE FROM agents; DELETE FROM users;`);
  }
}

export type { PurchaseResponse };
