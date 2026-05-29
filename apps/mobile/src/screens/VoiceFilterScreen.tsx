import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { useColors } from '../theme/index.js';
import { font, space } from '../theme/tokens.js';
import { useSettings } from '../store/settings.js';
import {
  VOICE_FILTER_PROFILES,
  type VoiceFilterProfileId,
} from '../calls/voice-filter-profiles.js';

interface Props {
  onBack: () => void;
}

/**
 * SETTINGS.md §7 — Voice filter drilldown.
 *
 * Mirrors the AvatarPicker pattern: Account → "Voice filter" drilldown
 * row → dedicated screen with the three Smoke / Velvet / Glass tiles.
 * Lifted from AccountScreen's inline VoiceFilterPicker in rc.34 after
 * tester feedback ("move the voice filter choices to a separate page
 * to match the hierarchy of face selection").
 *
 * Selection persists via the settings store and takes effect on the
 * NEXT Private Call — active calls keep the filter they were placed
 * with.
 */
export function VoiceFilterScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const selected = useSettings((s) => s.voiceFilterProfile);
  const setProfile = useSettings((s) => s.setVoiceFilterProfile);

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="voice-filter-screen"
    >
      <AppBar onBack={onBack} title="Voice filter" testID="voice-filter-appbar" />

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.helper, { color: themed.slate }]}>
          Used on Private Calls. Anonymizes your voice. Pick the one
          that fits. Active calls keep the filter they were placed with;
          the new pick applies to the next call.
        </Text>

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
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingTop: space.s },
  helper: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: space.base,
    paddingBottom: space.lg,
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
