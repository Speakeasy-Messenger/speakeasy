import Fastify, { FastifyInstance } from 'fastify';
import {
  MockValidator,
  Validator,
  VouchflowApiClient,
  VouchflowValidator,
} from '@speakeasy/vouchflow';
import { LocalDevValidator } from './auth/local-dev-validator.js';
import { vouchflowPlugin } from './auth/vouchflow.js';
import { DrizzleUserRepo } from './db/users.drizzle.js';
import { InMemoryUserRepo } from './db/users.memory.js';
import type { UserRepo } from './db/users.js';
import { InMemoryPreKeyRepo } from './db/prekeys.memory.js';
import { DrizzlePreKeyRepo } from './db/prekeys.drizzle.js';
import { DrizzleGroupRepo } from './db/groups.drizzle.js';
import { DrizzleCommunityRepo } from './db/communities.drizzle.js';
import { DrizzleMessagesRepo } from './db/messages.drizzle.js';
import { DrizzleDevicesRepo } from './db/devices.drizzle.js';
import { registerEnrollRoutes } from './routes/enroll.js';
import { registerUserRoutes } from './routes/users.js';
import { registerPreKeyRoutes } from './routes/prekeys.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerCommunityRoutes } from './routes/communities.js';
import type { PreKeyRepo } from './db/prekeys.js';
import type { GroupRepo } from './db/groups.js';
import type { CommunityRepo } from './db/communities.js';
import { attachWebsocket } from './ws/server.js';
import { InMemoryConnections, type Connections } from './ws/connections.js';
import {
  LocalUserNotifier,
  NoopUserNotifier,
  type UserNotifier,
} from './ws/user-notifier.js';
import { InMemoryPresence } from './presence/memory.js';
import { RedisPresence } from './presence/redis.js';
import type { Presence } from './presence/presence.js';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { InMemoryMessagesRepo } from './db/messages.memory.js';
import { InMemoryGroupRepo } from './db/groups.memory.js';
import { InMemoryCommunityRepo } from './db/communities.memory.js';
import type { MessagesRepo } from './db/messages.js';
import { InMemoryRateLimiter, type RateLimiter } from './ratelimit/ratelimit.js';
import { RedisRateLimiter } from './ratelimit/redis.js';
import { rateLimit } from './ratelimit/middleware.js';
import { InMemoryAckRouter, type AckRouter } from './ws/ack-router.js';
import { RedisAckRouter } from './ws/ack-router.redis.js';
import { RedisUserNotifier } from './ws/user-notifier.redis.js';
import { NoopPushProvider, type PushProvider } from './push/push.js';
import { FcmApnsPushProvider } from './push/push.fcm-apns.js';
import { InMemoryDevicesRepo } from './db/devices.memory.js';
import type { DevicesRepo } from './db/devices.js';
import { registerDeviceRoutes } from './routes/devices.js';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

export interface BuildServerOptions {
  validator?: Validator;
  userRepo?: UserRepo;
  preKeyRepo?: PreKeyRepo;
  groupRepo?: GroupRepo;
  communityRepo?: CommunityRepo;
  messagesRepo?: MessagesRepo;
  rateLimiter?: RateLimiter;
  ackRouter?: AckRouter;
  push?: PushProvider;
  devicesRepo?: DevicesRepo;
  connections?: Connections;
  presence?: Presence;
  /** Override the in-process notifier used by route handlers (test injection). */
  userNotifier?: UserNotifier;
  /** Server instance id used as the value of `session:{user_id}` in Redis. */
  instanceId?: string;
  logger?: boolean | { level: string };
  /** Override id generator for deterministic tests. */
  generateId?: () => string;
  /** Skip mounting the WebSocket server (useful for unit tests of REST routes). */
  skipWebsocket?: boolean;
}

function defaultValidator(log: import('fastify').FastifyBaseLogger): Validator {
  if (process.env.VOUCHFLOW_USE_MOCK === '1') {
    log.warn(
      'VOUCHFLOW_USE_MOCK=1 — using LocalDevValidator (persisted to file). ' +
        'Never set this in production.',
    );
    return new LocalDevValidator();
  }
  const readKey = process.env.VOUCHFLOW_READ_KEY;
  const baseUrl = process.env.VOUCHFLOW_BASE_URL;
  if (!readKey || !baseUrl) {
    throw new Error(
      'VOUCHFLOW_READ_KEY and VOUCHFLOW_BASE_URL are required (or set VOUCHFLOW_USE_MOCK=1 for tests). ' +
        'See apps/api/.env.local.',
    );
  }
  const apiClient = new VouchflowApiClient({ baseUrl, readKey });
  const maxAge = Number(process.env.VOUCHFLOW_MAX_VERIFICATION_AGE_MS) || undefined;
  const maxRisk = Number(process.env.VOUCHFLOW_MAX_RISK_SCORE) || undefined;
  // Sandbox env relaxes the confidence floor to `low`. Sideloaded debug-
  // signed APKs fail Play Integrity / App Attest, which makes Vouchflow
  // record their verifies at `low`. Production must keep the default
  // `medium` floor — set VOUCHFLOW_MIN_CONFIDENCE explicitly only on
  // sandbox boxes.
  const isSandbox = baseUrl.includes('sandbox');
  const envOverride = process.env.VOUCHFLOW_MIN_CONFIDENCE as 'low' | 'medium' | 'high' | undefined;
  const minConfidence = envOverride ?? (isSandbox ? 'low' : 'medium');
  if (minConfidence !== 'medium') {
    log.warn(
      { minConfidence, baseUrl },
      'vouchflow validator using non-default minimum confidence — sandbox / debug only',
    );
  }
  return new VouchflowValidator({
    apiClient,
    maxVerificationAgeMs: maxAge,
    maxRiskScore: maxRisk,
    minConfidence,
  });
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: false,
  });

  const validator = opts.validator ?? defaultValidator(app.log);
  await app.register(vouchflowPlugin, { validator });

  const limiter = opts.rateLimiter ?? defaultRateLimiter();

  // Hoisted before route registration so the prekey route can push
  // `prekeys_low` frames into the owner's live sockets via UserNotifier.
  // When skipWebsocket is set (route-only test harness), a NoopUserNotifier
  // is used and the connections object is unused.
  const connections = opts.skipWebsocket
    ? undefined
    : (opts.connections ?? new InMemoryConnections());
  // instanceId is also needed by the WS init block below; computed once
  // here so RedisUserNotifier can stamp publishes with origin.
  const instanceId = opts.instanceId ?? process.env.INSTANCE_ID ?? randomUUID();
  const userNotifier: UserNotifier =
    opts.userNotifier ??
    (connections ? defaultUserNotifier(connections, instanceId) : new NoopUserNotifier());

  // When DATABASE_URL is set, all repos use Drizzle (Postgres).
  // Otherwise fall back to InMemory implementations for sandbox / dev.
  const hasDb = !!process.env.DATABASE_URL;
  const repo =
    opts.userRepo ??
    (hasDb ? new DrizzleUserRepo() : new InMemoryUserRepo());
  // Sandbox / dev mode hook: the LocalDevValidator needs the
  // (deviceToken, userId) pair after a fresh mint so subsequent verifies
  // (login, WS auth) recognize the user. Real VouchflowValidator ignores
  // this — the binding lives in Vouchflow's backend.
  const onUserMinted =
    validator instanceof LocalDevValidator
      ? (token: string, userId: string) => validator.bind(token, userId)
      : undefined;
  await registerEnrollRoutes(app, {
    repo,
    generateId: opts.generateId,
    enrollRateLimit: rateLimit({
      limiter,
      endpoint: 'enroll',
      limit: 5,
      windowMs: 60 * 60_000,
    }),
    onUserMinted,
  });
  await registerUserRoutes(app, { repo });
  const preKeyRepo =
    opts.preKeyRepo ??
    (hasDb ? new DrizzlePreKeyRepo() : new InMemoryPreKeyRepo(repo as InMemoryUserRepo));
  await registerPreKeyRoutes(app, {
    repo: preKeyRepo,
    limiter,
    notifier: userNotifier,
  });
  const groups = opts.groupRepo ?? (hasDb ? new DrizzleGroupRepo() : new InMemoryGroupRepo());
  const communities = opts.communityRepo ?? (hasDb ? new DrizzleCommunityRepo() : new InMemoryCommunityRepo());
  await registerGroupRoutes(app, { repo: groups });
  await registerCommunityRoutes(app, { repo: communities, limiter });
  // Devices repo is needed for both the push-token route and the WS handler.
  // Resolve it once so both paths share the same instance.
  const devices = opts.devicesRepo ?? (hasDb ? new DrizzleDevicesRepo() : new InMemoryDevicesRepo());
  await registerDeviceRoutes(app, { devices });

  app.get('/healthz', async () => ({ ok: true }));

  // Prometheus metrics — /metrics on the main listener when enabled.
  // Set METRICS_ENABLED=1 to activate. Scraped by Fly's internal Prometheus.
  if (process.env.METRICS_ENABLED === '1') {
    const mod = await import('fastify-metrics');
    const plugin = mod.default.default ?? mod.default;
    await app.register(plugin as any, { endpoint: '/metrics' });
    app.log.info('Prometheus /metrics endpoint enabled');
  }

  if (!opts.skipWebsocket) {
    if (!connections) throw new Error('connections must be defined when WS enabled');
    const { presence, redis } = opts.presence
      ? { presence: opts.presence, redis: undefined as Redis | undefined }
      : defaultPresence(app.log);
    // instanceId already computed above for the user notifier.
    const messages = opts.messagesRepo ?? (hasDb ? new DrizzleMessagesRepo() : new InMemoryMessagesRepo());
    const ackRouter = opts.ackRouter ?? defaultAckRouter();
    const push = opts.push ?? defaultPushProvider(devices, app.log);

    attachWebsocket(app, {
      validator,
      connections,
      presence,
      instanceId,
      messages,
      groups,
      communities,
      ackRouter,
      push,
      devices,
    });
    if (redis) {
      app.addHook('onClose', async () => {
        await redis.quit();
      });
    }
  }

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

function defaultPresence(log: import('fastify').FastifyBaseLogger): {
  presence: Presence;
  redis?: Redis;
} {
  const url = process.env.REDIS_URL;
  if (!url) {
    log.warn('REDIS_URL not set — falling back to InMemoryPresence (single-instance only)');
    return { presence: new InMemoryPresence() };
  }
  const redis = new Redis(url, { lazyConnect: false });
  return { presence: new RedisPresence(redis), redis };
}

function defaultRateLimiter(): RateLimiter {
  const url = process.env.REDIS_URL;
  if (!url) return new InMemoryRateLimiter();
  return new RedisRateLimiter(new Redis(url, { lazyConnect: false }));
}

function defaultAckRouter(): AckRouter {
  const url = process.env.REDIS_URL;
  if (!url) return new InMemoryAckRouter();
  // Two connections per ioredis convention — pub/sub can't share.
  const pub = new Redis(url, { lazyConnect: false });
  const sub = new Redis(url, { lazyConnect: false });
  return new RedisAckRouter(pub, sub);
}

function defaultUserNotifier(connections: Connections, instanceId: string): UserNotifier {
  const url = process.env.REDIS_URL;
  if (!url) return new LocalUserNotifier(connections);
  // Same two-connection pattern as defaultAckRouter (and same Redis
  // instance). Cross-instance variant so `prekeys_low` (and any future
  // single-user push) reaches the owner's socket regardless of which
  // box accepted that socket's WS connection.
  const pub = new Redis(url, { lazyConnect: false });
  const sub = new Redis(url, { lazyConnect: false });
  return new RedisUserNotifier(connections, pub, sub, instanceId);
}

function defaultPushProvider(
  devices: DevicesRepo,
  log: import('fastify').FastifyBaseLogger,
): PushProvider {
  if (process.env.FCM_PROJECT_ID) {
    log.info('FCM_PROJECT_ID set — using FcmApnsPushProvider');
    return new FcmApnsPushProvider(devices);
  }
  log.info('FCM_PROJECT_ID not set — using NoopPushProvider (no push notifications)');
  return new NoopPushProvider((msg, ctx) => log.debug(ctx ?? {}, msg));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
