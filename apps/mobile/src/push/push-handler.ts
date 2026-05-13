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
 * All navigation goes through the `usePushNavigation` hook below,
 * which reads a persisted tap-target on mount and re-routes on
 * every new `onNotificationOpenedApp` event.
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
    // Call pushes include the conversation_id which is a direct-message
    // channel. Resolve the peer from it if possible.
    if (convId && msgType === 'direct') {
      const conv = useConversations.getState().byId[convId];
      if (conv?.peerUserId) {
        return { kind: 'call', peerId: conv.peerUserId };
      }
      // Store not hydrated yet — persist conversation_id for deferred
      // routing. We'll need the peer to start the call orchestrator.
      // Fall through to a best-effort navigation.
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

  // Cold-start race: store not hydrated. Persist convId and let
  // the navigation hook retry after hydration.
  return { kind: 'direct', peerId: convId };
}

// ---------------------------------------------------------------------------
// Background message handler (registered outside React lifecycle)
// ---------------------------------------------------------------------------

let backgroundHandlerRegistered = false;

export function registerBackgroundMessageHandler(): void {
  if (backgroundHandlerRegistered) return;
  if (Platform.OS === 'ios') {
    // iOS: setBackgroundMessageHandler is not supported on iOS —
    // the OS handles notification taps natively and delivers the
    // data via getInitialNotification / onNotificationOpenedApp.
    // On Android, this is the only way to run code when the app
    // is in the background/killed state.
    backgroundHandlerRegistered = true;
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const messaging = require('@react-native-firebase/messaging') as {
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

    backgroundHandlerRegistered = true;
    diag('push', 'background message handler registered');
  } catch (err) {
    diag('push', 'setBackgroundMessageHandler registration failed', {
      err: String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Foreground message handler
// ---------------------------------------------------------------------------

/**
 * Register the foreground `onMessage` handler. Without this, FCM shows
 * a system notification banner on top of our in-app InAppBanner when the
 * app is foreground — the "duplicate push notifications" bug.
 *
 * By intercepting the foreground message, we suppress the OS banner.
 * The existing `notifyInbound` → `decideBanner` pipeline already handles
 * in-app notification for live-delivered messages. For messages that
 * arrive only via push (app was background when WS closed, now
 * foregrounded but WS hasn't reconnected yet), we just absorb the
 * duplicate — the WS drain will populate the conversation list shortly.
 */
let foregroundHandlerUnsub: (() => void) | undefined;

/**
 * Register the foreground `onMessage` handler ASAP — ideally at
 * module-load time, NOT inside a React useEffect.
 *
 * The "2x push notification" bug happened because onMessage was
 * previously registered inside a useEffect gated on `hydrated && userId`.
 * Any FCM push that arrived during the startup window (after the native
 * module initialised but before React hydration) caused Android to
 * auto-display the system notification because no onMessage listener
 * was attached yet. Meanwhile the WS also delivered the message,
 * triggering the in-app InAppBanner → user saw two notifications.
 *
 * Registering at module level closes that timing gap. The handler is
 * idempotent — calling it again is a no-op.
 */
export function registerForegroundMessageHandler(): void {
  if (foregroundHandlerUnsub) return; // already registered

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const messaging = require('@react-native-firebase/messaging') as {
      onMessage: (handler: (msg: RemoteMessageShape) => void) => () => void;
    };

    foregroundHandlerUnsub = messaging.onMessage((remoteMessage) => {
      const data = (remoteMessage.data ?? {}) as FcmData;
      diag('push-fg', 'foreground push received (suppressed OS banner)', {
        conversationId: data.conversation_id,
        kind: data.notify_kind,
        msgType: data.msg_type,
      });

      // We intentionally do NOT show an additional in-app banner here.
      // If the WS is connected, the live frame already triggered
      // `notifyInbound`. If the WS is reconnecting, the banner from
      // the WS frame will fire within a few seconds.
      //
      // The sole purpose of this handler is to tell FCM "the app
      // handled this notification" so Android/iOS don't also show
      // the system tray banner → no duplicate.
    });

    diag('push', 'foreground message handler registered');
  } catch (err) {
    diag('push', 'onMessage registration failed', { err: String(err) });
  }
}

export function unregisterForegroundMessageHandler(): void {
  foregroundHandlerUnsub?.();
  foregroundHandlerUnsub = undefined;
}

// ---------------------------------------------------------------------------
// Navigation hook — the React-side consumer
// ---------------------------------------------------------------------------

type RemoteMessageShape = {
  data?: Record<string, string | undefined> | null;
  messageId?: string;
};

/**
 * Hook that routes push-notification taps to the correct screen.
 *
 * Call once from the root component (App.tsx), passing the same
 * `navRef` used by the NavigationContainer.
 *
 * Handles:
 *   - Cold start: reads `getInitialNotification()` on mount
 *   - Warm resume: subscribes to `onNotificationOpenedApp`
 *   - Deferred: checks AsyncStorage for a target persisted by the
 *     background handler (covers the Android killed-app case)
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

    async function routeTarget(target: TapTarget) {
      if (!navRef.current) {
        // Navigation container not mounted yet — defer by a tick
        await new Promise((r) => setTimeout(r, 100));
        if (cancelled || !navRef.current) return;
      }

      diag('push-nav', 'routing tap-target', { target });

      try {
        switch (target.kind) {
          case 'direct': {
            // target.peerId might be a conversation_id if the store wasn't
            // hydrated when we resolved. Re-resolve now.
            let peerId = target.peerId;
            const conv = useConversations.getState().byId[peerId];
            if (conv?.peerUserId) {
              peerId = conv.peerUserId;
            } else if (peerId.startsWith('dm-')) {
              // Try to find the conversation by walking the store
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
            // For call pushes, we navigate to the incoming call screen.
            // The call orchestrator will pick up the buffered offer on
            // WS reconnect. If the orchestrator is available, we also
            // warm up the CallKeep bridge so the native ring UI shows.
            if (callOrchestrator) {
              try {
                // Bridge is lazy — calling start() ensures the native
                // ring UI is available if the OS has granted the
                // "Calling accounts" permission.
                const bridge = new CallKeepBridge({ orchestrator: callOrchestrator });
                await bridge.start();
                diag('push-nav', 'CallKeepBridge started from push tap');
              } catch (err) {
                diag('push-nav', 'CallKeepBridge start failed (non-fatal)', {
                  err: String(err),
                });
              }
            }
            // If there's an active incoming call in the store, navigate
            // to IncomingCall. Otherwise, fall through to Call screen
            // (which handles the "no active call" state gracefully).
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

    async function handleInitialNotification() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const messaging = require('@react-native-firebase/messaging') as {
          getInitialNotification: () => Promise<RemoteMessageShape | null>;
          onNotificationOpenedApp: (handler: (msg: RemoteMessageShape) => void) => () => void;
        };

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
            await routeTarget(target);
            return;
          }
        }

        // 2. Deferred — check AsyncStorage for background-handler target
        if (!routedRef.current) {
          const deferred = await consumeTapTarget();
          if (deferred) {
            diag('push-nav', 'deferred tap-target from background handler', {
              target: deferred,
            });
            routedRef.current = true;
            await routeTarget(deferred);
            return;
          }
        }

        // 3. Warm resume — subscribe to onNotificationOpenedApp
        const unsub = messaging.onNotificationOpenedApp((remoteMessage) => {
          if (!remoteMessage?.data) return;
          const data = remoteMessage.data as FcmData;
          const target = resolveTarget(data);
          if (target) {
            diag('push-nav', 'warm resume from push tap', {
              conversationId: data.conversation_id,
              kind: data.notify_kind,
            });
            void routeTarget(target);
          }
        });

        return () => unsub();
      } catch (err) {
        diag('push-nav', 'FCM handler setup failed', { err: String(err) });
        return undefined;
      }
    }

    const cleanup = handleInitialNotification();
    return () => {
      cancelled = true;
      void cleanup.then((fn) => fn?.());
    };
  }, [hydrated, userId, callOrchestrator]);
}

// ---------------------------------------------------------------------------
// Utility — safe identity read (avoids import-cycle with full useIdentity)
// ---------------------------------------------------------------------------

import { useIdentity } from '../store/identity.js';

function useIdentity_safe(): string | undefined {
  return useIdentity((s) => s.userId);
}
