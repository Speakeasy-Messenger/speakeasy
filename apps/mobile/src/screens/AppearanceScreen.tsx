import React from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';
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
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Appearance</Text>
        <View style={{ width: 32 }} />
      </View>

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
  sectionLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: 9.5,
    letterSpacing: 0.22 * 9.5,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 10,
  },
  segmented: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  segment: {
    flex: 1,
    paddingVertical: 10,
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
