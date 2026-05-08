import React from 'react';
import { Platform, View } from 'react-native';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Svg, { Path } from 'react-native-svg';
import { InAppBanner } from '../components/InAppBanner.js';
import type { BannerData } from '../store/banner.js';
import { OnboardingFlow } from '../screens/onboarding/OnboardingFlow.js';
import { IdRevealScreen } from '../screens/IdRevealScreen.js';
import { ConversationsScreen } from '../screens/ConversationsScreen.js';
import { CallsScreen } from '../screens/CallsScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { GroupChatScreen } from '../screens/GroupChatScreen.js';
import { ManageGroupMembersScreen } from '../screens/ManageGroupMembersScreen.js';
import { NewChatScreen } from '../screens/NewChatScreen.js';
import { NewGroupScreen } from '../screens/NewGroupScreen.js';
import { DiagnosticsScreen } from '../screens/DiagnosticsScreen.js';
import { AvatarPreviewScreen } from '../screens/AvatarPreviewScreen.js';
import { InviteFriendsScreen } from '../screens/InviteFriendsScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';
import { CallScreen } from '../screens/CallScreen.js';
import { IncomingCallScreen } from '../screens/IncomingCallScreen.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
import { PhoneIcon } from '../components/icons/CallIcons.js';
import { useColors } from '../theme/index.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

export type RootStack = {
  Onboarding: undefined;
  IdReveal: { userId: string };
  /** Home is the bottom-tab nav: Chats + Calls. */
  Home: undefined;
  Chat: { peerId: string };
  GroupChat: { groupId: string };
  ManageGroupMembers: { groupId: string };
  NewChat: { initialPeerId?: string } | undefined;
  NewGroup: undefined;
  Diagnostics: undefined;
  AvatarPreview: undefined;
  InviteFriends: undefined;
  Settings: undefined;
  Call: undefined;
  IncomingCall: undefined;
};

type HomeTabs = {
  Chats: undefined;
  Calls: undefined;
};

const Stack = createNativeStackNavigator<RootStack>();
const Tabs = createBottomTabNavigator<HomeTabs>();

interface RootNavigatorProps {
  navRef: React.RefObject<NavigationContainerRef<RootStack>>;
  onBannerTap: (target: BannerData['target']) => void;
  /**
   * Optional voice-call orchestrator. When undefined the call screens
   * are inert and call entry points are hidden — useful for tests that
   * render the navigator without bootstrapping the WS pipeline.
   */
  callOrchestrator?: CallOrchestrator;
}

export function RootNavigator({ navRef, onBannerTap, callOrchestrator }: RootNavigatorProps) {
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
              <OnboardingFlow
                // Phase 3: 4-screen flow (Door / Room / Handle / Face).
                // The Face step is the one that calls
                // `identity.setUserId()`, which flips this stack to
                // the authed Group below. `replace` is a no-op once
                // the stacks swap; kept for the IdReveal celebration
                // path (which fires only on first-time enrollment;
                // re-installs land in the Group directly).
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
            <Stack.Screen name="Home">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Home'>) => (
                <HomeTabsView
                  userId={userId}
                  callOrchestrator={callOrchestrator}
                  onOpenChat={(peerId) => navigation.navigate('Chat', { peerId })}
                  onOpenGroup={(groupId) => navigation.navigate('GroupChat', { groupId })}
                  onNewChat={() => navigation.navigate('NewChat')}
                  onNewGroup={() => navigation.navigate('NewGroup')}
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                  onOpenSettings={() => navigation.navigate('Settings')}
                  onInviteFriends={() => navigation.navigate('InviteFriends')}
                  onCallStarted={() => navigation.navigate('Call')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="IdReveal">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'IdReveal'>) => (
                <IdRevealScreen
                  userId={route.params?.userId ?? userId}
                  onContinue={() => navigation.replace('Home')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Diagnostics">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Diagnostics'>) => (
                <DiagnosticsScreen
                  onBack={() => navigation.goBack()}
                  onOpenAvatarPreview={() => navigation.navigate('AvatarPreview')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="AvatarPreview">
              {({ navigation }: NativeStackScreenProps<RootStack, 'AvatarPreview'>) => (
                <AvatarPreviewScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="Settings">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Settings'>) => (
                <SettingsScreen
                  onBack={() => navigation.goBack()}
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                  onInviteFriends={() => navigation.navigate('InviteFriends')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="InviteFriends">
              {({ navigation }: NativeStackScreenProps<RootStack, 'InviteFriends'>) => (
                <InviteFriendsScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen
              name="NewChat"
              options={{ presentation: 'modal' }}
            >
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'NewChat'>) => (
                <NewChatScreen
                  onCancel={() => navigation.goBack()}
                  onStart={(peerId) => {
                    openDirect(userId, peerId);
                    navigation.replace('Chat', { peerId });
                  }}
                  initialPeerId={route.params?.initialPeerId}
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
                  onStartCall={
                    callOrchestrator
                      ? async (peerId) => {
                          try {
                            await callOrchestrator.startOutgoing(peerId);
                            navigation.navigate('Call');
                          } catch {
                            // already busy / self-call; ignore — orchestrator
                            // surfaces details via diag()
                          }
                        }
                      : undefined
                  }
                />
              )}
            </Stack.Screen>
            {callOrchestrator ? (
              <>
                <Stack.Screen
                  name="Call"
                  options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
                >
                  {({ navigation }: NativeStackScreenProps<RootStack, 'Call'>) => (
                    <CallScreen
                      orchestrator={callOrchestrator}
                      onClosed={() => navigation.goBack()}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen
                  name="IncomingCall"
                  options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
                >
                  {({ navigation }: NativeStackScreenProps<RootStack, 'IncomingCall'>) => (
                    <IncomingCallScreen
                      orchestrator={callOrchestrator}
                      onResolved={() => {
                        // After accept → CallScreen; after decline → pop back.
                        // We always replace to Call; if it dismissed itself
                        // already (decline) the dismiss is a no-op effect.
                        navigation.replace('Call');
                      }}
                    />
                  )}
                </Stack.Screen>
              </>
            ) : null}
            <Stack.Screen name="GroupChat">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'GroupChat'>) => (
                <GroupChatScreen
                  groupId={route.params.groupId}
                  onBack={() => navigation.goBack()}
                  onManageMembers={() =>
                    navigation.navigate('ManageGroupMembers', {
                      groupId: route.params.groupId,
                    })
                  }
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="ManageGroupMembers">
              {({
                navigation,
                route,
              }: NativeStackScreenProps<RootStack, 'ManageGroupMembers'>) => (
                <ManageGroupMembersScreen
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

interface HomeTabsViewProps {
  userId: string;
  callOrchestrator?: CallOrchestrator;
  onOpenChat: (peerId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onInviteFriends: () => void;
  onCallStarted: () => void;
}

/**
 * Bottom-tab nav under the authed root stack. Two tabs:
 *  - Chats: the existing ConversationsScreen (1:1 + group chats)
 *  - Calls: dialer + local call history
 *
 * Each tab is a leaf; modal screens (Chat, Settings, Call, etc.)
 * push onto the parent stack, so they cover the tab bar — natural
 * UX for "open this conversation" / "answer this call".
 */
function HomeTabsView({
  userId,
  callOrchestrator,
  onOpenChat,
  onOpenGroup,
  onNewChat,
  onNewGroup,
  onOpenDiagnostics,
  onOpenSettings,
  onInviteFriends,
  onCallStarted,
}: HomeTabsViewProps): React.JSX.Element {
  const themed = useColors();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: themed.primary,
        tabBarInactiveTintColor: themed.slate,
        tabBarStyle: {
          backgroundColor: themed.cream,
          borderTopColor: themed.pale,
          height: Platform.OS === 'ios' ? 84 : 60,
          paddingTop: 4,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
        },
      }}
    >
      <Tabs.Screen
        name="Chats"
        options={{
          tabBarIcon: ({ color }) => <ChatsTabIcon color={color} />,
        }}
      >
        {() => (
          <ConversationsScreen
            onOpenChat={onOpenChat}
            onOpenGroup={onOpenGroup}
            onNewChat={onNewChat}
            onNewGroup={onNewGroup}
            onOpenDiagnostics={onOpenDiagnostics}
            onOpenSettings={onOpenSettings}
            onInviteFriends={onInviteFriends}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen
        name="Calls"
        options={{
          tabBarIcon: ({ color }) => <PhoneIcon size={22} color={color} />,
        }}
      >
        {() => (
          <CallsScreen
            orchestrator={callOrchestrator}
            onCallStarted={onCallStarted}
          />
        )}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

function ChatsTabIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <View>
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
        <Path
          d="M4 5 H20 V17 H13 L9 21 V17 H4 Z"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="square"
          strokeLinejoin="miter"
          fill="none"
        />
      </Svg>
    </View>
  );
}
