import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBar } from '../components/AppBar.js';
import { RichMessageText } from '../components/RichMessageText.js';
import { space, useColors } from '../theme/index.js';
import { font } from '../theme/tokens.js';

interface Props {
  /** The full message text, passed through from the bubble's "See more". */
  text: string;
  onBack: () => void;
}

/**
 * Full-text view for a long message, reached via the "See more"
 * affordance on a truncated chat bubble. Read-only; links stay tappable
 * (RichMessageText with no `onSeeMore`, so it renders the text in full).
 */
export function FullMessageScreen({ text, onBack }: Props): React.ReactElement {
  const themed = useColors();
  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="full-message-screen"
    >
      <AppBar onBack={onBack} title="Message" testID="full-message-appbar" />
      <ScrollView contentContainerStyle={styles.content}>
        <RichMessageText
          text={text}
          style={[styles.body, { color: themed.ink }]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 24 },
});
