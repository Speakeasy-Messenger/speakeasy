/**
 * FCM message handlers — v24 correct implementation.
 * 
 * CRITICAL: Handlers MUST be registered synchronously at module load.
 * Android Headless JS expects handlers to exist immediately when the
 * bundle loads. Any async/dynamic requires will cause race conditions.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStack } from '../navigation/RootNavigator.js';
import { useConversations } from '../store/conversations.js';
import { useCalls } from '../store/calls.js';
import { CallKeepBridge } from '../calls/callkeep-bridge.js';

// ---------------------------------------------------------------------------
// FCM data-payload shape
// ---------------------------------------------------------------------------

type FcmData = {
  conversation_id?: string;
  notify_kind?: 'message' | 'call';
  msg_type?: 'direct' | 'group';
};

type RemoteMessageShape = {
  data?: Record<string, string | undefined> | null;
  messageId?: string;
};

type TapTarget =
  | { kind: 'direct'; peerId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'call'; peerId: string };

const TAP_TARGET_KEY = '@speakeasy/push-tap-target';

function resolveTarget(data: FcmData): TapTarget | null {
  const { conversation_id, notify_kind, msg_type } = data;
  if (!conversation_id || !notify_kind) return null;

  if (notify_kind === 'call') {
    const peerId = conversation_id.replace('dm-', '').slice(0, 16);
    return { kind: 'call', peerId };
  }

  if (notify_kind === 'message') {
    if (msg_type === 'group') {
      const groupId = conversation_id.replace('group-', '');
      return { kind: 'group', groupId };
    }
    const peerId = conversation_id.replace('dm-', '').slice(0, 16);
    return { kind: 'direct', peerId };
  }

  return null;
}

async function persistTapTarget(target: TapTarget): Promise<void> {
  try {
    await AsyncStorage.setItem(TAP_TARGET_KEY, JSON.stringify(target));
  } catch {
    // Non-fatal
  }
}

async function consumeTapTarget(): Promise<TapTarget | null> {
  try {
    const val = await AsyncStorage.getItem(TAP_TARGET_KEY);
    if (!val) return null;
    await AsyncStorage.removeItem(TAP_TARGET_KEY);
    return JSON.parse(val) as TapTarget;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TOP-LEVEL BACKGROUND HANDLER REGISTRATION (Android only)
// CRITICAL: This MUST execute at module load, not in a function
// ---------------------------------------------------------------------------

if (Platform.OS === 'android') {
  messaging().setBackgroundMessageHandler(async (remoteMessage: RemoteMessageShape) => {
    const data = (remoteMessage.data ?? {}) as FcmData;
    diag('push-bg', 'background message received', {
      conversationId: data.conversation_id,
      kind: data.notify_kind,
      msgType: data.msg_type,
      timestamp: Date.now(),
    });

    const target = resolveTarget(data);
    if (target) {
      await persistTapTarget(target);
      diag('push-bg', 'tap-target persisted', { target });
    } else {
      diag('push-bg', 'could not resolve target from FCM data', { data });
    }
  });

  diag('push', 'background message handler registered');
}

// ---------------------------------------------------------------------------
// FOREGROUND HANDLER (exported for App.tsx to call after module init)
// ---------------------------------------------------------------------------

let foregroundHandlerUnsub: (() => void) | undefined;

export function registerForegroundMessageHandler(): void {
  if (foregroundHandlerUnsub) return;

  foregroundHandlerUnsub = messaging().onMessage((remoteMessage: RemoteMessageShape) => {
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
// NOTIFICATION-OPENED LISTENER
// ---------------------------------------------------------------------------

let notificationOpenedRegistered = false;

export function registerNotificationOpenedListener(): void {
  if (notificationOpenedRegistered) return;
  notificationOpenedRegistered = true;
  
  messaging().onNotificationOpenedApp((remoteMessage: RemoteMessageShape) => {
    if (!remoteMessage?.data) return;
    const data = remoteMessage.data as FcmData;
    const target = resolveTarget(data);
    if (target) {
      diag('push-open', 'warm resume from push tap', {
        conversationId: data.conversation_id,
        kind: data.notify_kind,
        msgType: data.msg_type,
      });
      void persistTapTarget(target);
    }
  });

  diag('push', 'notification-opened listener registered');
}

// ---------------------------------------------------------------------------
// NAVIGATION HOOK
// ---------------------------------------------------------------------------

async function routeTarget(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  target: TapTarget,
  callOrchestrator?: CallOrchestrator,
): Promise<void> {
  if (target.kind === 'call') {
    if (callOrchestrator) {
      await CallKeepBridge.start(callOrchestrator);
    }
    navRef.current?.navigate('IncomingCall');
  } else if (target.kind === 'group') {
    navRef.current?.navigate('GroupChat', { groupId: target.groupId });
  } else {
    navRef.current?.navigate('Chat', { peerId: target.peerId });
  }
}

export function usePushNavigation(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  callOrchestrator?: CallOrchestrator,
): void {
  const hydrated = useConversations((s) => s.hydrated);
  const userId = useConversations((s) => s.userId);
  const routedRef = useRef(false);

  useEffect(() => {
    if (!hydrated || !userId) return;
    if (routedRef.current) return;

    let cancelled = false;

    async function handleInitialNotification() {
      try {
        // 1. Cold start — check getInitialNotification
        const initial = await messaging().getInitialNotification();
        if (initial?.data && !routedRef.current && !cancelled) {
          const data = initial.data as FcmData;
          const target = resolveTarget(data);
          if (target) {
            diag('push-nav', 'cold start from push tap', {
              conversationId: data.conversation_id,
              kind: data.notify_kind,
            });
            routedRef.current = true;
            await routeTarget(navRef, target, callOrchestrator);
            return;
          }
        }

        // 2. Deferred — check AsyncStorage for background-handler target
        if (!routedRef.current && !cancelled) {
          const deferred = await consumeTapTarget();
          if (deferred) {
            diag('push-nav', 'deferred tap-target from background handler', {
              target: deferred,
            });
            routedRef.current = true;
            await routeTarget(navRef, deferred, callOrchestrator);
          }
        }
      } catch (err) {
        diag('push-nav', 'FCM handler setup failed', { err: String(err) });
      }
    }

    void handleInitialNotification();

    return () => {
      cancelled = true;
    };
  }, [hydrated, userId, navRef, callOrchestrator]);
}
