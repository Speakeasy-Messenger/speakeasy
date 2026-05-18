import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import { AppBar } from '../components/AppBar.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useBlocks } from '../store/blocks.js';
import { useSettings } from '../store/settings.js';
import { useColors } from '../theme/index.js';
import { type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenBlockList: () => void;
}

/** SETTINGS.md §4 — three sections (Calls / Findability / Blocked). */
export function PrivacyScreen({
  onBack,
  onOpenBlockList,
}: Props): React.ReactElement {
  const themed = useColors();
  const allowIncomingCalls = useSettings((s) => s.allowIncomingCalls);
  const setAllowIncomingCalls = useSettings((s) => s.setAllowIncomingCalls);
  const animateAvatarMouth = useSettings((s) => s.animateAvatarMouth);
  const setAnimateAvatarMouth = useSettings((s) => s.setAnimateAvatarMouth);
  const showOnlineStatus = useSettings((s) => s.showOnlineStatus);
  const setShowOnlineStatus = useSettings((s) => s.setShowOnlineStatus);
  const blockedCount = useBlocks((s) => Object.keys(s.byHandle).length);

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="privacy-screen"
    >
      <AppBar onBack={onBack} title="Privacy" testID="privacy-appbar" />

      <ScrollView>
        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          CALLS
        </Text>
        <SettingsListItem
          kind="toggle"
          title="Allow incoming calls"
          description="Off: all calls auto-declined."
          value={allowIncomingCalls}
          onChange={setAllowIncomingCalls}
        />
        <SettingsListItem
          kind="toggle"
          title="Animate avatar mouth"
          description="Disable if you don't want your animal's mouth tracking your voice."
          value={animateAvatarMouth}
          onChange={setAnimateAvatarMouth}
        />
        <SettingsListItem
          kind="toggle"
          title="Wake from background"
          description="Coming soon — when on, calls log to your phone's call history (and iCloud, if synced)."
          value={false}
          onChange={() => {}}
          disabled
        />

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          FINDABILITY
        </Text>
        <SettingsListItem
          kind="toggle"
          title="Show online status"
          description="When off, you always look offline to others."
          value={showOnlineStatus}
          onChange={setShowOnlineStatus}
        />

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          BLOCKED
        </Text>
        <SettingsListItem
          kind="drilldown"
          title="Blocked handles"
          description={`${blockedCount} blocked`}
          onPress={onOpenBlockList}
          testID="privacy-blocked"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 10,
  },
});
