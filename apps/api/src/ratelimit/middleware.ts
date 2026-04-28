import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { RateLimiter } from './ratelimit.js';

export interface RateLimitOptions {
  limiter: RateLimiter;
  endpoint: string;
  limit: number;
  windowMs: number;
  /** Compute the rate-limit subject for this request. Default: auth.userId or remoteAddress. */
  subject?: (req: FastifyRequest) => string;
}

const DEFAULT_SUBJECT = (req: FastifyRequest) =>
  req.auth?.userId ?? req.auth?.deviceToken ?? req.ip ?? 'anonymous';

/** Fastify preHandler that enforces a fixed-window rate limit. Sets RateLimit-* response headers. */
export function rateLimit(opts: RateLimitOptions): preHandlerHookHandler {
  const subjectOf = opts.subject ?? DEFAULT_SUBJECT;
  return async function rateLimitHandler(req: FastifyRequest, reply: FastifyReply) {
    const decision = await opts.limiter.consume({
      subject: subjectOf(req),
      endpoint: opts.endpoint,
      limit: opts.limit,
      windowMs: opts.windowMs,
    });
    reply.header('RateLimit-Limit', String(opts.limit));
    reply.header('RateLimit-Remaining', String(decision.remaining));
    reply.header('RateLimit-Reset', String(Math.ceil((decision.resetAtMs - Date.now()) / 1000)));
    if (!decision.allowed) {
      return reply.code(429).send({ error: 'rate_limited' });
    }
  };
}
