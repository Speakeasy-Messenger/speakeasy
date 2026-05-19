import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';
import { formatDateSeparator } from '../utils/time.js';

/**
 * A date-change separator in the chat feed. Visually mirrors
 * `SystemMessageRow` — centered caption text in `slate`, no bubble —
 * so the day labels read as soft scaffolding between messages, not as
 * messages themselves.
 *
 * Rendered above the first message of each day. Label resolves through
 * `formatDateSeparator`: "Today" / "Yesterday" / weekday / full date.
 */
interface Props {
  /** Wall-clock send time (ms) of any message on the day this row labels. */
  timestamp: number;
}

export function DateSeparatorRow({ timestamp }: Props): React.ReactElement {
  const themed = useColors();
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: themed.slate }]}>
        {formatDateSeparator(timestamp)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: 'center',
    paddingVertical: 6,
    marginVertical: space.xs,
    paddingHorizontal: space.md,
  },
  text: {
    fontFamily: font.medium,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
    textAlign: 'center',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});
