import React from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SettingsHeader } from '../components/SettingsHeader.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useConnection } from '../store/connection.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenPrivacy: () => void;
  onOpenNotifications: () => void;
  onOpenAppearance: () => void;
  onOpenAccount: () => void;
  onOpenAbout: () => void;
}

/**
 * SETTINGS.md §3 — five-category landing.
 *
 * Header is tappable as a whole — opens Account directly per
 * §3.2. Each category row carries a one-line description so the
 * landing doubles as a reference (§3.4).
 */
export function SettingsLandingScreen({
  onBack,
  onOpenPrivacy,
  onOpenNotifications,
  onOpenAppearance,
  onOpenAccount,
  onOpenAbout,
}: Props): React.ReactElement {
  const themed = useColors();
  const wsState = useConnection((s) => s.state);
  const connectionLabel = wsStateToLabel(wsState);

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="settings-screen"
    >
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Settings</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView>
        <SettingsHeader
          metaSub={connectionLabel}
          onPress={onOpenAccount}
          testID="settings-header"
        />
        <SettingsListItem
          kind="drilldown"
          title="Privacy"
          description="Calls, blocks, what's shared"
          onPress={onOpenPrivacy}
          testID="settings-privacy"
        />
        <SettingsListItem
          kind="drilldown"
          title="Notifications"
          description="Sounds, vibration, banners"
          onPress={onOpenNotifications}
          testID="settings-notifications"
        />
        <SettingsListItem
          kind="drilldown"
          title="Appearance"
          description="Light, dark, or follow your phone"
          onPress={onOpenAppearance}
          testID="settings-appearance"
        />
        <SettingsListItem
          kind="drilldown"
          title="Account"
          description="Your handle, your face"
          onPress={onOpenAccount}
          testID="settings-account"
        />
        <SettingsListItem
          kind="drilldown"
          title="About"
          description="Version, what we don't do"
          onPress={onOpenAbout}
          testID="settings-about"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function wsStateToLabel(state: string): string {
  switch (state) {
    case 'authed':
      return 'CONNECTED';
    case 'connecting':
    case 'open':
      return 'CONNECTING';
    case 'idle':
    case 'closed':
    case 'error':
      return 'OFFLINE';
    default:
      return state.toUpperCase();
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  back: { width: 32, paddingVertical: 4 },
  backText: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  title: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
  },
});
