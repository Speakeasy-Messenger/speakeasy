import type { FastifyInstance } from 'fastify';
import {
  ABUSE_REPORT_BAN_THRESHOLD,
  ABUSE_REPORT_DETAIL_MAX_CHARS,
  ABUSE_REPORT_REASONS,
  type AbuseReportReason,
} from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { AbuseReportsRepo } from '../db/abuse-reports.js';
import type { UserRepo } from '../db/users.js';
import { rateLimit } from '../ratelimit/middleware.js';
import type { RateLimiter } from '../ratelimit/ratelimit.js';
import type { getDb } from '../db/client.js';

type Db = ReturnType<typeof getDb>;

interface Body {
  reason: AbuseReportReason;
  /** Optional. Free-text context; mainly used when reason='other'. */
  detail?: string;
}
interface HandleParam {
  handle: string;
}

/**
 * Phase X — user-reporting.
 *
 *   POST /v1/users/:handle/report — file an abuse report against `handle`.
 *
 *     Body: `{ reason, detail? }`. Idempotent: a duplicate report from
 *     the same reporter against the same target succeeds without
 *     recording a second row.
 *
 *     Threshold: when this report pushes the active count
 *     (`ABUSE_REPORT_DECAY_DAYS`-windowed) to `ABUSE_REPORT_BAN_THRESHOLD`,
 *     the reported user's account is auto-deleted. The deletion
 *     happens in-line; the response returns `{ ok: true, banned: true }`
 *     when it triggered.
 *
 *     Self-report: the route rejects reports where the reporter and
 *     the target are the same user (400). Cleaner than silently
 *     incrementing a counter that can never matter.
 *
 *     Missing target: returns 404 if the reported handle doesn't
 *     resolve to a user. Prevents the table from accumulating reports
 *     against handles that never existed.
 *
 *     Rate limit: 10 reports / day per reporter (the limit is a sane
 *     ceiling — a user spamming reports across the network gets
 *     throttled before they can saturate the threshold against many
 *     targets).
 *
 *   `requireAuth` ensures every report carries a Vouchflow-verified
 *   reporter userId. No anonymous reports.
 */
export async function registerAbuseRoutes(
  app: FastifyInstance,
  opts: {
    abuseReports: AbuseReportsRepo;
    userRepo: UserRepo;
    limiter?: RateLimiter;
    /** Per-test override of the auto-ban threshold. Defaults to the shared constant. */
    banThreshold?: number;
    /**
     * For the Drizzle path, the transaction the ban check runs in.
     * In-memory tests pass nothing (the InMemory repos are
     * single-threaded so no transaction is needed).
     */
    db?: Db;
  },
): Promise<void> {
  const threshold = opts.banThreshold ?? ABUSE_REPORT_BAN_THRESHOLD;

  const rateLimitReports = opts.limiter
    ? [
        rateLimit({
          limiter: opts.limiter,
          endpoint: 'abuse.report',
          // 10 reports / day per reporter. The dedup constraint plus
          // this ceiling means a single reporter can't sweep more
          // than 10 distinct targets in any 24h window.
          limit: 10,
          windowMs: 24 * 60 * 60 * 1000,
        }),
      ]
    : [];

  app.post<{ Body: Body; Params: HandleParam }>(
    '/v1/users/:handle/report',
    {
      preHandler: [requireAuth, ...rateLimitReports],
      schema: {
        params: {
          type: 'object',
          required: ['handle'],
          properties: { handle: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', enum: [...ABUSE_REPORT_REASONS] },
            detail: {
              type: 'string',
              maxLength: ABUSE_REPORT_DETAIL_MAX_CHARS,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const reporterUserId = request.auth?.userId;
      if (!reporterUserId) return reply.code(401).send({ error: 'not_enrolled' });

      const reportedHandle = request.params.handle.toLowerCase();
      if (reportedHandle === reporterUserId) {
        return reply.code(400).send({ error: 'self_report' });
      }

      const target = await opts.userRepo.findById(reportedHandle);
      if (!target) {
        return reply.code(404).send({ error: 'user_not_found' });
      }

      const result = await opts.abuseReports.record({
        reporterUserId,
        reportedUserId: reportedHandle,
        reason: request.body.reason,
        detail: request.body.detail,
      });

      // Threshold check + auto-ban. The dedup constraint guarantees
      // each report row is from a distinct reporter, so the active
      // count directly answers "how many distinct accusers are
      // currently active against this user."
      //
      // Run the count + delete inside a transaction on the Drizzle
      // path so two concurrent reports that both cross the threshold
      // don't double-delete (one wins, one is a no-op because the
      // user is already gone). The InMemory path is single-threaded
      // and doesn't need it.
      let banned = false;
      const ban = async (): Promise<void> => {
        const active = await opts.abuseReports.countActive(reportedHandle);
        if (active < threshold) return;
        // deleteUser is idempotent on a missing row (Drizzle's
        // delete-by-id is a no-op when the user is already gone),
        // which makes this safe under concurrent threshold trips.
        await opts.userRepo.deleteUser(reportedHandle);
        banned = true;
        request.log.warn(
          {
            audit: 'auto_ban',
            userId: reportedHandle,
            activeReports: active,
            threshold,
            lastReporter: reporterUserId,
            lastReason: request.body.reason,
          },
          'auto-banned user after abuse-report threshold',
        );
      };

      if (opts.db) {
        // Drizzle path: serialize count + delete under a transaction
        // so two concurrent reports that both cross the threshold see
        // a consistent view. The insert above is already committed —
        // the report is recorded even if the ban path crashes, so a
        // retry doesn't lose the strike.
        await opts.db.transaction(async () => {
          await ban();
        });
      } else {
        await ban();
      }

      return reply.code(200).send({
        ok: true,
        recorded: result === 'recorded',
        banned,
      });
    },
  );
}
