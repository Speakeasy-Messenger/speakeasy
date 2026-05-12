/**
 * FCM message handlers — Phase 6 fix.
 *
 * BEFORE THIS FILE: The app registered zero FCM message handlers.
 * Tapping a push notification always landed the user on the
 * conversation list because the FCM data payload (which contains
 * `conversation_id` + `notify_kind`) was never read by the JS layer.
 *
 * This module wires three @react-native-firebase/messaging hooks:
 *
 *   1. `setBackgroundMessageHandler` — runs in headless JS when the
 *      app is killed / backgrounded. We can't navigate from here
 *      (no React root), but we persist the tap-target so
 *      `getInitialNotification` can route on next mount.
 *
 *   2. `onMessage` — fires when a push arrives while the app is
 *      foreground. Without this, FCM shows a system banner on top
 *      of our in-app InAppBanner → duplicate notification. We
 *      intercept and suppress the default FCM banner; the existing
 *      `notifyInbound` → `decideBanner` path handles in-app
 *      notification.
 *
 *   3. `getInitialNotification` + `onNotificationOpenedApp` — fire
 *      when the user taps a system notification (cold start and
 *      warm resume respectively). We extract `conversation_id` and
 *      `notify_kind` from the FCM `data` block and route:
 *        - `notify_kind === 'message'` + `msg_type === 'direct'`
 *          → navigate to Chat with peerId resolved from conversation
 *        - `notify_kind === 'message'` + `msg_type === 'group'`
 *          → navigate to GroupChat with groupId
 *        - `notify_kind === 'call'`
 *          → start CallKeepBridge + navigate to IncomingCall
 *
 * Key design: all three listeners are registered at module level
 * (outside React's lifecycle) to close timing gaps. They persist
 * tap-targets to AsyncStorage. The `usePushNavigation` React hook
 * consumes those targets after hydration.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { diag } from '../diag/log.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStack } from '../navigation/RootNavigator.js';
import { useConversations } from '../store/conversations.js';
import { useCalls } from '../store/calls.js';
import { CallKeepBridge } from '../calls/callkeep-bridge.js';

// ---------------------------------------------------------------------------
// Safe native-module require with retry
// ---------------------------------------------------------------------------

/**
 * @react-native-firebase/messaging may return `undefined` if the native
 * module bridge hasn't initialized when the JS bundle first evaluates.
 * On Android this is common during cold start — the TurboModule registry
 * is populated asynchronously and `require()` can race ahead of it.
 *
 * This helper tries the require, and if it returns undefined (or throws),
 * retries on the next event-loop tick (up to `maxRetries` times).
 * Returns the messaging module, or `undefined` if all retries fail.
 */
function requireMessaging(maxRetries = 10): Promise<object | undefined> {
  return new Promise((resolve) => {
    let attempts = 0;

    function tryRequire(): void {
      attempts++;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const mod = require('@react-native-firebase/messaging');
        if (mod && typeof mod === 'object') {
          resolve(mod);
          return;
        }
      } catch {
        // Module not ready yet
      }

      if (attempts >= maxRetries) {
        diag('push', 'messaging module never became available', {
          attempts,
        });
        resolve(undefined);
        return;
      }

      // Defer to next tick — by then the native bridge is usually ready
      setTimeout(tryRequire, 50);
    }

    tryRequire();
  });
}

// ---------------------------------------------------------------------------
// FCM data-payload shape (matches server: push.fcm-apns.ts)
// ---------------------------------------------------------------------------

export interface FcmData {
  /** e.g. "dm-aaed1572360329a0" or "grp-…" */
  conversation_id?: string;
  /** "direct" | "group" | "community" */
  msg_type?: string;
  /** "message" | "call" */
  notify_kind?: string;
}

// ---------------------------------------------------------------------------
// AsyncStorage key for cross-process tap-target
// ---------------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';
const TAP_TARGET_KEY = 'speakeasy.push.tap-target.v1';

export type TapTarget =
  | { kind: 'direct'; peerId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'call'; peerId: string };

async function persistTapTarget(target: TapTarget): Promise<void> {
  try {
    await AsyncStorage.setItem(TAP_TARGET_KEY, JSON.stringify(target));
  } catch {
    /* best-effort */
  }
}

async function consumeTapTarget(): Promise<TapTarget | undefined> {
  try {
    const raw = await AsyncStorage.getItem(TAP_TARGET_KEY);
    if (!raw) return undefined;
    await AsyncStorage.removeItem(TAP_TARGET_KEY);
    return JSON.parse(raw) as TapTarget;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Resolve a conversation_id to a navigation target
// ---------------------------------------------------------------------------

/**
 * Derive a TapTarget from the FCM data payload.
 *
 * For direct messages, the conversation_id is `dm-<sorted-hash>`. We don't
 * try to reverse the hash — instead we look up the conversation in the
 * local store to find the `peerUserId`. If the store hasn't hydrated yet
 * (cold start race), we persist the raw conversation_id and let the
 * navigation hook retry once stores are ready.
 */
export function resolveTarget(data: FcmData): TapTarget | undefined {
  const kind = data.notify_kind ?? 'message';
  const convId = data.conversation_id;
  const msgType = data.msg_type ?? 'direct';

  if (kind === 'call') {
    if (convId && msgType === 'direct') {
      const conv = useConversations.getState().byId[convId];
      if (conv?.peerUserId) {
        return { kind: 'call', peerId: conv.peerUserId };
      }
      return { kind: 'call', peerId: convId };
    }
    return undefined;
  }

  // Message push
  if (!convId) return undefined;

  if (msgType === 'group') {
    return { kind: 'group', groupId: convId };
  }

  // Direct — resolve peer from conversation store
  const conv = useConversations.getState().byId[convId];
  if (conv?.peerUserId) {
    return { kind: 'direct', peerId: conv.peerUserId };
  }

  // Cold-start race: store not hydrated. Use convId as peerId;
  // the navigation hook will re-resolve after hydration.
  return { kind: 'direct', peerId: convId };
}

// ---------------------------------------------------------------------------
// Navigation helper (module-level, callable from any listener or hook)
// ---------------------------------------------------------------------------

type RemoteMessageShape = {
  data?: Record<string, string | undefined> | null;
  messageId?: string;
};

/**
 * Navigate to the correct screen for a tap-target.
 *
 * Extracted from the React hook so it can be called from both the hook
 * and the module-level foreground/AppState listeners.
 */
export async function routeTarget(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  target: TapTarget,
  callOrchestrator?: CallOrchestrator,
): Promise<void> {
  if (!navRef.current) {
    await new Promise((r) => setTimeout(r, 100));
    if (!navRef.current) return;
  }

  diag('push-nav', 'routing tap-target', { target });

  try {
    switch (target.kind) {
      case 'direct': {
        let peerId = target.peerId;
        const conv = useConversations.getState().byId[peerId];
        if (conv?.peerUserId) {
          peerId = conv.peerUserId;
        } else if (peerId.startsWith('dm-')) {
          for (const [id, c] of Object.entries(useConversations.getState().byId)) {
            if (id === peerId && c.peerUserId) {
              peerId = c.peerUserId;
              break;
            }
          }
        }
        navRef.current.navigate('Chat', { peerId });
        break;
      }
      case 'group': {
        navRef.current.navigate('GroupChat', { groupId: target.groupId });
        break;
      }
      case 'call': {
        if (callOrchestrator) {
          try {
            const bridge = new CallKeepBridge({ orchestrator: callOrchestrator });
            await bridge.start();
            diag('push-nav', 'CallKeepBridge started from push tap');
          } catch (err) {
            diag('push-nav', 'CallKeepBridge start failed (non-fatal)', {
              err: String(err),
            });
          }
        }
        const activeCall = useCalls.getState().active;
        if (activeCall?.stage === 'incoming_ringing') {
          navRef.current.navigate('IncomingCall');
        } else {
          navRef.current.navigate('Call');
        }
        break;
      }
    }
  } catch (err) {
    diag('push-nav', 'navigation failed', { err: String(err), target });
  }
}

// ---------------------------------------------------------------------------
// Background message handler (registered outside React lifecycle)
// ---------------------------------------------------------------------------

let backgroundHandlerRegistered = false;

export function registerBackgroundMessageHandler(): void {
  if (backgroundHandlerRegistered) return;
  if (Platform.OS === 'ios') {
    backgroundHandlerRegistered = true;
    return;
  }

  backgroundHandlerRegistered = true; // Set early to prevent duplicate calls

  void requireMessaging().then((mod) => {
    if (!mod) return;
    const messaging = mod as {
      setBackgroundMessageHandler: (handler: (msg: RemoteMessageShape) => Promise<void>) => void;
    };

    messaging.setBackgroundMessageHandler(async (remoteMessage) => {
      const data = (remoteMessage.data ?? {}) as FcmData;
      diag('push-bg', 'background message received', {
        conversationId: data.conversation_id,
        kind: data.notify_kind,
        msgType: data.msg_type,
      });

      const target = resolveTarget(data);
      if (target) {
        await persistTapTarget(target);
        diag('push-bg', 'tap-target persisted', { target });
      }
    });

    diag('push', 'background message handler registered (async)');
  });
}

// ---------------------------------------------------------------------------
// Foreground message handler
// ---------------------------------------------------------------------------

let foregroundHandlerUnsub: (() => void) | undefined;

/**
 * Register the foreground `onMessage` handler ASAP — ideally at
 * module-load time, NOT inside a React useEffect.
 *
 * The "2x push notification" bug happened because onMessage was
 * previously registered inside a useEffect gated on `hydrated && userId`.
 * Any FCM push that arrived during the startup window caused Android to
 * auto-display the system notification because no onMessage listener
 * was attached yet. Meanwhile the WS also delivered the message,
 * triggering the in-app InAppBanner → user saw two notifications.
 *
 * Registering at module level closes that timing gap. Idempotent.
 */
export function registerForegroundMessageHandler(): void {
  if (foregroundHandlerUnsub) return;

  void requireMessaging().then((mod) => {
    if (!mod || foregroundHandlerUnsub) return;
    const messaging = mod as {
      onMessage: (handler: (msg: RemoteMessageShape) => void) => () => void;
    };

    foregroundHandlerUnsub = messaging.onMessage((remoteMessage) => {
      const data = (remoteMessage.data ?? {}) as FcmData;
      diag('push-fg', 'foreground push received (suppressed OS banner)', {
        conversationId: data.conversation_id,
        kind: data.notify_kind,
        msgType: data.msg_type,
      });
    });

    diag('push', 'foreground message handler registered (async)');
  });
}

export function unregisterForegroundMessageHandler(): void {
  foregroundHandlerUnsub?.();
  foregroundHandlerUnsub = undefined;
}

// ---------------------------------------------------------------------------
// Notification-opened listener — registered at module level
// ---------------------------------------------------------------------------

/**
 * Register `onNotificationOpenedApp` at module level.
 *
 * When the user taps a system notification while the app is
 * in the background, the OS foregrounds the activity and
 * `onNotificationOpenedApp` fires immediately — before any React
 * useEffect re-runs. If the subscription only exists inside a
 * useEffect gated on `hydrated && userId`, the event is lost and
 * the user lands on the conversation list instead of the chat.
 *
 * This listener persists the tap-target to AsyncStorage; the
 * `usePushNavigation` hook consumes it after hydration.
 */
let notificationOpenedRegistered = false;

export function registerNotificationOpenedListener(): void {
  if (notificationOpenedRegistered) return;
  notificationOpenedRegistered = true; // Set early to prevent duplicate calls

  void requireMessaging().then((mod) => {
    if (!mod) return;
    const messaging = mod as {
      onNotificationOpenedApp: (handler: (msg: RemoteMessageShape) => void) => () => void;
    };

    messaging.onNotificationOpenedApp((remoteMessage) => {
      if (!remoteMessage?.data) return;
      const data = remoteMessage.data as FcmData;
      const target = resolveTarget(data);
      if (target) {
        diag('push-open', 'warm resume from push tap — persisting for hook', {
          conversationId: data.conversation_id,
          kind: data.notify_kind,
          msgType: data.msg_type,
        });
        void persistTapTarget(target);
      }
    });

    diag('push', 'notification-opened listener registered (async)');
  });
}

// ---------------------------------------------------------------------------
// Navigation hook — the React-side consumer
// ---------------------------------------------------------------------------

/**
 * Hook that routes push-notification taps to the correct screen.
 *
 * Call once from the root component (App.tsx), passing the same
 * `navRef` used by the NavigationContainer.
 *
 * All three FCM listeners (background, foreground, notification-opened)
 * are registered at module level and persist tap-targets to AsyncStorage.
 * This hook consumes those targets after hydration completes.
 *
 * Handles:
 *   - Cold start: reads `getInitialNotification()` on mount
 *   - Warm resume: checks AsyncStorage (populated by module-level
 *     onNotificationOpenedApp listener)
 *   - Deferred: checks AsyncStorage (populated by background handler
 *     or foreground re-check)
 *   - Re-checks on every app foreground transition (via AppState)
 */
export function usePushNavigation(
  navRef: React.RefObject<NavigationContainerRef<RootStack> | null>,
  callOrchestrator?: CallOrchestrator,
): void {
  const hydrated = useConversations((s) => s.hydrated);
  const userId = useIdentity_safe();
  const routedRef = useRef(false);

  useEffect(() => {
    if (!hydrated || !userId) return;

    let cancelled = false;

    async function handleInitialNotification() {
      try {
        const messaging = await requireMessaging() as undefined | {
          getInitialNotification: () => Promise<RemoteMessageShape | null>;
        };

        if (!messaging) {
          diag('push-nav', 'messaging module unavailable — skipping initial notification check');
          // Still try deferred tap-target below
        } else {
          // 1. Cold start — check getInitialNotification
          const initial = await messaging.getInitialNotification();
          if (initial?.data && !routedRef.current) {
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
        }

        // 2. Deferred — consume any tap-target persisted by the
        //    background handler OR the module-level onNotificationOpenedApp
        //    listener.
        if (!routedRef.current) {
          const deferred = await consumeTapTarget();
          if (deferred) {
            diag('push-nav', 'deferred tap-target consumed after hydration', {
              target: deferred,
            });
            routedRef.current = true;
            await routeTarget(navRef, deferred, callOrchestrator);
            return;
          }
        }
      } catch (err) {
        diag('push-nav', 'FCM handler setup failed', { err: String(err) });
      }
    }

    handleInitialNotification();
    return () => { cancelled = true; };
  }, [hydrated, userId, callOrchestrator, navRef]);

  // Second effect: re-check AsyncStorage when app comes to foreground.
  // The module-level onNotificationOpenedApp listener persists tap-targets
  // to AsyncStorage, but the main effect above only runs once per
  // hydration cycle. This effect catches new targets from push taps that
  // happen after the app is already hydrated and running.
  useEffect(() => {
    if (!hydrated || !userId) return;

    let cancelled = false;
    let appStateSub: { remove: () => void } | undefined;

    async function checkForPendingTarget() {
      if (routedRef.current) return;
      const deferred = await consumeTapTarget();
      if (deferred && !cancelled) {
        diag('push-nav', 'foreground check found pending tap-target', {
          target: deferred,
        });
        routedRef.current = true;
        await routeTarget(navRef, deferred, callOrchestrator);
      }
    }

    // We need AppState but it's from 'react-native' — import it inline
    // to avoid the mock complexity at test time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { AppState } = require('react-native') as {
      AppState: {
        addEventListener: (type: 'change', handler: (state: string) => void) => { remove: () => void };
      };
    };

    appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Give the module-level onNotificationOpenedApp listener a moment
        // to finish persisting the tap-target before we consume it.
        setTimeout(() => { void checkForPendingTarget(); }, 500);
      }
    });

    return () => {
      cancelled = true;
      appStateSub?.remove();
    };
  }, [hydrated, userId, callOrchestrator, navRef]);
}

// ---------------------------------------------------------------------------
// Utility — safe identity read (avoids import-cycle with full useIdentity)
// ---------------------------------------------------------------------------

import { useIdentity } from '../store/identity.js';

function useIdentity_safe(): string | undefined {
  return useIdentity((s) => s.userId);
}
