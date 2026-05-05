import { FastifyInstance } from 'fastify';
import { isUserId, newGroupId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { GroupRepo } from '../db/groups.js';

interface AddMemberBody {
  user_id: string;
}
interface IdParam {
  id: string;
}
interface AvatarBody {
  /** base64 JPEG, or null to clear. Same 200KB cap as user avatars. */
  avatar_b64: string | null;
}

const MAX_AVATAR_B64_LENGTH = 200_000;

export async function registerGroupRoutes(
  app: FastifyInstance,
  opts: { repo: GroupRepo; generateGroupId?: () => string },
): Promise<void> {
  const generateId = opts.generateGroupId ?? newGroupId;

  /**
   * POST /v1/groups — create a small-group conversation. Caller becomes the
   * first member. Spec §6: groups are 3–100; we don't enforce the 3-floor at
   * creation (a 1-member "group" is just an empty room). 100-ceiling is
   * enforced on add.
   */
  app.post(
    '/v1/groups',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(403).send({ error: 'not_enrolled' });
      const groupId = generateId();
      try {
        await opts.repo.create({ groupId, createdBy: userId });
      } catch (err) {
        request.log.error({ err, groupId }, 'group create failed');
        return reply.code(500).send({ error: 'internal' });
      }
      return reply.code(201).send({ group_id: groupId });
    },
  );

  /**
   * POST /v1/groups/:id/members — add a user. Caller must already be a
   * member (server doesn't trust an arbitrary outsider to add). Returns
   * the new member count or an error code.
   */
  app.post<{ Params: IdParam; Body: AddMemberBody }>(
    '/v1/groups/:id/members',
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
      const { id: groupId } = request.params;
      const { user_id: target } = request.body;
      if (!isUserId(target)) return reply.code(400).send({ error: 'invalid_id' });

      const result = await opts.repo.addMember({
        groupId,
        userId: target,
        addedBy: callerId,
      });
      if (result === 'group_missing') {
        return reply.code(404).send({ error: 'group_missing' });
      }
      if (result === 'not_member') {
        return reply.code(403).send({ error: 'not_member' });
      }
      if (result === 'group_full') {
        return reply.code(409).send({ error: 'group_full' });
      }
      return reply.code(201).send({ members: result });
    },
  );

  /**
   * GET /v1/groups/:id — fetch group metadata (creator + avatar).
   * Members-only; an outsider doesn't get to probe whether a group
   * exists or sniff its avatar.
   */
  app.get<{ Params: IdParam }>(
    '/v1/groups/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: groupId } = request.params;
      const summary = await opts.repo.findById(groupId);
      if (!summary) return reply.code(404).send({ error: 'group_missing' });
      if (!(await opts.repo.isMember(groupId, callerId))) {
        return reply.code(403).send({ error: 'not_member' });
      }
      return reply.send({
        id: summary.id,
        created_by: summary.createdBy,
        avatar_b64: summary.avatarB64 ?? null,
      });
    },
  );

  /**
   * PUT /v1/groups/:id/avatar — set or clear the group's photo. Only
   * the creator can change it (matches the user's ask). The body is
   * the base64 JPEG, or `null` / empty to clear.
   */
  app.put<{ Params: IdParam; Body: AvatarBody }>(
    '/v1/groups/:id/avatar',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['avatar_b64'],
          properties: {
            avatar_b64: {
              type: ['string', 'null'],
              maxLength: MAX_AVATAR_B64_LENGTH,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: groupId } = request.params;
      const summary = await opts.repo.findById(groupId);
      if (!summary) return reply.code(404).send({ error: 'group_missing' });
      if (summary.createdBy !== callerId) {
        return reply.code(403).send({ error: 'not_creator' });
      }
      const raw = request.body.avatar_b64;
      const next = raw && raw.length > 0 ? raw : undefined;
      await opts.repo.setAvatar(groupId, next);
      return reply.code(204).send();
    },
  );
}
