import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar.js';
import { Handle } from './Handle.js';
import { useColors } from '../theme/index.js';
import { colors } from '../theme/index.js';

interface Props {
  /** Current query text after the `@` (lowercase). */
  query: string;
  /** Group member handles to filter. */
  members: string[];
  /** The local user's id — excluded from the list. */
  selfUserId: string;
  /** Called when a member is selected. Receives the bare handle (no @). */
  onSelect: (handle: string) => void;
}

/**
 * Lightweight autocomplete that appears above the input bar when the
 * user types `@` in a group chat. Shows matching members; tapping one
 * inserts `@handle ` into the text field.
 */
export function MentionPicker({ query, members, selfUserId, onSelect }: Props) {
  const themed = useColors();

  const filtered = useMemo(() => {
    if (!query) return members.filter((m) => m !== selfUserId).slice(0, 8);
    const q = query.toLowerCase();
    return members
      .filter((m) => m !== selfUserId && m.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [query, members, selfUserId]);

  if (filtered.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: themed.cream, borderTopColor: themed.divider }]}>
      {filtered.map((handle) => (
        <Pressable
          key={handle}
          testID={`mention-option-${handle}`}
          onPress={() => onSelect(handle)}
          style={styles.row}
        >
          <Avatar userId={handle} size={28} />
          <Handle value={handle} variant="body" />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    maxHeight: 240,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
});
