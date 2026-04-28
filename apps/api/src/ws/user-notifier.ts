import type { Connections } from './connections.js';

/**
 * Push a JSON frame to every live socket for a single user (all of their
 * devices). Used by API route handlers that want to push a side-channel
 * signal to the *owning* user when something happens server-side — e.g.
 * `prekeys_low` from the bundle endpoint, or future quota / kick frames.
 *
 * Distinct from [PushProvider] (FCM/APNs notify-only) and [AckRouter]
 * (cross-instance ack relay). Where AckRouter routes between instances,
 * UserNotifier routes from a route handler down to in-process WS sockets.
 *
 * Phase 5b carry-over: cross-instance variant lands in Phase 5f, mirroring
 * `RedisAckRouter`. For now `LocalUserNotifier` only reaches sockets on
 * the same process — if the user's only live socket is on another
 * instance, the signal is dropped and they'll re-receive it next time
 * the trigger fires (acceptable for non-critical signals like prekey
 * replenishment).
 */
export interface UserNotifier {
  notify(userId: string, frame: object): void;
}

/** Drops every notify call. Used in route-only tests that don't init WS. */
export class NoopUserNotifier implements UserNotifier {
  notify(_userId: string, _frame: object): void {
    /* no-op */
  }
}

/** In-process notifier — pushes to every local socket of `userId`. */
export class LocalUserNotifier implements UserNotifier {
  constructor(private readonly connections: Connections) {}

  notify(userId: string, frame: object): void {
    const devices = this.connections.getDevices(userId);
    if (devices.length === 0) return;
    const payload = JSON.stringify(frame);
    for (const socket of devices) {
      try {
        socket.send(payload);
      } catch {
        /* socket may have closed mid-iteration; ignore */
      }
    }
  }
}
