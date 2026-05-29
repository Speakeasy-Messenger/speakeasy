import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';
import { useThemePref } from '../theme/ThemeProvider.js';

interface Props {
  onBack: () => void;
}

type ModePref = 'light' | 'dark' | 'system';

const OPTIONS: ReadonlyArray<{ value: ModePref; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/**
 * SETTINGS.md §6 — one screen, one decision. Light / Dark / System
 * segmented control + helper text.
 */
export function AppearanceScreen({ onBack }: Props): React.ReactElement {
  const themed = useColors();
  const themePref = useThemePref((s) => s.preference);
  const setThemePref = useThemePref((s) => s.set);
  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="appearance-screen"
    >
      <AppBar onBack={onBack} title="Appearance" testID="appearance-appbar" />

      <Text style={[styles.sectionLabel, { color: themed.slate }]}>MODE</Text>
      <View style={styles.segmented}>
        {OPTIONS.map((opt) => {
          const selected = opt.value === themePref;
          return (
            <Pressable
              key={opt.value}
              onPress={() => setThemePref(opt.value)}
              testID={`appearance-${opt.value}`}
              style={[
                styles.segment,
                {
                  backgroundColor: selected ? themed.primary : 'transparent',
                  borderColor: selected ? themed.primary : themed.divider,
                },
              ]}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  {
                    color: selected ? themed.cream : themed.slate,
                    fontFamily: selected ? font.medium : font.regular,
                  },
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.helper, { color: themed.slate }]}>
        Light mode uses warm paper tones, not white. Dark mode is the default.
        System follows whichever your phone uses.
      </Text>
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
  segmented: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.base,
    marginBottom: space.m,
  },
  segment: {
    flex: 1,
    paddingVertical: space.m,
    alignItems: 'center',
    borderWidth: 1,
  },
  segmentLabel: { fontSize: 13 },
  helper: {
    fontFamily: font.regular,
    fontSize: 11.5,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
});
