import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { space, useColors } from '../theme/index.js';
import { accent, font, type as typeScale } from '../theme/tokens.js';
import { useUiState } from '../store/ui.js';

/**
 * One-shot callout shown at the top of the conversations list when
 * the native [SpeakeasyDb] layer wiped the encrypted store on this
 * launch — either the upgrade-time orphan cleanup or the rare
 * lost-key recovery branch. App.tsx flips
 * [useUiState.storeResetBannerVisible] on once at startup, and the
 * native flag is read-and-cleared in the same call so dismissing
 * the banner is final.
 *
 * Conservative copy on purpose: tells the user what happened, why
 * recovery isn't possible, and what is unaffected — no jargon, no
 * version-numbered postmortem.
 */
export function StoreResetBanner(): React.ReactElement | null {
  const themed = useColors();
  const visible = useUiState((s) => s.storeResetBannerVisible);
  const dismiss = useUiState((s) => s.dismissStoreResetBanner);
  if (!visible) return null;
  return (
    <View
      testID="store-reset-banner"
      style={[
        styles.row,
        { backgroundColor: themed.pale, borderLeftColor: accent.base },
      ]}
    >
      <Text style={[styles.text, { color: themed.ink }]}>
        Your local message history on this device was reset. Past messages
        can't be recovered. New chats are unaffected.
      </Text>
      <Pressable
        testID="store-reset-banner-dismiss"
        onPress={dismiss}
        hitSlop={8}
        style={styles.dismiss}
        accessibilityLabel="Dismiss"
      >
        <Text style={[styles.dismissGlyph, { color: themed.slate }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginHorizontal: space.md,
    marginTop: space.xs,
    borderLeftWidth: 3,
    borderRadius: 4,
  },
  text: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
  },
  dismiss: {
    paddingLeft: space.sm,
    paddingTop: 2,
  },
  dismissGlyph: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 18,
  },
});
