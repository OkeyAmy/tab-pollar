/**
 * SSRF guard for the x402 fetcher. The API must never become a proxy for the
 * agent: HTTPS only, host allowlist, DNS resolution, and no private/loopback/
 * link-local/metadata addresses. Redirects are refused by the caller.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export const defaultDnsLookup: DnsLookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family,
  }));
};

export type SafeUrlResult =
  | { ok: true; url: URL }
  | { ok: false; code: string; message: string };

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return null;
  }
  return parts;
}

function isPrivateV4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  if (a === 255) return true;
  return false;
}

export function isPrivateAddress(raw: string): boolean {
  let address = raw.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);

  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return true; // not an IP: fail closed

  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true; // ULA
  if (address.startsWith("fe8") || address.startsWith("fe9") ||
      address.startsWith("fea") || address.startsWith("feb")) {
    return true; // link-local
  }
  if (address.startsWith("ff")) return true; // multicast
  return false;
}

export async function validateX402Url(input: {
  raw: string;
  allowedHosts: string[];
  lookup?: DnsLookup;
}): Promise<SafeUrlResult> {
  let url: URL;
  try {
    url = new URL(input.raw);
  } catch {
    return {
      ok: false,
      code: "X402_INVALID_URL",
      message: "That x402 URL is not a valid URL.",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "X402_HTTPS_REQUIRED",
      message: "x402 resources must be fetched over HTTPS.",
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (!input.allowedHosts.includes(hostname)) {
    return {
      ok: false,
      code: "X402_HOST_NOT_ALLOWED",
      message: `The host ${hostname} is not an allowlisted x402 merchant.`,
    };
  }

  if (isIP(hostname) && isPrivateAddress(hostname)) {
    return {
      ok: false,
      code: "X402_BLOCKED_ADDRESS",
      message: "The x402 host resolves to a private or metadata address.",
    };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await (input.lookup ?? defaultDnsLookup)(hostname);
  } catch {
    return {
      ok: false,
      code: "X402_DNS_FAILED",
      message: "Could not resolve the x402 host.",
    };
  }

  if (records.length === 0) {
    return {
      ok: false,
      code: "X402_DNS_FAILED",
      message: "The x402 host resolved to no addresses.",
    };
  }

  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      return {
        ok: false,
        code: "X402_BLOCKED_ADDRESS",
        message: "The x402 host resolves to a private or metadata address.",
      };
    }
  }

  return { ok: true, url };
}
