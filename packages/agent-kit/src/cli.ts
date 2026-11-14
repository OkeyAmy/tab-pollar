#!/usr/bin/env node
/**
 * `tab` — the CLI an agent (or a human debugging an agent) uses.
 *
 * OWNER: agent-kit agent. Every command supports `--json`; human output is
 * plain ASCII/box text and never depends on colour.
 *
 * Exit codes:
 *   0  done
 *   1  failed (API error, policy denial, payment failed)
 *   2  pending — a human must approve, or the signer is not connected yet
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { remainingBudget } from "@tab/shared";
import {
  TabApiError,
  TabClient,
  exitCodeForCharge,
  exitCodeForX402,
  formatAmount,
  isPendingPurchase,
  isX402Pending,
  type PurchaseResult,
} from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const WEB_URL = (process.env.TAB_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
/** Scanned once: `--json` may appear before or after the subcommand. */
const JSON_MODE = process.argv.includes("--json");

const client = TabClient.fromEnv();

/* ── output ──────────────────────────────────────────────────────────────── */

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function exit(code: number): void {
  process.exitCode = code;
}

function row(pairs: Array<[string, string]>): void {
  const width = pairs.reduce((w, [k]) => Math.max(w, k.length), 0);
  for (const [key, value] of pairs) console.log(`  ${key.padEnd(width)}  ${value}`);
}

function table(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join("  ").trimEnd());
  for (const cells of rows) {
    console.log(cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd());
  }
}

function approvalUrl(chargeId: string): string {
  return `${WEB_URL}/app?charge=${encodeURIComponent(chargeId)}`;
}

function fail(err: unknown): void {
  if (err instanceof TabApiError) {
    if (JSON_MODE) console.error(JSON.stringify({ error: err.toJSON() }, null, 2));
    console.error(`✗ ${err.message}`);
    if (err.details !== undefined) console.error(JSON.stringify(err.details, null, 2));
    exit(1);
    return;
  }
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function requireKey(): void {
  if (client.hasApiKey()) return;
  throw new TabApiError(
    0,
    "MISSING_API_KEY",
    "MISSING_API_KEY — No agent key configured. Create an agent in the TAB dashboard, then set TAB_API_KEY=tab_agent_…",
  );
}

const json = () => JSON_MODE;

/* ── commands ────────────────────────────────────────────────────────────── */

const program = new Command();
program
  .name("tab")
  .description("Virtual cards for AI agents, backed by the Pollar wallet.")
  .version("0.1.0")
  .option("--json", "machine-readable output");

program
  .command("health")
  .description("Check the TAB API and signer status")
  .option("--json", "machine-readable output")
  .action(async () => {
    const health = await client.health();
    if (json()) return printJson(health);
    console.log(`TAB ${health.ok ? "online" : "down"}  ·  ${health.mode}${health.demoMode ? "  ·  demo rail" : ""}`);
    row([
      ["api", client.baseUrl],
      ["signer", health.signerOnline ? "online" : "offline"],
      ["merchants", String(health.merchants)],
      ["now", health.now],
    ]);
    return exit(health.ok ? 0 : 1);
  });

program
  .command("cards")
  .description("List cards this agent can spend from")
  .option("--json", "machine-readable output")
  .action(async () => {
    requireKey();
    const { cards } = await client.listCards();
    if (json()) return printJson(cards);
    if (cards.length === 0) {
      console.log("No cards yet. Open a tab in the dashboard first.");
      return;
    }
    table(
      ["ID", "LABEL", "CARD", "LEFT", "MAX/CHARGE", "STATUS"],
      cards.map((card) => [
        card.id,
        card.label,
        card.maskedNumber,
        formatAmount(remainingBudget(card), card.asset),
        formatAmount(card.limits.perCharge, card.asset),
        card.status,
      ]),
    );
  });

program
  .command("budget <cardId>")
  .description("Show a card's budget, limits and merchant allowlist")
  .option("--json", "machine-readable output")
  .action(async (cardId: string) => {
    requireKey();
    const { card } = await client.getCard(cardId);
    if (json()) return printJson(card);
    console.log(`${card.label}  ${card.maskedNumber}`);
    row([
      ["id", card.id],
      ["agent", card.agentId],
      ["status", card.status],
      ["rail", `${card.chain} · ${card.asset}`],
      ["left", formatAmount(remainingBudget(card), card.asset)],
      ["total", formatAmount(card.budget.total, card.asset)],
      ["spent", formatAmount(card.budget.spent, card.asset)],
      ["reserved", formatAmount(card.budget.reserved, card.asset)],
      ["max per charge", formatAmount(card.limits.perCharge, card.asset)],
      ["daily cap", formatAmount(card.limits.daily, card.asset)],
      ["needs approval above", formatAmount(card.limits.autoApproveUnder, card.asset)],
      ["merchants", card.merchants.length > 0 ? card.merchants.join(", ") : "any"],
      ["expires", card.expiresAt],
    ]);
  });

program
  .command("buy")
  .description("Buy a merchant SKU with a card")
  .requiredOption("--card <cardId>", "card to spend from, crd_…")
  .requiredOption("--merchant <merchantId>", "merchant id, mch_…")
  .requiredOption("--sku <skuId>", "SKU id, e.g. exa-starter")
  .requiredOption("--amount <usd>", "price as a decimal string, e.g. 2.50")
  .option("--description <text>", "what the purchase is for")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    requireKey();
    const result: PurchaseResult = await client.buy({
      cardId: opts.card,
      merchantId: opts.merchant,
      sku: opts.sku,
      amount: opts.amount,
      description: opts.description,
    });

    if (json()) printJson(result);

    if (isPendingPurchase(result)) {
      if (!json()) {
        console.log(
          result.charge.status === "AWAITING_APPROVAL"
            ? `PENDING — needs approval at ${approvalUrl(result.charge.id)}`
            : `PENDING — waiting for the signer; watch ${approvalUrl(result.charge.id)}`,
        );
        row([
          ["charge", `${result.charge.id}  [${result.charge.status}]`],
          ["amount", formatAmount(result.charge.amount, result.charge.asset)],
          ["merchant", result.charge.merchantName],
        ]);
      }
      return exit(exitCodeForCharge(result.charge.status));
    }

    if (!json()) {
      console.log(`✓ ${result.sku.name} — ${formatAmount(result.charge.amount, result.charge.asset)}`);
      row([
        ["sku", result.sku.id],
        ["license", result.licenseKey],
        ["charge", `${result.charge.id}  [${result.charge.status}]`],
        ["receipt", result.receipt?.explorerUrl ?? "—"],
      ]);
    }
    return exit(exitCodeForCharge(result.charge.status));
  });

program
  .command("charges")
  .description("Recent charges and their settlement status")
  .option("--card <cardId>", "only this card")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    requireKey();
    const { charges } = await client.listCharges(opts.card);
    if (json()) return printJson(charges);
    if (charges.length === 0) {
      console.log("No charges yet.");
      return;
    }
    table(
      ["ID", "AMOUNT", "MERCHANT", "STATUS", "CREATED"],
      charges.map((charge) => [
        charge.id,
        formatAmount(charge.amount, charge.asset),
        charge.merchantName,
        charge.status,
        charge.createdAt,
      ]),
    );
  });

program
  .command("token")
  .description("Request a single-use charge token (5 min) for a merchant")
  .requiredOption("--card <cardId>", "card to spend from, crd_…")
  .requiredOption("--merchant <merchantId>", "merchant id, mch_…")
  .requiredOption("--amount <usd>", "maximum amount, e.g. 2.50")
  .option("--description <text>", "what the token is for")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    requireKey();
    const token = await client.requestToken({
      cardId: opts.card,
      merchantId: opts.merchant,
      amount: opts.amount,
      description: opts.description,
    });
    if (json()) return printJson(token);
    const { card } = await client.getCard(token.card.id);
    console.log(token.token);
    row([
      ["expires", token.expiresAt],
      ["max", formatAmount(token.maxAmount, card.asset)],
      ["card", token.card.maskedNumber],
      ["merchant", token.merchantId],
    ]);
  });

program
  .command("pay")
  .description("Redeem a charge token at a merchant (the merchant side of the flow)")
  .requiredOption("--token <tab_ch_…>", "single-use token from `tab token`")
  .requiredOption("--merchant <merchantId>", "merchant redeeming it, mch_…")
  .requiredOption("--amount <usd>", "amount to charge, e.g. 2.50")
  .option("--description <text>", "what was bought")
  .option("--idempotency-key <key>", "safe to retry with the same key")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    const { charge, replayed } = await client.charge({
      token: opts.token,
      merchantId: opts.merchant,
      amount: opts.amount,
      description: opts.description,
      idempotencyKey: opts.idempotencyKey,
    });

    if (json()) printJson({ charge, replayed });

    const code = exitCodeForCharge(charge.status);
    if (code === 2) {
      if (!json()) {
        if (charge.status === "AWAITING_APPROVAL") {
          console.log(`PENDING — needs approval at ${approvalUrl(charge.id)}`);
        } else {
          const state = charge.status === "QUEUED" ? "queued for the signer" : "signing in progress";
          console.log(`PENDING — ${state}; watch ${approvalUrl(charge.id)}`);
        }
        row([
          ["charge", `${charge.id}  [${charge.status}]`],
          ["amount", formatAmount(charge.amount, charge.asset)],
        ]);
      }
      return exit(2);
    }

    if (!json()) {
      const mark = charge.status === "SETTLED" ? "✓" : "✗";
      console.log(
        `${mark} ${formatAmount(charge.amount, charge.asset)} to ${charge.merchantName} — ${charge.status}${replayed ? "  (replay)" : ""}`,
      );
      row([
        ["charge", charge.id],
        ["receipt", charge.receipt?.explorerUrl ?? "—"],
      ]);
    }
    return exit(code);
  });

program
  .command("x402")
  .description("Pay a real x402-protected API through the card, then print its response")
  .requiredOption("--card <cardId>", "card to spend from, crd_…")
  .requiredOption("--url <url>", "the x402-protected resource")
  .option("--json", "machine-readable output")
  .action(async (opts) => {
    requireKey();
    const result = await client.x402({ cardId: opts.card, url: opts.url });

    if (json()) printJson(result);

    if (isX402Pending(result)) {
      if (!json()) {
        console.log(`PENDING — needs approval at ${approvalUrl(result.chargeId)}`);
        row([
          ["request", result.requestId],
          ["charge", result.chargeId],
          ["status", result.status],
        ]);
      }
      return exit(2);
    }

    if (result.status !== "SETTLED") {
      if (!json()) console.error(`✗ ${result.status} — the x402 payment did not settle.`);
      return exit(exitCodeForX402(result.status));
    }

    if (!json()) {
      const paid = result.receipt
        ? formatAmount(result.receipt.amount, result.receipt.asset)
        : "paid";
      console.log(`✓ ${paid} — ${opts.url}`);
      if (result.receipt) row([["tx", result.receipt.explorerUrl]]);
      console.log("");
      if (typeof result.body === "string") console.log(result.body);
      else console.log(JSON.stringify(result.body ?? null, null, 2));
    }
    return exit(exitCodeForX402(result.status));
  });

program
  .command("mcp")
  .description("Print a ready-to-paste MCP config for Claude Desktop / Cursor")
  .option("--json", "machine-readable output (always on for this command)")
  .action(() => {
    // The real key is never printed: the config is a template to paste into a file.
    const config = {
      mcpServers: {
        tab: {
          command: "pnpm",
          args: ["--dir", REPO_ROOT, "--filter", "@tab/mcp", "start"],
          env: {
            TAB_API_URL: client.baseUrl,
            TAB_API_KEY: "tab_agent_…",
          },
        },
      },
    };
    printJson(config);
  });

program.parseAsync(process.argv).catch(fail);
