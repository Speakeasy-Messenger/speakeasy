import React from 'react';
import {
  Pressable,
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
import { font, space, type as typeScale } from '../theme/tokens.js';
import { useSettings } from '../store/settings.js';
import {
  VOICE_FILTER_PROFILES,
  type VoiceFilterProfileId,
} from '../calls/voice-filter-profiles.js';

interface Props {
  onBack: () => void;
  onChangeFace: () => void;
  onShareHandle: () => void;
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

        <Text style={[styles.sectionLabel, { color: themed.slate }]}>
          VOICE FILTER
        </Text>
        <Text style={[styles.sectionHint, { color: themed.slate }]}>
          Used on Private Calls. Anonymizes your voice. Pick the one
          that fits.
        </Text>
        <VoiceFilterPicker />

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

/**
 * Smoke / Velvet / Glass picker. Three stacked rows; the active one
 * shows a brass dot trailing. Tap to switch — the change persists
 * via the settings store and takes effect on the NEXT Private Call
 * (active calls keep the filter they were placed with).
 */
function VoiceFilterPicker(): React.ReactElement {
  const themed = useColors();
  const selected = useSettings((s) => s.voiceFilterProfile);
  const setProfile = useSettings((s) => s.setVoiceFilterProfile);
  return (
    <View testID="voice-filter-picker">
      {VOICE_FILTER_PROFILES.map((p) => {
        const isActive = selected === p.id;
        return (
          <Pressable
            key={p.id}
            onPress={() => setProfile(p.id satisfies VoiceFilterProfileId)}
            style={[
              styles.profileRow,
              { borderBottomColor: themed.divider },
            ]}
            testID={`voice-filter-${p.id}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: isActive }}
          >
            <View style={styles.profileBody}>
              <Text style={[styles.profileLabel, { color: themed.ink }]}>
                {p.label}
              </Text>
              <Text style={[styles.profileBlurb, { color: themed.slate }]}>
                {p.blurb}
              </Text>
            </View>
            {isActive ? (
              <View
                style={[styles.activeDot, { backgroundColor: themed.primary }]}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
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
  sectionHint: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: space.base,
    paddingBottom: space.m,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.base,
    paddingVertical: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  profileBody: { flex: 1 },
  profileLabel: {
    fontFamily: font.medium,
    fontSize: 15,
    marginBottom: 2,
  },
  profileBlurb: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
