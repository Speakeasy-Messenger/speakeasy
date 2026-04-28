import type { Presence, PresenceState } from './presence.js';

export class InMemoryPresence implements Presence {
  readonly sessions = new Map<string, string>();
  readonly presence = new Map<string, PresenceState>();

  async recordOnline(userId: string, instanceId: string): Promise<void> {
    this.sessions.set(userId, instanceId);
    this.presence.set(userId, { state: 'online' });
  }

  async recordOffline(userId: string): Promise<void> {
    this.sessions.delete(userId);
    this.presence.set(userId, { state: 'offline', lastSeenMs: Date.now() });
  }

  async lookupInstance(userId: string): Promise<string | undefined> {
    return this.sessions.get(userId);
  }

  async lookupPresence(userId: string): Promise<PresenceState> {
    return this.presence.get(userId) ?? { state: 'unknown' };
  }
}
