import type { FastifyInstance } from 'fastify';
import { newFeedbackId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import { getDb } from '../db/client.js';
import { feedback } from '../db/schema.js';

interface Body {
  text: string;
  /** Optional. App version at time of report (e.g. '0.5.0-rc.38'). */
  app_version?: string;
}

const MAX_TEXT = 4000;

/**
 * POST /v1/feedback — capture user-submitted feedback addressed to the
 * `@feedback` handle on the mobile client. Plaintext on purpose
 * (NOT E2E): user is opting in to share with the dev team. Vouchflow-
 * authed so we know which user filed the report.
 *
 * The chat UI on mobile shows a banner above the @feedback conversation
 * making the not-E2E nature explicit.
 */
export async function registerFeedbackRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body: Body }>(
    '/v1/feedback',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
            app_version: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      const db = getDb();
      await db.insert(feedback).values({
        id: newFeedbackId(),
        senderUserId: userId,
        appVersion: request.body.app_version ?? null,
        text: request.body.text,
      });
      return reply.code(200).send({ ok: true });
    },
  );
}
