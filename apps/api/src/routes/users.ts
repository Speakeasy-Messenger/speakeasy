import { FastifyInstance } from 'fastify';
import { isUserId, KNOWN_CALL_KINDS, type CallKind } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { UserRepo } from '../db/users.js';
import type { DevicesRepo } from '../db/devices.js';
import type { Connections } from '../ws/connections.js';
import type { DeletedHandlesRepo } from '../db/deleted-handles.js';

interface Params {
  id: string;
}

/**
 * Server-known animal ids. Mobile clients render the matching SVG;
 * unknown ids cause the client to fall back to a deterministic-from-
 * userId default. Centralized here so that:
 *   - The PUT route can reject ids the launch set doesn't include
 *     (typo guard, prevents a peer setting `selected_avatar_id =
 *     "i-am-an-elephant"` and breaking other clients' renders).
 *   - When we add a new animal in v2 we update this list and ship a
 *     new server build; old clients gracefully fall back rather than
 *     showing a black tile.
 */
/**
 * Canonical set lives in `apps/mobile/src/avatars/catalog.ts`. We
 * duplicate the ids here as a typo-guard only — server doesn't gate
 * ownership of paid avatars (RevenueCat does that on the client at
 * purchase time). Keep this list in sync when CATALOG changes;
 * rc.6 expanded it from 12 free animals to 12 free + 12 rare + 4
 * legendary, and renamed `raven` (free) → `pigeon`.
 */
const KNOWN_ANIMAL_IDS = new Set([
  // free 12
  'fox',
  'owl',
  'pigeon',
  'hare',
  'stag',
  'whale',
  'moth',
  'octopus',
  'heron',
  'bear',
  'cat',
  'bat',
  // rare 12
  'lynx',
  'koi',
  'raven',
  'frog',
  'snake',
  'peacock',
  'hawk',
  'squirrel',
  'crab',
  'beetle',
  'anglerfish',
  'seahorse',
  // legendary 4
  'dragon',
  'phoenix',
  'turtle',
  'manticore',
]);

interface AvatarBody {
  /** Animal id from the launch set, or null to clear. */
  animal_id: string | null;
}

/**
 * GET /v1/users/:id — public-key + existence + selected animal lookup.
 * Vouchflow-gated to mitigate enumeration attacks; only authenticated
 * callers can probe.
 *
 * PUT /v1/users/me/avatar — set or clear the caller's selected animal.
 *
 * AVATAR-SYSTEM.md §8 sunset note: this endpoint previously accepted a
 * `avatar_b64` JPEG payload. It now accepts an `animal_id` string from
 * the launch set. Server doesn't store JPEGs at all — `users.avatar_b64`
 * was dropped in migration 0009.
 */
export async function registerUserRoutes(
  app: FastifyInstance,
  opts: {
    repo: UserRepo;
    /**
     * Optional Phase 5j dependencies. When present, `GET /v1/users/:id`
     * returns `supported_call_kinds: string[]` — the UNION of live
     * device capabilities (in-memory connections) with a fallback to
     * persisted DB values when the user has no live sockets. Older
     * tests that don't init WS pass neither and the field is omitted.
     */
    devices?: DevicesRepo;
    connections?: Connections;
    /**
     * Tombstone for handles deleted via `DELETE /v1/users/me`. When
     * provided, `GET /v1/users/:id` returns 410 Gone for a handle in
     * the tombstone set (instead of 404 = never existed). Optional so
     * older test harnesses that don't init the repo keep returning
     * plain 404.
     */
    deletedHandles?: DeletedHandlesRepo;
  },
): Promise<void> {
  app.get<{ Params: Params }>(
    '/v1/users/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;
      if (!isUserId(id)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const u = await opts.repo.findById(id);
      if (!u) {
        // Distinguish "deleted" from "never existed" so the mobile
        // client can render an in-chat "@<handle>'s account was
        // deleted" system message instead of a generic "user not
        // found" toast.
        if (opts.deletedHandles && (await opts.deletedHandles.isDeleted(id))) {
          return reply.code(410).send({ error: 'user_deleted' });
        }
        return reply.code(404).send({ error: 'not_found' });
      }
      let supportedCallKinds = await aggregateCallKinds(id, opts);
      // "Refuse video calls" (#13): hide 'video' from this peer's
      // advertised kinds so the caller's sheet never shows the Video row.
      // The call-router enforces the real rejection (this is cosmetic /
      // pre-flight); a stale caller is still rejected server-side.
      if (supportedCallKinds && u.refuseVideo) {
        supportedCallKinds = supportedCallKinds.filter((k) => k !== 'video');
      }
      return reply.send({
        id: u.id,
        public_key: u.publicKey.toString('base64'),
        created_at: u.createdAt.toISOString(),
        selected_avatar_id: u.selectedAvatarId ?? null,
        ...(supportedCallKinds && { supported_call_kinds: supportedCallKinds }),
      });
    },
  );

  /**
   * GET /v1/users/me — identity recovery. Returns the user bound to
   * the caller's Vouchflow deviceToken, or 404 if no user has been
   * enrolled with this device. Mobile uses this on fresh-install
   * cold start: if Vouchflow attestation succeeds and the server
   * recognizes the deviceToken, the client restores identity locally
   * and skips onboarding entirely. The previous behavior forced a
   * new handle on every reinstall, which lost @-handles permanently
   * (the original userId still existed server-side, just orphaned).
   */
  app.get(
    '/v1/users/me',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(404).send({ error: 'not_enrolled' });
      const u = await opts.repo.findById(userId);
      if (!u) return reply.code(404).send({ error: 'not_found' });
      return reply.send({
        id: u.id,
        public_key: u.publicKey.toString('base64'),
        created_at: u.createdAt.toISOString(),
        selected_avatar_id: u.selectedAvatarId ?? null,
        refuse_video: u.refuseVideo ?? false,
      });
    },
  );

  /**
   * PUT /v1/users/me/refuse-video — set the per-user "Refuse video calls"
   * privacy flag (#13). When on, the call-router rejects inbound video
   * offers before ringing (caller gets `video_refused`), and this user's
   * `/v1/users/:id` aggregation drops 'video' from supported_call_kinds.
   */
  app.put<{ Body: { refuse: boolean } }>(
    '/v1/users/me/refuse-video',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['refuse'],
          properties: { refuse: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'not_enrolled' });
      await opts.repo.setRefuseVideo(userId, request.body.refuse);
      return reply.code(204).send();
    },
  );

  app.put<{ Body: AvatarBody }>(
    '/v1/users/me/avatar',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['animal_id'],
          properties: {
            animal_id: {
              // Bounded length, but the real validation is the
              // launch-set check below — the schema only protects us
              // against junk strings.
              type: ['string', 'null'],
              maxLength: 32,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'not_enrolled' });
      const raw = request.body.animal_id;
      if (raw !== null && !KNOWN_ANIMAL_IDS.has(raw)) {
        return reply.code(400).send({ error: 'unknown_animal_id' });
      }
      await opts.repo.setSelectedAvatar(userId, raw ?? undefined);
      return reply.code(204).send();
    },
  );

  /**
   * DELETE /v1/users/me — permanently delete the caller's account and
   * everything tied to them (devices, prekeys, memberships, buffered
   * messages, groups/communities they created). Frees the handle for
   * reuse. Backs the mobile Delete Account screen.
   */
  app.delete(
    '/v1/users/me',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'not_enrolled' });
      await opts.repo.deleteUser(userId);
      // Tombstone the handle for the peer-deleted notification path.
      // Sequenced AFTER deleteUser intentionally: if the user-delete
      // throws (FK cascade trips, etc.) we don't want a stale
      // tombstone for a handle that wasn't actually deleted. The
      // tombstone-then-delete race the other direction (handle in
      // tombstone before user row is fully gone) is fine — `findById`
      // is still resolving and the small window just yields the same
      // not-found-with-tombstone result the steady state has.
      if (opts.deletedHandles) {
        await opts.deletedHandles.record(userId);
      }
      request.log.info({ audit: 'account_deleted', userId }, 'account deleted');
      return reply.code(200).send({ ok: true });
    },
  );
}

/**
 * Phase 5j (Private Call) — `supported_call_kinds` aggregation for
 * `GET /v1/users/:id`. Live in-memory connections win; persisted
 * `devices.supported_call_kinds` is the fallback when the user has no
 * live sockets. Returns `undefined` when neither dep is available
 * (older test setups) so the response field is simply omitted.
 *
 * UNION semantics: a user with two devices reporting `['audio','video']`
 * and `['audio','video','private']` advertises `['audio','video','private']`.
 * Server-side fan-out (call-router) still filters per-device at send
 * time, so UNION is safe to expose to the caller as "this peer can
 * answer Private somewhere."
 */
async function aggregateCallKinds(
  userId: string,
  opts: { devices?: DevicesRepo; connections?: Connections },
): Promise<string[] | undefined> {
  if (!opts.connections && !opts.devices) return undefined;
  // Live first.
  if (opts.connections) {
    const live = opts.connections.getCapabilitiesUnion(userId);
    if (live.length > 0) return live;
  }
  // Fall back to persisted.
  if (opts.devices) {
    const rows = await opts.devices.listForUser(userId);
    const union = new Set<CallKind>();
    for (const row of rows) {
      for (const k of row.supportedCallKinds ?? []) {
        if (KNOWN_CALL_KINDS.has(k as CallKind)) union.add(k as CallKind);
      }
    }
    if (union.size > 0) return [...union];
  }
  // No data at all (user exists but never connected since 0018 migration).
  // Return empty array so the caller can distinguish "field is unknown"
  // from "we know they support nothing" — empty array means we have a
  // user row but no device-level info.
  return [];
}
