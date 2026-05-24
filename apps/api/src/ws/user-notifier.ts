import type { CallKind } from '@speakeasy/shared';
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
 *
 * Phase 5j (Private Call): `notify` accepts an optional `requireCapability`
 * — when set, fan-out (local and cross-instance) only reaches devices
 * whose declared `supported_call_kinds` includes the named kind. Used by
 * `call-router` so a `kind:'private'` offer never rings the peer's old
 * device that can't honor it. Closes Codex tension #1.
 */
export interface NotifyOptions {
  /** Skip devices whose capability set doesn't include this kind. */
  requireCapability?: CallKind;
}

export interface UserNotifier {
  notify(userId: string, frame: object, opts?: NotifyOptions): void;
}

/** Drops every notify call. Used in route-only tests that don't init WS. */
export class NoopUserNotifier implements UserNotifier {
  notify(_userId: string, _frame: object, _opts?: NotifyOptions): void {
    /* no-op */
  }
}

/** In-process notifier — pushes to every local socket of `userId`. */
export class LocalUserNotifier implements UserNotifier {
  constructor(private readonly connections: Connections) {}

  notify(userId: string, frame: object, opts?: NotifyOptions): void {
    const devices = opts?.requireCapability
      ? this.connections.getDevicesWithCapability(userId, opts.requireCapability)
      : this.connections.getDevices(userId);
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
