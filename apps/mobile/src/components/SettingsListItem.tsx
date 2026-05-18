import React from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { TextBodyEmphasis, TextCaption } from '../theme/Text.js';
import { useColors } from '../theme/index.js';
import { font, space } from '../theme/tokens.js';

/**
 * SETTINGS.md §10 — standard settings row primitive.
 *
 * 14×16 padded, hairline divider below, title in body weight + optional
 * description below in caption. Trailing slot can be a toggle, an
 * arrow, or nothing. Danger variant flips the title to brass per the
 * Account → Delete row treatment (§7.2).
 *
 * Toggle and trailing-arrow are mutually exclusive — the chevron
 * only renders for drilldowns, never alongside an inline toggle.
 */

interface BaseProps {
  title: string;
  description?: string;
  testID?: string;
  /** Brass title color for destructive rows (Delete account, etc.). */
  danger?: boolean;
}

interface ToggleProps extends BaseProps {
  kind: 'toggle';
  value: boolean;
  onChange: (next: boolean) => void;
  /** Renders the toggle dimmed + ignores taps. Used for "Coming
   * soon" rows like Wake from background. */
  disabled?: boolean;
}

interface DrilldownProps extends BaseProps {
  kind: 'drilldown';
  onPress: () => void;
}

interface PlainProps extends BaseProps {
  kind: 'plain';
  onPress?: () => void;
}

type Props = ToggleProps | DrilldownProps | PlainProps;

export function SettingsListItem(props: Props): React.ReactElement {
  const themed = useColors();
  const titleColor = props.danger ? themed.primary : themed.ink;

  const inner = (
    <View style={[styles.row, { borderBottomColor: themed.divider }]}>
      <View style={styles.body}>
        <TextBodyEmphasis style={{ color: titleColor }}>
          {props.title}
        </TextBodyEmphasis>
        {props.description ? (
          <TextCaption style={{ color: themed.slate, lineHeight: 16 }}>
            {props.description}
          </TextCaption>
        ) : null}
      </View>
      {props.kind === 'toggle' ? (
        <Switch
          value={props.value}
          onValueChange={props.disabled ? undefined : props.onChange}
          disabled={props.disabled}
          accessibilityLabel={props.title}
          trackColor={{ false: themed.divider, true: themed.primary }}
          thumbColor={props.value ? themed.cream : themed.slate}
          style={props.disabled ? { opacity: 0.4 } : undefined}
        />
      ) : null}
      {props.kind === 'drilldown' ? (
        <Text style={[styles.arrow, { color: themed.slate }]}>›</Text>
      ) : null}
    </View>
  );

  if (props.kind === 'drilldown' || (props.kind === 'plain' && props.onPress)) {
    return (
      <Pressable
        onPress={props.kind === 'drilldown' ? props.onPress : props.onPress}
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={
          props.description
            ? `${props.title}, ${props.description}`
            : props.title
        }
        style={({ pressed }) => [
          pressed ? { backgroundColor: themed.soft } : null,
        ]}
      >
        {inner}
      </Pressable>
    );
  }
  return <View testID={props.testID}>{inner}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingHorizontal: space.base,
    paddingVertical: space.base,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, gap: space.xs, minWidth: 0 },
  arrow: {
    fontFamily: font.regular,
    fontSize: 18,
  },
});
