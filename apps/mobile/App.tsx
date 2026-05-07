import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { conversationIdForCommunity, conversationIdForDirect, conversationIdForGroup } from '@speakeasy/shared';
import type { NavigationContainerRef } from '@react-navigation/native';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import type { RootStack } from './src/navigation/RootNavigator.js';
import { useIdentity } from './src/store/identity.js';
import { useConversations } from './src/store/conversations.js';
import { useGroups } from './src/store/groups.js';
import { useDistributionIds } from './src/store/distribution-ids.js';
import { useSettings } from './src/store/settings.js';
import { useProfiles } from './src/store/profiles.js';
import { useOnboardingCards } from './src/store/onboarding-cards.js';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider.js';
import { ensureServerBinding } from './src/auth/ensure-enrolled.js';
import { saveAttachmentsToGallery } from './src/attachments/save-to-gallery.js';
import { useUiState } from './src/store/ui.js';
import { useBanner } from './src/store/banner.js';
import { api, getWsClient, groupMessaging, pushNotifications, signalProtocol, vouchflow } from './src/services.js';
import { makeGroupOrchestrator } from './src/crypto/group-orchestration.js';
import { makeMessageRouter } from './src/ws/message-router.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { CallOrchestrator } from './src/calls/orchestrator.js';
import { ensureSessionWithPeer } from './src/crypto/session.js';
import { useCalls } from './src/store/calls.js';
import { reactNativeWebRtcPeerFactory } from './src/calls/webrtc-peer.js';
// CallKeepBridge intentionally not imported here — see deferred-init
// note below. The bridge module still ships in the bundle so the next
// release can wire it without another dep dance.
import { diag } from './src/diag/log.js';
import { parseAdd } from './src/utils/handle-link.js';
import { colors } from './src/theme/index.js';

// Global unhandled-rejection handler — prevents promise rejections
// from crashing the RN host on Android.
type ErrorUtilsGlobal = {
  ErrorUtils?: {
    getGlobalHandler?: () => ((e: Error, isFatal?: boolean) => void) | undefined;
    setGlobalHandler?: (h: (e: Error, isFatal?: boolean) => void) => void;
  };
};
const _origHandler = (globalThis as ErrorUtilsGlobal).ErrorUtils?.getGlobalHandler?.();
(globalThis as ErrorUtilsGlobal).ErrorUtils?.setGlobalHandler?.((e: Error, isFatal?: boolean) => {
  diag('app', 'global error', { message: e.message, isFatal: String(isFatal) });
  if (typeof _origHandler === 'function') _origHandler(e, isFatal);
});

export default function App() {
  const userId = useIdentity((s) => s.userId);
  const hydrated = useIdentity((s) => s.hydrated);
  const navRef = useRef<NavigationContainerRef<RootStack>>(null);
  // useState (not useRef) — assigning to a ref doesn't re-render, so the
  // RootNavigator below would never see the orchestrator. State triggers
  // a re-render and the navigator picks up the new prop on next pass.
  const [callOrchestrator, setCallOrchestrator] = useState<CallOrchestrator | undefined>(undefined);

  // Pull persisted identity AND conversations off disk on first mount.
  // Renders a blank screen until both are done so the navigator doesn't
  // briefly show Onboarding (no userId yet) and then snap to
  // Conversations (userId arrived) — and so the chat list is populated
  // from disk before the user can interact with it.
  useEffect(() => {
    if (!hydrated) {
      void useIdentity.getState().hydrate();
      void useConversations.getState().hydrate();
      void useGroups.getState().hydrate();
      void useDistributionIds.getState().hydrate();
      void useSettings.getState().hydrate();
      void useProfiles.getState().hydrate();
      void useOnboardingCards.getState().hydrate();
      void useCalls.getState().hydrate();
    }
  }, [hydrated]);

  // After hydration, if we have a cached identity, refresh
  // authentication eagerly before any authed request can fire.
  //
  // Why: the persisted `deviceToken` may be stale (Vouchflow's
  // server-side freshness window is ~5min) or missing entirely
  // (reinstall wiped Vouchflow's keystore but Speakeasy's identity
  // somehow survived — adb install -r, dev-build state bleed, etc.).
  // Without this, the navigator renders Conversations and the user
  // can tap things that hit 401 `device_not_found` / `not_enrolled`,
  // each surfaced as a different inline error. Bug report: "many
  // actions fail saying the device is not authenticated".
  //
  // Strategy: call `vouchflow.verify({context: 'login'})` first.
  // The CachingVouchflowClient + native SDK return the in-keystore
  // token if it's fresh (no biometric prompt); otherwise they
  // prompt biometric and re-attest. Then write the fresh token
  // through to the identity store, then re-bind with the server
  // (silent re-enroll if the server forgot us). On hard failure —
  // verify itself rejected, e.g. device removed from Vouchflow's
  // attestation universe — reset identity so the navigator falls
  // back to Onboarding instead of leaving the user stranded on a
  // dead Conversations screen.
  useEffect(() => {
    if (!hydrated || !userId) return;
    void (async () => {
      // Only re-verify if the cached deviceToken is missing or older
      // than the server's freshness window. Prior behaviour was to
      // re-attest on every cold launch, which (a) churned the
      // biometric prompt every time the app resumed from a long
      // background, and (b) meant the status pip greyed for a
      // few seconds while we waited on Vouchflow + Play Integrity.
      // The server's window is 24h by default (see VouchflowValidator
      // DEFAULT_MAX_AGE_MS). Mobile re-verifies a comfortable margin
      // before that — 22h — so a token that's still server-valid
      // is NEVER pre-emptively refreshed at launch.
      const FRESHNESS_MS = 22 * 60 * 60_000;
      const { deviceToken: cachedToken, deviceTokenIssuedAt: issuedAt } =
        useIdentity.getState();
      const ageMs = issuedAt ? Date.now() - issuedAt : Number.POSITIVE_INFINITY;
      const tokenStillFresh = !!cachedToken && ageMs < FRESHNESS_MS;

      if (tokenStillFresh) {
        diag('app', 'launch verify skipped — cached token still fresh', {
          userId,
          ageMs,
        });
      } else {
        try {
          const r = await vouchflow.verify({ context: 'login' });
          useIdentity.getState().setDeviceToken(r.deviceToken);
          diag('app', 'launch verify OK', { userId, prevAgeMs: ageMs });
        } catch (err) {
          diag('app', 'launch verify FAILED — clearing identity', {
            err: String(err),
          });
          await useIdentity.getState().reset();
          return;
        }
      }
      void ensureServerBinding({ signalProtocol, vouchflow });
    })();
  }, [hydrated, userId]);

  // Deep-link handler: when the user (or a peer) scans a Speakeasy QR
  // with their phone camera, the OS hands us a `speakeasy://add?handle=…`
  // URL. We route to the NewChat screen with the handle prefilled so
  // the recipient can confirm + start the chat in one tap.
  //
  // Handles two cases:
  //   - Cold start: the URL came in via the launching intent. We pull
  //     it off `Linking.getInitialURL()` and navigate once the user is
  //     enrolled (otherwise the navigation target doesn't exist yet).
  //   - Warm: the app is already running; `addEventListener('url')`
  //     fires synchronously when the OS hands us a new URL.
  useEffect(() => {
    if (!hydrated || !userId) return;
    let cancelled = false;
    function handleUrl(url: string | null | undefined): void {
      if (!url) return;
      const handle = parseAdd(url);
      if (!handle) {
        diag('app', 'deep-link ignored (not a valid handle URL)', { url });
        return;
      }
      if (handle === userId) {
        diag('app', 'deep-link ignored (self handle)', { handle });
        return;
      }
      diag('app', 'deep-link → NewChat', { handle });
      navRef.current?.navigate('NewChat', { initialPeerId: handle });
    }
    void Linking.getInitialURL().then((url) => {
      if (!cancelled) handleUrl(url);
    });
    const sub = Linking.addEventListener('url', (ev) => handleUrl(ev.url));
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrated, userId]);

  // Open WebSocket once enrolled. Close + reset when identity is cleared.
  // Token comes from the identity store (set at signup); we only fall
  // back to vouchflow.verify() if the store is empty (unexpected — implies
  // we got into App-with-userId without going through OnboardingScreen).
  useEffect(() => {
    if (!userId) return;
    diag('app', 'mounting router for userId', { userId });
    const getToken = async () => {
      const cached = useIdentity.getState().deviceToken;
      if (cached) return cached;
      const r = await vouchflow.verify({ context: 'login' });
      useIdentity.getState().setDeviceToken(r.deviceToken);
      return r.deviceToken;
    };
    const ws = getWsClient(getToken);
    ws.connect();

    // Phase 5d: register push token on every app start. Token can
    // rotate (FCM invalidates on app reinstall, OS update). Best-effort.
    // Errors are non-fatal — push is a nice-to-have, not a blocker.
    // Also rides along the current notificationPrivacy preference so a
    // user who toggled privacy mode while offline gets it synced up on
    // the next launch even if the inline toggle-time request failed.
    getToken().then((dt) => {
      return pushNotifications.getToken().then((pushResult) => {
        if (pushResult) {
          const privacy = useSettings.getState().notificationPrivacy;
          void api
            .registerPushToken(dt, pushResult.pushToken, pushResult.platform, privacy)
            .catch(() => {});
        }
      });
    }).catch((err) => {
      diag('app', 'push token registration failed (non-fatal)', { err: String(err) });
    });

    // Replenisher dedupes concurrent prekey-low signals onto a single
    // in-flight round.
    const replenisher = makeReplenisher({ api, signalProtocol, getDeviceToken: getToken });

    // Group orchestrator (Phase 5b) — owns the SKDM bootstrap state and
    // does the per-group send fan-out.
    const orchestrator = makeGroupOrchestrator({
      api,
      signalProtocol,
      groupMessaging,
      ws,
      getDeviceToken: getToken,
      getOrCreateDistributionId: (groupId) =>
        useDistributionIds.getState().getOrCreate(groupId),
    });

    // Set of msgIds we've already shown a banner for. Survives WS
    // flaps so a server redelivery doesn't fire a duplicate banner.
    // (`useConversations.add` dedupes the bubble; this dedupes the
    // notification too.) Bounded by message volume per session —
    // pruned only on app restart.
    const notifiedMsgIds = new Set<string>();

    // Voice-call orchestrator. Owns the WebRTC peer connection and
    // the call_* WS frame round-trip. Reuses the same Signal session
    // ChatScreen does, so calls go through the existing 1:1 crypto.
    //
    // Wrapped so a constructor failure in any new dep can't crash the
    // post-enrollment effect. Messaging keeps working even if calling
    // is broken.
    let callOrch: CallOrchestrator | undefined;
    try {
      callOrch = new CallOrchestrator({
        myUserId: userId,
        signalProtocol,
        api,
        peerFactory: reactNativeWebRtcPeerFactory,
        getDeviceToken: getToken,
        send: (frame) => ws.send(frame),
        ensureSessionWithPeer,
        onStateChange: (call) => useCalls.getState().setActive(call),
        onCallFinished: (entry) => useCalls.getState().recordHistory(entry),
      });
      setCallOrchestrator(callOrch);
    } catch (err) {
      diag('app', 'CallOrchestrator init FAILED — calls disabled', {
        err: String(err),
      });
    }

    // CallKeep (CallKit / ConnectionService) deferred — a misconfigured
    // foregroundService notificationIcon was crashing the app right
    // after enrollment. Calls still work via the in-app
    // IncomingCallScreen / CallScreen; the lock-screen ring UI lands in
    // a follow-up once we've verified the right resource references on
    // hardware. Bridge code remains for that future enable.

    // Single ws.subscribe wired to the unified router. Every screen
    // (ChatScreen, GroupChatScreen, future CommunityScreen) reads from
    // the conversations store; nobody owns the ws subscription anymore.
    const router = makeMessageRouter({
      myUserId: userId,
      api,
      signalProtocol,
      groupMessaging,
      ws,
      orchestrator,
      // Optional — when callOrch failed to construct, we drop call_*
      // frames; messaging still works.
      onCallFrame: callOrch
        ? (frame) => void callOrch!.handleFrame(frame)
        : undefined,
      onPrekeysLow: () => void replenisher.trigger(),
      addToConversation: (conversationId, msg) =>
        useConversations.getState().add(conversationId, msg),
      markDelivered: (msgId) =>
        useConversations.getState().markDelivered(msgId),
      conversationIdFor: (kind, senderId, to) => {
        switch (kind) {
          case 'direct':
            return conversationIdForDirect(senderId, to);
          case 'group':
            return conversationIdForGroup(to);
          case 'community':
            return conversationIdForCommunity(to);
        }
      },
      // Best-effort: photos/gifs land in the device gallery so the
      // recipient can revisit them outside Speakeasy (and so the
      // dissolve TTL doesn't take them away forever). Files are
      // skipped — there's no system "documents" gallery analog.
      onInboundAttachments: (attachments) => {
        void saveAttachmentsToGallery(attachments);
      },
      notifyInbound: ({ msgId, from, text, target }) => {
        if (notifiedMsgIds.has(msgId)) return;
        notifiedMsgIds.add(msgId);
        if (!useSettings.getState().inAppNotificationsEnabled) return;
        // Suppress when the user is already on this conversation's screen.
        const activeConv = useUiState.getState().activeConversationId;
        const targetConv =
          target.kind === 'direct'
            ? conversationIdForDirect(userId, target.peerId)
            : conversationIdForGroup(target.groupId);
        if (activeConv === targetConv) return;
        useBanner.getState().show({
          id: msgId,
          sender: from,
          text,
          target,
        });
      },
    });

    const unsubscribe = ws.subscribe(router);

    // App lifecycle: when the OS pauses the app, the underlying TCP
    // socket may get killed silently. On resume the WS client thinks
    // it's still connected, the next ws.send() throws, and the user
    // sees a crash. Force a reconnect on `active` if we're not
    // already in `authed` state.
    const lifecycleSub = AppState.addEventListener('change', (next) => {
      diag('app', 'AppState change', { next, wsState: ws.getState() });
      if (next === 'active') {
        const state = ws.getState();
        // `reconnecting` already has a timer pending — the WS client
        // turned `connect()` into a no-op for that state in the loop
        // fix, so calling it would just produce a misleading
        // "forcing reconnect" log line. Skip and let the timer fire.
        if (
          state !== 'authed' &&
          state !== 'authenticating' &&
          state !== 'connecting' &&
          state !== 'reconnecting'
        ) {
          diag('app', 'AppState active → forcing reconnect', { prevState: state });
          try {
            ws.connect();
          } catch (err) {
            diag('app', 'reconnect threw', { err: String(err) });
          }
        }
      }
    });

    // Bring the IncomingCallScreen up automatically when the
    // orchestrator transitions into `incoming_ringing`.
    const callsUnsub = useCalls.subscribe((s, prev) => {
      if (
        s.active?.stage === 'incoming_ringing' &&
        prev?.active?.stage !== 'incoming_ringing'
      ) {
        navRef.current?.navigate('IncomingCall');
      }
    });

    return () => {
      diag('app', 'cleanup router for userId', { userId });
      lifecycleSub.remove();
      unsubscribe();
      callsUnsub();
      setCallOrchestrator(undefined);
      ws.close();
    };
  }, [userId]);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        {hydrated ? (
          <RootNavigator
            navRef={navRef}
            callOrchestrator={callOrchestrator}
            onBannerTap={(target) => {
              if (target.kind === 'direct') {
                navRef.current?.navigate('Chat', { peerId: target.peerId });
              } else {
                navRef.current?.navigate('GroupChat', { groupId: target.groupId });
              }
            }}
          />
        ) : (
          <View style={{ flex: 1, backgroundColor: colors.cream }} />
        )}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * StatusBar that flips with the active theme. Lives inside the
 * ThemeProvider so it can read `useTheme()`. The status bar is owned
 * by the OS shell, so backgroundColor here paints the Android tinted
 * area to match the workspace canvas (or stays dark on the brand
 * canvas — Onboarding / IdReveal handle their own status-bar color
 * via their SafeAreaView).
 */
function ThemedStatusBar(): React.JSX.Element {
  const t = useTheme();
  return (
    <StatusBar
      barStyle={t.mode === 'dark' ? 'light-content' : 'dark-content'}
      backgroundColor={t.canvas}
    />
  );
}
