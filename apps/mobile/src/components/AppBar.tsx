import React, { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Top app bar — BRANDING1.md §6.1.
 *
 *   - height 56 (status-bar inset added by caller via SafeAreaView)
 *   - canvas bg, 1px text-faint bottom border
 *   - left: handle (with brass `·` separators), optional Back affordance
 *   - right: meta status (`E2E`, `OFFLINE`) in `text-mute`
 *
 * The handle is rendered with brass-period punctuation between
 * segments — splitting on `·`, `-`, or `_` so legacy 3-word ids
 * (silent-golden-hawk) and new handles (alice_2026) both render with
 * the brand's brass-dot motif.
 */
export interface AppBarProps {
  handle: string;
  /** Optional secondary line under the handle (e.g. "2 members"). */
  subtitle?: string;
  /** Right-side status: 'E2E' / 'OFFLINE' / 'CONNECTING'. */
  meta?: string;
  /** When set, renders a back arrow on the left. */
  onBack?: () => void;
  testID?: string;
}

export function AppBar({
  handle,
  subtitle,
  meta,
  onBack,
  testID,
}: AppBarProps): React.JSX.Element {
  const theme = useTheme();
  // Split on hyphen, underscore, or `·`. Brass `·` re-inserted between
  // segments so the same component renders both legacy 3-word ids and
  // new @handles consistently. For an unsegmented handle this just
  // shows the bare token.
  const segments = handle.split(/[-_·]/g).filter((s) => s.length > 0);

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: theme.canvas, borderBottomColor: theme.textFaint },
      ]}
      testID={testID}
    >
      <View style={styles.left}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={8}>
            <Text
              style={{
                color: theme.accent,
                fontFamily: font.medium,
                fontSize: type.subtitle.size,
              }}
            >
              ‹
            </Text>
          </Pressable>
        ) : null}
        <View style={styles.handleCol}>
          <Text
            style={[
              styles.handle,
              {
                color: theme.text,
                fontFamily: font.medium,
                fontSize: type.handle.size,
              },
            ]}
            numberOfLines={1}
          >
            {segments.map((s, i) => (
              <Fragment key={i}>
                {i > 0 ? <Text style={{ color: theme.accent }}>·</Text> : null}
                {s}
              </Fragment>
            ))}
          </Text>
          {subtitle ? (
            <Text
              style={{
                color: theme.textMute,
                fontFamily: font.regular,
                fontSize: type.caption.size,
              }}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {meta ? (
        <Text
          style={[
            styles.meta,
            {
              color: theme.textMute,
              fontFamily: font.medium,
              fontSize: type.meta.size,
              letterSpacing: type.meta.letterSpacingEm * type.meta.size,
            },
          ]}
        >
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 56,
    paddingHorizontal: 18,
    paddingTop: space.s,
    paddingBottom: 14,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.m,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: space.s, flex: 1 },
  handleCol: { gap: 2, flex: 1 },
  handle: { letterSpacing: 0 },
  meta: { textTransform: 'uppercase' },
});
