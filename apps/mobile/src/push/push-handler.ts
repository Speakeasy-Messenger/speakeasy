/**
 * FCM message handlers — v24 correct implementation.
 *
 * CRITICAL: Handlers MUST be registered synchronously at module load.
 * Android Headless JS expects handlers to exist immediately when the
 * bundle loads. Any async/dynamic requires will cause race conditions.
 *
 * rc.83 — peerId resolution moved to consume-time. The background
 * Headless JS context never hydrates the Zustand `conversations`
 * store, so resolving FCM `conversation_id` → `peerUserId` inside
 * `setBackgroundMessageHandler` always falls through to the
 * "use conversation_id as peerId" fallback, persisting a value
 * ChatScreen can't navigate to (it computes
 * `conversationIdForDirect(myUserId, peerId)` and the fallback
 * makes that synthesise a *new* conversation id with no messages
 * → blank screen, tap-does-nothing bug).
 *
 * Fix: persist the raw FCM data instead, and resolve to a peerId
 * at tap-consume time, when the foreground app's store is hydrated.
 * For call taps we additionally check whether the offer is still
 * within ringing window — stale call pushes route to the Chat with
 * the caller instead of an empty IncomingCall screen.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import messaging, { FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStack } from '../navigation/RootNavigator.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
import { useCalls } from '../store/calls.js';

type RemoteMessage = FirebaseMessagingTypes.RemoteMessage;

// ---------------------------------------------------------------------------
// FCM data-payload shape
// ---------------------------------------------------------------------------

export type FcmData = {
  conversation_id?: string;
  notify_kind?: 'message' | 'call';
  msg_type?: 'direct' | 'group';
};

/**
 * Persisted form of a tapped push. We store the *raw* FCM data plus
 * the timestamp at which the tap was queued — peerId resolution
 * happens at consume time, not here, because the background Headless
 * JS context can't read the (un-hydrated) conversations store.
 */
type PersistedPush = {
  conversationId: string;
  kind: 'message' | 'call';
  msgType: 'direct' | 'group' | undefined;
  /** ms since epoch — used for staleness check on call taps. */
  persistedAt: number;
};

/**
 * Resolved navigation target produced by `resolveTargetAtConsumeTime`.
 * Different from `PersistedPush` because by this point the conversations
 * store is hydrated and we've mapped `conversation_id` → real peerUserId.
 */
type NavTarget =
  | { kind: 'direct'; peerId: string }
  | { kind: 'group'; groupId: string }
  | {
      /**
       * Live incoming call — orchestrator has an `active` call in
       * `incoming_ringing` for this peer, so IncomingCallScreen will
       * render meaningfully. Resolved at consume time only.
       */
      kind: 'call-live';
    }
  | {
      /**
       * Stale call push — by the time the user tapped, the call had
       * already ended / timed out. We route to the Chat with the
       * caller (which shows a "missed call" entry if one was logged)
       * rather than an empty IncomingCallScreen.
       */
      kind: 'call-stale';
      peerId: string;
    };

const TAP_TARGET_KEY = '@speakeasy/push-tap-target';

/**
 * How long after a call push arrives we still consider it "live" enough
 * to route to IncomingCallScreen. Beyond this we assume the offer
 * expired (orchestrator default ring timeout is ~30 s; we add a small
 * grace for tap latency).
 */
const CALL_STALENESS_MS = 45_000;

async function persistRawPush(p: PersistedPush): Promise<void> {
  try {
    await AsyncStorage.setItem(TAP_TARGET_KEY, JSON.stringify(p));
  } catch {
    // Non-fatal
  }
}

async function consumeRawPush(): Promise<PersistedPush | null> {
  try {
    const val = await AsyncStorage.getItem(TAP_TARGET_KEY);
    if (!val) return null;
    await AsyncStorage.removeItem(TAP_TARGET_KEY);
    const parsed = JSON.parse(val) as Partial<PersistedPush>;
    if (!parsed?.conversationId || !parsed?.kind) return null;
    return {
      conversationId: parsed.conversationId,
      kind: parsed.kind,
      msgType: parsed.msgType,
      persistedAt: typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a raw `PersistedPush` (or a fresh cold-start FCM data
 * payload, which we wrap into one) into a navigable target. Runs in
 * the foreground app context where the conversations store is hydrated,
 * so `peerUserId` lookups succeed.
 */
export function resolveTargetAtConsumeTime(p: PersistedPush): NavTarget | null {
  const { conversationId, kind, msgType, persistedAt } = p;
  if (!conversationId || !kind) return null;

  if (kind === 'message') {
    if (msgType === 'group') {
      const groupId = conversationId.replace(/^group-/, '');
      return { kind: 'group', groupId };
    }
    // Direct message — look up peerUserId from hydrated store.
    const conv = useConversations.getState().byId[conversationId];
    if (conv?.peerUserId) {
      return { kind: 'direct', peerId: conv.peerUserId };
    }
    // Store hydrated but no record — likely first-ever message from
    // this peer and the conversation wasn't `openDirect`-created yet.
    // We can't navigate without a real userId (ChatScreen computes
    // conversationIdForDirect(myUserId, peerId)). Bail and let the
    // user open the chat from the conversation list once the WS
    // message arrives and creates the entry.
    diag('push-nav', 'no peerUserId for direct conversation — skipping nav', {
      conversationId,
    });
    return null;
  }

  if (kind === 'call') {
    const conv = useConversations.getState().byId[conversationId];
    const peerId = conv?.peerUserId;
    const ageMs = Date.now() - persistedAt;
    const live = useCalls.getState().active;
    const isLive =
      ageMs < CALL_STALENESS_MS &&
      live?.stage === 'incoming_ringing' &&
      (!peerId || live.peerUserId === peerId);

    if (isLive) {
      return { kind: 'call-live' };
    }
    if (peerId) {
      diag('push-nav', 'call push stale — routing to chat instead', {
        conversationId,
        ageMs,
        liveStage: live?.stage,
      });
      return { kind: 'call-stale', peerId };
    }
    // Can't even identify the peer → silently drop. The conversation
    // entry will appear once any signaling/message arrives over WS.
    diag('push-nav', 'call push stale + no peerUserId — dropping', {
      conversationId,
      ageMs,
    });
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// TOP-LEVEL BACKGROUND HANDLER REGISTRATION (Android only)
// CRITICAL: This MUST execute at module load, not in a function
// ---------------------------------------------------------------------------

if (Platform.OS === 'android') {
  messaging().setBackgroundMessageHandler(async (remoteMessage: RemoteMessage) => {
    const data = (remoteMessage.data ?? {}) as FcmData;
    diag('push-bg', 'background message received', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
      timestamp: Date.now(),
    });

    if (!data.conversation_id || !data.notify_kind) {
      diag('push-bg', 'incomplete FCM data — skipping persist', { data });
      return;
    }

    await persistRawPush({
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
      persistedAt: Date.now(),
    });
    diag('push-bg', 'tap-target persisted', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
    });
  });

  diag('push', 'background message handler registered');
}

// ---------------------------------------------------------------------------
// FOREGROUND HANDLER (exported for App.tsx to call after module init)
// ---------------------------------------------------------------------------

let foregroundHandlerUnsub: (() => void) | undefined;

export function registerForegroundMessageHandler(): void {
  if (foregroundHandlerUnsub) return;

  foregroundHandlerUnsub = messaging().onMessage((remoteMessage: RemoteMessage) => {
    const data = (remoteMessage.data ?? {}) as FcmData;
    diag('push-fg', 'foreground push received (suppressed OS banner)', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
    });
  });

  diag('push', 'foreground message handler registered');
}

export function unregisterForegroundMessageHandler(): void {
  foregroundHandlerUnsub?.();
  foregroundHandlerUnsub = undefined;
}

// ---------------------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------------------

async function routeTarget(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  target: NavTarget,
  _callOrchestrator?: CallOrchestrator,
): Promise<void> {
  switch (target.kind) {
    case 'call-live':
      // IncomingCallScreen reads from useCalls.active — it will render
      // because we verified active.stage === 'incoming_ringing'.
      navRef.current?.navigate('IncomingCall');
      return;
    case 'call-stale':
      navRef.current?.navigate('Chat', { peerId: target.peerId });
      return;
    case 'group':
      navRef.current?.navigate('GroupChat', { groupId: target.groupId });
      return;
    case 'direct':
      navRef.current?.navigate('Chat', { peerId: target.peerId });
      return;
  }
}

export function usePushNavigation(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  navReady: boolean,
  callOrchestrator?: CallOrchestrator,
): void {
  const hydrated = useConversations((s) => s.hydrated);
  const userId = useIdentity((s) => s.userId);
  const startupHandledRef = useRef(false);

  useEffect(() => {
    // navReady gates routing: on a cold start the stores hydrate
    // before the NavigationContainer mounts, and navigate() on a null
    // navRef is a silent no-op.
    if (!hydrated || !userId || !navReady) return;

    let cancelled = false;

    async function route(p: PersistedPush, source: string): Promise<void> {
      const target = resolveTargetAtConsumeTime(p);
      if (!target) {
        diag('push-nav', 'tap-target could not be resolved', {
          source,
          conversationId: p.conversationId,
          kind: p.kind,
        });
        return;
      }
      diag('push-nav', 'routing tapped push', {
        source,
        conversationId: p.conversationId,
        kind: p.kind,
        target: target.kind,
      });
      await routeTarget(navRef, target, callOrchestrator);
    }

    // Cold start: the notification that launched the app from a quit
    // state, plus any push the background handler persisted before
    // this hook mounted. Runs once per process.
    async function handleStartup() {
      if (startupHandledRef.current) return;
      startupHandledRef.current = true;
      try {
        const initial = await messaging().getInitialNotification();
        const data = initial?.data as FcmData | undefined;
        if (data?.conversation_id && data?.notify_kind && !cancelled) {
          await route(
            {
              conversationId: data.conversation_id,
              kind: data.notify_kind,
              msgType: data.msg_type,
              persistedAt: Date.now(),
            },
            'cold-start',
          );
          return;
        }
        if (!cancelled) {
          const deferred = await consumeRawPush();
          if (deferred) await route(deferred, 'deferred');
        }
      } catch (err) {
        diag('push-nav', 'startup notification handling failed', {
          err: String(err),
        });
      }
    }
    void handleStartup();

    // Warm taps: the app was already running and the user tapped a
    // notification. onNotificationOpenedApp fires every time — the
    // previous design routed only once per process, so every tap after
    // the first was silently dropped.
    const unsubscribe = messaging().onNotificationOpenedApp((rm) => {
      const data = (rm?.data ?? {}) as FcmData;
      if (!data.conversation_id || !data.notify_kind) return;
      // Drain any slot the background handler persisted for this push
      // so it can't re-fire as a stale deferred nav on the next cold
      // start.
      void consumeRawPush();
      void route(
        {
          conversationId: data.conversation_id,
          kind: data.notify_kind,
          msgType: data.msg_type,
          persistedAt: Date.now(),
        },
        'warm-tap',
      );
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hydrated, userId, navReady, navRef, callOrchestrator]);
}
