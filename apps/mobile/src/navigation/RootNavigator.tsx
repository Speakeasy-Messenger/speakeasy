import React from 'react';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { InAppBanner } from '../components/InAppBanner.js';
import { ScreenErrorBoundary } from '../components/ScreenErrorBoundary.js';
import { Toast } from '../components/Toast.js';
import { VerifyDeviceSheet } from '../components/VerifyDeviceSheet.js';
import type { BannerData } from '../store/banner.js';
import { OnboardingFlow } from '../screens/onboarding/OnboardingFlow.js';
import { IdRevealScreen } from '../screens/IdRevealScreen.js';
import { ConversationsScreen } from '../screens/ConversationsScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { VerifyGateScreen } from '../screens/VerifyGateScreen.js';
import { FullMessageScreen } from '../screens/FullMessageScreen.js';
import { ConversationSettingsScreen } from '../screens/ConversationSettingsScreen.js';
import { GroupChatScreen } from '../screens/GroupChatScreen.js';
import { GroupSettingsScreen } from '../screens/GroupSettingsScreen.js';
import { NewGroupScreen } from '../screens/NewGroupScreen.js';
import { DiagnosticsScreen } from '../screens/DiagnosticsScreen.js';
import { AvatarPreviewScreen } from '../screens/AvatarPreviewScreen.js';
import { BlockListScreen } from '../screens/BlockListScreen.js';
import { SettingsLandingScreen } from '../screens/SettingsLandingScreen.js';
import { PrivacyScreen } from '../screens/PrivacyScreen.js';
import { NotificationsScreen } from '../screens/NotificationsScreen.js';
import { AppearanceScreen } from '../screens/AppearanceScreen.js';
import { AccountScreen } from '../screens/AccountScreen.js';
import { AvatarPickerScreen } from '../screens/AvatarPickerScreen.js';
import { VoiceFilterScreen } from '../screens/VoiceFilterScreen.js';
import { DeleteAccountScreen } from '../screens/DeleteAccountScreen.js';
import { AboutScreen } from '../screens/AboutScreen.js';
import { ShareHandleScreen } from '../screens/ShareHandleScreen.js';
import { AddContactScreen } from '../screens/AddContactScreen.js';
import { CallScreen } from '../screens/CallScreen.js';
import { IncomingCallScreen } from '../screens/IncomingCallScreen.js';
import { VideoCallScreen } from '../screens/VideoCallScreen.js';
import { useCalls } from '../store/calls.js';
import { useIdentity } from '../store/identity.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

export type RootStack = {
  Onboarding: undefined;
  /** Full-screen verify gate. Mounted when the user is enrolled
   *  (userId set) but the Vouchflow device token is absent. Blocks
   *  all other routes until verification succeeds. See
   *  VerifyGateScreen for the two scenarios that route here. */
  VerifyGate: undefined;
  IdReveal: { userId: string };
  /** Authed root — renders the conversation list directly. The
   * previous Chats+Calls bottom-tab nav was retired; calls live
   * inline as system messages in the chat feed (CALLS.md §06). */
  Home: undefined;
  Chat: { peerId: string };
  ConversationSettings: { peerId: string };
  GroupChat: { groupId: string };
  GroupSettings: { groupId: string };
  NewGroup: undefined;
  Diagnostics: undefined;
  AvatarPreview: undefined;
  ShareHandle: undefined;
  AddContact: { handle: string };
  BlockList: undefined;
  Settings: undefined;
  Privacy: undefined;
  Notifications: undefined;
  Appearance: undefined;
  Account: undefined;
  AvatarPicker: undefined;
  VoiceFilter: undefined;
  DeleteAccount: undefined;
  About: undefined;
  Call: undefined;
  IncomingCall: { connectingPeerId?: string } | undefined;
  /** Full text of a long message, reached via "See more" in a bubble. */
  FullMessage: { text: string };
};

const Stack = createNativeStackNavigator<RootStack>();

interface RootNavigatorProps {
  navRef: React.RefObject<NavigationContainerRef<RootStack>>;
  /** Fires once the NavigationContainer is mounted and navRef is usable. */
  onReady?: () => void;
  onBannerTap: (target: BannerData['target']) => void;
  /**
   * Optional voice-call orchestrator. When undefined the call screens
   * are inert and call entry points are hidden — useful for tests that
   * render the navigator without bootstrapping the WS pipeline.
   */
  callOrchestrator?: CallOrchestrator;
}

export function RootNavigator({ navRef, onReady, onBannerTap, callOrchestrator }: RootNavigatorProps) {
  const userId = useIdentity((s) => s.userId);
  const hasDeviceToken = useIdentity((s) => !!s.deviceToken);
  // Identity isn't usable until both the userId AND the device token
  // are present. The gate sits between Onboarding (no userId) and the
  // authed Group (full identity) and forces verification before any
  // other screen mounts. See VerifyGateScreen for the scenarios that
  // land here (fresh install over existing account, recovery paths).
  const showGate = !!userId && !hasDeviceToken;

  return (
    <NavigationContainer ref={navRef} onReady={onReady}>
      <InAppBanner onTap={onBannerTap} />
      <Toast />
      <VerifyDeviceSheet />
      <ScreenErrorBoundary>
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
        ) : showGate ? (
          <Stack.Screen name="VerifyGate">
            {() => <VerifyGateScreen />}
          </Stack.Screen>
        ) : (
          // Initial route is Conversations: re-launches with a hydrated
          // identity should go straight there, not back through IdReveal
          // (which is a one-time post-enroll celebration). Onboarding's
          // onEnrolled explicitly navigates to IdReveal for fresh enrolls.
          <Stack.Group screenOptions={{}}>
            <Stack.Screen name="Home">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Home'>) => (
                <ConversationsScreen
                  onOpenChat={(peerId) => navigation.navigate('Chat', { peerId })}
                  onOpenGroup={(groupId) =>
                    navigation.navigate('GroupChat', { groupId })
                  }
                  onNewGroup={() => navigation.navigate('NewGroup')}
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                  onOpenSettings={() => navigation.navigate('Settings')}
                  onShareHandle={() => navigation.navigate('ShareHandle')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="IdReveal">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'IdReveal'>) => (
                <IdRevealScreen
                  userId={route.params?.userId ?? userId}
                  onContinue={() => navigation.replace('Home')}
                  onShareHandle={() => navigation.navigate('ShareHandle')}
                />
              )}
            </Stack.Screen>
            {/* CLAUDECODENOTE.md §3: Diagnostics + AvatarPreview are
                meant to be debug/alpha only. Until we have a build
                flag distinguishing alpha-channel from production
                release, we ship them in all alpha sideloads (the
                5-tap-version unlock in About → footer is the access
                gate). When a production pipeline exists, re-gate
                this block on the alpha flag. */}
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
                <SettingsLandingScreen
                  onBack={() => navigation.goBack()}
                  onOpenPrivacy={() => navigation.navigate('Privacy')}
                  onOpenNotifications={() => navigation.navigate('Notifications')}
                  onOpenAppearance={() => navigation.navigate('Appearance')}
                  onOpenAccount={() => navigation.navigate('Account')}
                  onOpenAbout={() => navigation.navigate('About')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Privacy">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Privacy'>) => (
                <PrivacyScreen
                  onBack={() => navigation.goBack()}
                  onOpenBlockList={() => navigation.navigate('BlockList')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Notifications">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Notifications'>) => (
                <NotificationsScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="Appearance">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Appearance'>) => (
                <AppearanceScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="Account">
              {({ navigation }: NativeStackScreenProps<RootStack, 'Account'>) => (
                <AccountScreen
                  onBack={() => navigation.goBack()}
                  onChangeFace={() => navigation.navigate('AvatarPicker')}
                  onShareHandle={() => navigation.navigate('ShareHandle')}
                  onChangeVoiceFilter={() => navigation.navigate('VoiceFilter')}
                  onDeleteAccount={() => navigation.navigate('DeleteAccount')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="AvatarPicker">
              {({ navigation }: NativeStackScreenProps<RootStack, 'AvatarPicker'>) => (
                <AvatarPickerScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="VoiceFilter">
              {({ navigation }: NativeStackScreenProps<RootStack, 'VoiceFilter'>) => (
                <VoiceFilterScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="DeleteAccount">
              {({ navigation }: NativeStackScreenProps<RootStack, 'DeleteAccount'>) => (
                <DeleteAccountScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="About">
              {({ navigation }: NativeStackScreenProps<RootStack, 'About'>) => (
                <AboutScreen
                  onBack={() => navigation.goBack()}
                  // Always pass — release-mode alpha builds need the
                  // Diagnostics row reachable. The AboutScreen still
                  // gates the row visibility on the prop being defined,
                  // so when alpha → production this re-gates by passing
                  // `undefined` outside `__ALPHA__`.
                  onOpenDiagnostics={() => navigation.navigate('Diagnostics')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="ShareHandle">
              {({ navigation }: NativeStackScreenProps<RootStack, 'ShareHandle'>) => (
                <ShareHandleScreen onBack={() => navigation.goBack()} />
              )}
            </Stack.Screen>
            <Stack.Screen name="AddContact">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'AddContact'>) => (
                <AddContactScreen
                  handle={route.params.handle}
                  onClose={() => navigation.replace('Home')}
                  onOpenChat={(peerId) => navigation.replace('Chat', { peerId })}
                  onCreateRoom={() => navigation.replace('NewGroup')}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="BlockList">
              {({ navigation }: NativeStackScreenProps<RootStack, 'BlockList'>) => (
                <BlockListScreen onBack={() => navigation.goBack()} />
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
                  onOpenFullMessage={(text) =>
                    navigation.navigate('FullMessage', { text })
                  }
                  // `push`, not `navigate`: native-stack `navigate`
                  // to the same route name just swaps params on the
                  // current screen — tapping an @mention should open
                  // a fresh Chat on top, with a back path home.
                  onOpenPeer={(peerId) => navigation.push('Chat', { peerId })}
                  onOpenSettings={() =>
                    navigation.navigate('ConversationSettings', {
                      peerId: route.params.peerId,
                    })
                  }
                  onStartCall={
                    callOrchestrator
                      ? async (peerId, kind) => {
                          try {
                            await callOrchestrator.startOutgoing(peerId, kind);
                            navigation.navigate('Call');
                          } catch {
                            // already busy / self-call / camera denied;
                            // ignore — orchestrator surfaces details
                            // via diag()
                          }
                        }
                      : undefined
                  }
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="ConversationSettings">
              {({
                navigation,
                route,
              }: NativeStackScreenProps<RootStack, 'ConversationSettings'>) => (
                <ConversationSettingsScreen
                  peerId={route.params.peerId}
                  onBack={() => navigation.goBack()}
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
                    <CallSwitcher
                      orchestrator={callOrchestrator}
                      onClosed={() => navigation.goBack()}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen
                  name="IncomingCall"
                  options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
                >
                  {({ navigation, route }: NativeStackScreenProps<RootStack, 'IncomingCall'>) => (
                    <IncomingCallScreen
                      orchestrator={callOrchestrator}
                      connectingPeerId={route.params?.connectingPeerId}
                      onResolved={() => {
                        // After accept → CallScreen; after decline → pop back.
                        // We always replace to Call; if it dismissed itself
                        // already (decline) the dismiss is a no-op effect.
                        navigation.replace('Call');
                      }}
                      onCancelConnecting={() => navigation.goBack()}
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
                  onOpenFullMessage={(text) =>
                    navigation.navigate('FullMessage', { text })
                  }
                  // Tap an @mention in a group message → open a 1:1
                  // with that member.
                  onOpenPeer={(peerId) => navigation.navigate('Chat', { peerId })}
                  // GROUP-SETTINGS.md §2: tapping the AppBar title block
                  // opens the room's full settings screen.
                  onManageMembers={() =>
                    navigation.navigate('GroupSettings', {
                      groupId: route.params.groupId,
                    })
                  }
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="FullMessage">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'FullMessage'>) => (
                <FullMessageScreen
                  text={route.params.text}
                  onBack={() => navigation.goBack()}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="GroupSettings">
              {({ navigation, route }: NativeStackScreenProps<RootStack, 'GroupSettings'>) => (
                <GroupSettingsScreen
                  groupId={route.params.groupId}
                  onBack={() => navigation.goBack()}
                  onOpenPeer={(peerId) => navigation.navigate('Chat', { peerId })}
                />
              )}
            </Stack.Screen>
          </Stack.Group>
        )}
        </Stack.Navigator>
      </ScreenErrorBoundary>
    </NavigationContainer>
  );
}

/**
 * Picks between CallScreen (audio: animal portraits + speech rings) and
 * VideoCallScreen (full-bleed remote video + PiP local) based on the
 * orchestrator's active call kind. Reads from useCalls so the screen
 * also flips correctly on incoming offers (where the kind isn't known
 * until handleIncomingOffer runs).
 */
function CallSwitcher({
  orchestrator,
  onClosed,
}: {
  orchestrator: CallOrchestrator;
  onClosed: () => void;
}): React.ReactElement {
  const kind = useCalls((s) => s.active?.kind ?? 'audio');
  return kind === 'video' ? (
    <VideoCallScreen orchestrator={orchestrator} onClosed={onClosed} />
  ) : (
    <CallScreen orchestrator={orchestrator} onClosed={onClosed} />
  );
}
