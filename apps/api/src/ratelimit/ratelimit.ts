/**
 * Per spec §8 (Redis keys): `ratelimit:{user_id}:{endpoint}` is a sliding-
 * window counter. We use the simpler **fixed-window** strategy here: bucket
 * by floor(now / windowMs). Trades exact precision at the window boundary
 * for O(1) per-call cost and clean Redis TTL semantics.
 *
 * The `subject` is whatever scopes the limit — usually a deviceToken or
 * userId, occasionally an IP for unauthenticated routes.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Unix ms at which the current bucket expires. */
  resetAtMs: number;
}

export interface RateLimiter {
  consume(args: {
    subject: string;
    endpoint: string;
    limit: number;
    windowMs: number;
    now?: number;
  }): Promise<RateLimitDecision>;
}

function bucketWindow(now: number, windowMs: number): { bucket: number; resetAtMs: number } {
  const bucket = Math.floor(now / windowMs);
  return { bucket, resetAtMs: (bucket + 1) * windowMs };
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, { bucket: number; count: number }>();

  async consume(args: {
    subject: string;
    endpoint: string;
    limit: number;
    windowMs: number;
    now?: number;
  }): Promise<RateLimitDecision> {
    const now = args.now ?? Date.now();
    const { bucket, resetAtMs } = bucketWindow(now, args.windowMs);
    const key = `${args.subject}:${args.endpoint}`;
    const existing = this.counts.get(key);
    const count = existing && existing.bucket === bucket ? existing.count + 1 : 1;
    this.counts.set(key, { bucket, count });
    return {
      allowed: count <= args.limit,
      remaining: Math.max(0, args.limit - count),
      resetAtMs,
    };
  }
}
