import type { WebSocket } from 'ws';

/**
 * Tracks authed WebSocket connections, keyed by **(userId, deviceToken)**
 * (Phase 4 multi-device). One user can have N live device sockets.
 *
 * Phase 1: in-memory single-instance only.
 * Phase 1 (next task) added Redis-backed presence behind the same shape.
 * Phase 4: keys widen to include deviceToken for multi-device fan-out.
 */
export interface Connections {
  add(userId: string, deviceToken: string, socket: WebSocket): Promise<void>;
  remove(userId: string, deviceToken: string, socket: WebSocket): Promise<void>;
  /** All live sockets for this user, across all their devices. */
  getDevices(userId: string): WebSocket[];
}

export class InMemoryConnections implements Connections {
  /** userId → (deviceToken → socket) */
  private readonly byUserDevice = new Map<string, Map<string, WebSocket>>();

  async add(userId: string, deviceToken: string, socket: WebSocket): Promise<void> {
    let bucket = this.byUserDevice.get(userId);
    if (!bucket) {
      bucket = new Map();
      this.byUserDevice.set(userId, bucket);
    }
    const existing = bucket.get(deviceToken);
    if (existing && existing !== socket) {
      // Same device reconnected — newer wins. Older socket is closed by caller.
      try {
        existing.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    bucket.set(deviceToken, socket);
  }

  async remove(userId: string, deviceToken: string, socket: WebSocket): Promise<void> {
    const bucket = this.byUserDevice.get(userId);
    if (!bucket) return;
    if (bucket.get(deviceToken) === socket) {
      bucket.delete(deviceToken);
      if (bucket.size === 0) this.byUserDevice.delete(userId);
    }
  }

  getDevices(userId: string): WebSocket[] {
    const bucket = this.byUserDevice.get(userId);
    return bucket ? [...bucket.values()] : [];
  }
}
