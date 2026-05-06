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
import { launchImageLibrary } from 'react-native-image-picker';
import { Avatar } from '../components/Avatar.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { useIdentity } from '../store/identity.js';
import { useConnection } from '../store/connection.js';
import { useConversations } from '../store/conversations.js';
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { api } from '../services.js';
import { useThemePref } from '../theme/ThemeProvider.js';
import { useColors } from '../theme/index.js';

interface Props {
  onBack: () => void;
  onOpenDiagnostics: () => void;
  onInviteFriends: () => void;
}

export function SettingsScreen({ onBack, onOpenDiagnostics, onInviteFriends }: Props) {
  const userId = useIdentity((s) => s.userId);
  const resetIdentity = useIdentity((s) => s.reset);
  const resetConversations = useConversations((s) => s.reset);
  const wsState = useConnection((s) => s.state);
  const inAppNotificationsEnabled = useSettings((s) => s.inAppNotificationsEnabled);
  const setInAppNotificationsEnabled = useSettings((s) => s.setInAppNotificationsEnabled);
  const setProfile = useProfiles((s) => s.set);
  const themePref = useThemePref((s) => s.preference);
  const setThemePref = useThemePref((s) => s.set);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const themed = useColors();

  const handleCopyId = () => {
    if (!userId) return;
    // Clipboard package not available in MVP — show confirmation via Alert.
    Alert.alert('Copied!', `@${userId}`);
  };

  async function handleChangeAvatar() {
    if (!userId) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) {
      Alert.alert('Sign in again — device token missing.');
      return;
    }
    const result = await launchImageLibrary({
      mediaType: 'photo',
      // image-picker handles the resize for us. 256x256 is enough for
      // a list-row thumbnail, well under the server's 200KB cap.
      maxWidth: 256,
      maxHeight: 256,
      quality: 0.8,
      includeBase64: true,
      // No-op on Android (we don't request the front camera here).
      selectionLimit: 1,
    });
    if (result.didCancel) return;
    const asset = result.assets?.[0];
    if (!asset?.base64) {
      Alert.alert('Could not read that image. Try another?');
      return;
    }
    setAvatarBusy(true);
    try {
      await api.setAvatar(deviceToken, asset.base64);
      setProfile(userId, { avatarB64: asset.base64, fetchedAt: Date.now() });
    } catch (err) {
      Alert.alert('Avatar upload failed', String(err));
    } finally {
      setAvatarBusy(false);
    }
  }

  function handleClearAvatar() {
    if (!userId) return;
    const deviceToken = useIdentity.getState().deviceToken;
    if (!deviceToken) return;
    Alert.alert('Remove avatar?', 'This shows your initials again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setAvatarBusy(true);
          try {
            await api.setAvatar(deviceToken, null);
            setProfile(userId, { avatarB64: undefined, fetchedAt: Date.now() });
          } catch (err) {
            Alert.alert('Failed to remove avatar', String(err));
          } finally {
            setAvatarBusy(false);
          }
        },
      },
    ]);
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
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={[text.heroBody, { color: themed.ink }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Profile ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel, { color: themed.slate }]}>PROFILE</Text>
        <View style={[styles.card, { backgroundColor: themed.pale }]}>
          <View style={styles.profileRow}>
            <Pressable
              onPress={avatarBusy ? undefined : handleChangeAvatar}
              hitSlop={4}
              testID="settings-change-avatar"
            >
              {userId ? (
                <Avatar userId={userId} size={64} />
              ) : (
                <View style={[styles.profileAvatarPlaceholder]} />
              )}
            </Pressable>
            <View style={styles.profileBody}>
              <Text
                style={[styles.idValue, { color: themed.ink }]}
                numberOfLines={1}
              >
                {userId ? `@${userId}` : '—'}
              </Text>
              <View style={styles.profileActions}>
                <Pressable onPress={handleCopyId} style={styles.copyBtn}>
                  <Text style={styles.copyBtnText}>Copy</Text>
                </Pressable>
                <Pressable
                  onPress={avatarBusy ? undefined : handleChangeAvatar}
                  style={[styles.copyBtn, avatarBusy && styles.copyBtnBusy]}
                >
                  <Text style={styles.copyBtnText}>
                    {avatarBusy ? '…' : 'Change photo'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={avatarBusy ? undefined : handleClearAvatar}
                  style={styles.copyBtn}
                >
                  <Text style={styles.copyBtnText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>

        {/* ── Appearance ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel, { color: themed.slate }]}>APPEARANCE</Text>
        <View style={[styles.card, { backgroundColor: themed.pale }]}>
          <View style={styles.segmentRow}>
            {(['system', 'dark', 'light'] as const).map((opt) => {
              const active = themePref === opt;
              return (
                <Pressable
                  key={opt}
                  onPress={() => setThemePref(opt)}
                  style={[styles.segment, active && styles.segmentActive]}
                  testID={`settings-theme-${opt}`}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? styles.segmentTextActive.color : themed.ink },
                    ]}
                  >
                    {opt === 'system' ? 'System' : opt === 'dark' ? 'Dark' : 'Light'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* ── Notifications ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel, { color: themed.slate }]}>NOTIFICATIONS</Text>
        <View style={[styles.card, { backgroundColor: themed.pale }]}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelWrap}>
              <Text style={[styles.toggleLabel, { color: themed.ink }]}>In-app banners</Text>
              <Text style={[styles.toggleHint, { color: themed.slate }]}>
                Show a top banner with sender + preview when a message
                arrives while you're using the app.
              </Text>
            </View>
            <Switch
              value={inAppNotificationsEnabled}
              onValueChange={setInAppNotificationsEnabled}
              testID="settings-in-app-notifications"
            />
          </View>
        </View>

        {/* ── Connection ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel, { color: themed.slate }]}>CONNECTION</Text>
        <View style={[styles.card, { backgroundColor: themed.pale }]}>
          <View style={styles.statusRow}>
            <Text style={[styles.statusLabel, { color: themed.ink }]}>WebSocket</Text>
            <Text style={[styles.statusValue, { color: themed.slate }]}>{wsState}</Text>
          </View>
        </View>

        {/* ── Actions ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel, { color: themed.slate }]}>ACTIONS</Text>
        <View style={[styles.card, { backgroundColor: themed.pale }]}>
          <Pressable
            onPress={onInviteFriends}
            style={styles.primaryBtn}
            testID="settings-invite-friends"
          >
            <Text style={styles.primaryBtnText}>Invite friends</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable onPress={onOpenDiagnostics} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Diagnostics</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            onPress={handleSignOut}
            style={[
              styles.destructiveBtn,
              { borderColor: themed.divider },
            ]}
          >
            <Text style={[styles.destructiveBtnText, { color: themed.ink }]}>Sign Out</Text>
          </Pressable>
        </View>

        {/* ── Footer ── */}
        <Text style={[text.footnote, styles.version, { color: themed.slate }]}>
          speakeasy 0.1.0
        </Text>
      </ScrollView>
    </SafeAreaView>
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
    color: colors.primary,
  },

  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
    gap: space.sm,
  },

  sectionLabel: {
    color: colors.slate,
    marginTop: space.md,
    marginBottom: space.xs,
  },

  card: {
    backgroundColor: colors.pale,
    borderRadius: radius.avatar,
    padding: space.md,
    gap: space.sm,
  },

  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  profileBody: { flex: 1, gap: space.xs },
  profileActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // Spec §10: no avatar circles — the placeholder follows the
  // `<Avatar>` component's 4-radius square rule.
  profileAvatarPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: radius.avatar,
    backgroundColor: colors.pale,
  },
  idValue: {
    fontFamily: fonts.inter500,
    fontSize: 16,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  copyBtn: {
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.pale,
  },
  copyBtnBusy: { opacity: 0.6 },
  copyBtnText: {
    fontFamily: fonts.inter500,
    fontSize: 12,
    color: colors.primary,
  },

  primaryBtn: {
    paddingVertical: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontFamily: fonts.inter500,
    fontSize: 15,
    color: colors.cream,
  },

  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusLabel: {
    fontFamily: fonts.inter400,
    fontSize: 14,
    color: colors.ink,
  },
  statusValue: {
    fontFamily: fonts.inter500,
    fontSize: 13,
    color: colors.slate,
    textTransform: 'capitalize',
  },

  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },

  // Segmented theme toggle. Sharp corners (radius 0) per spec §6.6;
  // active segment uses the brass accent + ink foreground.
  segmentRow: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.divider,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.sm,
    backgroundColor: 'transparent',
  },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: {
    fontFamily: fonts.inter500,
    fontSize: 13,
    color: colors.ink,
  },
  segmentTextActive: { color: colors.cream },
  toggleLabelWrap: { flex: 1 },
  toggleLabel: {
    fontFamily: fonts.inter500,
    fontSize: 14,
    color: colors.ink,
  },
  toggleHint: {
    fontFamily: fonts.inter400,
    fontSize: 12,
    color: colors.slate,
    marginTop: 2,
  },

  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
  },

  // Spec §1: no third color. Sign Out is "deliberate but secondary":
  // transparent bg + 1px text-faint border + ink foreground. The
  // confirmation Alert.alert handles the "are you sure" gate so we
  // don't need a fire-engine red to signal danger.
  destructiveBtn: {
    paddingVertical: 14,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.divider,
    alignItems: 'center',
  },
  destructiveBtnText: {
    fontFamily: fonts.inter500,
    fontSize: 15,
    color: colors.ink,
  },

  version: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.xl,
  },
});
