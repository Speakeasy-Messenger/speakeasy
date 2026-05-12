import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { renderSegments } from './system-message-segments.js';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

/**
 * CONVERSATIONS.md §3.6 — system message line in the chat feed.
 *
 * Centered caption text in `text-mute`, no bubble. Always ends
 * with a brass period (the brand-punctuation pattern). When a
 * `@handle` token appears in the text, its `@` glyph is rendered
 * in brass — same treatment as the `<Handle />` primitive
 * elsewhere. Examples:
 *
 *   you blocked @amber.
 *   @lyra joined the room.
 *   voice call · 4:38.
 *
 * Used by both ChatScreen and GroupChatScreen when a feed entry
 * has `from === 'system'`.
 */

interface Props {
  text: string;
}

export function SystemMessageRow({ text }: Props): React.ReactElement {
  const themed = useColors();
  const segments = renderSegments(text);
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: themed.slate }]}>
        {segments.map((seg, i) =>
          seg.brass ? (
            <Text key={i} style={{ color: themed.primary }}>
              {seg.text}
            </Text>
          ) : (
            <Text key={i}>{seg.text}</Text>
          ),
        )}
      </Text>
    </View>
  );
}


/**
 * Tokenize a system-message string into a list of plain + brass
 * segments. Two patterns get brass:
 *   - The leading `@` of every `@handle` token
 *   - The trailing `.` of the message
 *
 * The parser itself lives in `system-message-segments.ts` — pure
 * TS, importable by unit tests under the node-environment vitest
 * harness without dragging in `react-native`.
 */

const styles = StyleSheet.create({
  row: {
    alignSelf: 'center',
    paddingVertical: 8,
    marginVertical: space.xs,
    paddingHorizontal: space.md,
  },
  text: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
    textAlign: 'center',
    letterSpacing: 0.005 * typeScale.caption.size,
  },
});
