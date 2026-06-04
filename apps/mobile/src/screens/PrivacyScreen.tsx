import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useBlocks } from '../store/blocks.js';
import { useSettings } from '../store/settings.js';
import { api } from '../services.js';
import { getCachedDeviceToken } from '../native/cached-device-token.js';
import { diag } from '../diag/log.js';
import { useColors } from '../theme/index.js';
import { space, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onOpenBlockList: () => void;
}

/** SETTINGS.md §4 — Calls / Blocked. (Findability's "Show online status"
 * was cut: a concealment-first app deliberately doesn't broadcast presence.) */
export function PrivacyScreen({
  onBack,
  onOpenBlockList,
}: Props): React.ReactElement {
  const themed = useColors();
  const allowIncomingCalls = useSettings((s) => s.allowIncomingCalls);
  const setAllowIncomingCalls = useSettings((s) => s.setAllowIncomingCalls);
  const animateAvatarMouth = useSettings((s) => s.animateAvatarMouth);
  const setAnimateAvatarMouth = useSettings((s) => s.setAnimateAvatarMouth);
  const refuseVideo = useSettings((s) => s.refuseVideo);
  const setRefuseVideo = useSettings((s) => s.setRefuseVideo);
  const blockedCount = useBlocks((s) => Object.keys(s.byHandle).length);

  // "Refuse video calls" is server-authoritative (the call-router enforces
  // it). Flip the local toggle optimistically, then mirror to the server.
  // A failed sync leaves the server on its last value; the next toggle
  // re-pushes, and `GET /v1/users/me` reseeds on cold start.
  function onChangeRefuseVideo(v: boolean): void {
    setRefuseVideo(v);
    void (async () => {
      try {
        const token = await getCachedDeviceToken();
        if (token) await api.setRefuseVideo(token, v);
      } catch (err) {
        diag('settings', 'refuse-video sync failed', { err: String(err) });
      }
    })();
  }

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
          title="Refuse video calls"
          description="On: people can't video-call you. They're told you keep video off; you're not notified."
          value={refuseVideo}
          onChange={onChangeRefuseVideo}
          testID="privacy-refuse-video"
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
    paddingHorizontal: space.base,
    paddingTop: space.lg,
    paddingBottom: space.m,
  },
});
