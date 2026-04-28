import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { OnboardingScreen } from '../screens/OnboardingScreen.js';
import { IdRevealScreen } from '../screens/IdRevealScreen.js';
import { ConversationsScreen } from '../screens/ConversationsScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { NewChatScreen } from '../screens/NewChatScreen.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';

export type RootStack = {
  Onboarding: undefined;
  IdReveal: { userId: string };
  Conversations: undefined;
  Chat: { peerId: string };
  NewChat: undefined;
};

const Stack = createNativeStackNavigator<RootStack>();

export function RootNavigator() {
  const userId = useIdentity((s) => s.userId);
  const openDirect = useConversations((s) => s.openDirect);

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{ headerShown: false, animation: 'fade', animationDuration: 400 }}
      >
        {!userId ? (
          <Stack.Screen name="Onboarding">
            {({ navigation }: NativeStackScreenProps<RootStack, 'Onboarding'>) => (
              <OnboardingScreen
                onEnrolled={(id) => navigation.replace('IdReveal', { userId: id })}
              />
            )}
          </Stack.Screen>
        ) : (
          <>
            <Stack.Screen name="IdReveal">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'IdReveal'>) => (
                <IdRevealScreen
                  userId={route.params?.userId ?? userId}
                  onContinue={() => navigation.replace('Conversations')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Conversations">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Conversations'>) => (
                <ConversationsScreen
                  onOpenChat={(peerId) => navigation.navigate('Chat', { peerId })}
                  onNewChat={() => navigation.navigate('NewChat')}
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
                    // Replace the modal so back from chat lands on the list,
                    // not on the new-chat form.
                    navigation.replace('Chat', { peerId });
                  }}
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
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
