import React from 'react';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { InAppBanner } from '../components/InAppBanner.js';
import type { BannerData } from '../store/banner.js';
import { OnboardingScreen } from '../screens/OnboardingScreen.js';
import { IdRevealScreen } from '../screens/IdRevealScreen.js';
import { ConversationsScreen } from '../screens/ConversationsScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { GroupChatScreen } from '../screens/GroupChatScreen.js';
import { NewChatScreen } from '../screens/NewChatScreen.js';
import { NewGroupScreen } from '../screens/NewGroupScreen.js';
import { DiagnosticsScreen } from '../screens/DiagnosticsScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';

export type RootStack = {
  Onboarding: undefined;
  IdReveal: { userId: string };
  Conversations: undefined;
  Chat: { peerId: string };
  GroupChat: { groupId: string };
  NewChat: undefined;
  NewGroup: undefined;
  Diagnostics: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStack>();

interface RootNavigatorProps {
  navRef: React.RefObject<NavigationContainerRef<RootStack>>;
  onBannerTap: (target: BannerData['target']) => void;
}

export function RootNavigator({ navRef, onBannerTap }: RootNavigatorProps) {
  const userId = useIdentity((s) => s.userId);
  const openDirect = useConversations((s) => s.openDirect);

  return (
    <NavigationContainer ref={navRef}>
      <InAppBanner onTap={onBannerTap} />
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: 'fade', animationDuration: 400 }}
      >
        {!userId ? (
          <Stack.Screen name="Onboarding">
            {({ navigation }: NativeStackScreenProps<RootStack, 'Onboarding'>) => (
              <OnboardingScreen
                // Side-effect of enrollment is `useIdentity.setUserId()`,
                // which flips this stack to the authed Group below; the
                // Group's initial route is Conversations. The `replace`
                // here is a no-op once the stacks swap, but kept for
                // clarity that the intended UX is post-enroll → IdReveal.
                // (IdReveal is a one-time celebration; if missed via the
                // race, it's accessible from a future "show my id" link.)
                onEnrolled={(id) => navigation.replace('IdReveal', { userId: id })}
              />
            )}
          </Stack.Screen>
        ) : (
          // Initial route is Conversations: re-launches with a hydrated
          // identity should go straight there, not back through IdReveal
          // (which is a one-time post-enroll celebration). Onboarding's
          // onEnrolled explicitly navigates to IdReveal for fresh enrolls.
          <Stack.Group screenOptions={{}}>
            <Stack.Screen name="Conversations">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Conversations'>) => (
                <ConversationsScreen
                  onOpenChat={(peerId) => navigation.navigate('Chat', { peerId })}
                  onOpenGroup={(groupId) => navigation.navigate('GroupChat', { groupId })}
                  onNewChat={() => navigation.navigate('NewChat')}
                  onNewGroup={() => navigation.navigate('NewGroup')}
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                  onOpenSettings={() => navigation.navigate('Settings')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="IdReveal">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'IdReveal'>) => (
                <IdRevealScreen
                  userId={route.params?.userId ?? userId}
                  onContinue={() => navigation.replace('Conversations')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Diagnostics">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Diagnostics'>) => (
                <DiagnosticsScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="Settings">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Settings'>) => (
                <SettingsScreen
                  onBack={() => navigation.goBack()}
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="NewChat"
              options={{ presentation: 'modal' }}
            >
              {({ navigation }: NativeStackScreenProps<RootStack, 'NewChat'>) => (
                <NewChatScreen
                  onCancel={() => navigation.goBack()}
                  onStart={(peerId) => {
                    openDirect(userId, peerId);
                    navigation.replace('Chat', { peerId });
                  }}
                />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="NewGroup"
              options={{ presentation: 'modal' }}
            >
              {({ navigation }: NativeStackScreenProps<RootStack, 'NewGroup'>) => (
                <NewGroupScreen
                  onCancel={() => navigation.goBack()}
                  onCreated={(groupId) => navigation.replace('GroupChat', { groupId })}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Chat">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'Chat'>) => (
                <ChatScreen
                  peerId={route.params.peerId}
                  onBack={() => navigation.goBack()}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="GroupChat">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'GroupChat'>) => (
                <GroupChatScreen
                  groupId={route.params.groupId}
                  onBack={() => navigation.goBack()}
                />
              )}
            </Stack.Screen>
          </Stack.Group>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
