#!/usr/bin/env node
/**
 * TAB seed — merchants, SKUs, and an optional demo user/agent/card.
 *
 * Idempotent by construction: fixed ids + `ON CONFLICT` upserts. Running it
 * twice never duplicates merchants, SKUs, users, agents or cards.
 *
 * Merchant settlement (no more "generate a keypair and pretend it works"):
 *   1. `STELLAR_MERCHANT_ADDRESS` when set (a Pollar wallet gets its trustline
 *      at login); `STELLAR_MERCHANT_SECRET` is used only to derive it if the
 *      address is absent.
 *   2. otherwise the app's distribution vault from
 *      `GET /v3/billing/distribution-vault`, verified with
 *      `GET /v3/wallets/{address}/balance` (Server API, secret key in env).
 *   3. if that wallet has no USDC trustline, the settlement asset is XLM and a
 *      loud warning is printed — the seed never claims a USDC payout it cannot
 *      make. `data/merchant.json` and DB meta record the decision.
 *
 * No new dependencies: Stellar StrKey (base32 + CRC16-XModem) and ed25519
 * derivation are implemented below with node:crypto only.
 */
import { createPrivateKey, createPublicKey, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, Repo } from "../packages/db/src/index.js";
import {
  newId,
  type LedgerEventType,
  type Merchant,
  type Sku,
} from "../packages/shared/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  // Node >= 20.12. Keeps `pnpm seed` self-contained; absent .env is fine.
  process.loadEnvFile(resolve(ROOT, ".env"));
} catch {
  /* no .env — defaults below still work */
}

const DATA_DIR = resolve(ROOT, "data");
const MERCHANT_FILE = resolve(DATA_DIR, "merchant.json");
const DEMO_FILE = resolve(DATA_DIR, "demo.json");

const DB_PATH_RAW = process.env.DATABASE_PATH ?? "./data/tab.db";
const DB_PATH =
  DB_PATH_RAW === ":memory:" || isAbsolute(DB_PATH_RAW) ? DB_PATH_RAW : resolve(ROOT, DB_PATH_RAW);

const SERVER_API = (process.env.POLLAR_SERVER_API_URL ?? "https://server.api.pollar.xyz").replace(/\/$/, "");
const FRIENDBOT = "https://friendbot.stellar.org";

/* ─────────────────────────────────────────────────────────────────────────────
 * Stellar StrKey helpers (no @stellar/stellar-sdk dependency)
 * ──────────────────────────────────────────────────────────────────────────── */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SEED_VERSION = 0x90; // "S…"
const ACCOUNT_VERSION = 0x30; // "G…"
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error("invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function crc16Xmodem(bytes: Buffer): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function strKeyEncode(version: number, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const checksum = crc16Xmodem(body);
  return base32Encode(
    Buffer.concat([body, Buffer.from([checksum & 0xff, (checksum >>> 8) & 0xff])]),
  );
}

function strKeyDecode(text: string, expectedVersion: number): Buffer {
  const raw = base32Decode(text.trim());
  if (raw.length !== 35) throw new Error("invalid Stellar key length");
  const body = raw.subarray(0, 33);
  const checksum = raw.subarray(33);
  const expected = crc16Xmodem(body);
  if (checksum[0] !== (expected & 0xff) || checksum[1] !== ((expected >>> 8) & 0xff)) {
    throw new Error("invalid Stellar key checksum");
  }
  if (body[0] !== expectedVersion) throw new Error("unexpected Stellar key version");
  return Buffer.from(body.subarray(1));
}

function publicKeyFromSeed(seed: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(spki) || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("unexpected ed25519 public key encoding");
  }
  return spki.subarray(12);
}

function addressFromSecret(secret: string): string {
  return strKeyEncode(ACCOUNT_VERSION, publicKeyFromSeed(strKeyDecode(secret, SEED_VERSION)));
}

function assertAccountId(address: string): void {
  try {
    strKeyDecode(address, ACCOUNT_VERSION);
  } catch {
    throw new Error(`"${address}" is not a valid Stellar account id (G…)`);
  }
}

/** Fail fast if our StrKey math disagrees with a known-good Stellar address. */
function selfCheckStrKey(): void {
  const known = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  if (strKeyEncode(ACCOUNT_VERSION, strKeyDecode(known, ACCOUNT_VERSION)) !== known) {
    throw new Error("StrKey self-check failed (base32/CRC16 mismatch)");
  }
  // Ed25519 derivation: a random seed must round-trip through both StrKeys.
  const seed = randomBytes(32);
  const probe = strKeyEncode(ACCOUNT_VERSION, publicKeyFromSeed(seed));
  if (addressFromSecret(strKeyEncode(SEED_VERSION, seed)) !== probe) {
    throw new Error("StrKey self-check failed (ed25519 derivation mismatch)");
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Settlement wallet resolution + verification
 * ──────────────────────────────────────────────────────────────────────────── */

type SettlementAsset = "USDC" | "XLM";

interface WalletCheck {
  verified: boolean;
  exists: boolean;
  usdcTrustline: boolean;
  xlmBalance: string | null;
  usdcBalance: string | null;
  detail: string;
}

interface Settlement {
  address: string;
  asset: SettlementAsset;
  source: string;
  check: WalletCheck;
  warnings: string[];
}

function serverHeaders(): Record<string, string> | null {
  const secret = process.env.POLLAR_SECRET_KEY?.trim();
  return secret ? { "x-pollar-api-key": secret } : null;
}

async function fetchDistributionVault(): Promise<{ address: string | null; error: string | null }> {
  const headers = serverHeaders();
  if (!headers) return { address: null, error: "POLLAR_SECRET_KEY is not set" };
  try {
    const response = await fetch(`${SERVER_API}/v3/billing/distribution-vault`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) return { address: null, error: `HTTP ${response.status}` };
    const body = JSON.parse(text) as { content?: { vault?: { address?: unknown } } };
    const address = body.content?.vault?.address;
    if (typeof address !== "string" || !address) {
      return { address: null, error: "response has no vault address" };
    }
    return { address, error: null };
  } catch (error) {
    return { address: null, error: `network error: ${(error as Error).message}` };
  }
}

async function verifyWallet(address: string): Promise<WalletCheck> {
  const empty: WalletCheck = {
    verified: false,
    exists: false,
    usdcTrustline: false,
    xlmBalance: null,
    usdcBalance: null,
    detail: "not verified",
  };
  const headers = serverHeaders();
  if (!headers) return { ...empty, detail: "POLLAR_SECRET_KEY is not set" };

  try {
    const response = await fetch(
      `${SERVER_API}/v3/wallets/${encodeURIComponent(address)}/balance`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    const text = await response.text();
    if (!response.ok) return { ...empty, detail: `HTTP ${response.status}` };

    const body = JSON.parse(text) as {
      content?: {
        exists?: unknown;
        balances?: Array<{
          code?: unknown;
          issuer?: unknown;
          balance?: unknown;
          trustlineRemoved?: unknown;
        }>;
      };
    };
    const content = body.content;
    if (!content) return { ...empty, detail: "response has no content" };

    const balances = Array.isArray(content.balances) ? content.balances : [];
    const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER?.trim() || null;
    const usdc = balances.find((b) => {
      if (String(b.code ?? "").toUpperCase() !== "USDC") return false;
      if (b.trustlineRemoved === true) return false;
      // If both sides name an issuer, they must agree; an omitted issuer is
      // accepted because the balance payload is the Server API's own view.
      return !issuer || !b.issuer || b.issuer === issuer;
    });
    const xlm = balances.find((b) => String(b.code ?? "").toUpperCase() === "XLM");

    return {
      verified: true,
      exists: Boolean(content.exists),
      usdcTrustline: Boolean(usdc),
      xlmBalance: typeof xlm?.balance === "string" ? xlm.balance : null,
      usdcBalance: typeof usdc?.balance === "string" ? usdc.balance : null,
      detail: "verified via Server API",
    };
  } catch (error) {
    return { ...empty, detail: `network error: ${(error as Error).message}` };
  }
}

async function resolveSettlement(cachedAddress: string | null): Promise<Settlement> {
  const warnings: string[] = [];

  let address = process.env.STELLAR_MERCHANT_ADDRESS?.trim() || "";
  let source = "env:STELLAR_MERCHANT_ADDRESS";

  if (!address) {
    const secret = process.env.STELLAR_MERCHANT_SECRET?.trim();
    if (secret) {
      try {
        address = addressFromSecret(secret);
        source = "env:STELLAR_MERCHANT_SECRET";
      } catch (error) {
        throw new Error(`STELLAR_MERCHANT_SECRET is invalid (${(error as Error).message})`);
      }
    }
  }

  if (!address) {
    const vault = await fetchDistributionVault();
    if (vault.address) {
      address = vault.address;
      source = "pollar:distribution-vault";
    } else {
      const envVault = (
        process.env.POLLAR_DISTRIBUTION_ADDRESS ??
        process.env.STELLAR_DISTRIBUTION_ADDRESS ??
        ""
      ).trim();
      if (envVault) {
        address = envVault;
        source = "env:distribution-address";
      } else if (cachedAddress) {
        address = cachedAddress;
        source = "cache:previous-seed";
        warnings.push(`distribution vault lookup failed (${vault.error}); using cached address`);
      } else {
        throw new Error(
          `no merchant settlement address: set STELLAR_MERCHANT_ADDRESS or POLLAR_SECRET_KEY (vault lookup: ${vault.error})`,
        );
      }
    }
  }

  assertAccountId(address);
  const check = await verifyWallet(address);

  // Only claim USDC when the wallet actually has a live USDC trustline.
  const asset: SettlementAsset = check.verified && check.usdcTrustline ? "USDC" : "XLM";

  if (!check.verified) {
    warnings.push(`could not verify ${address} (${check.detail}); settling in XLM until verified`);
  } else if (!check.usdcTrustline) {
    warnings.push(`${address} has no USDC trustline; TAB will settle in XLM`);
  }

  const envAsset = (process.env.NEXT_PUBLIC_SETTLEMENT_ASSET ?? "USDC").toUpperCase();
  if (asset === "XLM" && envAsset === "USDC") {
    warnings.push(
      "NEXT_PUBLIC_SETTLEMENT_ASSET=USDC but the settlement wallet cannot receive USDC. Set NEXT_PUBLIC_SETTLEMENT_ASSET=XLM.",
    );
  }

  return { address, asset, source, check, warnings };
}

async function ensureFunding(settlement: Settlement): Promise<string> {
  const { check, asset, address } = settlement;

  if (asset === "USDC") {
    return check.usdcTrustline
      ? "not needed (USDC trustline present)"
      : "not needed (settling in XLM)";
  }
  if (!check.verified) {
    return `UNVERIFIED — fund testnet XLM manually if needed: ${FRIENDBOT}/?addr=${address}`;
  }
  if (check.exists) {
    return `not needed (XLM balance ${check.xlmBalance ?? "unknown"})`;
  }

  try {
    const response = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text().catch(() => "");
    if (response.ok) return "funded with testnet XLM";
    if (/already|exists|funded/i.test(body)) return "account already funded";
    return `FAILED — HTTP ${response.status}${body ? `: ${body.slice(0, 140)}` : ""} → ${FRIENDBOT}/?addr=${address}`;
  } catch (error) {
    return `FAILED — ${(error as Error).message} → ${FRIENDBOT}/?addr=${address}`;
  }
}

/** Last known settlement address, used only when the vault lookup is unavailable. */
function readMerchantFileAddress(): string | null {
  if (!existsSync(MERCHANT_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(MERCHANT_FILE, "utf8")) as { address?: unknown };
    return typeof parsed.address === "string" ? parsed.address : null;
  } catch {
    return null;
  }
}

function writeMerchantFile(settlement: Settlement): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const record = {
    network: "testnet",
    address: settlement.address,
    asset: settlement.asset,
    source: settlement.source,
    verified: settlement.check.verified,
    usdcTrustline: settlement.check.usdcTrustline,
    xlmBalance: settlement.check.xlmBalance,
    usdcBalance: settlement.check.usdcBalance,
    updatedAt: new Date().toISOString(),
    note: "Merchant settlement wallet chosen by scripts/seed.ts. No secret is stored here.",
  };
  writeFileSync(MERCHANT_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(MERCHANT_FILE, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Seed data (CONTRACTS.md + x402 addendum)
 * ──────────────────────────────────────────────────────────────────────────── */

const NOW = new Date().toISOString();
const X402_PAY_TO = "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC";

function merchants(settlementAddress: string): Merchant[] {
  return [
    {
      id: "mch_exa",
      name: "Exa",
      domain: "exa.ai",
      emoji: "🔎",
      category: "search",
      settlementAddress,
      settlementChain: "STELLAR",
      createdAt: NOW,
    },
    {
      id: "mch_firecrawl",
      name: "Firecrawl",
      domain: "firecrawl.dev",
      emoji: "🔥",
      category: "scraping",
      settlementAddress,
      settlementChain: "STELLAR",
      createdAt: NOW,
    },
    {
      id: "mch_openai",
      name: "OpenAI",
      domain: "openai.com",
      emoji: "🤖",
      category: "ai",
      settlementAddress,
      settlementChain: "STELLAR",
      createdAt: NOW,
    },
    {
      // Real x402 rail: the live 402 challenge supplies the price, so no SKU.
      // Settlement goes directly to Nirium's advertised payTo address.
      id: "mch_x402",
      name: "Nirium",
      domain: "nirium-agent.fly.dev",
      emoji: "📈",
      category: "market data",
      settlementAddress: X402_PAY_TO,
      settlementChain: "STELLAR",
      createdAt: NOW,
    },
  ];
}

const SKUS: Sku[] = [
  {
    id: "exa-starter",
    merchantId: "mch_exa",
    name: "Exa Starter",
    description: "1,000 searches",
    price: "2.50",
    unit: "1,000 searches",
    licensePrefix: "EXA",
  },
  {
    id: "exa-pro",
    merchantId: "mch_exa",
    name: "Exa Pro",
    description: "10,000 searches",
    price: "9.00",
    unit: "10,000 searches",
    licensePrefix: "EXA",
  },
  {
    id: "firecrawl-1k",
    merchantId: "mch_firecrawl",
    name: "Firecrawl 1K",
    description: "1,000 pages crawled",
    price: "4.00",
    unit: "1,000 pages",
    licensePrefix: "FIRE",
  },
  {
    id: "firecrawl-10k",
    merchantId: "mch_firecrawl",
    name: "Firecrawl 10K",
    description: "10,000 pages crawled",
    price: "19.00",
    unit: "10,000 pages",
    licensePrefix: "FIRE",
  },
  {
    id: "openai-5",
    merchantId: "mch_openai",
    name: "OpenAI $5",
    description: "API credit",
    price: "5.00",
    unit: "$5 credit",
    licensePrefix: "OAI",
  },
  {
    id: "openai-20",
    merchantId: "mch_openai",
    name: "OpenAI $20",
    description: "API credit",
    price: "20.00",
    unit: "$20 credit",
    licensePrefix: "OAI",
  },
];

/* ─────────────────────────────────────────────────────────────────────────────
 * Demo user / agent / card
 * ──────────────────────────────────────────────────────────────────────────── */

const DEMO_USER_ID = "usr_demo";
const DEMO_POLLAR_ID = "pollar_demo";
const DEMO_AGENT_ID = "agt_demo";
const DEMO_CARD_ID = "crd_demo";

function event(
  repo: Repo,
  ownerId: string,
  cardId: string | null,
  type: LedgerEventType,
  actor: string,
  summary: string,
  data: Record<string, unknown> = {},
): void {
  repo.appendEvent({
    id: newId("event"),
    ownerId,
    cardId,
    chargeId: null,
    type,
    actor,
    summary,
    data,
    createdAt: new Date().toISOString(),
  });
}

function readDemoFile(): { apiKey?: string } | null {
  if (!existsSync(DEMO_FILE)) return null;
  try {
    return JSON.parse(readFileSync(DEMO_FILE, "utf8")) as { apiKey?: string };
  } catch {
    return null;
  }
}

function writeDemoFile(file: {
  userId: string;
  agentId: string;
  cardId: string;
  apiKey: string;
}): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    DEMO_FILE,
    `${JSON.stringify(
      { ...file, createdAt: new Date().toISOString(), note: "Demo agent key — never commit." },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  try {
    chmodSync(DEMO_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  selfCheckStrKey();

  const db = openDb(DB_PATH);
  const repo = new Repo(db);

  const cachedAddress =
    repo.getMeta("settlement.address") ??
    repo.getMeta("seed.merchant_wallet") ??
    readMerchantFileAddress();
  const settlement = await resolveSettlement(cachedAddress);
  const funding = await ensureFunding(settlement);

  writeMerchantFile(settlement);
  repo.setMeta("settlement.address", settlement.address);
  repo.setMeta("settlement.asset", settlement.asset);
  repo.setMeta("settlement.source", settlement.source);
  repo.setMeta("settlement.verified", settlement.check.verified ? "1" : "0");
  repo.setMeta("settlement.usdc_trustline", settlement.check.usdcTrustline ? "1" : "0");
  // The old seed stored a generated wallet under this key; keep it in sync.
  repo.setMeta("seed.merchant_wallet", settlement.address);

  for (const merchant of merchants(settlement.address)) repo.upsertMerchant(merchant);
  for (const sku of SKUS) repo.upsertSku(sku);

  const demoEnabled = (process.env.SEED_DEMO_USER ?? "1") !== "0";
  let demo: {
    agentCreated: boolean;
    cardCreated: boolean;
    apiKey: string | null;
  } | null = null;

  if (demoEnabled) {
    const existingUser = repo.getUserByPollarId(DEMO_POLLAR_ID);
    repo.upsertUser({
      id: DEMO_USER_ID,
      pollarUserId: DEMO_POLLAR_ID,
      email: "demo@tab.local",
      name: "Demo Human",
      stellarAddress: null,
      solanaAddress: null,
      createdAt: NOW,
    });
    if (!existingUser) {
      event(repo, DEMO_USER_ID, null, "USER_CREATED", "human", "Demo human created");
    }

    let agentCreated = false;
    let apiKey: string | null = null;
    if (!repo.getAgent(DEMO_AGENT_ID)) {
      apiKey = `tab_agent_${randomBytes(20).toString("hex")}`;
      repo.createAgent({
        id: DEMO_AGENT_ID,
        ownerId: DEMO_USER_ID,
        name: "Scout",
        description: "buys research data",
        emoji: "🔭",
        keyHash: createHash("sha256").update(apiKey).digest("hex"),
        keyPrefix: apiKey.slice(0, "tab_agent_".length + 6),
        createdAt: NOW,
      });
      event(repo, DEMO_USER_ID, null, "AGENT_CREATED", "human", "Scout agent created");
      agentCreated = true;
    }

    let cardCreated = false;
    const existingCard = repo.getCard(DEMO_CARD_ID);
    if (!existingCard) {
      repo.createCard({
        id: DEMO_CARD_ID,
        ownerId: DEMO_USER_ID,
        agentId: DEMO_AGENT_ID,
        label: "Research Scout",
        maskedNumber: "",
        chain: "STELLAR",
        asset: settlement.asset,
        budgetTotal: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        merchants: ["mch_exa", "mch_firecrawl"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: NOW,
      });
      event(repo, DEMO_USER_ID, DEMO_CARD_ID, "CARD_CREATED", "human", "Research Scout card opened", {
        budget: "25",
        perCharge: "5",
        daily: "10",
        autoApproveUnder: "3",
        asset: settlement.asset,
      });
      cardCreated = true;
    } else {
      const patch: { expiresAt?: string; asset?: string } = {};
      if (new Date(existingCard.expiresAt).getTime() <= Date.now()) {
        patch.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      }
      if (existingCard.asset !== settlement.asset) patch.asset = settlement.asset;
      if (Object.keys(patch).length > 0) repo.updateCard(DEMO_CARD_ID, patch);
    }

    if (apiKey) {
      writeDemoFile({
        userId: DEMO_USER_ID,
        agentId: DEMO_AGENT_ID,
        cardId: DEMO_CARD_ID,
        apiKey,
      });
    }

    demo = { agentCreated, cardCreated, apiKey };
  }

  const merchantCount = repo.listMerchants().length;
  const skuCount = repo.listSkus().length;
  const card = repo.getCard(DEMO_CARD_ID);

  for (const warning of settlement.warnings) console.log(`\n  ! WARNING  ${warning}`);
  console.log("");
  console.log("  TAB seed");
  console.log(`  database        ${DB_PATH}`);
  console.log(`  settlement      ${settlement.address}  (${settlement.source})`);
  console.log(
    `  settlement asset ${settlement.asset}  (USDC trustline: ${settlement.check.usdcTrustline ? "yes" : "no"})`,
  );
  console.log(`  merchant funding ${funding}`);
  console.log(`  merchants       ${merchantCount}  (mch_exa, mch_firecrawl, mch_openai, mch_x402)`);
  console.log(`  skus            ${skuCount}  (${SKUS.map((s) => s.id).join(", ")})`);
  console.log(`  x402 payTo      ${X402_PAY_TO}  (Nirium, display only)`);

  if (!demo) {
    console.log("  demo user       skipped (SEED_DEMO_USER=0)");
  } else {
    console.log(`  demo user       ${DEMO_USER_ID}  demo@tab.local`);
    console.log(`  demo agent      ${DEMO_AGENT_ID}  Scout${demo.agentCreated ? "  (created)" : ""}`);
    if (card) {
      console.log(
        `  demo card       ${DEMO_CARD_ID}  ${card.label}  $${card.budget.total} / $${card.limits.perCharge} per charge / $${card.limits.daily} daily / $${card.limits.autoApproveUnder} auto-approve  [${card.status}] ${card.asset}`,
      );
    }
    if (demo.apiKey) {
      console.log(`  agent api key   ${demo.apiKey}   (shown once; saved to data/demo.json)`);
    } else if (demo.agentCreated) {
      console.log("  agent api key   not shown");
    } else {
      const saved = readDemoFile();
      console.log(
        saved?.apiKey
          ? "  agent api key   already created — see data/demo.json (not printed again)"
          : "  agent api key   already created — key not recoverable; rotate it or run POST /demo/reset",
      );
    }
  }

  console.log(`  ready           ${new Date().toISOString()}`);
  console.log("");

  db.close();
}

main().catch((error) => {
  console.error(`\n  seed failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
