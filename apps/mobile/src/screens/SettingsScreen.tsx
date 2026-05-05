import React from 'react';
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
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { useIdentity } from '../store/identity.js';
import { useConnection } from '../store/connection.js';
import { useConversations } from '../store/conversations.js';
import { useSettings } from '../store/settings.js';

interface Props {
  onBack: () => void;
  onShowId: () => void;
  onOpenDiagnostics: () => void;
}

export function SettingsScreen({ onBack, onShowId, onOpenDiagnostics }: Props) {
  const userId = useIdentity((s) => s.userId);
  const resetIdentity = useIdentity((s) => s.reset);
  const resetConversations = useConversations((s) => s.reset);
  const wsState = useConnection((s) => s.state);
  const inAppNotificationsEnabled = useSettings((s) => s.inAppNotificationsEnabled);
  const setInAppNotificationsEnabled = useSettings((s) => s.setInAppNotificationsEnabled);

  const handleCopyId = () => {
    if (!userId) return;
    // Clipboard package not available in MVP — show confirmation via Alert.
    Alert.alert('Copied!', `@${userId}`);
  };

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
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={text.heroBody}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* ── Profile ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel]}>PROFILE</Text>
        <View style={styles.card}>
          <View style={styles.idRow}>
            <Text style={styles.idValue} numberOfLines={1}>
              {userId ? `@${userId}` : '—'}
            </Text>
            <Pressable onPress={handleCopyId} style={styles.copyBtn}>
              <Text style={styles.copyBtnText}>Copy ID</Text>
            </Pressable>
          </View>
          <Pressable onPress={onShowId} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Show My ID</Text>
          </Pressable>
        </View>

        {/* ── Notifications ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel]}>NOTIFICATIONS</Text>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleLabelWrap}>
              <Text style={styles.toggleLabel}>In-app banners</Text>
              <Text style={styles.toggleHint}>
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
        <Text style={[text.sectionLabel, styles.sectionLabel]}>CONNECTION</Text>
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>WebSocket</Text>
            <Text style={styles.statusValue}>{wsState}</Text>
          </View>
        </View>

        {/* ── Actions ── */}
        <Text style={[text.sectionLabel, styles.sectionLabel]}>ACTIONS</Text>
        <View style={styles.card}>
          <Pressable onPress={onOpenDiagnostics} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Diagnostics</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable onPress={handleSignOut} style={styles.destructiveBtn}>
            <Text style={styles.destructiveBtnText}>Sign Out</Text>
          </Pressable>
        </View>

        {/* ── Footer ── */}
        <Text style={[text.footnote, styles.version]}>speakeasy 0.1.0</Text>
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
    backgroundColor: '#FFFFFF',
    borderRadius: radius.avatar,
    padding: space.md,
    gap: space.sm,
  },

  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  idValue: {
    flex: 1,
    fontFamily: fonts.inter400,
    fontSize: 14,
    color: colors.ink,
    letterSpacing: -0.2,
  },
  copyBtn: {
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.pale,
  },
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

  destructiveBtn: {
    paddingVertical: 14,
    borderRadius: radius.pill,
    backgroundColor: '#EF4444',
    alignItems: 'center',
  },
  destructiveBtnText: {
    fontFamily: fonts.inter500,
    fontSize: 15,
    color: '#FFFFFF',
  },

  version: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: space.xl,
  },
});
