import { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { validateHandle } from '@speakeasy/shared';
import { VouchflowValidationError } from '@speakeasy/vouchflow';
import type { PreKeyBundleInput, UserRepo } from '../db/users.js';

interface EnrollBody {
  token: string;
  /** User-chosen handle (no `@` prefix). Validated against the strict
   * `HANDLE_REGEX` + reserved set; on collision the route returns
   * `409 {error: 'taken'}` so the client can prompt for another. */
  user_id: string;
  publicKey: string; // base64
  preKeyBundle: PreKeyBundleInput;
}

/**
 * Body for `POST /v1/devices/rebind`. Same shape as enroll's body so
 * the client can call rebind with the same payload it just used for
 * enroll. The route distinguishes the recovery path from creation
 * by URL alone.
 */
type RebindBody = EnrollBody;

export async function registerEnrollRoutes(
  app: FastifyInstance,
  opts: {
    repo: UserRepo;
    /** Optional Phase-4 rate-limit preHandler. Subject defaults to req.ip. */
    enrollRateLimit?: preHandlerHookHandler;
    /**
     * Sandbox-only hook: called after a successful mint with the
     * (deviceToken, userId) pair. Lets the in-memory dev validator
     * remember the binding for subsequent verifies. No-op in production
     * — real Vouchflow tracks this binding server-side.
     */
    onUserMinted?: (deviceToken: string, userId: string) => void;
  },
): Promise<void> {
  const { repo } = opts;
  const preHandlers = opts.enrollRateLimit ? [opts.enrollRateLimit] : undefined;

  app.post<{ Body: EnrollBody }>(
    '/v1/enroll',
    {
      ...(preHandlers ? { preHandler: preHandlers } : {}),
      schema: {
        body: {
          type: 'object',
          required: ['token', 'user_id', 'publicKey', 'preKeyBundle'],
          properties: {
            token: { type: 'string', minLength: 1 },
            user_id: { type: 'string', minLength: 3, maxLength: 20 },
            publicKey: { type: 'string', minLength: 1 },
            preKeyBundle: {
              type: 'object',
              required: [
                'registrationId',
                'signedPreKeyId',
                'signedPreKey',
                'signedPreKeySig',
                'preKeys',
              ],
              properties: {
                registrationId: { type: 'integer', minimum: 0 },
                signedPreKeyId: { type: 'integer', minimum: 0 },
                signedPreKey: { type: 'string', minLength: 1 },
                signedPreKeySig: { type: 'string', minLength: 1 },
                preKeys: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['id', 'key'],
                    properties: {
                      id: { type: 'integer', minimum: 0 },
                      key: { type: 'string', minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { token, publicKey, preKeyBundle } = request.body;
      const userId = request.body.user_id.trim().toLowerCase();

      const handleReason = validateHandle(userId);
      if (handleReason === 'invalid') {
        return reply.code(400).send({ error: 'invalid_user_id' });
      }
      if (handleReason === 'reserved') {
        return reply.code(409).send({ error: 'reserved' });
      }

      try {
        await app.vouchflow.validate(token);
      } catch (err) {
        if (err instanceof VouchflowValidationError) {
          return reply.code(401).send({ error: err.reason });
        }
        request.log.error({ err }, 'unexpected vouchflow error during enroll');
        return reply.code(500).send({ error: 'internal' });
      }

      const publicKeyBuf = Buffer.from(publicKey, 'base64');

      const created = await repo.tryCreate({
        userId,
        deviceToken: token,
        publicKey: publicKeyBuf,
        bundle: preKeyBundle,
      });
      if (!created) {
        return reply.code(409).send({ error: 'taken' });
      }

      // Sandbox-only: tell the dev validator about the new binding so
      // subsequent verifies (login, WS auth) recognize the user. No-op
      // in production where real Vouchflow tracks this.
      opts.onUserMinted?.(token, userId);
      return reply.code(201).send({ user_id: userId });
    },
  );

  // ── POST /v1/devices/rebind ─────────────────────────────────────
  //
  // Reclaim an existing handle after a reinstall / Vouchflow token
  // rotation. The classic failure this fixes:
  //   - Server has bananaman3 enrolled with device-token T1.
  //   - Client reinstalls or rotates; new Vouchflow token T2.
  //   - WS auth with T2 fails with `not_enrolled` (T2 has no userId).
  //   - Silent re-enroll calls POST /v1/enroll → 409 `taken`.
  //   - Loop: every reconnect re-hits the same path.
  //
  // The rebind path lets a presenter who can prove BOTH biometric
  // (via Vouchflow.validate(token)) AND identity-key ownership
  // (their persisted Signal publicKey matches what the server has
  // on file) atomically rotate the device-token binding for the
  // existing user. Both proofs are required:
  //
  //   - Vouchflow alone isn't enough: a stolen/rooted device could
  //     pass biometric on someone else's behalf if the user shared
  //     their unlock pattern, and bind their account elsewhere.
  //   - publicKey alone isn't enough: leaked public keys aren't
  //     secret. Combined with biometric, a rebind requires both
  //     the legitimate device-presence AND the on-device Signal
  //     identity, which only the original install holds.
  //
  // 4xx mapping:
  //   - 400 `invalid_user_id`        — handle regex check fails.
  //   - 401 vouchflow reasons        — biometric proof rejected.
  //   - 401 `identity_mismatch`      — publicKey doesn't match.
  //   - 404 `no_such_user`           — handle isn't enrolled (use /v1/enroll).
  app.post<{ Body: RebindBody }>(
    '/v1/devices/rebind',
    {
      // Reuses the same enrollRateLimit as /v1/enroll — both endpoints
      // mint a new server-side device binding so they're equally
      // sensitive to brute-force probing.
      ...(preHandlers ? { preHandler: preHandlers } : {}),
      schema: {
        body: {
          type: 'object',
          required: ['token', 'user_id', 'publicKey', 'preKeyBundle'],
          properties: {
            token: { type: 'string', minLength: 1 },
            user_id: { type: 'string', minLength: 3, maxLength: 20 },
            publicKey: { type: 'string', minLength: 1 },
            preKeyBundle: {
              type: 'object',
              required: [
                'registrationId',
                'signedPreKeyId',
                'signedPreKey',
                'signedPreKeySig',
                'preKeys',
              ],
              properties: {
                registrationId: { type: 'integer', minimum: 0 },
                signedPreKeyId: { type: 'integer', minimum: 0 },
                signedPreKey: { type: 'string', minLength: 1 },
                signedPreKeySig: { type: 'string', minLength: 1 },
                preKeys: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    required: ['id', 'key'],
                    properties: {
                      id: { type: 'integer', minimum: 0 },
                      key: { type: 'string', minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { token, publicKey, preKeyBundle } = request.body;
      const userId = request.body.user_id.trim().toLowerCase();

      const handleReason = validateHandle(userId);
      if (handleReason === 'invalid') {
        return reply.code(400).send({ error: 'invalid_user_id' });
      }
      if (handleReason === 'reserved') {
        // Reserved handles shouldn't have been enrolled in the first
        // place; treat the same as no-such-user from a rebind POV.
        return reply.code(404).send({ error: 'no_such_user' });
      }

      try {
        await app.vouchflow.validate(token);
      } catch (err) {
        if (err instanceof VouchflowValidationError) {
          return reply.code(401).send({ error: err.reason });
        }
        request.log.error({ err }, 'unexpected vouchflow error during rebind');
        return reply.code(500).send({ error: 'internal' });
      }

      const expectedPublicKey = Buffer.from(publicKey, 'base64');
      const outcome = await repo.rebindDevice({
        userId,
        newDeviceToken: token,
        expectedPublicKey,
        bundle: preKeyBundle,
      });
      if (outcome === 'no_such_user') {
        return reply.code(404).send({ error: 'no_such_user' });
      }
      if (outcome === 'identity_mismatch') {
        return reply.code(401).send({ error: 'identity_mismatch' });
      }

      // Sandbox: refresh the dev validator's (token → userId)
      // binding to reflect the rotation. Production Vouchflow
      // tracks its own state independently.
      opts.onUserMinted?.(token, userId);
      return reply.code(200).send({ user_id: userId });
    },
  );
}
