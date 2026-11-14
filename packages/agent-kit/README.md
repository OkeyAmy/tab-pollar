# @tab/agent-kit

Give an AI agent a **budget, not your card**. This package is the typed client,
the `tab` CLI, and the MCP server that let Claude Code, Claude Desktop, Cursor
or any agent spend through a TAB card — while the human keeps the signing key
in their browser.

## Configure (2 minutes)

```bash
export TAB_API_URL=http://localhost:4000
export TAB_API_KEY=tab_agent_…          # shown once when you create an agent
pnpm dev:api                            # in another terminal
```

### Claude Code

```bash
claude mcp add tab --env TAB_API_KEY=$TAB_API_KEY --env TAB_API_URL=$TAB_API_URL \
  -- pnpm --dir "$PWD" --filter @tab/mcp start
```

### Claude Desktop / Cursor

Run `tab mcp` (or `pnpm --filter @tab/agent-kit exec tsx src/cli.ts mcp`) and
paste the block it prints:

```json
{
  "mcpServers": {
    "tab": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/tab", "--filter", "@tab/mcp", "start"],
      "env": {
        "TAB_API_URL": "http://localhost:4000",
        "TAB_API_KEY": "tab_agent_…"
      }
    }
  }
}
```

Restart the client. The server lists 8 tools: `health`, `list_cards`,
`get_budget`, `buy`, `list_charges`, `request_token`, `pay_token`, `x402_fetch`.

## Example session

> "What can you spend, and buy the Exa starter plan?"

```text
→ list_cards
  This agent can spend from 1 card: Research Scout (crd_…) — $25.00 left of
  $25.00, $5.00 per charge, ACTIVE

→ buy  { "cardId": "crd_…", "merchantId": "mch_exa", "sku": "exa-starter", "amount": "2.50" }
  Bought Exa Starter for $2.50 — license EXA-7K2M-9Q1P-4X8Z.
  Charge chg_… is SETTLED. Receipt: https://stellar.expert/explorer/testnet/tx/…

→ list_charges
  1 charge. Latest: $2.50 at Exa — SETTLED (https://stellar.expert/…).
```

A `$9.00` request returns `PENDING` (above the $3 auto-approve threshold).
A `$40.00` request returns `isError: true` with `AMOUNT_ABOVE_PER_CHARGE`.
An off-allowlist merchant returns `MERCHANT_NOT_ALLOWED`.

## Pay a real x402 API

The card can settle an x402 challenge end to end — token, charge, on-chain
payment, then the protected response body. This spends **0.05 testnet USDC per
call** and needs the human's signer console online:

```bash
tab x402 --card crd_… --url https://nirium-agent.fly.dev/api/v1/premium/market
# ✓ $0.05 — https://nirium-agent.fly.dev/api/v1/premium/market
#   tx  https://stellar.expert/explorer/testnet/tx/…
# { "market": "…" }
```

Exit codes: `0` paid, `2` pending (approval, queued, or signing), `1` failed
(`FAILED`, `DECLINED`, `EXPIRED`). Approval links are the canonical deep link
`${TAB_WEB_URL}/app?charge=<chargeId>` (default `http://localhost:3000`).

Amounts are rendered per asset: USDC is USD-denominated and shown as `$2.50`;
XLM is shown as `12.5000000 XLM`, never with a `$`.

## CLI

| Command | What it does |
| --- | --- |
| `tab health` | API mode, signer online, merchant count |
| `tab cards` | cards this agent can spend from |
| `tab budget <crd_…>` | budget, caps, allowlist, expiry |
| `tab buy --card … --merchant … --sku … --amount …` | one-shot SKU purchase |
| `tab charges [--card …]` | charge history + receipts |
| `tab token --card … --merchant … --amount …` | request a 5-minute single-use token |
| `tab pay --token tab_ch_… --merchant … --amount …` | merchant redeems the token |
| `tab x402 --card … --url …` | pay an x402 resource and print its body |
| `tab mcp` | paste-ready MCP config |

Every command accepts `--json`. `tab buy` exits `2` on `PENDING` so scripts can
distinguish "needs a human" from "failed". `tab pay` uses the same rule:
`AWAITING_APPROVAL`, `QUEUED` and `SIGNING` exit `2`; only `FAILED`, `DECLINED`
and `EXPIRED` exit `1`.

## Library

```ts
import { TabClient, isPendingPurchase } from "@tab/agent-kit";

const tab = TabClient.fromEnv();
const result = await tab.buy({
  cardId: "crd_…",
  merchantId: "mch_exa",
  sku: "exa-starter",
  amount: "2.50",
  // Optional: reuse the same key on a manual retry so the API dedupes it.
  idempotencyKey: "order-991",
});
if (isPendingPurchase(result)) {
  const settled = await tab.waitForCharge(result.charge.id, { timeoutMs: 30_000 });
}
```

`buy()` and `x402()` attach an idempotency key to every request (generated with
`crypto.randomUUID()` unless you pass one), so a retry after a timeout cannot
open a second charge. `x402()` returns the key it used.

`TabApiError` carries `{ status, code, details }`; `status: 0` means the request
never reached the API (`NETWORK`, `TIMEOUT`). Policy codes are the frozen enum
in `@tab/shared`. `formatAmount(amount, asset)` renders USDC as `$` and XLM with
its own ticker.

## Security model — two gates and a signature

- **Gate 1 — the agent key, never a wallet.** `tab_agent_…` is scoped to one
  agent, hashed at rest, revocable in one click. It can request spending but it
  cannot sign; a stolen key cannot move funds on its own.
- **Gate 2 — a single-use token per spend.** `tab_ch_…` is merchant-bound,
  amount-capped, and dies after 5 minutes or one redemption. A leaked token is
  worth at most one capped charge at one merchant, once.
- **The human's browser is the only signer.** The Pollar DPoP key never leaves
  the session. Close the signer tab and queued charges stop; revoke the card and
  every outstanding token dies with it.

## Tests

```bash
pnpm --filter @tab/agent-kit test        # 36 client tests, injected fetch
pnpm --filter @tab/agent-kit typecheck
pnpm --filter @tab/mcp smoke             # starts the MCP server, lists tools
```
