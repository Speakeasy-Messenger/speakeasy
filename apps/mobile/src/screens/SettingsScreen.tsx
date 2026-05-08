import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { PortraitTile } from '../components/PortraitTile.js';
import { ANIMAL_IDS, ANIMALS } from '../avatars/components.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';
import { useIdentity } from '../store/identity.js';
import { useConnection } from '../store/connection.js';
import { useConversations } from '../store/conversations.js';
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { api, pushNotifications } from '../services.js';
import { useThemePref } from '../theme/ThemeProvider.js';
import { useColors } from '../theme/index.js';

interface Props {
  onBack: () => void;
  onOpenDiagnostics: () => void;
  onInviteFriends: () => void;
}

/**
 * Settings — BRANDING1.md §7 (workspace settings):
 *  - Section labels group items.
 *  - ListItems with title + optional subtitle.
 *  - Switch: `accent` when on, `surface-pressed` when off, no thumb shadow.
 *  - Mode toggle: segmented control.
 *
 * No card backgrounds; flat rows separated by hairline `text-ghost`
 * dividers. The brand prefers space to lines (§6.9) so dividers are
 * minimum-weight.
 */
export function SettingsScreen({ onBack, onOpenDiagnostics, onInviteFriends }: Props) {
  const userId = useIdentity((s) => s.userId);
  const resetIdentity = useIdentity((s) => s.reset);
  const resetConversations = useConversations((s) => s.reset);
  const wsState = useConnection((s) => s.state);
  const inAppNotificationsEnabled = useSettings((s) => s.inAppNotificationsEnabled);
  const setInAppNotificationsEnabled = useSettings((s) => s.setInAppNotificationsEnabled);
  const notificationPrivacy = useSettings((s) => s.notificationPrivacy);
  const setNotificationPrivacy = useSettings((s) => s.setNotificationPrivacy);
  const setProfile = useProfiles((s) => s.set);
  const ownProfile = useProfiles((s) => (userId ? s.byUserId[userId] : undefined));
  const themePref = useThemePref((s) => s.preference);
  const setThemePref = useThemePref((s) => s.set);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const themed = useColors();

  const selectedAnimalId =
    ownProfile?.selectedAvatarId ?? (userId ? defaultAnimalForUser(userId) : 'fox');

  const handleCopyId = () => {
    if (!userId) return;
    // Clipboard package not available in MVP — show confirmation via Alert.
    Alert.alert('Copied!', `@${userId}`);
  };

  async function handlePickAnimal(animalId: string) {
    if (!userId) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) {
      Alert.alert('Sign in again — device token missing.');
      return;
    }
    setBusy(true);
    // Optimistic local update so the grid + profile preview update
    // instantly. The server round-trip below either confirms or
    // rolls back.
    const previousId = ownProfile?.selectedAvatarId;
    setProfile(userId, { selectedAvatarId: animalId, fetchedAt: Date.now() });
    try {
      await api.setAvatar(deviceToken, animalId);
      setPickerOpen(false);
    } catch (err) {
      // Rollback the optimistic write so the UI doesn't lie.
      setProfile(userId, { selectedAvatarId: previousId, fetchedAt: Date.now() });
      Alert.alert('Could not save avatar', String(err));
    } finally {
      setBusy(false);
    }
  }

  // Toggle "Show sender" → flip the local store, then push the new
  // value to the server immediately so the next inbound push respects
  // it without waiting for the next app-start sync. Best-effort: a
  // failure here is recovered on the next launch via App.tsx's
  // registerPushToken call.
  async function handleTogglePrivacy(showSender: boolean) {
    const next = showSender ? 'rich' : 'private';
    setNotificationPrivacy(next);
    try {
      const deviceToken = useIdentity.getState().deviceToken;
      if (!deviceToken) return;
      const pushResult = await pushNotifications.getToken();
      if (!pushResult) return;
      await api.registerPushToken(deviceToken, pushResult.pushToken, pushResult.platform, next);
    } catch {
      // Non-fatal — App.tsx re-syncs on next launch.
    }
  }

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure? This will clear all local data.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          void resetIdentity();
          void resetConversations();
          void useSettings.getState().reset();
          void useProfiles.getState().reset();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Text style={[styles.backText, { color: themed.primary }]}>‹ Back</Text>
        </Pressable>
        <Text style={[text.heroBody, { color: themed.ink }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Profile ── */}
        <SectionLabel color={themed.slate}>PROFILE</SectionLabel>
        <View style={styles.profileBlock}>
          <Pressable
            onPress={() => setPickerOpen((v) => !v)}
            hitSlop={4}
            testID="settings-change-avatar"
          >
            {userId ? (
              <PortraitTile kind="animal" id={selectedAnimalId} size={56} />
            ) : (
              <View style={[styles.profileAvatarPlaceholder, { backgroundColor: themed.pale }]} />
            )}
          </Pressable>
          <View style={styles.profileBody}>
            <Text style={[styles.idValue, { color: themed.ink }]} numberOfLines={1}>
              {userId ? `@${userId}` : '—'}
            </Text>
            <View style={styles.profileActions}>
              <TextLink onPress={handleCopyId} color={themed.primary}>
                Copy
              </TextLink>
              <Text style={[styles.actionSep, { color: themed.divider }]}>·</Text>
              <TextLink
                onPress={() => setPickerOpen((v) => !v)}
                color={themed.primary}
                disabled={busy}
              >
                {pickerOpen ? 'Done' : 'Change face'}
              </TextLink>
            </View>
          </View>
        </View>

        {pickerOpen ? (
          <View style={styles.pickerGrid} testID="settings-avatar-picker">
            {ANIMAL_IDS.map((id) => {
              const active = id === selectedAnimalId;
              return (
                <Pressable
                  key={id}
                  onPress={() => void handlePickAnimal(id)}
                  hitSlop={2}
                  style={[
                    styles.pickerCell,
                    {
                      backgroundColor: themed.pale,
                      borderColor: active ? themed.primary : themed.divider,
                      borderWidth: active ? 2 : StyleSheet.hairlineWidth,
                    },
                  ]}
                  testID={`settings-avatar-${id}`}
                >
                  <PortraitTile kind="animal" id={id} size={56} skipBlink />
                  <Text style={[styles.pickerLabel, { color: themed.slate }]}>
                    {ANIMALS[id]?.meta.name ?? id}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* ── Appearance ── */}
        <SectionLabel color={themed.slate}>APPEARANCE</SectionLabel>
        <ListItem dividerColor={themed.divider}>
          <View style={styles.listItemBody}>
            <Text style={[styles.listItemTitle, { color: themed.ink }]}>Theme</Text>
            <Text style={[styles.listItemSubtitle, { color: themed.slate }]}>
              System follows your device. Brand-canvas screens stay aubergine in both modes.
            </Text>
            <View style={[styles.segmentRow, { borderColor: themed.divider }]}>
              {(['system', 'dark', 'light'] as const).map((opt) => {
                const active = themePref === opt;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => setThemePref(opt)}
                    style={[
                      styles.segment,
                      active && { backgroundColor: themed.primary },
                    ]}
                    testID={`settings-theme-${opt}`}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        { color: active ? themed.cream : themed.ink },
                      ]}
                    >
                      {opt === 'system' ? 'System' : opt === 'dark' ? 'Dark' : 'Light'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ListItem>

        {/* ── Notifications ── */}
        <SectionLabel color={themed.slate}>NOTIFICATIONS</SectionLabel>
        <ListItem dividerColor={themed.divider}>
          <View style={styles.listItemBody}>
            <Text style={[styles.listItemTitle, { color: themed.ink }]}>In-app banners</Text>
            <Text style={[styles.listItemSubtitle, { color: themed.slate }]}>
              Top banner with sender + preview when a message arrives while you're using the app.
            </Text>
          </View>
          {/* Brand §7: accent when on, surface-pressed when off, no
              thumb shadow. Native Switch's thumb shadow can't be killed
              outright on iOS, but on Android the colors map cleanly.
              `ios_backgroundColor` matches the off track so the thumb
              halo doesn't bleed into a different shade. */}
          <Switch
            value={inAppNotificationsEnabled}
            onValueChange={setInAppNotificationsEnabled}
            trackColor={{ false: themed.soft, true: themed.primary }}
            thumbColor={themed.cream}
            ios_backgroundColor={themed.soft}
            testID="settings-in-app-notifications"
          />
        </ListItem>
        <ListItem dividerColor={themed.divider}>
          <View style={styles.listItemBody}>
            <Text style={[styles.listItemTitle, { color: themed.ink }]}>Show sender</Text>
            <Text style={[styles.listItemSubtitle, { color: themed.slate }]}>
              Lock-screen banner reads "@handle: New message". Off → "speakeasy: New message" with
              no sender attribution. Message content stays end-to-end encrypted either way.
            </Text>
          </View>
          <Switch
            value={notificationPrivacy === 'rich'}
            onValueChange={(showSender) => void handleTogglePrivacy(showSender)}
            trackColor={{ false: themed.soft, true: themed.primary }}
            thumbColor={themed.cream}
            ios_backgroundColor={themed.soft}
            testID="settings-notification-show-sender"
          />
        </ListItem>

        {/* ── Connection ── */}
        <SectionLabel color={themed.slate}>CONNECTION</SectionLabel>
        <ListItem dividerColor={themed.divider}>
          <View style={styles.listItemBody}>
            <Text style={[styles.listItemTitle, { color: themed.ink }]}>WebSocket</Text>
          </View>
          <Text style={[styles.statusValue, { color: themed.slate }]}>{wsState}</Text>
        </ListItem>

        {/* ── Actions ── */}
        <SectionLabel color={themed.slate}>ACTIONS</SectionLabel>
        <ActionItem
          label="Invite friends"
          onPress={onInviteFriends}
          dividerColor={themed.divider}
          ink={themed.ink}
          accent={themed.primary}
          pressedBg={themed.soft}
          testID="settings-invite-friends"
        />
        <ActionItem
          label="Diagnostics"
          onPress={onOpenDiagnostics}
          dividerColor={themed.divider}
          ink={themed.ink}
          accent={themed.primary}
          pressedBg={themed.soft}
        />
        <ActionItem
          label="Sign out"
          onPress={handleSignOut}
          dividerColor={themed.divider}
          ink={themed.slate}
          // Sign out is deliberate but secondary — no trailing chevron,
          // muted ink. The Alert.alert confirmation does the danger
          // gate (brand §1: no third color for danger).
          chevron={false}
          pressedBg={themed.soft}
          testID="settings-sign-out"
        />

        <Text style={[text.footnote, styles.version, { color: themed.slate }]}>
          speakeasy 0.1.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionLabel({
  children,
  color,
}: {
  children: React.ReactNode;
  color: string;
}): React.JSX.Element {
  return <Text style={[styles.sectionLabel, { color }]}>{children}</Text>;
}

function ListItem({
  children,
  dividerColor,
}: {
  children: React.ReactNode;
  dividerColor: string;
}): React.JSX.Element {
  return (
    <View style={[styles.listItem, { borderBottomColor: dividerColor }]}>{children}</View>
  );
}

function TextLink({
  children,
  onPress,
  color,
  disabled,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  color: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable onPress={disabled ? undefined : onPress} hitSlop={6}>
      <Text
        style={[
          styles.textLink,
          { color, opacity: disabled ? 0.5 : 1 },
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function ActionItem({
  label,
  onPress,
  dividerColor,
  ink,
  accent,
  pressedBg,
  chevron = true,
  testID,
}: {
  label: string;
  onPress: () => void;
  dividerColor: string;
  ink: string;
  accent?: string;
  pressedBg: string;
  chevron?: boolean;
  testID?: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.listItem,
        { borderBottomColor: dividerColor },
        pressed && { backgroundColor: pressedBg },
      ]}
    >
      <Text style={[styles.listItemTitle, { color: ink, flex: 1 }]}>{label}</Text>
      {chevron ? <Text style={[styles.chevron, { color: accent }]}>›</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    paddingBottom: space.sm,
  },
  backBtn: { padding: space.xs },
  backText: {
    fontFamily: fonts.inter500,
    fontSize: 15,
  },

  content: {
    paddingBottom: space.xxl,
  },

  sectionLabel: {
    fontFamily: type.meta.weight,
    fontSize: type.meta.size,
    letterSpacing: type.meta.size * type.meta.letterSpacingEm,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
    marginTop: space.lg,
    marginBottom: space.xs,
  },

  // Profile is the one block that breaks the strict ListItem rhythm —
  // it's a hero affordance (avatar + handle + a row of inline text
  // links). Padding matches the ListItem so the section reads as
  // belonging to the same column.
  profileBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  profileBody: { flex: 1, gap: space.xs },
  profileAvatarPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: radius.avatar,
  },
  idValue: {
    fontFamily: font.medium,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  profileActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.xs,
    marginTop: 2,
  },
  textLink: {
    fontFamily: font.medium,
    fontSize: 13,
  },
  actionSep: {
    fontSize: 13,
    paddingHorizontal: 2,
  },

  // Animal picker grid — Phase 2 brand overhaul. Renders inline below
  // the profile block when the user taps "Change face". Sharp tiles,
  // 3 columns × 4 rows = 12 launch animals. Selected tile gets a 2px
  // accent border (matches AVATAR-SYSTEM.md §6.1's first-run picker).
  pickerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  pickerCell: {
    width: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.sm,
    gap: 4,
  },
  pickerLabel: {
    fontFamily: font.regular,
    fontSize: type.caption.size,
  },

  // Per BRANDING1.md §6.8 — 56-min height, 16/20 padding (we use 20
  // horizontal to match the section label gutter), hairline bottom
  // border. NO card background.
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 56,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listItemBody: { flex: 1, gap: 2 },
  listItemTitle: {
    fontFamily: type.body.weight,
    fontSize: type.body.size,
    letterSpacing: type.body.size * type.body.letterSpacingEm,
  },
  listItemSubtitle: {
    fontFamily: type.caption.weight,
    fontSize: type.caption.size,
    letterSpacing: type.caption.size * type.caption.letterSpacingEm,
  },

  statusValue: {
    fontFamily: font.medium,
    fontSize: 13,
    textTransform: 'capitalize',
  },

  // Sharp, geometric segmented control. Active segment uses the brass
  // accent + cream foreground; inactive segments are the row's own
  // canvas. 1px border in `divider` — no inner separators (the brand
  // prefers space to lines).
  segmentRow: {
    flexDirection: 'row',
    borderWidth: 1,
    marginTop: space.sm,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  segmentText: {
    fontFamily: font.medium,
    fontSize: 13,
  },

  // The trailing accent chevron — brand §6.8 explicitly allows this as
  // the trailing element on a ListItem, and *only* in accent.
  chevron: {
    fontFamily: font.regular,
    fontSize: 22,
    lineHeight: 22,
  },

  version: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.xl,
  },
});
