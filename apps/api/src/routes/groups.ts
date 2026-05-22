import { FastifyInstance } from 'fastify';
import { isUserId, newGroupId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { GroupRepo } from '../db/groups.js';

interface AddMemberBody {
  user_id: string;
}
interface SetNameBody {
  name: string;
}
interface IdParam {
  id: string;
}

const GROUP_NAME_MAX = 64;

function normalizeGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX) return undefined;
  return trimmed;
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
  app.post<{ Body: { name?: string } | undefined }>(
    '/v1/groups',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(403).send({ error: 'not_enrolled' });
      const groupId = generateId();
      // Legacy clients omit the body entirely; rc.48 clients pass
      // `{ name }`. No JSON-schema validation here so empty-body
      // requests still parse — the route just shrugs and treats name
      // as undefined. We do bound the length manually below.
      const rawName =
        typeof request.body === 'object' && request.body !== null
          ? (request.body as { name?: unknown }).name
          : undefined;
      const name = normalizeGroupName(rawName);
      try {
        await opts.repo.create({ groupId, createdBy: userId, name });
      } catch (err) {
        request.log.error({ err, groupId }, 'group create failed');
        return reply.code(500).send({ error: 'internal' });
      }
      return reply.code(201).send({ group_id: groupId });
    },
  );

  /**
   * PUT /v1/groups/:id/name — creator updates the room name.
   * Members fetch the authoritative name through GET /v1/groups/:id.
   */
  app.put<{ Params: IdParam; Body: SetNameBody }>(
    '/v1/groups/:id/name',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: GROUP_NAME_MAX } },
        },
      },
    },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: groupId } = request.params;
      const name = normalizeGroupName(request.body.name);
      if (!name) return reply.code(400).send({ error: 'invalid_name' });
      const summary = await opts.repo.findById(groupId);
      if (!summary) return reply.code(404).send({ error: 'group_missing' });
      if (summary.createdBy !== callerId) {
        return reply.code(403).send({ error: 'not_creator' });
      }
      const updated = await opts.repo.setName({ groupId, name });
      if (updated === 'group_missing') {
        return reply.code(404).send({ error: 'group_missing' });
      }
      return reply.send({
        id: updated.id,
        created_by: updated.createdBy,
        name: updated.name,
      });
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
   * GET /v1/groups/:id/members — list every member in the group.
   * Members-only (the same privacy rationale as the metadata endpoint:
   * non-members shouldn't be able to enumerate the roster).
   */
  app.get<{ Params: IdParam }>(
    '/v1/groups/:id/members',
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
      const members = await opts.repo.listMembers(groupId);
      return reply.send({ members, created_by: summary.createdBy });
    },
  );

  /**
   * DELETE /v1/groups/:id/members/:userId — remove a member. Only the
   * creator may evict; the creator themselves cannot be removed via
   * this route (`cannot_remove_creator`). The repo is the source of
   * truth on membership/auth state — we surface its result codes back
   * to the client one-to-one.
   */
  app.delete<{ Params: { id: string; userId: string } }>(
    '/v1/groups/:id/members/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: groupId, userId: target } = request.params;
      const summary = await opts.repo.findById(groupId);
      if (!summary) return reply.code(404).send({ error: 'group_missing' });
      if (summary.createdBy !== callerId) {
        return reply.code(403).send({ error: 'not_creator' });
      }
      const result = await opts.repo.removeMember({ groupId, userId: target });
      if (result === 'group_missing') {
        return reply.code(404).send({ error: 'group_missing' });
      }
      if (result === 'not_member') {
        return reply.code(404).send({ error: 'not_member' });
      }
      if (result === 'cannot_remove_creator') {
        return reply.code(409).send({ error: 'cannot_remove_creator' });
      }
      return reply.send({ members: result });
    },
  );

  /**
   * POST /v1/groups/:id/leave — caller voluntarily leaves the room.
   * If the creator leaves, the creator role passes to the oldest
   * remaining member. If no members remain, the room is deleted.
   */
  app.post<{ Params: IdParam }>(
    '/v1/groups/:id/leave',
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth?.userId;
      if (!callerId) return reply.code(403).send({ error: 'not_enrolled' });
      const { id: groupId } = request.params;
      const result = await opts.repo.leaveMember({ groupId, userId: callerId });
      if (result === 'group_missing') {
        return reply.code(404).send({ error: 'group_missing' });
      }
      if (result === 'not_member') {
        return reply.code(403).send({ error: 'not_member' });
      }
      return reply.send({
        members: result.members,
        created_by: result.createdBy,
        deleted: result.deleted,
      });
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
        name: summary.name,
      });
    },
  );

  // PUT /v1/groups/:id/avatar dropped in Phase 2 — groups don't have
  // photos OR custom marks. The mobile client renders the
  // deterministic geometric room mark from the group id (see
  // `apps/mobile/src/avatars/RoomMark.tsx`). Per AVATAR-SYSTEM.md §7:
  // customization here would create the social-signaling pressure
  // ("our group has the cool icon") the no-identity ethos rejects.
}
