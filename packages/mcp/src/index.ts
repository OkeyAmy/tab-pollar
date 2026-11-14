#!/usr/bin/env node
/**
 * TAB MCP server — lets Claude Code / Claude Desktop spend within a card.
 *
 * OWNER: agent-kit agent. The MCP server must never see a private key; it
 * only holds an agent API key (tab_agent_...) issued by the human.
 *
 * Every tool answers with a human sentence first and the raw JSON second, so
 * a model can quote the sentence and still parse the data. Policy denials are
 * `isError: true` with the exact TAB code.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { remainingBudget, type TxReceipt } from "@tab/shared";
import {
  TabApiError,
  TabClient,
  formatAmount,
  isPendingPurchase,
  isX402Pending,
} from "@tab/agent-kit";

interface TextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
}

const SERVER_NAME = "tab";
const SERVER_VERSION = "0.1.0";

/** A human sentence plus the machine-readable payload. */
function reply(sentence: string, data: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: sentence },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
  };
}

/** A failure the model must not retry blindly: policy code, status, details. */
function failure(err: unknown, action: string): ToolResult {
  if (err instanceof TabApiError) {
    return {
      isError: true,
      content: [
        { type: "text", text: `TAB could not ${action}: ${err.message}` },
        {
          type: "text",
          text: JSON.stringify(
            { code: err.code, status: err.status, message: err.message, details: err.details },
            null,
            2,
          ),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      { type: "text", text: `TAB could not ${action}: ${message}` },
      { type: "text", text: JSON.stringify({ code: "UNEXPECTED_ERROR", message }, null, 2) },
    ],
  };
}

function receiptSuffix(receipt: TxReceipt | null | undefined): string {
  return receipt ? ` Receipt: ${receipt.explorerUrl}` : "";
}

export function createTabServer(client: TabClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "health",
    {
      title: "TAB health",
      description:
        "Check the TAB API, the settlement mode, and whether the human's signer is online. Call this first when something looks wrong.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const health = await client.health();
        const sentence =
          `TAB is ${health.ok ? "online" : "down"} on ${health.mode}` +
          `${health.demoMode ? " (demo rail)" : " (live rail)"}; ` +
          `the signer is ${health.signerOnline ? "online" : "offline"} and ${health.merchants} merchants are seeded.`;
        return reply(sentence, health);
      } catch (err) {
        return failure(err, "read health");
      }
    },
  );

  server.registerTool(
    "list_cards",
    {
      title: "List spending cards",
      description:
        "List the TAB cards this agent may spend from, with the remaining budget, per-charge cap and merchant allowlist.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { cards } = await client.listCards();
        if (cards.length === 0) {
          return reply("This agent has no cards yet. Open a tab in the TAB dashboard first.", cards);
        }
        const lines = cards.map(
          (card) =>
            `${card.label} (${card.id}) — ${formatAmount(remainingBudget(card), card.asset)} left of ` +
            `${formatAmount(card.budget.total, card.asset)}, ` +
            `${formatAmount(card.limits.perCharge, card.asset)} per charge, ${card.status}`,
        );
        return reply(`This agent can spend from ${cards.length} card(s):\n- ${lines.join("\n- ")}`, cards);
      } catch (err) {
        return failure(err, "list cards");
      }
    },
  );

  server.registerTool(
    "get_budget",
    {
      title: "Get card budget",
      description:
        "Read one card's remaining budget, limits, merchant allowlist and expiry before spending.",
      inputSchema: { cardId: z.string().describe("The card id, e.g. crd_…") },
      annotations: { readOnlyHint: true },
    },
    async ({ cardId }) => {
      try {
        const { card } = await client.getCard(cardId);
        const merchants = card.merchants.length > 0 ? card.merchants.join(", ") : "any merchant";
        const sentence =
          `"${card.label}" is ${card.status} with ${formatAmount(remainingBudget(card), card.asset)} left of ` +
          `${formatAmount(card.budget.total, card.asset)}; ` +
          `${formatAmount(card.limits.perCharge, card.asset)} per charge, ` +
          `${formatAmount(card.limits.daily, card.asset)} per day, and it needs your approval above ` +
          `${formatAmount(card.limits.autoApproveUnder, card.asset)}. Allowed merchants: ${merchants}. Expires ${card.expiresAt}.`;
        return reply(sentence, card);
      } catch (err) {
        return failure(err, "read the budget");
      }
    },
  );

  server.registerTool(
    "buy",
    {
      title: "Buy a SKU with a card",
      description:
        "Purchase a merchant SKU. TAB checks the card's policy, issues a single-use token, and settles the charge through the human's Pollar wallet. A 202/PENDING answer means a human must approve — poll list_charges.",
      inputSchema: {
        cardId: z.string().describe("Card to spend from, crd_…"),
        merchantId: z.string().describe("Merchant id, e.g. mch_exa"),
        sku: z.string().describe("SKU id, e.g. exa-starter"),
        amount: z.string().describe("USD amount as a decimal string, e.g. '2.50'"),
        description: z.string().max(120).optional().describe("What the purchase is for"),
        idempotencyKey: z
          .string()
          .max(120)
          .optional()
          .describe("Reuse the same key to retry this purchase without buying twice"),
      },
    },
    async (args) => {
      try {
        const result = await client.buy(args);
        if (isPendingPurchase(result)) {
          const reason =
            result.charge.status === "AWAITING_APPROVAL"
              ? "A human must approve it in the TAB dashboard"
              : "the human's signer is processing it";
          return reply(
            `Payment pending — charge ${result.charge.id} is ${result.charge.status} ` +
              `(${formatAmount(result.charge.amount, result.charge.asset)}). ${reason}; ` +
              `call list_charges shortly to see the result.`,
            result,
          );
        }
        return reply(
          `Bought ${result.sku.name} for ${formatAmount(result.charge.amount, result.charge.asset)} — license ` +
            `${result.licenseKey}. Charge ${result.charge.id} is ${result.charge.status}.` +
            receiptSuffix(result.receipt),
          result,
        );
      } catch (err) {
        return failure(err, "buy this SKU");
      }
    },
  );

  server.registerTool(
    "list_charges",
    {
      title: "List charges",
      description: "Recent charges and their on-chain receipts, optionally for one card.",
      inputSchema: { cardId: z.string().optional().describe("Only this card, crd_…") },
      annotations: { readOnlyHint: true },
    },
    async ({ cardId }) => {
      try {
        const { charges } = await client.listCharges(cardId);
        if (charges.length === 0) return reply("No charges yet.", charges);
        const latest = charges[0];
        const sentence =
          `${charges.length} charge(s). Latest: ${formatAmount(latest.amount, latest.asset)} at ` +
          `${latest.merchantName} — ${latest.status}` +
          (latest.receipt ? ` (${latest.receipt.explorerUrl})` : "") +
          ".";
        return reply(sentence, charges);
      } catch (err) {
        return failure(err, "list charges");
      }
    },
  );

  server.registerTool(
    "request_token",
    {
      title: "Request a charge token",
      description:
        "Ask TAB for a single-use, merchant-bound token (5 min TTL) for up to the given amount. Hand the token to the merchant; it authorises exactly one charge.",
      inputSchema: {
        cardId: z.string().describe("Card to spend from, crd_…"),
        merchantId: z.string().describe("Merchant that will redeem it, e.g. mch_exa"),
        amount: z.string().describe("Maximum USD amount, e.g. '2.50'"),
        description: z.string().max(120).optional().describe("What the token is for"),
      },
    },
    async (args) => {
      try {
        const token = await client.requestToken(args);
        const { card } = await client.getCard(token.card.id);
        const sentence =
          `Token ${token.token} is valid until ${token.expiresAt} for up to ` +
          `${formatAmount(token.maxAmount, card.asset)} at ${token.merchantId} on card ${token.card.maskedNumber}. ` +
          "It works once.";
        return reply(sentence, token);
      } catch (err) {
        return failure(err, "request a token");
      }
    },
  );

  server.registerTool(
    "pay_token",
    {
      title: "Redeem a charge token",
      description:
        "Redeem a token at a merchant — the merchant side of the flow. Pass an idempotencyKey to make retries safe.",
      inputSchema: {
        token: z.string().describe("The tab_ch_… token"),
        merchantId: z.string().describe("Merchant redeeming it, mch_…"),
        amount: z.string().describe("Amount to charge, e.g. '2.50'"),
        description: z.string().max(120).optional().describe("What was bought"),
        idempotencyKey: z.string().max(120).optional().describe("Reused on retries to avoid a double charge"),
      },
    },
    async (args) => {
      try {
        const { charge, replayed } = await client.charge(args);
        if (charge.status === "AWAITING_APPROVAL") {
          return reply(
            `Charge ${charge.id} is awaiting human approval for ${formatAmount(charge.amount, charge.asset)}. ` +
              "Nothing was signed; poll list_charges.",
            { charge, replayed },
          );
        }
        return reply(
          `Charge ${charge.id} is ${charge.status} for ${formatAmount(charge.amount, charge.asset)} at ` +
            `${charge.merchantName}${replayed ? " (replayed idempotency key)" : ""}.` +
            receiptSuffix(charge.receipt),
          { charge, replayed },
        );
      } catch (err) {
        return failure(err, "redeem this token");
      }
    },
  );

  server.registerTool(
    "x402_fetch",
    {
      title: "Pay and fetch an x402 API",
      description:
        "Pay a real x402-protected API through the human's Pollar wallet and return its response. " +
        "This SPENDS REAL TESTNET USDC (~0.05 per call) from the card and only completes while the " +
        "human's signer console is online; if it is offline or the amount needs approval, the result " +
        "is PENDING and the body is withheld. TAB settles on-chain and hands back the body plus the explorer link.",
      inputSchema: {
        cardId: z.string().describe("Card to spend from, crd_…"),
        url: z.string().describe("The x402-protected resource URL"),
        idempotencyKey: z
          .string()
          .max(120)
          .optional()
          .describe("Reuse the same key to retry without paying twice"),
      },
    },
    async ({ cardId, url, idempotencyKey }) => {
      try {
        const result = await client.x402({ cardId, url, idempotencyKey });

        if (isX402Pending(result)) {
          return reply(
            `The x402 payment is ${result.status} — request ${result.requestId}, charge ` +
              `${result.chargeId}. The human's signer must be online (and may need to approve this ` +
              `${formatAmount("0.05", "USDC")} testnet USDC charge) before ${url} will answer; ` +
              "call list_charges to follow the charge.",
            result,
          );
        }

        if (result.status !== "SETTLED") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `The x402 payment ${result.status.toLowerCase()} — ${url} was not paid.` +
                  (result.receipt ? ` Receipt: ${result.receipt.explorerUrl}` : ""),
              },
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          };
        }

        const paid = result.receipt
          ? formatAmount(result.receipt.amount, result.receipt.asset)
          : "paid";
        return reply(
          `Paid ${paid} for ${url}.` + receiptSuffix(result.receipt) + " The response body follows in the JSON.",
          result,
        );
      } catch (err) {
        return failure(err, "pay and fetch this x402 resource");
      }
    },
  );

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.TAB_API_KEY;
  if (!apiKey) {
    console.error(
      [
        "TAB_API_KEY is not set.",
        "",
        "  1. Open the TAB dashboard and create an agent — it shows the key once.",
        "  2. Export it for the MCP client:",
        "",
        "       TAB_API_URL=http://localhost:4000",
        "       TAB_API_KEY=tab_agent_…",
        "",
        "Then restart the MCP server. No key, no spending — that is the point.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const server = createTabServer(new TabClient({ apiKey }));
  await server.connect(new StdioServerTransport());
  console.error(`TAB MCP server ready (${SERVER_NAME} v${SERVER_VERSION}) → ${process.env.TAB_API_URL ?? "http://localhost:4000"}`);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("TAB MCP server failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
