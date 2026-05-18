import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { font, space } from '../theme/tokens.js';
import { TextSubtitle, TextMeta } from '../theme/Text.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Unified top app bar — BRANDING1.md §6.1.
 *
 * One component for every screen header. Three shapes fall out of the
 * same slots:
 *
 *  - **Workspace** (Settings, Privacy, Account, …): `onBack` + a string
 *    `title`, optional `trailing` action.
 *  - **Conversation** (Chat, GroupChat): `onBack` + a `leading` portrait
 *    + a node `title` (Handle + StatusSquare) + a meta `subtitle` line +
 *    a `trailing` call button, with the title block `onTitlePress`-able.
 *  - **Root** (Conversations): no `onBack`; `leading` self-portrait +
 *    node `title` + `trailing` settings glyph.
 *
 * Replaces the `back: {width:32,paddingVertical:4}` header fragment that
 * was hand-rolled across 10+ screens (DESIGN-DEBT.md, Pass 2).
 *
 * Layout is snapped to the 4px `space` scale: 16/12 padding, 8 gap,
 * 56 min-height, 1px hairline bottom border in `text-faint`.
 */
export interface AppBarProps {
  /** Renders the brass `‹` back chevron at the left edge. */
  onBack?: () => void;
  /** Leading content (avatar / portrait tile), after the back chevron. */
  leading?: React.ReactNode;
  /**
   * Title. A plain string renders at the `subtitle` scale; pass a node
   * for the conversation variants (a Handle + StatusSquare row).
   */
  title: React.ReactNode;
  /** Optional meta-style sub-line under the title. */
  subtitle?: string;
  /** When set, the title + subtitle block is pressable. */
  onTitlePress?: () => void;
  /** Trailing content (call button, settings glyph, action label). */
  trailing?: React.ReactNode;
  /**
   * a11y label for a pressable title block. Defaults to the title when
   * it is a string; required when `title` is a node and `onTitlePress`
   * is set.
   */
  titleA11yLabel?: string;
  testID?: string;
}

export function AppBar({
  onBack,
  leading,
  title,
  subtitle,
  onTitlePress,
  trailing,
  titleA11yLabel,
  testID,
}: AppBarProps): React.JSX.Element {
  const theme = useTheme();

  const titleBlock = (
    <View style={styles.titleCol}>
      {typeof title === 'string' ? (
        <TextSubtitle numberOfLines={1}>{title}</TextSubtitle>
      ) : (
        title
      )}
      {subtitle ? (
        <TextMeta tone="mute" numberOfLines={1}>
          {subtitle}
        </TextMeta>
      ) : null}
    </View>
  );

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: theme.canvas, borderBottomColor: theme.textFaint },
      ]}
      testID={testID}
    >
      {onBack ? (
        <Pressable
          onPress={onBack}
          hitSlop={8}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          testID={testID ? `${testID}-back` : undefined}
        >
          <Text style={[styles.backGlyph, { color: theme.accent }]}>‹</Text>
        </Pressable>
      ) : null}
      {leading ? <View>{leading}</View> : null}
      {onTitlePress ? (
        <Pressable
          onPress={onTitlePress}
          hitSlop={4}
          style={styles.titleCol}
          accessibilityRole="button"
          accessibilityLabel={
            titleA11yLabel ?? (typeof title === 'string' ? title : undefined)
          }
        >
          {titleBlock}
        </Pressable>
      ) : (
        titleBlock
      )}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.base,
    paddingVertical: space.m,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.s,
  },
  back: { alignItems: 'center', justifyContent: 'center' },
  backGlyph: { fontFamily: font.regular, fontSize: 28, lineHeight: 28 },
  titleCol: { flex: 1, gap: space.xs, minWidth: 0 },
  trailing: { marginLeft: space.s },
});
