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
}
