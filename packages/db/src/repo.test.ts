import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskCardNumber, remainingBudget, toUnits } from "@tab/shared";
import type { LedgerEvent, Merchant, PolicyDecision, Sku } from "@tab/shared";
import { openDb, Repo, type Db } from "./index.js";

const NOW = "2026-11-14T12:00:00.000Z";
const LATER = "2026-11-14T13:00:00.000Z";
const YESTERDAY = "2026-11-13T12:00:00.000Z";

const decision: PolicyDecision = {
  allowed: true,
  requiresApproval: false,
  code: "OK",
  message: "Within limits.",
  checks: [],
};

const merchant: Merchant = {
  id: "mch_test",
  name: "Exa",
  domain: "exa.ai",
  emoji: "🔎",
  category: "search",
  settlementAddress: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC",
  settlementChain: "STELLAR",
  createdAt: NOW,
};

const sku: Sku = {
  id: "exa-starter",
  merchantId: "mch_test",
  name: "Exa Starter",
  description: "1,000 searches",
  price: "2.50",
  unit: "1,000 searches",
  licensePrefix: "EXA",
};

let db: Db;
let repo: Repo;

beforeEach(() => {
  db = openDb(":memory:");
  repo = new Repo(db);
  repo.upsertUser({
    id: "usr_test",
    pollarUserId: "pollar_test",
    email: "ada@example.com",
    name: "Ada",
    stellarAddress: null,
    solanaAddress: null,
    createdAt: NOW,
  });
  repo.createAgent({
    id: "agt_test",
    ownerId: "usr_test",
    name: "Scout",
    description: "buys research data",
    emoji: "🔭",
    keyHash: "hash_agent_1",
    keyPrefix: "tab_agent_ab",
    createdAt: NOW,
  });
  repo.upsertMerchant(merchant);
  repo.upsertSku(sku);
  repo.createCard({
    id: "crd_test",
    ownerId: "usr_test",
    agentId: "agt_test",
    label: "Research Scout",
    maskedNumber: "4021 •••• •••• 0000",
    chain: "STELLAR",
    asset: "USDC",
    budgetTotal: "25",
    perCharge: "5",
    daily: "10",
    autoApproveUnder: "3",
    merchants: ["mch_test"],
    expiresAt: "2026-11-15T12:00:00.000Z",
    createdAt: NOW,
  });
});

afterEach(() => {
  db.close();
});

function mkCard(id: string, total: string): void {
  repo.createCard({
    id,
    ownerId: "usr_test",
    agentId: "agt_test",
    label: id,
    maskedNumber: "4021 •••• •••• 1111",
    chain: "STELLAR",
    asset: "USDC",
    budgetTotal: total,
    perCharge: "5",
    daily: "10",
    autoApproveUnder: "3",
    merchants: ["mch_test"],
    expiresAt: "2026-11-15T12:00:00.000Z",
    createdAt: NOW,
  });
}

function mkCharge(over: Partial<Parameters<Repo["createCharge"]>[0]> = {}) {
  return repo.createCharge({
    id: "chg_test",
    cardId: "crd_test",
    agentId: "agt_test",
    ownerId: "usr_test",
    merchantId: "mch_test",
    amount: "2.50",
    asset: "USDC",
    description: "Exa starter",
    status: "QUEUED",
    decision,
    approvalRequired: false,
    idempotencyKey: null,
    createdAt: NOW,
    ...over,
  });
}

function mkToken(over: Partial<Parameters<Repo["createToken"]>[0]> = {}) {
  return repo.createToken({
    id: "tkn_test",
    cardId: "crd_test",
    agentId: "agt_test",
    merchantId: "mch_test",
    maxAmount: "2.50",
    tokenHash: "hash_token_1",
    expiresAt: LATER,
    createdAt: NOW,
    ...over,
  });
}

describe("users", () => {
  it("upserts on pollar id and keeps the original row id", () => {
    const user = repo.upsertUser({
      id: "usr_ignored",
      pollarUserId: "pollar_test",
      email: "ada@lovelace.dev",
      name: "Ada Lovelace",
      stellarAddress: "GABC",
      solanaAddress: null,
      createdAt: LATER,
    });
    // blindfold: contract — pollar_user_id is the upsert key; the first id wins.
    expect(user.id).toBe("usr_test");
    // blindfold: contract — mutable profile fields come from the latest login.
    expect(user.email).toBe("ada@lovelace.dev");
    // blindfold: contract — the latest login's name wins the upsert.
    expect(user.name).toBe("Ada Lovelace");
    // blindfold: contract — created_at is immutable after first insert.
    expect(user.createdAt).toBe(NOW);
    // blindfold: contract — a newly supplied wallet address is persisted.
    expect(repo.getUserByPollarId("pollar_test")?.stellarAddress).toBe("GABC");
    // blindfold: contract — lookup by internal id returns the same row.
    expect(repo.getUserById("usr_test")?.name).toBe("Ada Lovelace");
  });
});

describe("agents", () => {
  it("finds an agent by key hash and maps snake_case to camelCase", () => {
    const agent = repo.getAgentByKeyHash("hash_agent_1");
    expect(agent).not.toBeNull();
    // blindfold: contract — Agent shape uses camelCase ownerId/keyPrefix.
    expect(agent).toMatchObject({
      id: "agt_test",
      ownerId: "usr_test",
      name: "Scout",
      description: "buys research data",
      emoji: "🔭",
      status: "ACTIVE",
      keyPrefix: "tab_agent_ab",
      lastSeenAt: null,
    });
    expect(repo.getAgent("missing")).toBeNull();
  });

  it("rotates the key hash and touches last_seen_at", () => {
    repo.rotateAgentKey("agt_test", "hash_agent_2", "tab_agent_cd");
    expect(repo.getAgentByKeyHash("hash_agent_1")).toBeNull();
    // blindfold: contract — rotation replaces both the hash and the display prefix.
    expect(repo.getAgentByKeyHash("hash_agent_2")?.keyPrefix).toBe("tab_agent_cd");
    repo.touchAgent("agt_test");
    expect(repo.getAgent("agt_test")?.lastSeenAt).not.toBeNull();
  });
});

describe("cards", () => {
  it("creates a card with decimal-string budgets and JSON merchants", () => {
    const card = repo.getCard("crd_test");
    expect(card).not.toBeNull();
    // blindfold: contract — the seeded demo card is $25 total, $5/charge, $10/day, $3 auto-approve.
    expect(card).toMatchObject({
      id: "crd_test",
      ownerId: "usr_test",
      agentId: "agt_test",
      label: "Research Scout",
      // blindfold: contract — maskedNumber is derived from the card id, not stored.
      maskedNumber: maskCardNumber("crd_test"),
      status: "ACTIVE",
      chain: "STELLAR",
      asset: "USDC",
      budget: { total: "25", spent: "0", reserved: "0" },
      limits: { perCharge: "5", daily: "10", autoApproveUnder: "3" },
      merchants: ["mch_test"],
      expiresAt: "2026-11-15T12:00:00.000Z",
    });
    // blindfold: contract — money is stored as TEXT, so the value is a string not a number.
    expect(typeof card!.budget.total).toBe("string");
    expect(repo.listCards("usr_test")).toHaveLength(1);
    expect(repo.listCardsForAgent("agt_test")).toHaveLength(1);
  });

  it("updates label, status and the merchant allowlist", () => {
    const card = repo.updateCard("crd_test", {
      label: "Paused Scout",
      status: "PAUSED",
      merchants: ["mch_test", "mch_other"],
    });
    // blindfold: contract — the label patch round-trips.
    expect(card.label).toBe("Paused Scout");
    // blindfold: contract — the status patch round-trips.
    expect(card.status).toBe("PAUSED");
    // blindfold: contract — the JSON allowlist round-trips in order.
    expect(card.merchants).toEqual(["mch_test", "mch_other"]);
  });
});

describe("budget reservation", () => {
  it("reserves, settles and releases with exact bigint arithmetic", () => {
    // blindfold: math — $5 of a $25 card leaves $20 reservable.
    expect(repo.reserveBudget("crd_test", "5")).toBe(true);
    expect(repo.getCard("crd_test")?.budget).toMatchObject({ spent: "0", reserved: "5" });

    // blindfold: math — 5 + 20.0000001 > 25, so this reservation must fail.
    expect(repo.reserveBudget("crd_test", "20.0000001")).toBe(false);
    // blindfold: invariant — a rejected reservation leaves the reserve untouched.
    expect(repo.getCard("crd_test")?.budget.reserved).toBe("5");

    repo.settleBudget("crd_test", "5");
    const settled = repo.getCard("crd_test")!;
    expect(settled.budget).toMatchObject({ spent: "5", reserved: "0" });
    // blindfold: invariant — spent + reserved + remaining must always equal total.
    expect(toUnits(settled.budget.spent) + toUnits(settled.budget.reserved) + toUnits(remainingBudget(settled))).toBe(
      toUnits(settled.budget.total),
    );

    mkCard("crd_release", "10");
    expect(repo.reserveBudget("crd_release", "2.5")).toBe(true);
    repo.releaseBudget("crd_release", "1");
    // blindfold: math — reserving 2.5 then releasing 1 leaves 1.5 reserved.
    expect(repo.getCard("crd_release")?.budget.reserved).toBe("1.5");
  });

  it("never lets a release produce a negative reserve", () => {
    repo.releaseBudget("crd_test", "1");
    // blindfold: invariant — releasing more than is reserved clamps at zero, not negative.
    expect(repo.getCard("crd_test")?.budget.reserved).toBe("0");
  });

  it("keeps the smallest 7dp unit exact through reserve and settle", () => {
    mkCard("crd_dust", "1");
    expect(repo.reserveBudget("crd_dust", "0.0000001")).toBe(true);
    repo.settleBudget("crd_dust", "0.0000001");
    // blindfold: math — one base unit settles as one base unit, no float loss.
    expect(repo.getCard("crd_dust")?.budget.spent).toBe("0.0000001");
    expect(toUnits(repo.getCard("crd_dust")!.budget.spent)).toBe(1n);
  });

  it("allows a reservation exactly at the total and rejects one unit over", () => {
    // blindfold: contract — the budget comparison is inclusive (<=).
    expect(repo.reserveBudget("crd_test", "25")).toBe(true);
    // blindfold: math — 25 + 0.0000001 > 25, so one base unit over must fail.
    expect(repo.reserveBudget("crd_test", "0.0000001")).toBe(false);
    // blindfold: math — the exact-total reservation consumed all $25.
    expect(repo.getCard("crd_test")?.budget.reserved).toBe("25");
  });

  it("preserves spent + reserved + remaining = total across a mixed sequence", () => {
    const checkInvariant = () => {
      const card = repo.getCard("crd_test")!;
      // blindfold: invariant (LIMITS.md) — every reservation lifecycle step keeps the sum exact.
      expect(
        toUnits(card.budget.spent) + toUnits(card.budget.reserved) + toUnits(remainingBudget(card)),
      ).toBe(toUnits(card.budget.total));
    };

    checkInvariant();
    expect(repo.reserveBudget("crd_test", "5")).toBe(true);
    checkInvariant();
    expect(repo.reserveBudget("crd_test", "10")).toBe(true);
    checkInvariant();
    repo.releaseBudget("crd_test", "5");
    checkInvariant();
    repo.settleBudget("crd_test", "10");
    checkInvariant();
    expect(repo.reserveBudget("crd_test", "15")).toBe(true);
    checkInvariant();
    repo.releaseBudget("crd_test", "15");
    checkInvariant();
  });
});

describe("card tokens", () => {
  it("marks a token used exactly once", () => {
    const token = mkToken();
    // blindfold: contract — a freshly issued token starts ACTIVE.
    expect(token.status).toBe("ACTIVE");
    // blindfold: contract — a charge token is single-use.
    expect(repo.markTokenUsed("tkn_test")).toBe(true);
    expect(repo.markTokenUsed("tkn_test")).toBe(false);
    const used = repo.getTokenByHash("hash_token_1");
    // blindfold: contract — redeeming flips the token to USED.
    expect(used?.status).toBe("USED");
    // blindfold: contract — redeeming stamps used_at.
    expect(used?.usedAt).not.toBeNull();
  });

  it("revokes only active tokens for a card", () => {
    mkToken();
    mkToken({ id: "tkn_used", tokenHash: "hash_token_2" });
    repo.markTokenUsed("tkn_used");
    repo.revokeTokensForCard("crd_test");
    // blindfold: contract — revocation only touches ACTIVE tokens.
    expect(repo.getToken("tkn_test")?.status).toBe("REVOKED");
    // blindfold: contract — an already-USED token keeps its terminal status.
    expect(repo.getToken("tkn_used")?.status).toBe("USED");
  });
});

describe("charges", () => {
  it("returns the original charge for a repeated idempotency key", () => {
    const first = mkCharge({ id: "chg_first", idempotencyKey: "exa-order-991" });
    const found = repo.getChargeByIdempotency("crd_test", "exa-order-991");
    // blindfold: contract — a repeated idempotency key must resolve to the original charge.
    expect(found?.id).toBe(first.id);
    // blindfold: contract — the original amount is returned unchanged.
    expect(found?.amount).toBe("2.50");
    // blindfold: contract — the DB enforces uniqueness of (card_id, idempotency_key).
    expect(() => mkCharge({ id: "chg_second", idempotencyKey: "exa-order-991" })).toThrow();
  });

  it("maps merchant name and decision JSON onto the charge", () => {
    const charge = mkCharge({ id: "chg_join" });
    // blindfold: contract — charge payload carries the merchant display name.
    expect(charge.merchantName).toBe("Exa");
    // blindfold: contract — decision JSON round-trips with its PolicyCode.
    expect(charge.decision.code).toBe("OK");
    expect(charge.approvalRequired).toBe(false);
    expect(charge.receipt).toBeNull();
  });

  it("lists signer backlog oldest first and ignores terminal charges", () => {
    mkCharge({ id: "chg_queued_1", createdAt: NOW });
    mkCharge({ id: "chg_queued_2", createdAt: LATER });
    mkCharge({ id: "chg_settled", status: "SETTLED", createdAt: "2026-11-14T11:00:00.000Z" });
    const pending = repo.getChargesAwaitingSigner("usr_test");
    // blindfold: contract — only QUEUED/SIGNING charges are signer work.
    expect(pending.map((c) => c.id)).toEqual(["chg_queued_1", "chg_queued_2"]);
  });

  it("sums the daily window by settlement time, not creation time", () => {
    mkCharge({ id: "chg_late", amount: "2.50", createdAt: YESTERDAY });
    mkCharge({ id: "chg_other", amount: "4", createdAt: YESTERDAY });
    repo.setChargeReceipt("chg_late", {
      chain: "STELLAR",
      hash: "abc",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/abc",
      asset: "USDC",
      amount: "2.50",
      memo: "TAB:late",
      confirmedAt: NOW,
    });
    repo.setChargeReceipt("chg_other", {
      chain: "STELLAR",
      hash: "def",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/def",
      asset: "USDC",
      amount: "4",
      memo: "TAB:other",
      confirmedAt: NOW,
    });
    // Charge rows were created yesterday; force one to settle inside the window.
    db.prepare(`UPDATE charges SET created_at = ?, updated_at = ? WHERE id = ?`).run(YESTERDAY, LATER, "chg_late");
    db.prepare(`UPDATE charges SET created_at = ?, updated_at = ? WHERE id = ?`).run(YESTERDAY, YESTERDAY, "chg_other");
    // blindfold: contract — $2.50 settled at 13:00 counts after 12:00; $4 settled yesterday does not.
    expect(repo.settledSince("crd_test", NOW)).toBe("2.5");
  });

  it("counts settled plus in-flight reservations in committedSince", () => {
    mkCharge({ id: "chg_settled_in", amount: "2.50", status: "SETTLED", createdAt: YESTERDAY });
    mkCharge({ id: "chg_settled_out", amount: "4", status: "SETTLED", createdAt: YESTERDAY });
    mkCharge({ id: "chg_active_in", amount: "3", status: "QUEUED", createdAt: LATER });
    mkCharge({ id: "chg_active_out", amount: "1", status: "AWAITING_APPROVAL", createdAt: YESTERDAY });
    mkCharge({ id: "chg_declined", amount: "9", status: "DECLINED", createdAt: LATER });

    db.prepare(`UPDATE charges SET updated_at = ? WHERE id = ?`).run(LATER, "chg_settled_in");
    db.prepare(`UPDATE charges SET updated_at = ? WHERE id = ?`).run(YESTERDAY, "chg_settled_out");

    // blindfold: contract (LIMITS.md) — 2.50 settled + 3 queued = 5.50; declined/out-of-window ignored.
    expect(repo.committedSince("crd_test", NOW)).toBe("5.5");
    // blindfold: contract — settledSince remains settled-only for compatibility.
    expect(repo.settledSince("crd_test", NOW)).toBe("2.5");
  });
});

describe("ledger", () => {
  it("appends and lists events with structured data", () => {
    const event: LedgerEvent = {
      id: "evt_test",
      ownerId: "usr_test",
      cardId: "crd_test",
      chargeId: "chg_test",
      type: "CHARGE_SETTLED",
      actor: "agent",
      summary: "Charged $2.50 at Exa",
      data: { amount: "2.50", merchantId: "mch_test" },
      createdAt: NOW,
    };
    repo.appendEvent(event);
    const [listed] = repo.listLedger("usr_test");
    expect(listed).toMatchObject({
      id: "evt_test",
      ownerId: "usr_test",
      cardId: "crd_test",
      chargeId: "chg_test",
      type: "CHARGE_SETTLED",
      actor: "agent",
      summary: "Charged $2.50 at Exa",
    });
    expect(listed.data).toEqual({ amount: "2.50", merchantId: "mch_test" });
  });
});
