/**
 * In-memory sliding-window rate limiter. Single-process demo scale only; a
 * production deployment would put this in Redis or the edge.
 */
export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  check(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitResult {
    const cutoff = now - policy.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= policy.limit) {
      const oldest = recent[0] ?? now;
      const retryAfter = Math.max(
        1,
        Math.ceil((oldest + policy.windowMs - now) / 1000),
      );
      this.hits.set(key, recent);
      return { allowed: false, retryAfter };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfter: 0 };
  }
}

export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

const MINUTE = 60_000;

export function perMinute(limit: number): RateLimitPolicy {
  return { limit, windowMs: MINUTE };
}
