import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TtlOption } from '@speakeasy/shared';
import { useColors } from '../theme/index.js';
import { font, space, type as typeScale } from '../theme/tokens.js';

/**
 * NEW-CONVERSATION.md §4.5 / GROUP-SETTINGS.md §3.11 — segmented
 * 4-button TTL picker for room creation and group settings.
 *
 * Options: 1h / 24h / 7d / 30d. The `off` option (TTL_OPTIONS.off)
 * is intentionally not exposed here — group rooms always have a TTL
 * per spec §4.6 (more aggressive default for groups). Sharp corners,
 * brass-filled selection, faint-bordered rest.
 *
 * `disabled=true` dims to 40% opacity; the selected option still
 * highlights brass so members can read the current setting per
 * GROUP-SETTINGS.md §4.3.
 */

const OPTIONS: ReadonlyArray<{
  value: Exclude<TtlOption, 'off'>;
  label: string;
}> = [
  { value: 'hour', label: '1h' },
  { value: 'day', label: '24h' },
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
];

interface Props {
  // Accepts the full TtlOption: when the stored value is 'off' (never expire)
  // no cell highlights, honestly showing "no timer set" rather than silently
  // displaying '7d'. Groups always pass a concrete option, so this widening
  // is transparent to them; onChange still only ever emits a real TTL.
  value: TtlOption;
  onChange: (next: Exclude<TtlOption, 'off'>) => void;
  disabled?: boolean;
}

export function TTLSegmentedControl({
  value,
  onChange,
  disabled,
}: Props): React.ReactElement {
  const themed = useColors();
  return (
    <View style={styles.row}>
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            testID={`ttl-${opt.value}`}
            onPress={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            style={[
              styles.cell,
              {
                backgroundColor: selected ? themed.primary : 'transparent',
                borderColor: selected ? themed.primary : themed.divider,
                opacity: disabled ? 0.4 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.label,
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
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.xs,
  },
  // Sharp corners — brand never softens.
  cell: {
    flex: 1,
    paddingVertical: space.m,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  label: {
    fontSize: 13,
    letterSpacing: typeScale.body.size * 0.005,
  },
});
