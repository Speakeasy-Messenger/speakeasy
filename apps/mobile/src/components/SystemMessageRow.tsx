import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
  const segments = renderSegments(text, themed.primary);
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

interface Segment {
  text: string;
  brass: boolean;
}

/**
 * Tokenize a system-message string into a list of plain + brass
 * segments. Two patterns get brass:
 *   - The leading `@` of every `@handle` token
 *   - The trailing `.` of the message
 *
 * Anything else stays in the muted body color. The trailing-period
 * rule sits last — if the message doesn't end with one we don't
 * synthesize it, but in practice every system message the product
 * generates does.
 */
function renderSegments(input: string, _brass: string): Segment[] {
  // Split into segments around @-handles. Handle pattern matches
  // the same character set as `isUserId` plus the leading `@` so
  // we can color the `@` separately.
  const pieces: Segment[] = [];
  const handleRe = /@[a-z0-9._-]+/gi;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = handleRe.exec(input)) !== null) {
    if (m.index > cursor) {
      pieces.push({ text: input.slice(cursor, m.index), brass: false });
    }
    // Brass `@`
    pieces.push({ text: '@', brass: true });
    // Muted handle body
    pieces.push({ text: m[0].slice(1), brass: false });
    cursor = m.index + m[0].length;
  }
  if (cursor < input.length) {
    pieces.push({ text: input.slice(cursor), brass: false });
  }

  // Brass-tail the trailing period. Walk back from the end of the
  // last segment; if it's a plain piece ending in `.`, peel that
  // character off and add a brass `.` segment.
  if (pieces.length > 0) {
    const last = pieces[pieces.length - 1]!;
    if (!last.brass && last.text.endsWith('.')) {
      const trimmed = last.text.slice(0, -1);
      pieces[pieces.length - 1] = { text: trimmed, brass: false };
      pieces.push({ text: '.', brass: true });
    }
  }
  return pieces;
}

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
