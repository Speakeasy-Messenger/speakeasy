import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { font, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * List row — BRANDING1.md §6.8.
 *
 *   - 56px min height, expands for content
 *   - 16 / 20 padding
 *   - bottom border 1px text-ghost (intentionally lighter than
 *     text-faint — these stack and we don't want a ladder)
 *   - title in `body`/`text`, optional subtitle in `caption`/`text-mute`
 *   - trailing: optional brass `›` chevron or status indicator
 *
 * Pressed state: `surface-pressed`. No chevron color other than brass.
 */
export interface ListItemProps {
  title: string;
  subtitle?: string;
  /** Optional content rendered to the left of the title (avatar, mark, etc.). */
  leading?: React.ReactNode;
  /** Optional trailing slot. Pass a brass `›` Text node or a status
   * indicator. Anything you pass renders on the right. */
  trailing?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
  /** Hides the bottom divider — for the last item in a stack. */
  noDivider?: boolean;
  style?: ViewStyle | ViewStyle[];
}

export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  testID,
  noDivider,
  style,
}: ListItemProps): React.JSX.Element {
  const theme = useTheme();
  const Comp = onPress ? Pressable : View;
  return (
    <Comp
      onPress={onPress}
      testID={testID}
      style={({ pressed }: { pressed?: boolean } = {}) =>
        [
          styles.row,
          {
            backgroundColor: pressed ? theme.surfacePressed : 'transparent',
            borderBottomColor: noDivider ? 'transparent' : theme.textGhost,
            borderBottomWidth: noDivider ? 0 : 1,
          },
          style as ViewStyle,
        ] as ViewStyle[]
      }
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.body}>
        <Text
          style={{
            color: theme.text,
            fontFamily: font.regular,
            fontSize: type.body.size,
          }}
          numberOfLines={1}
        >
          {title}
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
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </Comp>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.base,
    gap: space.base,
  },
  leading: {},
  body: { flex: 1, gap: 2 },
  trailing: { marginLeft: space.s },
});
