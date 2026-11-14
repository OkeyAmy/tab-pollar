export type CatalogMerchant = {
  id: string;
  name: string;
  domain: string;
  category: string;
  /** Settlement asset as reported by the merchant endpoint, when it says. */
  asset?: string | null;
};

export type CatalogSku = {
  id: string;
  merchantId: string;
  name: string;
  price: string;
  unit: string;
  description: string;
  licensePrefix: string;
  asset?: string | null;
};

export type Catalogue = {
  merchants: CatalogMerchant[];
  skus: CatalogSku[];
};

export type CatalogueGroup = {
  merchant: CatalogMerchant;
  skus: CatalogSku[];
};

const MONEY = /^\d+(\.\d{1,7})?$/;

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asMoney(value: unknown): string | null {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value.toFixed(2)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!MONEY.test(raw)) return null;
  if (Number(raw) <= 0) return null;
  return raw;
}

/** Only accept assets the till can actually settle and label. */
function asAsset(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const asset = value.trim().toUpperCase();
    if (asset === "XLM" || asset === "USDC") return asset;
  }
  return null;
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (Array.isArray(obj.merchants) && Array.isArray(obj.skus)) return obj;
  if (obj.data && typeof obj.data === "object") {
    const inner = obj.data as Record<string, unknown>;
    if (Array.isArray(inner.merchants) && Array.isArray(inner.skus)) return inner;
  }
  return null;
}

/** Tolerant reader for `GET /api/v1/merchants`. Unknown fields are ignored. */
export function parseCatalogue(payload: unknown): Catalogue | null {
  const root = unwrap(payload);
  if (!root) return null;

  const merchants: CatalogMerchant[] = [];
  for (const raw of root.merchants as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const id = asString(m.id);
    const name = asString(m.name);
    if (!id || !name) continue;
    merchants.push({
      id,
      name,
      domain: asString(m.domain) || "direct",
      category: asString(m.category) || "Supplier",
      asset: asAsset(m.asset, m.settlementAsset, m.currency),
    });
  }

  const merchantAsset = new Map(merchants.map((merchant) => [merchant.id, merchant.asset]));
  const knownMerchants = new Set(merchants.map((m) => m.id));
  const skus: CatalogSku[] = [];
  for (const raw of root.skus as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const id = asString(s.id);
    const merchantId = asString(s.merchantId);
    const name = asString(s.name);
    const price = asMoney(s.price);
    if (!id || !merchantId || !name || !price) continue;
    if (!knownMerchants.has(merchantId)) continue;
    skus.push({
      id,
      merchantId,
      name,
      price,
      unit: asString(s.unit) || "one unit",
      description: asString(s.description) || "Delivered as a key after the payment settles.",
      licensePrefix: asString(s.licensePrefix) || "DEPOT",
      asset: asAsset(s.asset, s.settlementAsset) ?? merchantAsset.get(merchantId) ?? null,
    });
  }

  if (merchants.length === 0 || skus.length === 0) return null;
  return { merchants, skus };
}

export function groupCatalogue(catalogue: Catalogue | null): CatalogueGroup[] {
  if (!catalogue) return [];
  return catalogue.merchants
    .map((merchant) => ({
      merchant,
      // Display-only sort. No money arithmetic happens here.
      skus: catalogue.skus
        .filter((sku) => sku.merchantId === merchant.id)
        .sort((a, b) => Number(a.price) - Number(b.price)),
    }))
    .filter((group) => group.skus.length > 0);
}

/**
 * The fixed seed catalogue from .agents/CONTRACTS.md. Used only when
 * `GET /merchants` is unreachable, and labelled as the printed copy in the UI.
 * Checkout stays honest: if the till is down, presenting a token fails.
 */
export const PRINTED_CATALOGUE: Catalogue = {
  merchants: [
    { id: "mch_exa", name: "Exa", domain: "exa.ai", category: "Search index" },
    { id: "mch_firecrawl", name: "Firecrawl", domain: "firecrawl.dev", category: "Web scraping" },
    { id: "mch_openai", name: "OpenAI", domain: "openai.com", category: "Models" },
  ],
  skus: [
    {
      id: "exa-starter",
      merchantId: "mch_exa",
      name: "Exa Starter",
      price: "2.50",
      unit: "1,000 searches",
      description: "One thousand searches across the web index, page text returned as markdown.",
      licensePrefix: "EXA",
    },
    {
      id: "exa-pro",
      merchantId: "mch_exa",
      name: "Exa Pro",
      price: "9.00",
      unit: "5,000 searches",
      description: "Five thousand searches on the same index, with a higher ceiling per call.",
      licensePrefix: "EXA",
    },
    {
      id: "firecrawl-1k",
      merchantId: "mch_firecrawl",
      name: "Firecrawl 1K",
      price: "4.00",
      unit: "1,000 pages",
      description: "One thousand pages scraped to clean markdown, crawl queue included.",
      licensePrefix: "FIRE",
    },
    {
      id: "firecrawl-10k",
      merchantId: "mch_firecrawl",
      name: "Firecrawl 10K",
      price: "19.00",
      unit: "10,000 pages",
      description: "Ten thousand pages of crawling and extraction, one key for the job.",
      licensePrefix: "FIRE",
    },
    {
      id: "openai-5",
      merchantId: "mch_openai",
      name: "OpenAI 5M",
      price: "5.00",
      unit: "5M tokens",
      description: "Five million tokens against a GPT-class model, metered on the key.",
      licensePrefix: "OPENAI",
    },
    {
      id: "openai-20",
      merchantId: "mch_openai",
      name: "OpenAI 20M",
      price: "20.00",
      unit: "20M tokens",
      description: "Twenty million tokens for longer jobs at the same rate.",
      licensePrefix: "OPENAI",
    },
  ],
};
