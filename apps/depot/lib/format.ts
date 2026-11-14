/** Display helpers. Money is a decimal string everywhere; never do sums here. */

function trimDecimal(raw: string): string {
  const [whole, frac = ""] = raw.split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0").slice(0, 7);
  return `${whole}.${trimmed}`;
}

/**
 * Render an amount in the asset the API actually named. USDC stays dollar
 * denominated; XLM (or any other asset) never gets a dollar sign.
 */
export function money(amount: string | null | undefined, asset?: string | null): string {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";

  const code = (asset ?? "").toUpperCase();
  if (code === "USDC") {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (code) return `${trimDecimal(amount)} ${code}`;
  return trimDecimal(amount);
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function maskToken(token: string): string {
  if (token.length <= 16) return token;
  return `${token.slice(0, 11)}…${token.slice(-4)}`;
}

/** UTC everywhere, so server and client render the same string. */
export function utcStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function stampDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(date)
    .toUpperCase();
}

export function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}
