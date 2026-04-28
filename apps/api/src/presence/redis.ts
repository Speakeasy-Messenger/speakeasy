import type { Redis } from 'ioredis';
import type { Presence, PresenceState } from './presence.js';

const sessionKey = (uid: string) => `session:${uid}`;
const presenceKey = (uid: string) => `presence:${uid}`;

/** ioredis-backed implementation. Production wiring. */
export class RedisPresence implements Presence {
  constructor(private readonly redis: Redis) {}

  async recordOnline(userId: string, instanceId: string): Promise<void> {
    await this.redis
      .multi()
      .set(sessionKey(userId), instanceId)
      .set(presenceKey(userId), 'online')
      .exec();
  }

  async recordOffline(userId: string): Promise<void> {
    await this.redis
      .multi()
      .del(sessionKey(userId))
      .set(presenceKey(userId), `offline:${Date.now()}`)
      .exec();
  }

  async lookupInstance(userId: string): Promise<string | undefined> {
    const v = await this.redis.get(sessionKey(userId));
    return v ?? undefined;
  }

  async lookupPresence(userId: string): Promise<PresenceState> {
    const v = await this.redis.get(presenceKey(userId));
    if (!v) return { state: 'unknown' };
    if (v === 'online') return { state: 'online' };
    if (v.startsWith('offline:')) {
      const ts = Number(v.slice('offline:'.length));
      return { state: 'offline', lastSeenMs: Number.isFinite(ts) ? ts : 0 };
    }
    return { state: 'unknown' };
  }
}
