import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../theme/index.js';

interface Props {
  /** The full message text. */
  text: string;
  /** Handles mentioned in this message (bare, no @). */
  mentions?: string[];
  /** Base text style (color, fontSize, etc.). */
  style?: object;
}

const MENTION_RE = /(^|\s)(@[a-z][a-z0-9_]{1,19})(?=[^a-z0-9_]|$)/gi;

/**
 * Renders message text with @handles highlighted in brass / primary.
 * Falls back to a plain <Text> for messages with no mentions.
 */
export function MentionText({ text, mentions, style }: Props) {
  if (!mentions?.length) {
    return <Text style={style}>{text}</Text>;
  }

  const parts: Array<{ text: string; isMention: boolean }> = [];
  let lastIndex = 0;

  // Reset regex state for each render
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // match[1] is the whitespace prefix (may be empty)
    // match[2] is the @handle
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isMention: false });
    }
    // Include the prefix as plain text
    if (match[1]) {
      parts.push({ text: match[1], isMention: false });
    }
    parts.push({ text: match[2]!, isMention: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isMention: false });
  }

  return (
    <Text style={style}>
      {parts.map((p, i) =>
        p.isMention ? (
          <Text key={i} style={styles.mention}>
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  mention: {
    color: colors.primary,
    fontWeight: '600',
  },
});
