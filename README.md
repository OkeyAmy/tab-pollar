# TAB

**Spend management & virtual cards for AI agents — give your agent a budget, not your card. Pays in USDC on Stellar in seconds.**

**Live demo:** https://tab.okeyamy.xyz

---

## The problem

Agents can already buy things — API credits, datasets, compute, market data. Today the only way to let them is to hand over a real card number or a raw private key. That is unbounded, unrevocable, and unauditable.

## What TAB does

TAB gives a human a **programmable card** they can hand to an agent:

- a budget (e.g. $25)
- a per-purchase cap (e.g. $5)
- a daily cap (e.g. $10)
- a merchant allowlist (Exa, Firecrawl — not the whole internet)
- an approval line (anything above $3 asks you first)
- an expiry and a kill switch

The agent never holds a private key or a card number. It asks TAB for a **single-use charge token**; the merchant redeems it; TAB checks the policy; the human's Pollar wallet settles a real USDC payment on Stellar. The receipt hash is verified on-chain and returned to the agent.

## Try it in 3 clicks

1. **Continue with Google** — Pollar creates the wallet. No seed phrase, no extension, no gas.
2. **Set up the demo for me** — creates Scout and a $25 / $5 / $10 / $3 card.
3. **Try it as the agent → “$2.50 — auto-approved.”** The signer console settles it and the receipt opens.

The same panel has approval, over-cap, blocked-merchant, and a **real third-party x402 merchant** (Nirium, 0.05 USDC).

## What is real

- **Real USDC payments on Stellar testnet**, signed by the human's Pollar session and verified on Horizon.
- **A real third-party merchant** via x402: `https://nirium-agent.fly.dev/api/v1/premium/market`.
- **Pollar** for login, embedded wallet, sponsored fees, settlement, and history.
- The **Visa-style card network is simulated on testnet**. Production uses Pollar Cards (provider + KYC) behind `TAB_DEMO_MODE=0`.

## Stack

| Piece | What it does |
| --- | --- |
| `apps/web` | Dashboard, card studio, approvals, ledger, **Signer Console** |
| `apps/api` | Control plane: policy, tokens, charges, signer jobs, x402, SSE |
| `apps/depot` | Demo merchant storefront (`/depot`) |
| `packages/shared` | Types, zod contracts, bigint money math |
| `packages/policy` | Pure spending-policy engine |
| `packages/db` | SQLite schema + repository |
| `packages/pollar` | Payment adapter (classic + x402) |
| `packages/agent-kit` | Typed client + `tab` CLI |
| `packages/mcp` | MCP server for Claude Code / Desktop |

## Run locally

```bash
cp .env.example .env       # Pollar testnet keys + USDC issuer
pnpm install
pnpm seed
pnpm dev                   # api :4000, web :3000, depot :3001
```

Open `http://localhost:3000`.

## Agent integration

```bash
pnpm --filter @tab/agent-kit tab cards
pnpm --filter @tab/agent-kit tab buy --card crd_… --merchant mch_exa --sku exa-starter --amount 2.50
pnpm --filter @tab/agent-kit tab x402 --card crd_… --url https://nirium-agent.fly.dev/api/v1/premium/market
```

MCP (Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "tab": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/pollar", "--filter", "@tab/mcp", "start"],
      "env": { "TAB_API_URL": "http://localhost:4000", "TAB_API_KEY": "tab_agent_…" }
    }
  }
}
```

Tools: `list_cards`, `get_budget`, `buy`, `list_charges`, `request_token`, `pay_token`, `x402_fetch`, `health`.

## Security model

- The **agent** holds a scoped, revocable `tab_agent_…` key. It cannot touch the wallet.
- A **charge token** is single-use, merchant-bound, amount-capped, and expires in 5 minutes.
- The **API never signs** and holds no private keys. It records intent and policy.
- The **human's browser** is the only signer: Pollar's DPoP-bound session lives there. Close the tab and queued charges stop.
- Settlement is **verified on-chain** before a charge is marked paid.
- Limits: `approvalLine ≤ perCharge ≤ daily ≤ total`; budget reservations are atomic; the daily cap counts held funds.

## Verify

```bash
pnpm install
pnpm -r typecheck
pnpm --filter @tab/api test        # 43 integration tests
pnpm --filter @tab/web build
pnpm --filter @tab/depot build
```

Package tests: shared 14, db 18, policy 24, pollar 45, agent-kit 36.

## Deploy

One origin, one container:

```
/          → web :3000
/api/*     → api :4000
/depot*    → depot :3001
/health    → api :4000
```

The repo ships a `Dockerfile` and a local `docker-compose.yml`; production
runbooks and host-specific configuration stay outside the repository.

## License

Hackathon project. Pollar SDK and the x402 facilitator are separate services.
