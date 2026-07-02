import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { SettingsHeader } from '../components/SettingsHeader.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { useColors } from '../theme/index.js';
import { space, type as typeScale } from '../theme/tokens.js';

interface Props {
  onBack: () => void;
  onChangeFace: () => void;
  onShareHandle: () => void;
  onChangeVoiceFilter: () => void;
  onDeleteAccount: () => void;
}

/**
 * SETTINGS.md §7 — header + Actions section + Danger row. The
 * header's meta-sub shows the account creation month/year per
 * §13.5. We don't currently persist a creation date locally; until
 * we do, the meta sub falls back to a year-only `SINCE 2026`
 * defensive default.
 */
export function AccountScreen({
  onBack,
  onChangeFace,
  onShareHandle,
  onChangeVoiceFilter,
  onDeleteAccount,
}: Props): React.ReactElement {
  const themed = useColors();
  // §13.5 defensive: we don't yet persist a creation date locally.
  // Year-only is the spec's fallback for the unknown case.
  const sinceLabel = `SINCE ${new Date().getFullYear()}`;

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="account-screen"
    >
      <AppBar onBack={onBack} title="Account" testID="account-appbar" />

      <ScrollView>
        <SettingsHeader metaSub={sinceLabel} />

        <View style={{ height: 8 }} />
        <SettingsListItem
          kind="drilldown"
          title="Change my face"
          description="Pick a different animal."
          onPress={onChangeFace}
          testID="account-change-face"
        />
        <SettingsListItem
          kind="drilldown"
          title="Share my handle"
          description="Show a QR or copy the link."
          onPress={onShareHandle}
          testID="account-share-handle"
        />

        {/* Voice filter is Android-only: the iOS call path uses the stock
            WebRTC audio device (the custom masking engine broke iOS call
            audio), so the filter has no effect on iOS. Hide the control
            there rather than expose a setting that does nothing. */}
        {Platform.OS === 'android' ? (
          <SettingsListItem
            kind="drilldown"
            title="Voice filter"
            description="Apply a filter to your voice on Private Calls."
            onPress={onChangeVoiceFilter}
            testID="account-voice-filter"
          />
        ) : null}

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          DANGER
        </Text>
        <SettingsListItem
          kind="plain"
          danger
          title="Delete this account"
          description="Releases your handle. Can't be undone."
          onPress={onDeleteAccount}
          testID="account-delete"
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
    paddingTop: space.xl,
    paddingBottom: space.m,
  },
});
