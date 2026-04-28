import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimiter } from './ratelimit.js';

/**
 * Redis-backed fixed-window rate limiter.
 *
 *   key = `ratelimit:{subject}:{endpoint}:{bucket}`
 *
 * Pipeline:
 *   INCR key
 *   PEXPIRE key {windowMs} NX  (set TTL only on first hit per bucket)
 *
 * NX on PEXPIRE keeps the TTL stable across the bucket window, so the key
 * vanishes when the window closes regardless of how many times we hit it.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(args: {
    subject: string;
    endpoint: string;
    limit: number;
    windowMs: number;
    now?: number;
  }): Promise<RateLimitDecision> {
    const now = args.now ?? Date.now();
    const bucket = Math.floor(now / args.windowMs);
    const resetAtMs = (bucket + 1) * args.windowMs;
    const key = `ratelimit:${args.subject}:${args.endpoint}:${bucket}`;

    const pipeline = this.redis.multi();
    pipeline.incr(key);
    // ioredis exposes pexpire(key, ms, 'NX').
    pipeline.pexpire(key, args.windowMs, 'NX');
    const results = await pipeline.exec();

    // results[0] = [null, count]; results[1] = [null, 0|1]
    const count = Number(results?.[0]?.[1] ?? 1);
    return {
      allowed: count <= args.limit,
      remaining: Math.max(0, args.limit - count),
      resetAtMs,
    };
  }
}
