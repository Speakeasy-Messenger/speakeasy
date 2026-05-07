import { FastifyInstance } from 'fastify';
import { isUserId, newCommunityId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { CommunityRepo } from '../db/communities.js';
import { rateLimit } from '../ratelimit/middleware.js';
import type { RateLimiter } from '../ratelimit/ratelimit.js';
import type { UserNotifier } from '../ws/user-notifier.js';
import { NoopUserNotifier } from '../ws/user-notifier.js';

interface CreateBody {
  ttl_days?: number;
}
interface AddMemberBody {
  user_id: string;
}
interface RemoveMemberParams {
  id: string;
  user_id: string;
}
interface EnvelopeBody {
  recipient_user_id: string;
  /** base64 — channel key wrapped for `recipient_user_id`. */
  wrapped_key: string;
  /** Defaults to 1 if omitted. Bump on rotation per spec §4b. */
  key_epoch?: number;
}
interface IdParam {
  id: string;
}

/**
 * Phase 2 community endpoints — spec §4b + §11.
 *
 *   POST /v1/communities                    — create (caller becomes moderator)
 *   POST /v1/communities/:id/members        — add member (caller must be a member)
 *   POST /v1/communities/:id/envelopes      — upload a wrapped channel-key envelope
 *   GET  /v1/communities/:id/key            — fetch caller's own envelope
 *
 * All Vouchflow-gated; the `requireAuth` middleware enforces the
 * spec §2 confidence floor.
 */
export async function registerCommunityRoutes(
  app: FastifyInstance,
  opts: {
    repo: CommunityRepo;
    generateCommunityId?: () => string;
    limiter?: RateLimiter;
    /**
     * Push the `channel_key_rotation_required` signal to remaining
     * members on member-remove. Defaults to no-op for tests that
     * exercise the route without a WS layer.
     */
    notifier?: UserNotifier;
  },
): Promise<void> {
  const generateId = opts.generateCommunityId ?? newCommunityId;
  const notifier = opts.notifier ?? new NoopUserNotifier();
  const rateLimitEnvelopes = opts.limiter
    ? [
        rateLimit({
          limiter: opts.limiter,
          endpoint: 'communities.envelopes',
          limit: 100,
          windowMs: 60_000,
        }),
      ]
    : [];

  app.post<{ Body: CreateBody }>(
    '/v1/communities',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          // Spec §13 decision (Phase 5g): community message TTL is
          // moderator-configurable from 1 day up to 1 year (365),
          // default 7. Communities have legitimate retention needs
          // beyond 7 days (e.g. a "decisions log" channel) that the
          // 1:1 ephemeral default doesn't apply to. 1 year is the
          // ceiling — preserves "ephemeral on a long arc" without
          // letting moderators set effectively-permanent retention
          // (the prior 3650-day cap was 10 years, which isn't
          // ephemeral by any reasonable reading).
          properties: { ttl_days: { type: 'integer', minimum: 1, maximum: 365 } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(403).send({ error: 'not_enrolled' });
      const communityId = generateId();
      try {
        await opts.repo.create({
          communityId,
          createdBy: userId,
          ttlDays: request.body?.ttl_days,
        });
      } catch (err) {
        request.log.error({ err, communityId }, 'community create failed');
        return reply.code(500).send({ error: 'internal' });
      }
      return reply.code(201).send({ community_id: communityId });
    },
  );

  app.post<{ Params: IdParam; Body: AddMemberBody }>(
    '/v1/communities/:id/members',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['user_id'],
          properties: { user_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: communityId } = request.params;
      const { user_id: target } = request.body;
      if (!isUserId(target)) return reply.code(400).send({ error: 'invalid_id' });

      const result = await opts.repo.addMember({
        communityId,
        userId: target,
        addedBy: callerId,
      });
      if (result === 'community_missing') {
        return reply.code(404).send({ error: 'community_missing' });
      }
      if (result === 'not_member') {
        return reply.code(403).send({ error: 'not_member' });
      }
      return reply.code(201).send({});
    },
  );

  /**
   * DELETE /v1/communities/:id/members/:user_id — remove a member.
   *
   * Authorization rules:
   *   - The caller must be a moderator of `:id`, OR
   *   - The caller is removing themselves (`:user_id === auth.userId`).
   *
   * On success, every remaining member's live socket receives a
   * `channel_key_rotation_required` frame so the mobile orchestrator
   * can rotate K (spec §4b: revocation guarantee — the leaver's K is
   * still on their device but is useless for messages encrypted with
   * the new K). The leaver's own envelopes for this community remain
   * in the table; they are never queried again because `getLatestEnvelope`
   * is gated on `isMember`.
   */
  app.delete<{ Params: RemoveMemberParams }>(
    '/v1/communities/:id/members/:user_id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: communityId, user_id: target } = request.params;
      if (!isUserId(target)) return reply.code(400).send({ error: 'invalid_id' });

      // Authz: moderator can remove anyone; anyone can remove self.
      const removingSelf = target === callerId;
      if (!removingSelf) {
        if (!(await opts.repo.isModerator(communityId, callerId))) {
          return reply.code(403).send({ error: 'not_moderator' });
        }
      }

      const result = await opts.repo.removeMember({
        communityId,
        userId: target,
      });
      if (result === 'community_missing') {
        return reply.code(404).send({ error: 'community_missing' });
      }
      if (result === 'not_a_member') {
        return reply.code(404).send({ error: 'not_a_member' });
      }

      // Notify remaining members so their devices can rotate K.
      // Best-effort: notifier is per-user fan-out to live sockets;
      // members offline at this moment will catch the rotation when
      // they next call `GET /v1/communities/:id/key` (the latest-epoch
      // envelope wins) — assuming a remaining member has uploaded
      // fresh envelopes by then.
      for (const memberId of result.remaining) {
        notifier.notify(memberId, {
          type: 'channel_key_rotation_required',
          community_id: communityId,
          reason: 'member_removed',
        });
      }
      request.log.info(
        {
          audit: 'community_member_removed',
          communityId,
          removedBy: callerId,
          removed: target,
          remainingCount: result.remaining.length,
        },
        'community member removed; rotation signal fanned out',
      );
      return reply.code(200).send({ remaining_members: result.remaining.length });
    },
  );

  app.post<{ Params: IdParam; Body: EnvelopeBody }>(
    '/v1/communities/:id/envelopes',
    {
      preHandler: [requireAuth, ...rateLimitEnvelopes],
      schema: {
        body: {
          type: 'object',
          required: ['recipient_user_id', 'wrapped_key'],
          properties: {
            recipient_user_id: { type: 'string', minLength: 1 },
            wrapped_key: { type: 'string', minLength: 1 },
            key_epoch: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: communityId } = request.params;
      const { recipient_user_id, wrapped_key, key_epoch = 1 } = request.body;
      if (!isUserId(recipient_user_id)) {
        return reply.code(400).send({ error: 'invalid_recipient_id' });
      }

      // Caller must be a member to wrap-and-share. Recipient must also be
      // a member (envelope for a non-member is a no-op leak).
      if (!(await opts.repo.isMember(communityId, callerId))) {
        return reply.code(403).send({ error: 'not_member' });
      }
      if (!(await opts.repo.isMember(communityId, recipient_user_id))) {
        return reply.code(404).send({ error: 'recipient_not_member' });
      }

      try {
        await opts.repo.putEnvelope({
          communityId,
          recipientUserId: recipient_user_id,
          wrappedKey: Buffer.from(wrapped_key, 'base64'),
          // Phase 4 security pass: `wrapped_by_user_id` is always taken
          // from `auth.userId` here — there is no way for a caller to
          // spoof a different wrapper. Logged as a structured audit
          // entry so security can trace key handoffs end-to-end.
          wrappedByUserId: callerId,
          keyEpoch: key_epoch,
        });
        request.log.info(
          {
            audit: 'envelope_upload',
            communityId,
            wrappedBy: callerId,
            recipient: recipient_user_id,
            keyEpoch: key_epoch,
          },
          'channel-key envelope uploaded',
        );
      } catch (err) {
        request.log.error({ err }, 'putEnvelope failed');
        return reply.code(500).send({ error: 'internal' });
      }
      return reply.code(201).send({ key_epoch });
    },
  );

  app.get<{ Params: IdParam }>(
    '/v1/communities/:id/key',
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: communityId } = request.params;

      if (!(await opts.repo.isMember(communityId, callerId))) {
        return reply.code(403).send({ error: 'not_member' });
      }
      const env = await opts.repo.getLatestEnvelope(communityId, callerId);
      if (!env) return reply.code(404).send({ error: 'no_envelope' });
      return reply.send({
        community_id: env.communityId,
        recipient_user_id: env.recipientUserId,
        wrapped_key: env.wrappedKey.toString('base64'),
        wrapped_by_user_id: env.wrappedByUserId,
        key_epoch: env.keyEpoch,
        created_at: env.createdAt.toISOString(),
      });
    },
  );
}
