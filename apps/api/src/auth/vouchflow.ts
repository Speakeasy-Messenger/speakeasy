import fp from 'fastify-plugin';
import {
  Confidence,
  Validator,
  VouchflowValidationError,
} from '@speakeasy/vouchflow';
import type { UserRepo } from '../db/users.js';
import { redactToken } from '../log/redact.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Configured Vouchflow validator. */
    vouchflow: Validator;
    /**
     * Used by `requireAuth` to resolve `deviceToken → userId` when the
     * validator's `ValidatedAttestation.userId` is absent (real
     * Vouchflow doesn't track our internal id; we own that binding).
     */
    userRepo: UserRepo;
  }
  interface FastifyRequest {
    /** Set by `requireAuth`. Absent on unauthenticated routes. */
    auth?: {
      userId?: string;
      deviceToken: string;
      confidence: Confidence;
      token: string;
      riskScore: number;
      anomalyFlags: string[];
    };
  }
}

interface Options {
  validator: Validator;
  userRepo: UserRepo;
}

/**
 * Registers the validator + user repo on the Fastify instance and
 * exposes a `requireAuth` preHandler. Routes opt in by adding it to
 * their preHandler chain — there is no global gate so /healthz and
 * /v1/enroll stay open.
 */
export const vouchflowPlugin = fp<Options>(async (app, opts) => {
  app.decorate('vouchflow', opts.validator);
  app.decorate('userRepo', opts.userRepo);
});

/**
 * Fastify preHandler. Reads `Authorization: Bearer <token>`, validates via
 * Vouchflow, hard-rejects below medium confidence (spec §2: no override),
 * and attaches the validated payload to `request.auth`.
 */
export async function requireAuth(
  this: import('fastify').FastifyInstance,
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'missing_bearer_token' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return reply.code(401).send({ error: 'missing_bearer_token' });
  }

  try {
    const v = await this.vouchflow.validate(token);
    // Real Vouchflow's ValidatedAttestation has no userId field — Vouchflow
    // tracks attestation/risk/age, not our internal Speakeasy id. The mock
    // dev-validator does carry it (set via the enroll route's onUserMinted
    // hook). When the validator returns no userId, fall back to our own
    // user repo's deviceToken→userId index, which the enroll route has
    // populated.
    let userId = v.userId;
    if (!userId) {
      userId = await this.userRepo.findUserIdByDeviceToken(v.deviceToken);
    }
    request.auth = {
      userId,
      deviceToken: v.deviceToken,
      confidence: v.confidence,
      token: v.token,
      riskScore: v.riskScore,
      anomalyFlags: v.anomalyFlags,
    };
    if (v.anomalyFlags.length > 0) {
      request.log.warn(
        { userId, deviceToken: redactToken(v.deviceToken), anomalyFlags: v.anomalyFlags },
        'vouchflow anomaly flags present',
      );
    }
  } catch (err) {
    if (err instanceof VouchflowValidationError) {
      return reply.code(401).send({ error: err.reason });
    }
    request.log.error({ err }, 'unexpected vouchflow validation error');
    return reply.code(500).send({ error: 'internal' });
  }
}
