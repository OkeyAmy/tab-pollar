/**
 * Pollar Server API token verification.
 *
 * The browser presents its Pollar SDK access token. We exchange it
 * server-to-server for the authoritative userId + wallet. Client-supplied ids
 * and addresses are never trusted.
 */
import type { ApiConfig } from "./env.js";

export interface VerifiedPollarToken {
  userId: string;
  walletAddress: string;
  solanaAddress: string | null;
  applicationId: string | null;
  network: string;
  expiresAt: string;
  email: string | null;
  name: string | null;
}

export class PollarVerifyError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 401 | 500 = 401,
  ) {
    super(message);
    this.name = "PollarVerifyError";
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  return null;
}

export async function verifyPollarToken(input: {
  token: string;
  config: ApiConfig;
  fetchImpl: typeof fetch;
}): Promise<VerifiedPollarToken> {
  if (!input.config.pollarSecretKey) {
    throw new PollarVerifyError(
      "POLLAR_NOT_CONFIGURED",
      "Server-side Pollar verification is not configured (POLLAR_SECRET_KEY is empty).",
    );
  }

  let res: Response;
  try {
    res = await input.fetchImpl(input.config.pollarVerifyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pollar-api-key": input.config.pollarSecretKey,
      },
      body: JSON.stringify({ token: input.token }),
    });
  } catch (err) {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_UNAVAILABLE",
      err instanceof Error
        ? `Could not reach the Pollar Server API: ${err.message}`
        : "Could not reach the Pollar Server API.",
    );
  }

  if (!res.ok) {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_FAILED",
      `Pollar rejected the access token (HTTP ${res.status}).`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_INVALID",
      "The Pollar Server API returned a non-JSON response.",
    );
  }

  const root =
    payload && typeof payload === "object"
      ? ((payload as { content?: unknown }).content ?? payload)
      : null;
  if (!root || typeof root !== "object") {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_INVALID",
      "The Pollar Server API response had no content.",
    );
  }
  const content = root as Record<string, unknown>;

  const userId = pickString(content, ["userId", "user_id"]);
  const wallet =
    content.wallet && typeof content.wallet === "object"
      ? (content.wallet as Record<string, unknown>)
      : {};
  const walletAddress = pickString(wallet, [
    "public_key",
    "publicKey",
    "stellarAddress",
    "address",
  ]);
  const solanaAddress = pickString(wallet, [
    "solanaAddress",
    "solana_address",
    "solana_public_key",
  ]);

  if (!userId || !walletAddress) {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_INVALID",
      "The verified token did not include a userId and wallet address.",
    );
  }

  const applicationId = pickString(content, ["applicationId", "application_id"]);
  if (
    input.config.pollarApplicationId &&
    applicationId !== input.config.pollarApplicationId
  ) {
    throw new PollarVerifyError(
      "POLLAR_APPLICATION_MISMATCH",
      "This Pollar token belongs to a different application.",
    );
  }

  const network = pickString(content, ["network"]);
  if (!network || !network.toLowerCase().includes(input.config.network)) {
    throw new PollarVerifyError(
      "POLLAR_NETWORK_MISMATCH",
      `This Pollar token is not for ${input.config.network}.`,
    );
  }

  const expiresRaw = content.expiresAt ?? content.expires_at;
  let expiresMs: number;
  if (typeof expiresRaw === "number") {
    // Pollar returns a Unix timestamp. Accept seconds or milliseconds.
    expiresMs = expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw;
  } else if (typeof expiresRaw === "string") {
    expiresMs = Date.parse(expiresRaw);
  } else {
    throw new PollarVerifyError(
      "POLLAR_VERIFY_INVALID",
      "The verified token had no expiry.",
    );
  }
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    throw new PollarVerifyError(
      "POLLAR_TOKEN_EXPIRED",
      "This Pollar access token has expired; sign in again.",
    );
  }

  const profile =
    content.profile && typeof content.profile === "object"
      ? (content.profile as Record<string, unknown>)
      : {};

  const firstName = pickString(profile, ["firstName", "first_name"]);
  const lastName = pickString(profile, ["lastName", "last_name"]);
  const displayName =
    pickString(profile, ["name", "displayName"]) ??
    ([firstName, lastName].filter(Boolean).join(" ") || null);

  return {
    userId,
    walletAddress,
    solanaAddress,
    applicationId,
    network,
    expiresAt: new Date(expiresMs).toISOString(),
    email: pickString(profile, ["email"]),
    name: displayName,
  };
}
