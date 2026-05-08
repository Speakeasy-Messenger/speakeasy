import React from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SettingsHeader } from '../components/SettingsHeader.js';
import { SettingsListItem } from '../components/SettingsListItem.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

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
      <View style={[styles.appbar, { borderBottomColor: themed.divider }]}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={[styles.backText, { color: themed.slate }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: themed.ink }]}>Account</Text>
        <View style={{ width: 32 }} />
      </View>

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
    paddingTop: 24,
    paddingBottom: 10,
  },
});
