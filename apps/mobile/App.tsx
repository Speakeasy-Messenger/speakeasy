import React, { useEffect } from 'react';
import { StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { conversationIdForCommunity, conversationIdForDirect, conversationIdForGroup } from '@speakeasy/shared';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import { useIdentity } from './src/store/identity.js';
import { useConversations } from './src/store/conversations.js';
import { useDistributionIds } from './src/store/distribution-ids.js';
import { api, getWsClient, groupMessaging, signalProtocol, vouchflow } from './src/services.js';
import { makeGroupOrchestrator } from './src/crypto/group-orchestration.js';
import { makeMessageRouter } from './src/ws/message-router.js';
import { makeReplenisher } from './src/crypto/replenish.js';
import { diag } from './src/diag/log.js';
import { colors } from './src/theme/index.js';

export default function App() {
  const userId = useIdentity((s) => s.userId);
  const hydrated = useIdentity((s) => s.hydrated);

  // Pull persisted identity off disk on first mount. Renders a blank
  // screen until done so the navigator doesn't briefly show Onboarding
  // (no userId yet) and then snap to Conversations (userId arrived).
  useEffect(() => {
    if (!hydrated) {
      void useIdentity.getState().hydrate();
    }
  }, [hydrated]);

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
    });

    const unsubscribe = ws.subscribe(router);
    return () => {
      diag('app', 'cleanup router for userId', { userId });
      unsubscribe();
      ws.close();
    };
  }, [userId]);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle="dark-content"
        backgroundColor={colors.cream}
      />
      {hydrated ? (
        <RootNavigator />
      ) : (
        <View style={{ flex: 1, backgroundColor: colors.cream }} />
      )}
    </SafeAreaProvider>
  );
}
