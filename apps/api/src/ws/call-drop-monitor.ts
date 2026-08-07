import type { FastifyBaseLogger } from 'fastify';
import type { UserNotifier } from './user-notifier.js';
import type { EventLogRepo } from '../db/event-log.js';

/**
 * Ends a 1:1 call for the surviving party when the other party's
 * WebSocket drops mid-call without a `call_end` of its own.
 *
 * Why this exists
 * ---------------
 * A killed client can't say goodbye. When a user swipes the app away
 * (or the process is killed, or the network vanishes) during a call,
 * the OS tears down the TCP socket with no chance for the app to send
 * `call_end`. The peer is then stranded on a live call screen forever
 * (reported: "swipe-away doesn't end the call"). The server is the only
 * party that can observe the drop and tell the peer.
 *
 * Why a grace window, not an immediate end
 * ----------------------------------------
 * The mobile client deliberately keeps its WS open for the WHOLE call —
 * App.tsx's background handler skips the usual proactive close while a
 * call is active. So a close during a call is always abnormal. But
 * "abnormal" still includes the *transient* cases the call should
 * survive: a foreground-return reconnect, a cellular handoff, or a
 * rolling server deploy that drops every WS at once and lets clients
 * reconnect seconds later. In all of those the WebRTC media keeps
 * flowing peer-to-peer with the signaling WS briefly gone, and the
 * client rides through (it does NOT tear the call down on its own WS
 * drop). Ending the call immediately would kill those calls.
 *
 * So: on a mid-call drop we arm a timer. If the SAME device reconnects
 * (re-auths) inside the window, {@link CallDropMonitor.cancel} clears
 * the pending end and the call rides through. If it doesn't, the timer
 * fires and we send the peer `call_end{peer_disconnected}`.
 *
 * Keyed by deviceToken (not userId) so a multi-device user dropping the
 * one device that's in the call is handled precisely — an unrelated
 * idle device of theirs staying online doesn't suppress the teardown.
 *
 * Cross-instance: the fire path goes through {@link UserNotifier}, which
 * fans out via Redis pub/sub to wherever the peer's WS actually lives.
 * A same-device reconnect that lands on a *different* instance than the
 * one holding the timer is the one residual gap: that instance won't see
 * the cancel and may fire a spurious `call_end`. It's rare (reconnects
 * almost always return to the same region/instance; a deploy tears the
 * old instance — and its timers — down before the window elapses) and
 * benign (the peer's client gates `call_end` on `call_id`, and the user
 * can redial). It is strictly better than the bug it replaces.
 */
export const DEFAULT_CALL_DROP_GRACE_MS = 10_000;

export interface CallDropMonitorDeps {
  userNotifier: UserNotifier;
  log: FastifyBaseLogger;
  /** Optional persistent diagnostics — one row per server-ended call. */
  eventLog?: EventLogRepo;
  /** Grace window before ending the call for the peer. Default 10s. */
  graceMs?: number;
  /**
   * Injectable timers for deterministic tests. Default to the global
   * setTimeout/clearTimeout. Tests pass a fake clock so they don't sleep.
   */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CallDropArgs {
  /** The user whose WS just dropped mid-call. */
  userId: string;
  /**
   * That user's device token — the cancel key. The SAME device
   * reconnecting cancels the pending end; an unrelated device does not.
   */
  deviceToken: string;
  /** The call that was live on the dropped socket. */
  callId: string;
  /** The other party, who must be told the call ended. */
  peerUserId: string;
}

export interface CallDropMonitor {
  /**
   * A socket carrying an active call closed — schedule a peer
   * `call_end{peer_disconnected}` after the grace window. Re-arming for a
   * device that already has a pending end replaces the prior timer.
   */
  arm(args: CallDropArgs): void;
  /** The device reconnected (re-authed) — cancel any pending end for it. */
  cancel(deviceToken: string): void;
  /** Cancel every pending end (server shutdown). */
  clearAll(): void;
}

export function createCallDropMonitor(
  deps: CallDropMonitorDeps,
): CallDropMonitor {
  const graceMs = deps.graceMs ?? DEFAULT_CALL_DROP_GRACE_MS;
  const setTimer =
    deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));

  // deviceToken → pending timer. A device is in at most one call at a
  // time, so one in-flight pending end per device is sufficient.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    arm({ userId, deviceToken, callId, peerUserId }) {
      const existing = pending.get(deviceToken);
      if (existing) clearTimer(existing);
      const handle = setTimer(() => {
        pending.delete(deviceToken);
        // Grace elapsed with no reconnect from this device → treat the
        // drop as a genuine swipe-away / kill and end the call for the
        // peer on the dropped party's behalf. `from` is the dropped
        // user so the peer attributes the end correctly.
        deps.userNotifier.notify(peerUserId, {
          type: 'call_end',
          from: userId,
          call_id: callId,
          reason: 'peer_disconnected',
        });
        deps.log.info(
          { droppedUserId: userId, peerUserId, callId },
          'ended call for peer after mid-call WS drop (no reconnect in grace window)',
        );
        if (deps.eventLog) {
          void deps.eventLog
            .record({
              eventType: 'call.peer_disconnected.ended',
              userId: peerUserId,
              payload: { callId, droppedUserId: userId },
            })
            .catch(() => {
              /* best-effort diagnostics */
            });
        }
      }, graceMs);
      pending.set(deviceToken, handle);
    },

    cancel(deviceToken) {
      const existing = pending.get(deviceToken);
      if (existing) {
        clearTimer(existing);
        pending.delete(deviceToken);
      }
    },

    clearAll() {
      for (const h of pending.values()) clearTimer(h);
      pending.clear();
    },
  };
}
