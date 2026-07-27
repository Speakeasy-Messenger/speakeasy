import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/vouchflow.js';
import type { DiagEntry, DiagUploadsRepo } from '../db/diag.js';

interface Body {
  entries: unknown[];
  appVersion: string;
  reason: string;
  callId?: string;
}

/** Hard cap on entries — the client buffer is 200; allow slack, reject abuse. */
const MAX_ENTRIES = 500;
/** Route-level body cap. Redacted metadata is small; 512 KiB is generous. */
const BODY_LIMIT_BYTES = 512 * 1024;
const MAX_VERSION_LEN = 64;
const MAX_REASON_LEN = 64;
const MAX_CALL_ID_LEN = 128;

/**
 * Keep only the known `DiagEntry` keys. Defense-in-depth: the client
 * buffer is already redacted (mobile `diag/log.ts`), but stripping to the
 * known shape here means a future/rogue client can't smuggle a plaintext
 * field (e.g. a raw handle or message body) into storage by adding keys.
 * Entries missing a well-typed t/tag/msg are dropped entirely.
 */
function scrubEntries(raw: unknown[]): DiagEntry[] {
  const out: DiagEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.t !== 'number' || typeof e.tag !== 'string' || typeof e.msg !== 'string') {
      continue;
    }
    const entry: DiagEntry = { t: e.t, tag: e.tag, msg: e.msg };
    if (e.ctx !== null && typeof e.ctx === 'object' && !Array.isArray(e.ctx)) {
      entry.ctx = e.ctx as Record<string, unknown>;
    }
    out.push(entry);
  }
  return out;
}

/**
 * `POST /v1/diag` — beta-only diagnostic log upload. Vouchflow-gated.
 * Stores the client's already-redacted diag ring buffer so we stop asking
 * testers to copy-paste logs. Keyed by `callId` so both sides of a failed
 * call correlate. Rejects non-beta (`appVersion` without "-rc.") with 403
 * so GA clients can never write here.
 */
export async function registerDiagRoute(
  app: FastifyInstance,
  opts: { repo: DiagUploadsRepo },
): Promise<void> {
  app.post<{ Body: Body }>(
    '/v1/diag',
    {
      preHandler: [requireAuth],
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['entries', 'appVersion', 'reason'],
          properties: {
            entries: { type: 'array', maxItems: MAX_ENTRIES, items: { type: 'object' } },
            appVersion: { type: 'string', minLength: 1, maxLength: MAX_VERSION_LEN },
            reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LEN },
            callId: { type: 'string', maxLength: MAX_CALL_ID_LEN },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      // Beta-only: GA clients (no "-rc.") can't write diagnostics even if
      // they hit the endpoint. Mirrors the client-side gate in diag/upload.ts.
      if (!request.body.appVersion.includes('-rc.')) {
        return reply.code(403).send({ error: 'not_beta' });
      }
      const entries = scrubEntries(request.body.entries);
      await opts.repo.insert({
        userId,
        callId: request.body.callId,
        appVersion: request.body.appVersion,
        reason: request.body.reason,
        entries,
      });
      return reply.code(200).send({ ok: true, stored: entries.length });
    },
  );
}
