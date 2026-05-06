import React, { useEffect, useRef } from 'react';
import { AppState, StatusBar, View } from 'react-native';
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
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider.js';
import { ensureServerBinding } from './src/auth/ensure-enrolled.js';
import { useUiState } from './src/store/ui.js';
import { useBanner } from './src/store/banner.js';
import { api, getWsClient, groupMessaging, pushNotifications, signalProtocol, vouchflow } from './src/services.js';
import { makeGroupOrchestrator } from './src/crypto/group-orchestration.js';
import { makeMessageRouter } from './src/ws/message-router.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { diag } from './src/diag/log.js';
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
    }
  }, [hydrated]);

  // After hydration, if we have a cached identity, make sure the
  // server still knows about us. The alpha sandbox runs in-memory
  // and forgets every enrollment on restart; without this guard a
  // returning user gets 401 not_enrolled on every authed request and
  // the WS loops forever in `reconnecting`. `ensureServerBinding`
  // re-enrolls silently with the same handle + cached identity key.
  useEffect(() => {
    if (!hydrated || !userId) return;
    void ensureServerBinding({ signalProtocol, vouchflow });
    // We only run on hydrate-then-userId-becomes-known. The
    // re-enroll itself is idempotent so a stray double-call is fine.
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
    getToken().then((dt) => {
      return pushNotifications.getToken().then((pushResult) => {
        if (pushResult) {
          void api.registerPushToken(dt, pushResult.pushToken, pushResult.platform).catch(() => {});
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
      onPrekeysLow: () => void replenisher.trigger(),
      addToConversation: (conversationId, msg) =>
        useConversations.getState().add(conversationId, msg),
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

    return () => {
      diag('app', 'cleanup router for userId', { userId });
      lifecycleSub.remove();
      unsubscribe();
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
