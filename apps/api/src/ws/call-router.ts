import type { FastifyBaseLogger } from 'fastify';
import {
  conversationIdForDirect,
  KNOWN_CALL_KINDS,
  type CallKind,
  type WsClientMsg,
  type WsServerMsg,
} from '@speakeasy/shared';
import type { Connections } from './connections.js';
import type { Presence } from '../presence/presence.js';
import type { PushProvider } from '../push/push.js';
import type { ApnsVoipSender } from '../push/apns-voip.js';
import type { DevicesRepo } from '../db/devices.js';
import type { UserNotifier } from './user-notifier.js';
import type { CallOfferBuffer } from './call-offer-buffer.js';
import type { EventLogRepo } from '../db/event-log.js';
import type { UserRepo } from '../db/users.js';

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
  /**
   * User repo — read at video-offer time to enforce the callee's
   * "Refuse video calls" setting (#13). Optional so existing test
   * harnesses without it keep working (video is then never refused).
   */
  users?: UserRepo;
  /**
   * iOS VoIP push sender (CallKit). When configured, a `call_offer` also
   * fires a direct-APNs VoIP push to the callee's iOS PushKit tokens so the
   * native call UI rings even from a killed state. Optional — absent in tests
   * and when APNs isn't configured (the call still rings via the regular push
   * + live WS routing). `devices` is the lookup for those VoIP tokens.
   */
  apnsVoip?: ApnsVoipSender;
  devices?: DevicesRepo;
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

  // -- normalize call kind on offer frames ----------------------------
  // Sender hints `kind` plaintext so the server can fan-out only to
  // capable peer devices (Codex tension #1 from /plan-eng-review).
  // Validate against the known set; unknown values are coerced to
  // 'audio' (back-compat with pre-rc.130 clients that never set the
  // field). Defense in depth: receiver also runs KNOWN_CALL_KINDS.
  let offerKind: CallKind = 'audio';
  if (msg.type === 'call_offer') {
    const declared = msg.kind;
    if (declared && KNOWN_CALL_KINDS.has(declared as CallKind)) {
      offerKind = declared as CallKind;
    }
  }

  // -- refuse-video gate (#13) ----------------------------------------
  // If the callee has "Refuse video calls" on, reject a video offer
  // BEFORE any ring / push / buffer: the callee sees nothing, and the
  // CALLER gets a `video_refused` decline to render the branded "No
  // video here." notice. Audio/masked ('private') offers are never
  // gated. Caller-side the sheet already hides the Video row via the
  // capability aggregation; this is the authoritative enforcement for
  // a stale caller that offers anyway.
  if (msg.type === 'call_offer' && offerKind === 'video' && deps.users) {
    const callee = await deps.users.findById(msg.to);
    if (callee?.refuseVideo) {
      deps.userNotifier.notify(senderUserId, {
        type: 'call_end',
        from: msg.to,
        call_id: msg.call_id,
        reason: 'video_refused',
      });
      recordCallRoute(deps, 'call_end', msg.to, msg.call_id, senderUserId, {
        decision: 'video_refused',
      });
      return ok();
    }
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
      : msg.type === 'call_offer'
        ? {
            type: 'call_offer',
            from: senderUserId,
            call_id: msg.call_id,
            ciphertext: msg.ciphertext as string,
            kind: offerKind,
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
        // Banner copy: "Incoming video call" vs "Incoming call".
        callVideo: offerKind === 'video',
      })
      .catch((err) =>
        deps.log.warn(
          { err, recipientId: msg.to },
          'call push notify failed',
        ),
      );

    // iOS CallKit: also fire a direct-APNs VoIP push so the callee's iPhone
    // rings via the native incoming-call UI even from a killed state (FCM
    // can't deliver VoIP pushes). Best-effort; the regular push above is the
    // Android + fallback path. A 410/Unregistered clears the dead token.
    if (deps.apnsVoip && deps.devices) {
      const { apnsVoip, devices } = deps;
      void (async () => {
        try {
          const rows = await devices.listForUser(msg.to);
          const voipTokens = rows
            .filter((d) => d.platform === 'ios' && d.voipToken)
            .map((d) => d.voipToken as string);
          if (voipTokens.length === 0) return;
          const payload = {
            call_id: String(msg.call_id),
            handle: senderUserId,
            caller_name: senderUserId,
            has_video: offerKind === 'video',
          };
          await Promise.all(
            voipTokens.map(async (token) => {
              const res = await apnsVoip.sendVoipPush(token, payload);
              if (!res.ok && (res.status === 410 || res.reason === 'Unregistered')) {
                await devices
                  .clearVoipToken({ voipToken: token, reason: `apns:${res.reason ?? res.status}` })
                  .catch(() => {});
              }
            }),
          );
        } catch (err) {
          deps.log.warn({ err, recipientId: msg.to }, 'voip push failed');
        }
      })();
    }
  }

  // -- missed-call push on caller-cancel ------------------------------
  // The caller gives up (45 s ring timeout, or manual cancel) → it
  // sends `call_end` with reason `cancel`. Fire a push so the callee's
  // stale "Incoming call" notification updates to "Missed call" — same
  // conversationId, so it replaces in place. Unconditional like the
  // offer push: this is the case the user hit, and it must land even
  // when the callee's app was killed (no live WS to deliver call_end).
  if (msg.type === 'call_end' && msg.reason === 'cancel') {
    const conversation = conversationIdForDirect(senderUserId, msg.to);
    void deps.push
      .notifyDelivery({
        userId: msg.to,
        conversationId: conversation,
        msgType: 'direct',
        senderId: senderUserId,
        kind: 'call',
        callEvent: 'missed',
      })
      .catch((err) =>
        deps.log.warn(
          { err, recipientId: msg.to },
          'missed-call push notify failed',
        ),
      );
  }

  // -- buffer bookkeeping (runs regardless of online status) ----------
  // Presence can be stale for a few seconds after a background
  // disconnect (the app closes its WS when it backgrounds). In that
  // window the OLD code saw the callee as "online", live-`notify`d the
  // offer to a now-dead socket (silently dropped), and returned WITHOUT
  // buffering — so the callee's reconnect drained nothing and never rang
  // (chloro 2026-06-04: tapped the call notification, landed in the chat,
  // no offer ever arrived; the caller gave up). Always buffer the offer
  // (+ trailing ICE) so the reconnect drain is authoritative. The 30s TTL
  // plus clear-on-answer / clear-on-end keep a successfully-delivered
  // offer from re-ringing; the client also ignores a re-delivered offer
  // for the call it's already handling (orchestrator handleIncomingOffer).
  switch (msg.type) {
    case 'call_offer':
      deps.callBuffer.put(msg.to, {
        type: 'call_offer',
        fromUserId: senderUserId,
        callId: msg.call_id,
        ciphertext: msg.ciphertext as string,
      });
      break;
    case 'call_ice':
      // Buffered only if it matches a buffered offer; otherwise dropped
      // (no anchor SDP makes a stray ICE useless).
      deps.callBuffer.put(msg.to, {
        type: 'call_ice',
        fromUserId: senderUserId,
        callId: msg.call_id,
        ciphertext: msg.ciphertext as string,
      });
      break;
    case 'call_answer':
      // Callee answered → drop their buffered offer so a mid-call
      // reconnect within the TTL can't re-ring an answered call. The
      // answer flows callee→caller, so the callee (whose buffer holds the
      // offer) is the SENDER, not `msg.to`.
      deps.callBuffer.clear(senderUserId, msg.call_id);
      break;
    case 'call_end':
      // Either side hung up / caller cancelled → drop the buffered offer
      // so the callee doesn't ring on a stale offer when they reconnect.
      deps.callBuffer.clear(msg.to, msg.call_id);
      break;
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
    //
    // #13: NO `requireCapability` gate any more. Masking is caller-local
    // (the filter alters the caller's own outbound track), so the callee
    // needs no capability to receive a 'private'/masked call — every one
    // of the callee's devices should ring. Old devices that can't render
    // the animal UI fall back to a plain audio call and still hear the
    // masked voice. (Previously 'private' offers were filtered to
    // private-capable devices; that gate is gone with the unify.)
    // The offer is ALSO buffered above; if this live delivery lands on a
    // stale (dead) socket, the callee's reconnect drain recovers it.
    deps.userNotifier.notify(msg.to, frameToSend);
    if (msg.type !== 'call_ice') {
      recordCallRoute(deps, msg.type, msg.to, msg.call_id, senderUserId, {
        decision: onlineLocally ? 'online_local' : 'online_cross_instance',
        peerInstance,
      });
    }
    return ok();
  }

  // -- truly offline: the offer/ICE is already buffered above and the
  // always-push (for offers) already fired. Just record the decision.
  // call_answer to an offline peer is a no-op — the peer's local
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
      | 'offline_drop'
      | 'video_refused';
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
