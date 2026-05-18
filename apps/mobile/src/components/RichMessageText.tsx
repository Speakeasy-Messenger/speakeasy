import React from 'react';
import {
  Linking,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useToast } from '../store/toast.js';
import { LONG_MESSAGE_CHARS, tokenize } from './rich-message-text.js';

interface Props {
  /** The full message text. */
  text: string;
  /** Handles @mentioned in this message — enables highlighted rendering. */
  mentions?: string[];
  /** Base text style (color, fontSize, etc.). */
  style?: StyleProp<TextStyle>;
  /**
   * Tap handler for the "See more" affordance. When provided and the
   * text is long, the bubble shows a truncated preview; tapping opens
   * the full text on its own screen. When omitted, the text renders in
   * full (used by the full-message screen itself).
   */
  onSeeMore?: () => void;
}

/**
 * Renders message text with @handles highlighted, URLs tappable
 * (underlined, open in the browser), and long messages truncated behind
 * a "See more" link. Segmentation logic lives in rich-message-text.ts.
 */
export function RichMessageText({ text, mentions, style, onSeeMore }: Props) {
  const truncate = !!onSeeMore && text.length > LONG_MESSAGE_CHARS;
  const shown = truncate ? text.slice(0, LONG_MESSAGE_CHARS).trimEnd() : text;
  const segs = tokenize(shown, !!mentions?.length);

  // Long-press copies the full message text. The prior approach —
  // `selectable` on the <Text> — renders the OS selection handles but
  // doesn't reliably wire through to copy on Android (users reported
  // copy not working), so we drive the clipboard explicitly. Nested
  // link / "see more" onPress children still fire on tap; long-press
  // anywhere on the text copies. The toast confirmation is the app's
  // own cross-platform `<Toast>` (rc.106 shipped ToastAndroid, which
  // left iOS with no feedback).
  function copyText() {
    Clipboard.setString(text);
    useToast.getState().show('Copied');
  }

  return (
    <Text style={style} onLongPress={copyText}>
      {segs.map((s, i) => {
        if (s.kind === 'mention') {
          return (
            <Text key={i} style={styles.mention}>
              {s.text}
            </Text>
          );
        }
        if (s.kind === 'link') {
          return (
            <Text
              key={i}
              style={styles.link}
              onPress={() => {
                void Linking.openURL(s.url).catch(() => {
                  /* nothing can open the URL — ignore */
                });
              }}
            >
              {s.text}
            </Text>
          );
        }
        return <Text key={i}>{s.text}</Text>;
      })}
      {truncate ? (
        <Text onPress={onSeeMore}>
          {'… '}
          <Text style={styles.seeMore}>See more</Text>
        </Text>
      ) : null}
    </Text>
  );
}

// No `color` on these — a nested <Text> inherits the parent body
// colour, so links/mentions stay legible on both bubble variants (the
// hardcoded brass was invisible on the brass sent bubble). Weight +
// underline carry the affordance instead.
const styles = StyleSheet.create({
  mention: {
    fontWeight: '600',
  },
  link: {
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  seeMore: {
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
