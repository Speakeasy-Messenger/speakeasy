import type { WebSocket } from 'ws';
import type { CallKind } from '@speakeasy/shared';

/**
 * Tracks authed WebSocket connections, keyed by **(userId, deviceToken)**
 * (Phase 4 multi-device). One user can have N live device sockets.
 *
 * Phase 1: in-memory single-instance only.
 * Phase 1 (next task) added Redis-backed presence behind the same shape.
 * Phase 4: keys widen to include deviceToken for multi-device fan-out.
 * Phase 5j (Private Call): per-connection `supported_call_kinds` so the
 * server's call-router can fan out a `kind:'private'` offer ONLY to the
 * peer's devices that can actually answer it. Capability stays in
 * memory (not Redis, not the DB) because it is presence-tied — a
 * device that's no longer connected can't honor a private call no
 * matter what its DB row says. See `lunchbox-main-design-20260524-014323.md`
 * (capability handshake).
 */
export interface Connections {
  add(
    userId: string,
    deviceToken: string,
    socket: WebSocket,
    capabilities?: readonly CallKind[],
  ): Promise<void>;
  remove(userId: string, deviceToken: string, socket: WebSocket): Promise<void>;
  /** All live sockets for this user, across all their devices. */
  getDevices(userId: string): WebSocket[];
  /**
   * Sockets for this user filtered to devices that can answer the given
   * call kind. Used by `call-router` to fan out `kind:'private'` offers
   * only to capable devices — without this filter, an older device on
   * the same account would still ring with raw audio (Codex tension #1
   * from /plan-eng-review).
   */
  getDevicesWithCapability(userId: string, kind: CallKind): WebSocket[];
  /**
   * UNION of `supported_call_kinds` across this user's currently-connected
   * devices, surfaced by `GET /v1/users/:id` for sender-side preflight.
   * Returns an empty array when the user has no live sockets.
   */
  getCapabilitiesUnion(userId: string): CallKind[];
}

/** Default capability set for clients pre-rc.130 that don't send the field. */
const DEFAULT_CAPABILITIES: readonly CallKind[] = ['audio', 'video'];

interface DeviceEntry {
  socket: WebSocket;
  capabilities: readonly CallKind[];
}

export class InMemoryConnections implements Connections {
  /** userId → (deviceToken → entry) */
  private readonly byUserDevice = new Map<string, Map<string, DeviceEntry>>();

  async add(
    userId: string,
    deviceToken: string,
    socket: WebSocket,
    capabilities?: readonly CallKind[],
  ): Promise<void> {
    let bucket = this.byUserDevice.get(userId);
    if (!bucket) {
      bucket = new Map();
      this.byUserDevice.set(userId, bucket);
    }
    const existing = bucket.get(deviceToken);
    if (existing && existing.socket !== socket) {
      // Same device reconnected — newer wins. Older socket is closed by caller.
      try {
        existing.socket.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    bucket.set(deviceToken, {
      socket,
      capabilities: capabilities ?? DEFAULT_CAPABILITIES,
    });
  }

  async remove(userId: string, deviceToken: string, socket: WebSocket): Promise<void> {
    const bucket = this.byUserDevice.get(userId);
    if (!bucket) return;
    if (bucket.get(deviceToken)?.socket === socket) {
      bucket.delete(deviceToken);
      if (bucket.size === 0) this.byUserDevice.delete(userId);
    }
  }

  getDevices(userId: string): WebSocket[] {
    const bucket = this.byUserDevice.get(userId);
    if (!bucket) return [];
    return [...bucket.values()].map((e) => e.socket);
  }

  getDevicesWithCapability(userId: string, kind: CallKind): WebSocket[] {
    const bucket = this.byUserDevice.get(userId);
    if (!bucket) return [];
    return [...bucket.values()]
      .filter((e) => e.capabilities.includes(kind))
      .map((e) => e.socket);
  }

  getCapabilitiesUnion(userId: string): CallKind[] {
    const bucket = this.byUserDevice.get(userId);
    if (!bucket) return [];
    const union = new Set<CallKind>();
    for (const entry of bucket.values()) {
      for (const k of entry.capabilities) union.add(k);
    }
    return [...union];
  }
}
