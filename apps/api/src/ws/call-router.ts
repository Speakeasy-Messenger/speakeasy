import type { FastifyBaseLogger } from 'fastify';
import {
  conversationIdForDirect,
  type WsClientMsg,
  type WsServerMsg,
} from '@speakeasy/shared';
import type { Connections } from './connections.js';
import type { Presence } from '../presence/presence.js';
import type { PushProvider } from '../push/push.js';
import type { UserNotifier } from './user-notifier.js';
import type { CallOfferBuffer } from './call-offer-buffer.js';
import type { EventLogRepo } from '../db/event-log.js';

/**
 * Voice/video call signaling router.
 *
 * Owns the full lifecycle of every `call_offer` / `call_answer` /
 * `call_ice` / `call_end` frame: validation, push wake-up, live
 * routing across fly instances, and ringing-window buffering for
 * recipients who are offline at the moment of dial.
 *
 * Extracted from handler.ts (was a ~150-line inline switch case)
 * for two reasons:
 *  - the call branch accumulated four layered fixes (rc.52 offer
 *    buffer, rc.53 Redis variant, rc.57 cross-instance UserNotifier,
 *    rc.58 always-push) and is the densest piece of routing logic in
 *    the server. Inline made every change a careful edit-around;
 *    isolating makes each branch testable on its own.
 *  - the unit tests in call-router.test.ts now exercise each branch
 *    directly with mock deps, no WS / Fastify / buildServer needed.
 *    handler.test.ts + cross-instance.test.ts still provide
 *    end-to-end coverage.
 *
 * Design model (the comments inside hold the history):
 *  - call_offer ALWAYS fires a push (rc.58), even when the recipient
 *    appears online. The "online via WS" check has a few-second race
 *    where presence still says online but the app has backgrounded;
 *    push closes that gap as a system-level wake-up. WhatsApp/Signal
 *    use the same model. FCM's foreground handler suppresses the
 *    duplicate banner when the app is already showing the ringer.
 *  - Live routing goes through UserNotifier (rc.57): local fan-out
 *    plus Redis pub/sub for any instance with the recipient's WS.
 *    Pre-rc.57 the answer/ice path was strictly local and lost ~50%
 *    of calls in a 2-machine deploy.
 *  - Offer + trailing ICE buffer (rc.52/53) holds frames for ~30s
 *    when the recipient is truly offline, drained on their next WS
 *    auth on any instance.
 */

export interface CallRouterDeps {
  connections: Connections;
  presence: Presence;
  instanceId: string;
  userNotifier: UserNotifier;
  callBuffer: CallOfferBuffer;
  push: PushProvider;
  log: FastifyBaseLogger;
  /**
   * Optional event log for persistent diagnostics. When provided, the
   * router records each non-ICE call frame's routing decision so
   * "tester didn't receive my call_answer 20 minutes ago" can be
   * answered by SQL instead of "please reproduce while I tail logs."
   * ICE frames are excluded (one call easily generates 30+).
   */
  eventLog?: EventLogRepo;
}

export type CallFrameClient = Extract<
  WsClientMsg,
  { type: 'call_offer' | 'call_answer' | 'call_ice' | 'call_end' }
>;

export type CallRouteResult =
  | { ok: true }
  | { ok: false; code: CallRouteErrorCode; message: string };

export type CallRouteErrorCode =
  | 'invalid_target'
  | 'bad_call_id'
  | 'invalid_ciphertext';

/**
 * Validate the inbound frame, build the outbound frame, route it, and
 * fire any side effects (push, buffer). Returns `{ ok: false, … }` on
 * a validation failure so the caller can emit `sendError`; never
 * throws.
 */
export async function routeCallFrame(
  deps: CallRouterDeps,
  senderUserId: string,
  msg: CallFrameClient,
): Promise<CallRouteResult> {
  // -- validation -----------------------------------------------------
  if (!msg.to || typeof msg.to !== 'string') {
    return errVal('invalid_target', 'call frame requires `to`');
  }
  if (msg.to === senderUserId) {
    return errVal('invalid_target', 'cannot call self');
  }
  if (!msg.call_id || typeof msg.call_id !== 'string') {
    return errVal('bad_call_id', 'call frame requires `call_id`');
  }
  if (msg.type !== 'call_end' && typeof msg.ciphertext !== 'string') {
    return errVal('invalid_ciphertext', 'call signaling requires ciphertext');
  }

  // -- build outbound frame -------------------------------------------
  const frameToSend: WsServerMsg =
    msg.type === 'call_end'
      ? {
          type: 'call_end',
          from: senderUserId,
          call_id: msg.call_id,
          reason: msg.reason,
        }
      : {
          type: msg.type,
          from: senderUserId,
          call_id: msg.call_id,
          ciphertext: msg.ciphertext as string,
        };

  // -- always-push for call_offer (rc.58) -----------------------------
  // The AppState→background→close-WS pattern has a race window of a
  // few seconds where the server still sees the recipient online but
  // the app has no UI up to surface a live offer. Push closes that
  // gap. Other call frames don't push (mid-call, no wake-up value).
  if (msg.type === 'call_offer') {
    const conversation = conversationIdForDirect(senderUserId, msg.to);
    void deps.push
      .notifyDelivery({
        userId: msg.to,
        conversationId: conversation,
        msgType: 'direct',
        senderId: senderUserId,
        // FCM data field — distinguishes "@caller is calling…" from
        // "@sender: New message" + lets the mobile FCM handler route
        // to the full-screen ringer.
        kind: 'call',
      })
      .catch((err) =>
        deps.log.warn(
          { err, recipientId: msg.to },
          'call push notify failed',
        ),
      );
  }

  // -- presence check: online anywhere? -------------------------------
  // Local fast path first (cheap, avoids Redis). If not local, ask
  // presence whether the user is authed on any instance in the
  // cluster.
  const localDevices = deps.connections.getDevices(msg.to);
  const onlineLocally = localDevices.length > 0;
  const peerInstance = onlineLocally
    ? deps.instanceId
    : await deps.presence.lookupInstance(msg.to);
  const onlineSomewhere = onlineLocally || !!peerInstance;

  if (onlineSomewhere) {
    // Route via UserNotifier — local fan-out + Redis pub/sub. Going
    // through the notifier even for same-instance keeps the path
    // uniform and matches the manual `for (peer of peerDevices)`
    // semantics for multi-device fan-out.
    deps.userNotifier.notify(msg.to, frameToSend);

    // Clear any stale buffered offer if the caller hung up while the
    // callee was reconnecting (rare race). Without this, the next
    // buffer drain would surface a phantom ring.
    if (msg.type === 'call_end') {
      deps.callBuffer.clear(msg.to, msg.call_id);
    }
    if (msg.type !== 'call_ice') {
      recordCallRoute(deps, msg.type, msg.to, msg.call_id, senderUserId, {
        decision: onlineLocally ? 'online_local' : 'online_cross_instance',
        peerInstance,
      });
    }
    return ok();
  }

  // -- truly offline: buffer + (for offer) push already fired ---------
  if (msg.type === 'call_offer') {
    // Buffer for the ringing window. On the recipient's next WS auth
    // (any instance), the offer + trailing ICE drain in order.
    // Replaces any prior buffered call for this recipient.
    deps.callBuffer.put(msg.to, {
      type: 'call_offer',
      fromUserId: senderUserId,
      callId: msg.call_id,
      ciphertext: msg.ciphertext as string,
    });
  } else if (msg.type === 'call_ice') {
    // Trickle ICE after a buffered offer. The buffer drops ICE
    // without a matching offer — no anchor SDP makes them useless.
    deps.callBuffer.put(msg.to, {
      type: 'call_ice',
      fromUserId: senderUserId,
      callId: msg.call_id,
      ciphertext: msg.ciphertext as string,
    });
  } else if (msg.type === 'call_end') {
    // Caller gave up before the callee reconnected. Clear the buffer
    // so the callee doesn't ring on a stale offer when they come back.
    deps.callBuffer.clear(msg.to, msg.call_id);
  }
  // call_answer to offline peer is a no-op — the peer's local
  // ringing-window timeout produces the same outcome.
  if (msg.type !== 'call_ice') {
    recordCallRoute(deps, msg.type, msg.to, msg.call_id, senderUserId, {
      decision: msg.type === 'call_offer' ? 'offline_buffered' : msg.type === 'call_end' ? 'offline_clear_buffer' : 'offline_drop',
    });
  }
  return ok();
}

function recordCallRoute(
  deps: CallRouterDeps,
  frameType: 'call_offer' | 'call_answer' | 'call_end',
  toUserId: string,
  callId: string,
  senderUserId: string,
  detail: {
    decision:
      | 'online_local'
      | 'online_cross_instance'
      | 'offline_buffered'
      | 'offline_clear_buffer'
      | 'offline_drop';
    peerInstance?: string;
  },
): void {
  if (!deps.eventLog) return;
  void deps.eventLog
    .record({
      eventType: `call.${frameType}.routed`,
      userId: toUserId,
      payload: {
        callId,
        senderId: senderUserId,
        decision: detail.decision,
        peerInstance: detail.peerInstance,
        ourInstance: deps.instanceId,
      },
    })
    .catch(() => {
      /* best-effort */
    });
}

function ok(): { ok: true } {
  return { ok: true };
}

function errVal(
  code: CallRouteErrorCode,
  message: string,
): { ok: false; code: CallRouteErrorCode; message: string } {
  return { ok: false, code, message };
}
