/**
 * Credentials: opaque session cookies for humans, bearer keys for agents.
 * Only hashes are ever stored or compared. Session-side CSRF and the Pollar
 * re-verification gate also live here.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Repo } from "@tab/db";
import { KEY_PREFIX, type Agent, type User } from "@tab/shared";
import type { ApiConfig } from "./env.js";
import { fail } from "./http.js";
import {
  PollarVerifyError,
  verifyPollarToken,
} from "./pollar.js";

export const SESSION_COOKIE = "tab_session";
const SESSION_META_PREFIX = "session_meta:";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export interface SessionMeta {
  pollarExpiresAt: string;
  verifiedAt: string;
  applicationId: string | null;
  network: string;
  walletAddress: string;
}

export function sessionMetaKey(tokenHash: string): string {
  return `${SESSION_META_PREFIX}${tokenHash}`;
}

export function readSessionMeta(repo: Repo, tokenHash: string): SessionMeta | null {
  const raw = repo.getMeta(sessionMetaKey(tokenHash));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionMeta>;
    if (
      typeof parsed.pollarExpiresAt !== "string" ||
      typeof parsed.verifiedAt !== "string" ||
      typeof parsed.network !== "string"
    ) {
      return null;
    }
    return {
      pollarExpiresAt: parsed.pollarExpiresAt,
      verifiedAt: parsed.verifiedAt,
      applicationId:
        typeof parsed.applicationId === "string" ? parsed.applicationId : null,
      network: parsed.network,
      walletAddress:
        typeof parsed.walletAddress === "string" ? parsed.walletAddress : "",
    };
  } catch {
    return null;
  }
}

export function writeSessionMeta(
  repo: Repo,
  tokenHash: string,
  meta: SessionMeta,
): void {
  repo.setMeta(sessionMetaKey(tokenHash), JSON.stringify(meta));
}

export function deleteSessionMeta(repo: Repo, tokenHash: string): void {
  repo.db.prepare(`DELETE FROM meta WHERE key = ?`).run(sessionMetaKey(tokenHash));
}

export function clearSessionMeta(repo: Repo): void {
  repo.db.prepare(`DELETE FROM meta WHERE key LIKE ?`).run(`${SESSION_META_PREFIX}%`);
}

/** CSRF token is an HMAC of the opaque session cookie, so it survives reloads. */
export function csrfTokenFor(rawSession: string, secret: string): string {
  return createHmac("sha256", secret).update(rawSession).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type OriginCheck =
  | { ok: true }
  | { ok: false; response: Response };

export function checkOrigin(c: Context, allowedOrigins: string[]): OriginCheck {
  const origin = c.req.header("origin");
  if (!origin) return { ok: true };
  if (allowedOrigins.includes(origin)) return { ok: true };
  return {
    ok: false,
    response: fail(c, 403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed."),
  };
}

export type SessionAuth =
  | {
      ok: true;
      user: User;
      sessionToken: string;
      tokenHash: string;
      csrfToken: string;
      meta: SessionMeta | null;
    }
  | { ok: false; response: Response };

export function requireSession(
  c: Context,
  repo: Repo,
  config: ApiConfig,
): SessionAuth {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) {
    return {
      ok: false,
      response: fail(c, 401, "UNAUTHORIZED", "Sign in to continue."),
    };
  }
  const tokenHash = hashToken(raw);
  const user = repo.getUserBySessionHash(tokenHash);
  if (!user) {
    return {
      ok: false,
      response: fail(c, 401, "UNAUTHORIZED", "This session is invalid or expired."),
    };
  }
  return {
    ok: true,
    user,
    sessionToken: raw,
    tokenHash,
    csrfToken: csrfTokenFor(raw, config.sessionSecret),
    meta: readSessionMeta(repo, tokenHash),
  };
}

/** Session + CSRF + Origin for every cookie-authenticated mutation. */
export function requireMutation(
  c: Context,
  repo: Repo,
  config: ApiConfig,
): SessionAuth {
  const auth = requireSession(c, repo, config);
  if (!auth.ok) return auth;

  const origin = checkOrigin(c, config.allowedOrigins);
  if (!origin.ok) return { ok: false, response: origin.response };

  const provided = c.req.header("x-tab-csrf");
  if (!provided || !safeEqual(provided, auth.csrfToken)) {
    return {
      ok: false,
      response: fail(
        c,
        403,
        "CSRF_INVALID",
        "Missing or invalid CSRF token.",
      ),
    };
  }
  return auth;
}

/** A Bearer token on a cookie route is a fresh Pollar access token. */
export function parsePollarBearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;
  if (token.startsWith(KEY_PREFIX.agent) || token.startsWith(KEY_PREFIX.merchant)) {
    return null;
  }
  return token;
}

export interface FreshSessionOptions {
  /** Approvals/declines always require a fresh Pollar verification. */
  always: boolean;
}

/**
 * Sensitive actions re-verify with the Pollar Server API. After the stored
 * Pollar expiry, the first signer claim/result must present a fresh token.
 */
export async function requireFreshSession(
  c: Context,
  repo: Repo,
  config: ApiConfig,
  fetchImpl: typeof fetch,
  opts: FreshSessionOptions,
): Promise<SessionAuth> {
  const auth = requireMutation(c, repo, config);
  if (!auth.ok) return auth;

  const bearer = parsePollarBearer(c);
  if (bearer) {
    try {
      const verified = await verifyPollarToken({
        token: bearer,
        config,
        fetchImpl,
      });
      if (verified.userId !== auth.user.pollarUserId) {
        return {
          ok: false,
          response: fail(
            c,
            401,
            "SESSION_USER_MISMATCH",
            "That Pollar token belongs to a different account.",
          ),
        };
      }
      const meta: SessionMeta = {
        pollarExpiresAt: verified.expiresAt,
        verifiedAt: new Date().toISOString(),
        applicationId: verified.applicationId,
        network: verified.network,
        walletAddress: verified.walletAddress,
      };
      writeSessionMeta(repo, auth.tokenHash, meta);
      return { ...auth, meta };
    } catch (err) {
      if (err instanceof PollarVerifyError) {
        return {
          ok: false,
          response: fail(c, err.status, err.code, err.message),
        };
      }
      throw err;
    }
  }

  if (opts.always) {
    return {
      ok: false,
      response: fail(
        c,
        401,
        "REVERIFY_REQUIRED",
        "Confirm your Pollar session to continue.",
        { reason: "FRESH_VERIFICATION_REQUIRED" },
      ),
    };
  }

  if (auth.meta && Date.parse(auth.meta.pollarExpiresAt) > Date.now()) {
    return auth;
  }

  return {
    ok: false,
    response: fail(
      c,
      401,
      "REVERIFY_REQUIRED",
      "Your Pollar session has expired; sign in again.",
      { reason: "POLLAR_TOKEN_EXPIRED" },
    ),
  };
}

export type AgentAuth =
  | { ok: true; agent: Agent }
  | { ok: false; response: Response };

export function requireAgent(c: Context, repo: Repo): AgentAuth {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: fail(c, 401, "UNAUTHORIZED", "Send an agent key as a Bearer token."),
    };
  }
  const raw = header.slice("Bearer ".length).trim();
  if (!raw.startsWith(KEY_PREFIX.agent)) {
    return {
      ok: false,
      response: fail(c, 401, "UNAUTHORIZED", "That is not an agent key."),
    };
  }
  const agent = repo.getAgentByKeyHash(hashToken(raw));
  if (!agent) {
    return {
      ok: false,
      response: fail(c, 401, "UNAUTHORIZED", "This agent key is not recognised."),
    };
  }
  if (agent.status === "REVOKED") {
    return {
      ok: false,
      response: fail(c, 403, "AGENT_REVOKED", "This agent was revoked."),
    };
  }
  if (agent.status === "PAUSED") {
    return {
      ok: false,
      response: fail(c, 403, "AGENT_PAUSED", "This agent is paused."),
    };
  }
  repo.touchAgent(agent.id);
  return { ok: true, agent };
}

export type Actor =
  | { kind: "user"; user: User }
  | { kind: "agent"; agent: Agent };

export type ActorAuth =
  | { ok: true; actor: Actor }
  | { ok: false; response: Response };

/** Cookie or agent key — used by read-only card/charge routes. */
export function resolveActor(
  c: Context,
  repo: Repo,
  config: ApiConfig,
): ActorAuth {
  if (c.req.header("authorization") && !parsePollarBearer(c)) {
    const auth = requireAgent(c, repo);
    return auth.ok
      ? { ok: true, actor: { kind: "agent", agent: auth.agent } }
      : { ok: false, response: auth.response };
  }
  const auth = requireSession(c, repo, config);
  return auth.ok
    ? { ok: true, actor: { kind: "user", user: auth.user } }
    : { ok: false, response: auth.response };
}
