-- TAB — SQLite schema. WAL mode, no ORM, migrations applied on boot.
-- All timestamps are ISO-8601 UTC strings. Money is stored as decimal TEXT
-- (never REAL) so 0.1 + 0.2 is exact.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  pollar_user_id  TEXT NOT NULL UNIQUE,
  email           TEXT,
  name            TEXT,
  stellar_address TEXT,
  solana_address  TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  emoji        TEXT NOT NULL DEFAULT '🤖',
  status       TEXT NOT NULL DEFAULT 'ACTIVE',
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);

CREATE TABLE IF NOT EXISTS cards (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  chain              TEXT NOT NULL DEFAULT 'STELLAR',
  asset              TEXT NOT NULL DEFAULT 'USDC',
  budget_total       TEXT NOT NULL,
  budget_spent       TEXT NOT NULL DEFAULT '0',
  budget_reserved    TEXT NOT NULL DEFAULT '0',
  per_charge         TEXT NOT NULL,
  daily              TEXT NOT NULL,
  auto_approve_under TEXT NOT NULL,
  merchants_json     TEXT NOT NULL DEFAULT '[]',
  expires_at         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_id);
CREATE INDEX IF NOT EXISTS idx_cards_agent ON cards(agent_id);

CREATE TABLE IF NOT EXISTS merchants (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  domain             TEXT NOT NULL,
  emoji              TEXT NOT NULL,
  category           TEXT NOT NULL,
  settlement_address TEXT NOT NULL,
  settlement_chain   TEXT NOT NULL DEFAULT 'STELLAR',
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  price          TEXT NOT NULL,
  unit           TEXT NOT NULL,
  license_prefix TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skus_merchant ON skus(merchant_id);

CREATE TABLE IF NOT EXISTS card_tokens (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  merchant_id TEXT REFERENCES merchants(id),
  max_amount  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_card ON card_tokens(card_id);

CREATE TABLE IF NOT EXISTS charges (
  id                TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES cards(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  owner_id          TEXT NOT NULL REFERENCES users(id),
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  amount            TEXT NOT NULL,
  asset             TEXT NOT NULL DEFAULT 'USDC',
  description       TEXT NOT NULL,
  status            TEXT NOT NULL,
  decision_json     TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 0,
  approved_at       TEXT,
  declined_at       TEXT,
  decline_reason    TEXT,
  receipt_json      TEXT,
  error             TEXT,
  idempotency_key   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (card_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_charges_owner ON charges(owner_id);
CREATE INDEX IF NOT EXISTS idx_charges_card ON charges(card_id);
CREATE INDEX IF NOT EXISTS idx_charges_status ON charges(status);

CREATE TABLE IF NOT EXISTS signer_jobs (
  id           TEXT PRIMARY KEY,
  charge_id    TEXT NOT NULL UNIQUE REFERENCES charges(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'QUEUED',
  claimed_at   TEXT,
  completed_at TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id    TEXT,
  charge_id  TEXT,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL,
  summary    TEXT NOT NULL,
  data_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_owner ON ledger_events(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchases (
  id          TEXT PRIMARY KEY,
  charge_id   TEXT NOT NULL REFERENCES charges(id),
  sku_id      TEXT NOT NULL REFERENCES skus(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  license_key TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
